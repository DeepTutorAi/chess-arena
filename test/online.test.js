import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OnlineRoomClient,
  buildInviteUrl,
  buildWatchInviteUrl,
  getOnlineApiUrl,
  loadRoomSession,
  parseInviteLocation,
  parseWatchInviteLocation,
  saveRoomSession,
  validateLobbyResponse,
  validateServerMessage,
} from '../src/online.js';

const ROOM_ID = 'abcdefgh23456722';
const TOKEN = 'A'.repeat(43);

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function validState(overrides = {}) {
  return {
    protocol: 'chess-arena-online',
    version: 1,
    type: 'state',
    roomId: ROOM_ID,
    title: 'Friday Blitz',
    visibility: 'public',
    allowSpectators: true,
    revision: 1,
    status: 'active',
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: 'w',
    lastMove: null,
    lastMoveSan: null,
    moves: [],
    result: null,
    reason: null,
    players: {
      w: { name: 'Host', avatar: 'knight', connected: true },
      b: { name: 'Guest', avatar: 'rook', connected: true },
    },
    spectators: [{ name: 'Viewer', avatar: 'bishop' }],
    spectatorCount: 1,
    afk: {
      strikes: { w: 0, b: 0 },
      countdown: { color: 'w', cause: 'opening', deadlineAt: 20_000 },
    },
    clock: null,
    expiresAt: 99_999,
    ...overrides,
  };
}

test('invite helpers preserve a GitHub Pages subpath and keep capability in the fragment', () => {
  const location = { href: 'https://example.github.io/chess-arena/?theme=dark' };
  const invite = buildInviteUrl(location, ROOM_ID, TOKEN);
  const url = new URL(invite);

  assert.equal(url.pathname, '/chess-arena/');
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.searchParams.get('room'), ROOM_ID);
  assert.equal(url.hash, `#invite=${TOKEN}`);
  assert.equal(url.search.includes(TOKEN), false);
  assert.deepEqual(parseInviteLocation({ href: invite }), { roomId: ROOM_ID, inviteToken: TOKEN });
});

test('parseInviteLocation rejects malformed room and invite values', () => {
  assert.equal(parseInviteLocation({ href: 'https://example.test/?room=short#invite=nope' }), null);
  assert.equal(parseInviteLocation({ href: 'https://example.test/' }), null);
});

test('watch invite helpers keep the spectator capability separate and in the fragment', () => {
  const location = { href: 'https://example.github.io/chess-arena/?theme=dark' };
  const invite = buildWatchInviteUrl(location, ROOM_ID, TOKEN);
  const url = new URL(invite);

  assert.equal(url.searchParams.get('room'), ROOM_ID);
  assert.equal(url.hash, `#watch=${TOKEN}`);
  assert.equal(parseInviteLocation({ href: invite }), null);
  assert.deepEqual(parseWatchInviteLocation({ href: invite }), { roomId: ROOM_ID, watchInviteToken: TOKEN });
  assert.equal(parseWatchInviteLocation({ href: `https://example.test/?room=${ROOM_ID}#watch=short` }), null);
});

