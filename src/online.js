import { ONLINE_RECONNECT_BASE_MS, ONLINE_RECONNECT_MAX_ATTEMPTS } from './config.js';

const PROTOCOL = 'chess-arena-online';
const VERSION = 1;
const ROOM_PATTERN = /^[a-z2-7]{16}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_PREFIX = 'chess-arena-online-session:';
// Single source of truth for the avatar vocabulary — lobby.js, controller.js
// and ui.js derive from this instead of redeclaring their own copy.
export const AVATARS = Object.freeze(['knight', 'king', 'rook', 'bishop', 'pawns', 'shield']);
export const AVATAR_GLYPHS = Object.freeze({
  knight: '♞', king: '♚', rook: '♜', bishop: '♝', pawns: '♟', shield: '♛',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSession(value) {
  return isRecord(value)
    && CAPABILITY_PATTERN.test(value.sessionToken)
    && (
      (['host', 'guest'].includes(value.role) && ['w', 'b'].includes(value.color))
      || (value.role === 'spectator' && value.color === null)
    );
}

function validProfile(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return isRecord(value)
    && typeof value.name === 'string'
    && Array.from(value.name.trim()).length > 0
    && Array.from(value.name.trim()).length <= 40
    && AVATARS.includes(value.avatar);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validPublicAfk(value) {
  if (value === null) return true;
  if (!hasOnlyKeys(value, ['strikes', 'countdown'])
    || !hasOnlyKeys(value.strikes, ['w', 'b'])
    || !['w', 'b'].every((color) => Number.isSafeInteger(value.strikes[color])
      && value.strikes[color] >= 0 && value.strikes[color] <= 2)) return false;
  if (value.countdown === null) return true;
  return hasOnlyKeys(value.countdown, ['color', 'cause', 'deadlineAt'])
    && ['w', 'b'].includes(value.countdown.color)
    && ['opening', 'hidden', 'heartbeat', 'inactivity'].includes(value.countdown.cause)
    && Number.isSafeInteger(value.countdown.deadlineAt);
}

function validPublicClock(value) {
  if (value === null) return true;
  return hasOnlyKeys(value, ['initialMs', 'incrementMs', 'whiteMs', 'blackMs', 'activeSince'])
    && [value.initialMs, value.incrementMs, value.whiteMs, value.blackMs].every(
      (ms) => Number.isSafeInteger(ms) && ms >= 0)
    && (value.activeSince === null || Number.isSafeInteger(value.activeSince));
}

function validLobbyRoom(value) {
  if (!isRecord(value)) return false;
  const allowed = [
    'roomId', 'title', 'status', 'host', 'guest', 'openColor', 'timeControlId',
    'createdAt', 'updatedAt', 'spectatorCount', 'allowSpectators', 'expiresAt',
  ];
  return Object.keys(value).every((key) => allowed.includes(key))
    && ROOM_PATTERN.test(value.roomId)
    && typeof value.title === 'string'
    && Array.from(value.title.trim()).length > 0
    && ['waiting', 'active', 'finished'].includes(value.status)
    && validProfile(value.host)
    && validProfile(value.guest, { nullable: true })
    && [null, 'w', 'b'].includes(value.openColor)
    && typeof value.timeControlId === 'string'
    && [value.createdAt, value.updatedAt, value.expiresAt].every(Number.isSafeInteger)
    && Number.isSafeInteger(value.spectatorCount)
    && value.spectatorCount >= 0
    && value.spectatorCount <= 50
    && typeof value.allowSpectators === 'boolean';
}

export function validateLobbyResponse(value) {
  if (!isRecord(value)
    || !Array.isArray(value.rooms)
    || value.rooms.length > 24
    || !value.rooms.every(validLobbyRoom)
    || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(value.nextCursor)))
    || !Number.isSafeInteger(value.serverTime)) {
    return { ok: false, error: 'invalid_lobby_response' };
  }
  return { ok: true, value };
}

export function getOnlineApiUrl(env = import.meta.env ?? {}, location = globalThis.location) {
  const value = String(env.VITE_ONLINE_API_URL ?? '').trim();
  if (/^https?:\/\/[^/]+/u.test(value)) return value.replace(/\/+$/u, '');
  // Static hosts (GitHub Pages / Cloudflare Pages) can never host the Worker
  // — the origin fallback that serves self-hosted (wrangler) deployments
  // would only produce requests to the static host, so online mode stays
  // disabled there until VITE_ONLINE_API_URL is provided at build time.
  if (/(^|\.)github\.io$|(\/|\.)pages\.dev$/u.test(location?.hostname ?? '')) return '';
  if (location?.protocol === 'https:' && /^https:\/\/[^/]+$/u.test(location.origin)) return location.origin;
  return '';
}

export function parseInviteLocation(location) {
  let url;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  const roomId = url.searchParams.get('room') ?? '';
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ''));
  const inviteToken = fragment.get('invite') ?? '';
  if (!ROOM_PATTERN.test(roomId) || !CAPABILITY_PATTERN.test(inviteToken)) return null;
  return { roomId, inviteToken };
}

