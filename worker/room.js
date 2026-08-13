import { DurableObject } from 'cloudflare:workers';

import { createCapability, digestCapability, safeDigestEqual } from './capabilities.js';
import {
  applyGameCommand,
  createGameState,
  joinGameState,
  realizeTimeout,
  toPublicState,
} from './game-state.js';
import { parseSocketCommand } from './protocol.js';

const ROOM_KEY = 'room';
const SECRETS_KEY = 'secrets';
const SPECTATOR_SESSIONS_KEY = 'spectatorSessions';
const MAX_ACTIVE_SPECTATORS = 50;
const MAX_SPECTATOR_SESSIONS = 100;

function json(value, status = 200) {
  return Response.json(value, { status });
}

export class ChessRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.registrySyncPromise = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/create') return this.create(request);
    if (request.method === 'POST' && url.pathname === '/join') {
      return this.ctx.blockConcurrencyWhile(() => this.join(request));
    }
    if (request.method === 'POST' && url.pathname === '/join-public') {
      return this.ctx.blockConcurrencyWhile(() => this.joinPublic(request));
    }
    if (request.method === 'POST' && url.pathname === '/watch') {
      return this.ctx.blockConcurrencyWhile(() => this.watch(request));
    }
    if (request.method === 'GET' && url.pathname === '/socket') return this.connect(request);
    return json({ error: 'not_found' }, 404);
  }

  async create(request) {
    if (await this.ctx.storage.get(ROOM_KEY)) return json({ error: 'room_exists' }, 409);

    const input = await request.json();
    const hostToken = createCapability();
    const inviteToken = createCapability();
    const watchInviteToken = createCapability();
    const state = createGameState(input, input.now);
    const secrets = {
      hostDigest: await digestCapability(hostToken),
      guestDigest: null,
      inviteDigest: await digestCapability(inviteToken),
      watchInviteDigest: await digestCapability(watchInviteToken),
    };
    await this.ctx.storage.put({
      [ROOM_KEY]: state,
      [SECRETS_KEY]: secrets,
      [SPECTATOR_SESSIONS_KEY]: {},
    });
    await this.scheduleAlarm(state);
    if (state.visibility === 'public') await this.syncRegistry(state);

    return json({
      roomId: state.roomId,
      sessionToken: hostToken,
      inviteToken,
      watchInviteToken,
      role: 'host',
      color: state.hostColor,
      state: this.publicState(state),
    }, 201);
  }

  async join(request) {
    const [state, secrets] = await Promise.all([
      this.ctx.storage.get(ROOM_KEY),
      this.ctx.storage.get(SECRETS_KEY),
    ]);
    if (!state || !secrets?.inviteDigest) return json({ error: 'invite_invalid' }, 401);

    const input = await request.json();
    const suppliedDigest = await digestCapability(input.inviteToken);
    if (!safeDigestEqual(suppliedDigest, secrets.inviteDigest)) {
      return json({ error: 'invite_invalid' }, 401);
    }

    const joined = joinGameState(state, input.playerName, input.now, input.avatar);
    if (!joined.ok) return json({ error: joined.error.code }, joined.error.code === 'room_expired' ? 410 : 409);

    const guestToken = createCapability();
    const nextSecrets = {
      ...secrets,
      guestDigest: await digestCapability(guestToken),
      inviteDigest: null,
    };
    await this.ctx.storage.put({ [ROOM_KEY]: joined.state, [SECRETS_KEY]: nextSecrets });
    await this.scheduleAlarm(joined.state);
    this.broadcast(joined.state);
    this.queueRegistrySync(joined.state);

    return json({
      roomId: joined.state.roomId,
      sessionToken: guestToken,
      role: 'guest',
      color: joined.state.guestColor,
      state: this.publicState(joined.state),
    });
  }

  async joinPublic(request) {
    const [state, secrets] = await Promise.all([
      this.ctx.storage.get(ROOM_KEY),
      this.ctx.storage.get(SECRETS_KEY),
    ]);
    if (!state) return json({ error: 'room_missing' }, 404);
    if (state.visibility !== 'public') return json({ error: 'room_not_public' }, 403);

    const input = await request.json();
    const joined = joinGameState(state, input.playerName, input.now, input.avatar);
    if (!joined.ok) return json({ error: joined.error.code }, joined.error.code === 'room_expired' ? 410 : 409);

    const guestToken = createCapability();
    await this.ctx.storage.put({
      [ROOM_KEY]: joined.state,
      [SECRETS_KEY]: {
        ...secrets,
        guestDigest: await digestCapability(guestToken),
        inviteDigest: null,
      },
    });
    await this.scheduleAlarm(joined.state);
    this.broadcast(joined.state);
    this.queueRegistrySync(joined.state);
    return json({
      roomId: joined.state.roomId,
      sessionToken: guestToken,
      role: 'guest',
      color: joined.state.guestColor,
      state: this.publicState(joined.state),
    });
  }

  async watch(request) {
    const [state, secrets, sessions = {}] = await Promise.all([
      this.ctx.storage.get(ROOM_KEY),
      this.ctx.storage.get(SECRETS_KEY),
      this.ctx.storage.get(SPECTATOR_SESSIONS_KEY),
    ]);
    if (!state || !secrets) return json({ error: 'room_missing' }, 404);
    const input = await request.json();
    if (input.now >= state.expiresAt) return json({ error: 'room_expired' }, 410);
    if (!state.allowSpectators) return json({ error: 'spectators_disabled' }, 409);
    if (this.ctx.getWebSockets('spectator').length >= MAX_ACTIVE_SPECTATORS) {
      return json({ error: 'spectator_limit' }, 409);
    }
    if (state.visibility === 'private') {
      const supplied = await digestCapability(input.watchInviteToken ?? '');
      if (!safeDigestEqual(supplied, secrets.watchInviteDigest)) return json({ error: 'watch_invite_invalid' }, 401);
    }

    const activeIds = new Set(this.activeSpectators().map((profile) => profile.id));
    const records = Object.entries(sessions)
      .sort(([, left], [, right]) => right.createdAt - left.createdAt)
      .filter(([, record], index) => activeIds.has(record.id) || index < MAX_SPECTATOR_SESSIONS - activeIds.size);
    const nextSessions = Object.fromEntries(records);
    const sessionToken = createCapability();
    const digest = await digestCapability(sessionToken);
    const profile = {
      id: createCapability().slice(0, 12),
      name: input.playerName,
      avatar: input.avatar,
      createdAt: input.now,
    };
    nextSessions[digest] = profile;
    await this.ctx.storage.put(SPECTATOR_SESSIONS_KEY, nextSessions);
    return json({
      roomId: state.roomId,
      sessionToken,
      role: 'spectator',
      color: null,
      state: this.publicState(state),
    });
  }

  async connect(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'upgrade_required' }, 426);
    }

    const sessionToken = this.readSessionProtocol(request.headers.get('Sec-WebSocket-Protocol'));
    if (!sessionToken) return json({ error: 'unauthorized' }, 401);

    const [state, secrets, spectatorSessions = {}] = await Promise.all([
      this.ctx.storage.get(ROOM_KEY),
      this.ctx.storage.get(SECRETS_KEY),
      this.ctx.storage.get(SPECTATOR_SESSIONS_KEY),
    ]);
    if (!state || !secrets || Date.now() >= state.expiresAt) return json({ error: 'room_expired' }, 410);

    const digest = await digestCapability(sessionToken);
    let role;
    let attachment;
    if (safeDigestEqual(digest, secrets.hostDigest)) role = 'host';
    else if (secrets.guestDigest && safeDigestEqual(digest, secrets.guestDigest)) role = 'guest';
    else if (spectatorSessions[digest]) role = 'spectator';
    else return json({ error: 'unauthorized' }, 401);

    if (role === 'spectator') {
      const profile = spectatorSessions[digest];
      attachment = {
        role,
        id: profile.id,
        name: profile.name,
        avatar: profile.avatar,
        connectedAt: Date.now(),
      };
      for (const existing of this.ctx.getWebSockets(`spectator:${profile.id}`)) existing.close(4001, 'replaced');
    } else {
      const color = role === 'host' ? state.hostColor : state.guestColor;
      attachment = { role, color };
      for (const existing of this.ctx.getWebSockets(role)) existing.close(4001, 'replaced');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, role === 'spectator' ? ['spectator', `spectator:${attachment.id}`] : [role]);
    this.broadcast(state);
    if (role === 'spectator') this.queueRegistrySync(state);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'chess.v1' },
    });
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    if (!attachment?.role || (attachment.role !== 'spectator' && !attachment.color)) {
      socket.close(4003, 'unauthorized');
      return;
    }

    const parsed = parseSocketCommand(message);
    if (!parsed.ok) {
      this.sendError(socket, parsed.code, parsed.message);
      return;
    }
    if (parsed.value.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    const state = await this.ctx.storage.get(ROOM_KEY);
    if (!state) {
      this.sendError(socket, 'room_missing', 'ไม่พบห้องนี้');
      return;
    }
    if (parsed.value.type === 'sync') {
      socket.send(JSON.stringify(this.publicState(state)));
      return;
    }

    if (attachment.role === 'spectator') {
      this.sendError(socket, 'unauthorized_role', 'ผู้ชมไม่มีสิทธิ์เปลี่ยนสถานะเกม', state.revision);
      return;
    }

    const result = applyGameCommand(state, attachment, parsed.value, Date.now());
    if (!result.ok) {
      if (result.state) {
        await this.ctx.storage.put(ROOM_KEY, result.state);
        await this.scheduleAlarm(result.state);
        this.broadcast(result.state);
      }
      this.sendError(socket, result.error.code, result.error.message, state.revision);
      return;
    }

    await this.ctx.storage.put(ROOM_KEY, result.state);
    await this.scheduleAlarm(result.state);
    this.broadcast(result.state);
    this.queueRegistrySync(result.state);
  }

  async webSocketClose(socket, code, reason) {
    socket.close(code, reason);
    const state = await this.ctx.storage.get(ROOM_KEY);
    if (state) {
      this.broadcast(state);
      if (socket.deserializeAttachment()?.role === 'spectator') this.queueRegistrySync(state);
    }
  }

  async webSocketError(socket) {
    socket.close(1011, 'socket_error');
    const state = await this.ctx.storage.get(ROOM_KEY);
    if (state) this.broadcast(state);
  }

  async alarm() {
    const state = await this.ctx.storage.get(ROOM_KEY);
    if (!state) return;

    const now = Date.now();
    if (now >= state.expiresAt) {
      for (const socket of this.ctx.getWebSockets()) socket.close(4004, 'room_expired');
      await this.removeFromRegistry(state.roomId);
      await this.ctx.storage.deleteAll();
      return;
    }

    const timeout = realizeTimeout(state, now);
    if (timeout.changed) {
      await this.ctx.storage.put(ROOM_KEY, timeout.state);
      this.broadcast(timeout.state);
      this.queueRegistrySync(timeout.state);
    }
    await this.scheduleAlarm(timeout.state);
  }

  readSessionProtocol(header) {
    const protocols = String(header ?? '').split(',').map((value) => value.trim());
    const session = protocols.find((value) => value.startsWith('session.'));
    return session?.slice('session.'.length) ?? null;
  }

  publicState(state) {
    const spectators = this.activeSpectators();
    return {
      ...toPublicState(state, {
      host: this.ctx.getWebSockets('host').length > 0,
      guest: this.ctx.getWebSockets('guest').length > 0,
      }),
      spectators,
      spectatorCount: spectators.length,
    };
  }

  activeSpectators() {
    const profiles = new Map();
    for (const socket of this.ctx.getWebSockets('spectator')) {
      const attachment = socket.deserializeAttachment();
      if (!attachment?.id || !attachment?.name || !attachment?.avatar) continue;
      const previous = profiles.get(attachment.id);
      if (!previous || attachment.connectedAt >= previous.connectedAt) {
        profiles.set(attachment.id, {
          id: attachment.id,
          name: attachment.name,
          avatar: attachment.avatar,
          connectedAt: attachment.connectedAt,
        });
      }
    }
    return [...profiles.values()]
      .sort((left, right) => left.connectedAt - right.connectedAt || left.id.localeCompare(right.id))
      .slice(0, MAX_ACTIVE_SPECTATORS)
      .map(({ id, name, avatar }) => ({ id, name, avatar }));
  }

  publicProjection(state) {
    const host = state.players[state.hostColor];
    const guest = state.players[state.guestColor];
    return {
      roomId: state.roomId,
      title: state.title,
      status: state.status,
      host: { name: host.name, avatar: host.avatar },
      guest: guest.name ? { name: guest.name, avatar: guest.avatar } : null,
      openColor: state.status === 'waiting' ? state.guestColor : null,
      timeControlId: state.timeControlId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      spectatorCount: this.activeSpectators().length,
      allowSpectators: state.allowSpectators,
      expiresAt: state.expiresAt,
    };
  }

  queueRegistrySync(state) {
    if (state.visibility !== 'public' || this.registrySyncPromise) return;
    this.registrySyncPromise = Promise.resolve()
      .then(() => this.syncRegistry(state))
      .catch(() => undefined)
      .finally(() => { this.registrySyncPromise = null; });
    this.ctx.waitUntil(this.registrySyncPromise);
  }

  async syncRegistry(state) {
    if (state.visibility !== 'public') return;
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    const response = await stub.fetch('http://lobby/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.publicProjection(state)),
    });
    if (!response.ok) throw new Error(`Lobby projection failed: ${response.status}`);
  }

  async removeFromRegistry(roomId) {
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    await stub.fetch('http://lobby/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
  }

  broadcast(state) {
    const payload = JSON.stringify(this.publicState(state));
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // The runtime will deliver a close/error event for dead sockets.
      }
    }
  }

  sendError(socket, code, message, revision) {
    socket.send(JSON.stringify({ type: 'error', code, message, ...(revision === undefined ? {} : { revision }) }));
  }

  async scheduleAlarm(state) {
    if (state.status === 'finished') {
      await this.ctx.storage.setAlarm(state.expiresAt);
      return;
    }
    if (state.status === 'active' && state.clock && state.clock.activeSince !== null) {
      const remaining = state.turn === 'w' ? state.clock.whiteMs : state.clock.blackMs;
      await this.ctx.storage.setAlarm(Math.min(state.expiresAt, state.clock.activeSince + remaining));
      return;
    }
    await this.ctx.storage.setAlarm(state.expiresAt);
  }
}