test('room sessions are isolated by room and validated when loaded', () => {
  const storage = memoryStorage();
  saveRoomSession(storage, ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  saveRoomSession(storage, 'bcdefghi23456723', { sessionToken: 'B'.repeat(43), role: 'guest', color: 'b' });

  assert.deepEqual(loadRoomSession(storage, ROOM_ID), { sessionToken: TOKEN, role: 'host', color: 'w' });
  assert.equal(loadRoomSession(storage, 'cdefghij23456724'), null);
  storage.setItem(`chess-arena-online-session:${ROOM_ID}`, '{broken');
  assert.equal(loadRoomSession(storage, ROOM_ID), null);

  saveRoomSession(storage, ROOM_ID, { sessionToken: TOKEN, role: 'spectator', color: null });
  assert.deepEqual(loadRoomSession(storage, ROOM_ID), { sessionToken: TOKEN, role: 'spectator', color: null });
});

test('validateLobbyResponse accepts public summaries and rejects authority leakage', () => {
  const value = {
    rooms: [{
      roomId: ROOM_ID,
      title: 'Friday Blitz',
      status: 'waiting',
      host: { name: 'Host', avatar: 'knight' },
      guest: null,
      openColor: 'b',
      timeControlId: 'blitz_5_0',
      createdAt: 1_000,
      updatedAt: 2_000,
      spectatorCount: 0,
      allowSpectators: true,
      expiresAt: 99_999,
    }],
    nextCursor: null,
    serverTime: 3_000,
  };
  assert.deepEqual(validateLobbyResponse(value), { ok: true, value });
  assert.equal(validateLobbyResponse({ ...value, rooms: [{ ...value.rooms[0], sessionToken: TOKEN }] }).ok, false);
  assert.equal(validateLobbyResponse({ ...value, rooms: [{ ...value.rooms[0], spectatorCount: 51 }] }).ok, false);
});

test('OnlineRoomClient lists, joins, and watches rooms with role-scoped sessions', async () => {
  const requests = [];
  const responses = [
    {
      rooms: [], nextCursor: null, serverTime: 10,
    },
    {
      roomId: ROOM_ID, sessionToken: TOKEN, role: 'guest', color: 'b', state: validState(),
    },
    {
      roomId: ROOM_ID, sessionToken: 'S'.repeat(43), role: 'spectator', color: null, state: validState(),
    },
  ];
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.test',
    storage: memoryStorage(),
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() { return responses.shift(); } };
    },
  });
  const signal = new AbortController().signal;

  assert.deepEqual(await client.listLobby({ status: 'open', time: 'blitz', search: 'Friday' }, signal), {
    rooms: [], nextCursor: null, serverTime: 10,
  });
  assert.match(requests[0].url, /\/api\/lobby\?status=open&time=blitz&search=Friday$/u);
  assert.equal(requests[0].options.signal, signal);

  await client.joinPublic(ROOM_ID, { playerName: 'Guest', avatar: 'rook' });
  assert.deepEqual(JSON.parse(requests[1].options.body), { playerName: 'Guest', avatar: 'rook' });
  assert.equal(client.session.role, 'guest');

  await client.watch(ROOM_ID, { playerName: 'Viewer', avatar: 'bishop' });
  assert.deepEqual(JSON.parse(requests[2].options.body), { playerName: 'Viewer', avatar: 'bishop' });
  assert.deepEqual(client.session, { sessionToken: 'S'.repeat(43), role: 'spectator', color: null });
});

test('validateServerMessage accepts canonical snapshots and rejects malformed authority', () => {
  assert.deepEqual(validateServerMessage(validState()), { ok: true, value: validState() });
  assert.equal(validateServerMessage(validState({ revision: -1 })).ok, false);
  assert.equal(validateServerMessage(validState({ turn: 'green' })).ok, false);
  assert.equal(validateServerMessage(validState({ players: {} })).ok, false);
  assert.equal(validateServerMessage(validState({ spectators: [{ name: 'Viewer', avatar: 'unknown' }] })).ok, false);
  assert.equal(validateServerMessage(validState({ spectatorCount: 2 })).ok, false);
  assert.equal(validateServerMessage(validState({ visibility: 'secret' })).ok, false);
  assert.equal(validateServerMessage(validState({ afk: { strikes: { w: -1, b: 0 }, countdown: null } })).ok, false);
  assert.equal(validateServerMessage(validState({ afk: { strikes: { w: 0, b: 0 }, countdown: { color: 'w', cause: 'idle', deadlineAt: 20_000 } } })).ok, false);
  assert.equal(validateServerMessage(validState({ afk: { strikes: { w: 0, b: 0 }, countdown: null, lastHeartbeatAt: 1 } })).ok, false);
  assert.equal(validateServerMessage(validState({ afk: { strikes: { w: 0, b: 0 }, countdown: { color: 'w', cause: 'opening', deadlineAt: 1.5 } } })).ok, false);
  assert.deepEqual(validateServerMessage({ type: 'error', code: 'wrong_turn', message: 'wait', revision: 2 }), {
    ok: true,
    value: { type: 'error', code: 'wrong_turn', message: 'wait', revision: 2 },
  });
});

