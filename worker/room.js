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

function json(value, status = 200) {
  return Response.json(value, { status });
}

export class ChessRoom extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/create') return this.create(request);
    if (request.method === 'POST' && url.pathname === '/join') return this.join(request);
    if (request.method === 'GET' && url.pathname === '/socket') return this.connect(request);
    return json({ error: 'not_found' }, 404);
  }

  async create(request) {
    if (await this.ctx.storage.get(ROOM_KEY)) return json({ error: 'room_exists' }, 409);

    const input = await request.json();
    const hostToken = createCapability();
    const inviteToken = createCapability();
    const state = createGameState(input, input.now);
    const secrets = {
      hostDigest: await digestCapability(hostToken),
      guestDigest: null,
      inviteDigest: await digestCapability(inviteToken),
    };
    await this.ctx.storage.put({ [ROOM_KEY]: state, [SECRETS_KEY]: secrets });
    await this.scheduleAlarm(state);

    return json({
      roomId: state.roomId,
      sessionToken: hostToken,
      inviteToken,
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

    const joined = joinGameState(state, input.playerName, input.now);
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

    return json({
      roomId: joined.state.roomId,
      sessionToken: guestToken,
      role: 'guest',
      color: joined.state.guestColor,
      state: this.publicState(joined.state),
    });
  }

  async connect(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'upgrade_required' }, 426);
    }

    const sessionToken = this.readSessionProtocol(request.headers.get('Sec-WebSocket-Protocol'));
    if (!sessionToken) return json({ error: 'unauthorized' }, 401);

    const [state, secrets] = await Promise.all([
      this.ctx.storage.get(ROOM_KEY),
      this.ctx.storage.get(SECRETS_KEY),
    ]);
    if (!state || !secrets || Date.now() >= state.expiresAt) return json({ error: 'room_expired' }, 410);

    const digest = await digestCapability(sessionToken);
    let role;
    if (safeDigestEqual(digest, secrets.hostDigest)) role = 'host';
    else if (secrets.guestDigest && safeDigestEqual(digest, secrets.guestDigest)) role = 'guest';
    else return json({ error: 'unauthorized' }, 401);

    const color = role === 'host' ? state.hostColor : state.guestColor;
    for (const existing of this.ctx.getWebSockets(role)) existing.close(4001, 'replaced');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role, color });
    this.ctx.acceptWebSocket(server, [role]);
    this.broadcast(state);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'chess.v1' },
    });
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    if (!attachment?.role || !attachment?.color) {
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
  }

  async webSocketClose(socket, code, reason) {
    socket.close(code, reason);
    const state = await this.ctx.storage.get(ROOM_KEY);
    if (state) this.broadcast(state);
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
      await this.ctx.storage.deleteAll();
      return;
    }

    const timeout = realizeTimeout(state, now);
    if (timeout.changed) {
      await this.ctx.storage.put(ROOM_KEY, timeout.state);
      this.broadcast(timeout.state);
    }
    await this.scheduleAlarm(timeout.state);
  }

  readSessionProtocol(header) {
    const protocols = String(header ?? '').split(',').map((value) => value.trim());
    const session = protocols.find((value) => value.startsWith('session.'));
    return session?.slice('session.'.length) ?? null;
  }

  publicState(state) {
    return toPublicState(state, {
      host: this.ctx.getWebSockets('host').length > 0,
      guest: this.ctx.getWebSockets('guest').length > 0,
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