export function parseWatchInviteLocation(location) {
  let url;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  const roomId = url.searchParams.get('room') ?? '';
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ''));
  const watchInviteToken = fragment.get('watch') ?? '';
  if (!ROOM_PATTERN.test(roomId) || !CAPABILITY_PATTERN.test(watchInviteToken)) return null;
  return { roomId, watchInviteToken };
}

export function buildInviteUrl(location, roomId, inviteToken) {
  if (!ROOM_PATTERN.test(roomId) || !CAPABILITY_PATTERN.test(inviteToken)) {
    throw new Error('Invalid room invitation');
  }
  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}

export function buildWatchInviteUrl(location, roomId, watchInviteToken) {
  if (!ROOM_PATTERN.test(roomId) || !CAPABILITY_PATTERN.test(watchInviteToken)) {
    throw new Error('Invalid watch invitation');
  }
  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  url.hash = new URLSearchParams({ watch: watchInviteToken }).toString();
  return url.toString();
}

export function saveRoomSession(storage, roomId, session) {
  if (!ROOM_PATTERN.test(roomId) || !validSession(session)) throw new Error('Invalid room session');
  storage.setItem(`${SESSION_PREFIX}${roomId}`, JSON.stringify(session));
}

export function loadRoomSession(storage, roomId) {
  if (!storage || !ROOM_PATTERN.test(roomId)) return null;
  try {
    const value = JSON.parse(storage.getItem(`${SESSION_PREFIX}${roomId}`));
    return validSession(value) ? value : null;
  } catch {
    return null;
  }
}

export function validateServerMessage(value) {
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, error: 'invalid_message' };
  if (value.type === 'error') {
    if (typeof value.code !== 'string' || typeof value.message !== 'string') {
      return { ok: false, error: 'invalid_message' };
    }
    if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) {
      return { ok: false, error: 'invalid_message' };
    }
    return { ok: true, value };
  }
  if (value.type === 'pong') return { ok: true, value };
  if (value.type !== 'state'
    || value.protocol !== PROTOCOL
    || value.version !== VERSION
    || !ROOM_PATTERN.test(value.roomId)
    || typeof value.title !== 'string'
    || Array.from(value.title.trim()).length === 0
    || Array.from(value.title.trim()).length > 80
    || !['public', 'private'].includes(value.visibility)
    || typeof value.allowSpectators !== 'boolean'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !['waiting', 'active', 'finished'].includes(value.status)
    || typeof value.initialFen !== 'string'
    || typeof value.fen !== 'string'
    || !['w', 'b'].includes(value.turn)
    || !Array.isArray(value.moves)
    || !isRecord(value.players)
    || !isRecord(value.players.w)
    || !isRecord(value.players.b)
    || typeof value.players.w.name !== 'string'
    || Array.from(value.players.w.name.trim()).length > 40
    || !AVATARS.includes(value.players.w.avatar)
    || typeof value.players.b.name !== 'string'
    || Array.from(value.players.b.name.trim()).length > 40
    || !AVATARS.includes(value.players.b.avatar)
    || typeof value.players.w.connected !== 'boolean'
    || typeof value.players.b.connected !== 'boolean'
    || !Array.isArray(value.spectators)
    || value.spectators.length > 50
    || !value.spectators.every((profile) => validProfile(profile))
    || !Number.isSafeInteger(value.spectatorCount)
    || value.spectatorCount !== value.spectators.length
    || !validPublicAfk(value.afk)
    || !validPublicClock(value.clock)
    || (value.serverTime !== undefined && !Number.isSafeInteger(value.serverTime))) {
    return { ok: false, error: 'invalid_message' };
  }
  return { ok: true, value };
}