test('getOnlineApiUrl uses an explicit endpoint or the production page origin', () => {
  assert.equal(getOnlineApiUrl({ VITE_ONLINE_API_URL: 'https://rooms.example.workers.dev/' }), 'https://rooms.example.workers.dev');
  assert.equal(getOnlineApiUrl({}, { protocol: 'https:', origin: 'https://chess.example.workers.dev' }), 'https://chess.example.workers.dev');
  assert.equal(getOnlineApiUrl({}, { protocol: 'http:', origin: 'http://localhost:5173' }), '');
  // Static hosts (github.io / pages.dev) cannot host the Worker — the origin
  // fallback would only hit the static host, so online mode is reported
  // unavailable there instead.
  assert.equal(getOnlineApiUrl({}, { protocol: 'https:', origin: 'https://player.github.io', hostname: 'player.github.io' }), '');
  assert.equal(getOnlineApiUrl({}, { protocol: 'https:', origin: 'https://chess-arena.pages.dev', hostname: 'chess-arena.pages.dev' }), '');
  assert.equal(getOnlineApiUrl({ VITE_ONLINE_API_URL: 'https://rooms.example.workers.dev' }, { protocol: 'https:', origin: 'https://player.github.io', hostname: 'player.github.io' }), 'https://rooms.example.workers.dev');
});

test('OnlineRoomClient authenticates with a WebSocket subprotocol, never the URL', () => {
  class FakeWebSocket {
    static instances = [];
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    close() {}
    send() {}
  }

  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: FakeWebSocket,
    storage: memoryStorage(),
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  client.connect();

  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, `wss://rooms.example.workers.dev/api/rooms/${ROOM_ID}/socket`);
  assert.equal(socket.url.includes(TOKEN), false);
  assert.deepEqual(socket.protocols, ['chess.v1', `session.${TOKEN}`]);
});

test('OnlineRoomClient reports player visibility and heartbeat while connected, then cleans up', () => {
  const sent = [];
  const intervals = new Map();
  const listeners = new Map();
  const documentImpl = {
    visibilityState: 'visible',
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
    open() { this.readyState = FakeWebSocket.OPEN; this.listeners.get('open')?.(); }
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: FakeWebSocket,
    storage: memoryStorage(),
    documentImpl,
    setIntervalImpl(callback, delay) { intervals.set(1, { callback, delay }); return 1; },
    clearIntervalImpl(id) { intervals.delete(id); },
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  const socket = client.connect();
  socket.open();

  assert.deepEqual(sent, [{ type: 'presence', visibility: 'visible' }]);
  assert.equal(intervals.get(1).delay, 10_000);
  intervals.get(1).callback();
  documentImpl.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  assert.deepEqual(sent.slice(1), [
    { type: 'heartbeat', visibility: 'visible' },
    { type: 'ping' },
    { type: 'presence', visibility: 'hidden' },
  ]);

  client.stop();
  assert.equal(intervals.size, 0);
  assert.equal(listeners.has('visibilitychange'), false);
});

test('a pong keeps liveness alive while sustained silence forces a reconnect', () => {
  const closed = [];
  const realNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  try {
    class FakeWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 1; this.listeners = new Map(); }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      send(value) {
        // Each ping represents one 10s heartbeat interval elapsing.
        if (JSON.parse(value).type === 'ping') fakeNow += 10_000;
      }
      close(code, reason) { closed.push({ code, reason }); }
      open() { this.readyState = FakeWebSocket.OPEN; this.listeners.get('open')?.(); }
    }
    const client = new OnlineRoomClient({
      apiUrl: 'https://rooms.example.workers.dev',
      WebSocketImpl: FakeWebSocket,
      storage: memoryStorage(),
      documentImpl: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
      setIntervalImpl(callback) { client._tick = callback; return 1; },
      clearIntervalImpl() {},
    });
    client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
    const socket = client.connect();
    socket.open(); // _lastPongAt = 1_000_000

    client._tick();
    client._tick();
    client._tick(); // 30s of silence exactly — still at the boundary
    assert.deepEqual(closed, []);

    socket.listeners.get('message')({ data: JSON.stringify({ type: 'pong' }) });
    client._tick(); // pong reset the silence window
    assert.deepEqual(closed, []);

    fakeNow += 21_000; // >30s since the last pong
    client._tick();
    assert.equal(closed.at(-1)?.reason, 'liveness_timeout');
    client.stop();
  } finally {
    Date.now = realNow;
  }
});

