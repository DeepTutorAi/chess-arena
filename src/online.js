import { ONLINE_RECONNECT_BASE_MS, ONLINE_RECONNECT_MAX_ATTEMPTS } from './config.js';

const PROTOCOL = 'chess-arena-online';
const VERSION = 1;
const ROOM_PATTERN = /^[a-z2-7]{16}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_PREFIX = 'chess-arena-online-session:';
const AVATARS = ['knight', 'king', 'rook', 'bishop', 'pawns', 'shield'];

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
    || !validPublicAfk(value.afk)) {
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
    maxReconnectAttempts = ONLINE_RECONNECT_MAX_ATTEMPTS,
  } = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/u, '');
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.storage = storage;
    this.onState = onState;
    this.onError = onError;
    this.onConnectionState = onConnectionState;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.roomId = null;
    this.session = null;
    this.state = null;
    this.socket = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  async create(input) {
    const result = await this.request('/api/rooms', input);
    this.useSession(result.roomId, result);
    this.state = result.state;
    this.onState(result.state);
    return result;
  }

  async join(roomId, input) {
    if (!ROOM_PATTERN.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const result = await this.request(`/api/rooms/${roomId}/join`, input);
    this.useSession(roomId, result);
    this.state = result.state;
    this.onState(result.state);
    return result;
  }

  async joinPublic(roomId, input) {
    if (!ROOM_PATTERN.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const result = await this.request(`/api/rooms/${roomId}/join-public`, input);
    this.useSession(roomId, result);
    this.state = result.state;
    this.onState(result.state);
    return result;
  }

  async watch(roomId, input) {
    if (!ROOM_PATTERN.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
    const result = await this.request(`/api/rooms/${roomId}/watch`, input);
    this.useSession(roomId, result);
    this.state = result.state;
    this.onState(result.state);
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
    const url = new URL(`${this.apiUrl}/api/rooms/${this.roomId}/socket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.WebSocketImpl(url.toString(), [
      'chess.v1',
      `session.${this.session.sessionToken}`,
    ]);
    this.socket = socket;
    this.onConnectionState(this.reconnectAttempts ? 'reconnecting' : 'connecting');

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempts = 0;
      this.onConnectionState('connected');
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
        this.state = parsed.value;
        this.onState(parsed.value);
      } else if (parsed.value.type === 'error') {
        this.onError(parsed.value.message, parsed.value);
      }
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.onConnectionState('error');
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) return;
      this.scheduleReconnect();
    });
    return socket;
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onConnectionState('failed');
      return;
    }
    const delay = Math.min(ONLINE_RECONNECT_BASE_MS * (2 ** this.reconnectAttempts), 10_000);
    this.reconnectAttempts += 1;
    this.onConnectionState('reconnecting');
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

  stop() {
    this.stopped = true;
    if (this.reconnectTimer !== null) this.clearTimeoutImpl(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client_stop');
    this.onConnectionState('disconnected');
  }
}