export class OnlineRoomClient {
  constructor({
    apiUrl = getOnlineApiUrl(),
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    storage = globalThis.localStorage,
    onState = () => {},
    onError = () => {},
    onConnectionState = () => {},
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    documentImpl = globalThis.document,
    maxReconnectAttempts = ONLINE_RECONNECT_MAX_ATTEMPTS,
  } = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/u, '');
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.storage = storage;
    this.onState = onState;
    this.onError = onError;
    this.onConnectionState = onConnectionState;
    this.setTimeoutImpl = typeof setTimeoutImpl === 'function' ? setTimeoutImpl.bind(globalThis) : setTimeoutImpl;
    this.clearTimeoutImpl = typeof clearTimeoutImpl === 'function' ? clearTimeoutImpl.bind(globalThis) : clearTimeoutImpl;
    this.setIntervalImpl = typeof setIntervalImpl === 'function' ? setIntervalImpl.bind(globalThis) : setIntervalImpl;
    this.clearIntervalImpl = typeof clearIntervalImpl === 'function' ? clearIntervalImpl.bind(globalThis) : clearIntervalImpl;
    this.documentImpl = documentImpl;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.roomId = null;
    this.session = null;
    this.state = null;
    this.socket = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.visibilityHandler = null;
    this.stopped = false;
    this.connectionState = null;
    this.serverTimeOffsetMs = 0;
    this._lastPongAt = null;
    // Reconnect is also driven from visibility changes: waking a laptop after
    // a terminal 'failed' should retry without a full page reload.
    this.retryVisibilityHandler = null;
    if (this.documentImpl && typeof this.documentImpl.addEventListener === 'function') {
      this.retryVisibilityHandler = () => {
        if (this.documentImpl.visibilityState === 'visible' && this.connectionState === 'failed') {
          this.reconnect();
        }
      };
      this.documentImpl.addEventListener('visibilitychange', this.retryVisibilityHandler);
    }
  }

  _setConnectionState(state) {
    this.connectionState = state;
    this.onConnectionState(state);
  }

  /** Server-aligned wall clock: snapshots carry serverTime and browsers may
   *  not agree with the server, so countdowns must not use raw Date.now(). */
  now() {
    return Date.now() + this.serverTimeOffsetMs;
  }

  forgetSession(roomId = this.roomId) {
    if (!roomId || !this.storage) return;
    try {
      this.storage.removeItem(`${SESSION_PREFIX}${roomId}`);
    } catch {
      // storage unavailable — persistence is best-effort only
    }
  }

  /** Validate + remember a server snapshot. HTTP responses never pass through
   *  the socket message handler, so every entry point routes through here. */
  _adoptState(roomId, state) {
    const parsed = validateServerMessage(state);
    if (!parsed.ok) throw new Error('เซิร์ฟเวอร์ส่งสถานะห้องไม่ตรงโปรโตคอล');
    if (roomId && parsed.value.roomId !== roomId) throw new Error('สถานะห้องไม่ตรงกับห้องที่เชื่อมต่อ');
    this._rememberState(parsed.value);
  }

  _rememberState(state) {
    this.state = state;
    if (Number.isSafeInteger(state.serverTime)) {
      this.serverTimeOffsetMs = state.serverTime - Date.now();
    }
    // A finished room's persisted session would only power a dead RECONNECT
    // shortcut — drop it as soon as the server confirms the result.
    if (state.status === 'finished') this.forgetSession(state.roomId);
    this.onState(state);
  }

  async create(input) {
    const result = await this.request('/api/rooms', input);
    this.useSession(result.roomId, result);
    this._adoptState(result.roomId, result.state);
    return result;
  }

  async join(roomId, input) {
    if (!ROOM_PATTERN.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const result = await this.request(`/api/rooms/${roomId}/join`, input);
    this.useSession(roomId, result);
    this._adoptState(roomId, result.state);
    return result;
  }

  async joinPublic(roomId, input) {
    if (!ROOM_PATTERN.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const result = await this.request(`/api/rooms/${roomId}/join-public`, input);
    this.useSession(roomId, result);
    this._adoptState(roomId, result.state);
    return result;
  }

  async watch(roomId, input) {
    if (!ROOM_PATTERN.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const result = await this.request(`/api/rooms/${roomId}/watch`, input);
    this.useSession(roomId, result);
    this._adoptState(roomId, result.state);
    return result;
  }

  async listLobby(filters = {}, signal) {
    if (!this.apiUrl) throw new Error('ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ห้องออนไลน์');
    const url = new URL(`${this.apiUrl}/api/lobby`);
    for (const key of ['status', 'time', 'search', 'cursor']) {
      if (filters[key] !== undefined && filters[key] !== '') url.searchParams.set(key, filters[key]);
    }
    const response = await this.fetchImpl(url.toString(), { signal });
    let value;
    try { value = await response.json(); } catch { value = null; }
    if (!response.ok) throw new Error(value?.message || value?.error || `HTTP ${response.status}`);
    const parsed = validateLobbyResponse(value);
    if (!parsed.ok) throw new Error('เซิร์ฟเวอร์ส่งรายการห้องไม่ตรงโปรโตคอล');
    return parsed.value;
  }

  async request(path, body) {
    if (!this.apiUrl) throw new Error('ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ห้องออนไลน์');
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let value;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!response.ok) throw new Error(value?.message || value?.error || `HTTP ${response.status}`);
    return value;
  }

  useSession(roomId, value) {
    const session = {
      sessionToken: value.sessionToken,
      role: value.role,
      color: value.color,
    };
    if (!ROOM_PATTERN.test(roomId) || !validSession(session)) throw new Error('ข้อมูล session ห้องไม่ถูกต้อง');
    this.roomId = roomId;
    this.session = session;
    if (this.storage) saveRoomSession(this.storage, roomId, session);
  }

  restoreSession(roomId) {
    const session = loadRoomSession(this.storage, roomId);
    if (!session) return false;
    this.roomId = roomId;
    this.session = session;
    return true;
  }

  connect() {
    if (!this.apiUrl || !this.roomId || !this.session || !this.WebSocketImpl) {
      throw new Error('ยังไม่มีข้อมูลสำหรับเชื่อมต่อห้อง');
    }
    this.stopped = false;
    this.stopPresenceReporting();
    // Retire any previous socket first: two live connections with the same
    // session keep replacing each other (server answers 4001 'replaced').
    const previous = this.socket;
    this.socket = null;
    try {
      previous?.close(4000, 'client_reconnect');
    } catch {
      // already closed
    }
    const url = new URL(`${this.apiUrl}/api/rooms/${this.roomId}/socket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.WebSocketImpl(url.toString(), [
      'chess.v1',
      `session.${this.session.sessionToken}`,
    ]);
    this.socket = socket;
    this._setConnectionState(this.reconnectAttempts ? 'reconnecting' : 'connecting');

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempts = 0;
      this._lastPongAt = Date.now();
      this._setConnectionState('connected');
      this.startPresenceReporting(socket);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      let raw;
      try {
        raw = JSON.parse(event.data);
      } catch {
        this.onError('เซิร์ฟเวอร์ส่งข้อมูลที่อ่านไม่ได้');
        return;
      }
      const parsed = validateServerMessage(raw);
      if (!parsed.ok) {
        this.onError('เซิร์ฟเวอร์ส่งข้อมูลไม่ตรงโปรโตคอล');
        return;
      }
      if (parsed.value.type === 'state') {
        this._rememberState(parsed.value);
      } else if (parsed.value.type === 'pong') {
        this._lastPongAt = Date.now();
      } else if (parsed.value.type === 'error') {
        this.onError(parsed.value.message, parsed.value);
      }
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this._setConnectionState('error');
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.stopPresenceReporting();
      // Terminal server decisions must not be retried: 4001 means another tab
      // took over the session, 4003/4004 mean unauthorized/expired. Only
      // transport-level losses (1006 etc.) justify auto-reconnect.
      if (event?.code === 4001) {
        this._setConnectionState('replaced');
        return;
      }
      if (event?.code === 4003) {
        this._setConnectionState('unauthorized');
        return;
      }
      if (event?.code === 4004) {
        this._setConnectionState('expired');
        return;
      }
      this.scheduleReconnect();
    });
    return socket;
  }

  /** Retry after a terminal 'failed' state — used by the visibility handler
   *  and available for an explicit user action. */
  reconnect() {
    if (this.stopped || !this.session || !this.roomId) return;
    if (this.reconnectTimer !== null) return;
    // Never replace a healthy connection; a dead socket (terminal 'failed')
    // stays assigned in this.socket, so only its non-OPEN state lets us pass.
    if (this.socket && this.socket.readyState === this.WebSocketImpl?.OPEN) return;
    this.reconnectAttempts = 0;
    this.connect();
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._setConnectionState('failed');
      return;
    }
    const base = Math.min(ONLINE_RECONNECT_BASE_MS * (2 ** this.reconnectAttempts), 10_000);
    // ±20% jitter so simultaneous clients don't reconnect in lockstep.
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;
    this._setConnectionState('reconnecting');
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  send(command) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error('ยังไม่ได้เชื่อมต่อห้อง');
    }
    this.socket.send(JSON.stringify(command));
  }

  sendMove(from, to, promotion, expectedRevision = this.state?.revision) {
    this.send({
      type: 'move', from, to,
      ...(promotion ? { promotion } : {}),
      expectedRevision,
    });
  }

  resign(expectedRevision = this.state?.revision) {
    this.send({ type: 'resign', expectedRevision });
  }

  sync() {
    this.send({ type: 'sync' });
  }

  startPresenceReporting(socket) {
    if (this.session?.role === 'spectator' || !this.documentImpl) return;
    const visibility = () => this.documentImpl.visibilityState === 'hidden' ? 'hidden' : 'visible';
    const sendIfCurrent = (command) => {
      if (this.socket === socket && socket.readyState === this.WebSocketImpl.OPEN) {
        socket.send(JSON.stringify(command));
      }
    };
    this.visibilityHandler = () => {
      const current = visibility();
      sendIfCurrent({ type: 'presence', visibility: current });
      if (current === 'visible') sendIfCurrent({ type: 'sync' });
    };
    this.documentImpl.addEventListener('visibilitychange', this.visibilityHandler);
    sendIfCurrent({ type: 'presence', visibility: visibility() });
    this.heartbeatTimer = this.setIntervalImpl(() => {
      sendIfCurrent({ type: 'heartbeat', visibility: visibility() });
      sendIfCurrent({ type: 'ping' });
      // Half-open TCP sockets report OPEN forever; the server answers every
      // ping with pong, so sustained silence means the connection is dead —
      // force a close so the reconnect path takes over.
      if (this._lastPongAt !== null && Date.now() - this._lastPongAt > 30_000) {
        try {
          socket.close(4000, 'liveness_timeout');
        } catch {
          // already closed
        }
      }
    }, 10_000);
  }

  stopPresenceReporting() {
    if (this.heartbeatTimer !== null) this.clearIntervalImpl(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.visibilityHandler && this.documentImpl) {
      this.documentImpl.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }

  stop() {
    this.stopped = true;
    this.stopPresenceReporting();
    if (this.retryVisibilityHandler && this.documentImpl) {
      this.documentImpl.removeEventListener('visibilitychange', this.retryVisibilityHandler);
    }
    this.retryVisibilityHandler = null;
    if (this.reconnectTimer !== null) this.clearTimeoutImpl(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client_stop');
    this._setConnectionState('disconnected');
  }
}