test('OnlineRoomClient never sends player presence for spectators', () => {
  const sent = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send(value) { sent.push(value); }
    close() {}
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: FakeWebSocket,
    storage: memoryStorage(),
    documentImpl: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setIntervalImpl() { throw new Error('spectators must not start heartbeat'); },
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'spectator', color: null });
  const socket = client.connect();
  socket.listeners.get('open')();
  assert.deepEqual(sent, []);
});

test('OnlineRoomClient preserves the browser receiver for native timer functions', () => {
  let intervalReceiver;
  let clearReceiver;
  function strictSetInterval() { intervalReceiver = this; return 7; }
  function strictClearInterval() { clearReceiver = this; }
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send() {}
    close() {}
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: FakeWebSocket,
    storage: memoryStorage(),
    documentImpl: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setIntervalImpl: strictSetInterval,
    clearIntervalImpl: strictClearInterval,
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  const socket = client.connect();
  socket.listeners.get('open')();
  client.stop();
  assert.equal(intervalReceiver, globalThis);
  assert.equal(clearReceiver, globalThis);
});

test('OnlineRoomClient invokes browser fetch with the global receiver', async () => {
  let receiver;
  async function strictFetch() {
    receiver = this;
    return {
      ok: true,
      async json() {
        return {
          roomId: ROOM_ID,
          sessionToken: TOKEN,
          inviteToken: 'I'.repeat(43),
          role: 'host',
          color: 'w',
          state: validState(),
        };
      },
    };
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    fetchImpl: strictFetch,
    storage: memoryStorage(),
  });

  await client.create({ playerName: 'Host' });
  assert.equal(receiver, globalThis);
});

test('OnlineRoomClient uses bounded exponential reconnect with jitter and stops after its cap', () => {
  const delays = [];
  const states = [];
  class ClosingWebSocket {
    static OPEN = 1;
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    close() {}
    send() {}
    fail() { this.listeners.get('close')?.({ code: 1006 }); }
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: ClosingWebSocket,
    storage: memoryStorage(),
    maxReconnectAttempts: 3,
    setTimeoutImpl(callback, delay) { delays.push(delay); callback(); return delays.length; },
    onConnectionState: (state) => states.push(state),
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  client.connect();

  for (let index = 0; index < 4; index += 1) client.socket.fail();
  // Base 500/1000/2000 with ±20% jitter.
  assert.equal(delays.length, 3);
  assert.ok(delays[0] >= 400 && delays[0] <= 600, `delay 0 = ${delays[0]}`);
  assert.ok(delays[1] >= 800 && delays[1] <= 1_200, `delay 1 = ${delays[1]}`);
  assert.ok(delays[2] >= 1_600 && delays[2] <= 2_400, `delay 2 = ${delays[2]}`);
  assert.equal(states.at(-1), 'failed');
});

test('terminal close codes never schedule a reconnect', () => {
  const cases = [
    { code: 4001, expectedState: 'replaced' },
    { code: 4003, expectedState: 'unauthorized' },
    { code: 4004, expectedState: 'expired' },
  ];
  for (const { code, expectedState } of cases) {
    let scheduled = 0;
    const states = [];
    class ClosingWebSocket {
      static OPEN = 1;
      constructor() { this.listeners = new Map(); }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      close() {}
      send() {}
      drop() { this.listeners.get('close')?.({ code }); }
    }
    const client = new OnlineRoomClient({
      apiUrl: 'https://rooms.example.workers.dev',
      WebSocketImpl: ClosingWebSocket,
      storage: memoryStorage(),
      setTimeoutImpl() { scheduled += 1; return 1; },
      onConnectionState: (state) => states.push(state),
    });
    client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
    client.connect();
    client.socket.drop();

    assert.equal(scheduled, 0, `code ${code} must not reconnect`);
    assert.equal(states.at(-1), expectedState);
    client.stop();
  }
});

test('reconnect() retries after a terminal failure and resets the attempt budget', () => {
  const delays = [];
  const states = [];
  const timers = [];
  class ClosingWebSocket {
    static OPEN = 1;
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    close() {}
    send() {}
    fail() { this.listeners.get('close')?.({ code: 1006 }); }
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: ClosingWebSocket,
    storage: memoryStorage(),
    maxReconnectAttempts: 1,
    setTimeoutImpl(callback, delay) { delays.push(delay); timers.push(callback); return timers.length; },
    clearTimeoutImpl() {},
    onConnectionState: (state) => states.push(state),
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  client.connect();
  assert.equal(states.at(-1), 'connecting');

  client.socket.fail();
  assert.equal(states.at(-1), 'reconnecting');
  timers.shift()(); // fire the pending reconnect -> second socket
  client.socket.fail();
  assert.equal(states.at(-1), 'failed');

  client.reconnect();
  assert.equal(client.socket instanceof ClosingWebSocket, true);
  assert.equal(states.at(-1), 'connecting');
  client.stop();
});

test('HTTP create/join/watch snapshots are validated like socket snapshots', async () => {
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { this.listeners = new Map(); }
    addEventListener() {}
    close() {}
    send() {}
  }
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    WebSocketImpl: FakeWebSocket,
    storage: memoryStorage(),
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          return { roomId: ROOM_ID, sessionToken: TOKEN, role: 'host', color: 'w', state: validState({ turn: 'green' }) };
        },
      };
    },
  });

  await assert.rejects(
    () => client.create({ playerName: 'Host' }),
    /ไม่ตรงโปรโตคอล/u,
  );
  assert.equal(client.state, null);
});

test('a finished snapshot clears the persisted session shortcut', async () => {
  const storage = memoryStorage();
  const client = new OnlineRoomClient({
    apiUrl: 'https://rooms.example.workers.dev',
    storage,
    WebSocketImpl: class {
      static OPEN = 1;
      constructor() { this.listeners = new Map(); }
      addEventListener() {}
      close() {}
      send() {}
    },
  });
  client.useSession(ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  assert.notEqual(storage.getItem(`chess-arena-online-session:${ROOM_ID}`), null);

  client._rememberState(validState({
    status: 'finished',
    result: '1-0',
    reason: 'checkmate',
    serverTime: 5_000,
  }));

  assert.equal(storage.getItem(`chess-arena-online-session:${ROOM_ID}`), null);
  assert.ok(Math.abs(client.now() - 5_000) < 5_000, 'serverTime seeds the offset');
});

test('validateServerMessage checks the clock subtree shape and tolerates serverTime', () => {
  assert.equal(validateServerMessage(validState({ clock: { initialMs: 1 } })).ok, false);
  assert.equal(validateServerMessage(validState({ clock: { initialMs: -1, incrementMs: 0, whiteMs: 1, blackMs: 1, activeSince: null } })).ok, false);
  assert.equal(validateServerMessage(validState({ clock: { initialMs: 1, incrementMs: 0, whiteMs: 1, blackMs: 1, activeSince: 'soon' } })).ok, false);
  assert.equal(validateServerMessage(validState({ serverTime: 'now' })).ok, false);
  const withClock = validState({
    clock: { initialMs: 60_000, incrementMs: 1_000, whiteMs: 59_000, blackMs: 60_000, activeSince: 1_000 },
    serverTime: 2_000,
  });
  assert.deepEqual(validateServerMessage(withClock), { ok: true, value: withClock });
});
