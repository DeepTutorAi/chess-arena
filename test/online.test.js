import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OnlineRoomClient,
  buildInviteUrl,
  getOnlineApiUrl,
  loadRoomSession,
  parseInviteLocation,
  saveRoomSession,
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
      w: { name: 'Host', connected: true },
      b: { name: 'Guest', connected: true },
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

test('room sessions are isolated by room and validated when loaded', () => {
  const storage = memoryStorage();
  saveRoomSession(storage, ROOM_ID, { sessionToken: TOKEN, role: 'host', color: 'w' });
  saveRoomSession(storage, 'bcdefghi23456723', { sessionToken: 'B'.repeat(43), role: 'guest', color: 'b' });

  assert.deepEqual(loadRoomSession(storage, ROOM_ID), { sessionToken: TOKEN, role: 'host', color: 'w' });
  assert.equal(loadRoomSession(storage, 'cdefghij23456724'), null);
  storage.setItem(`chess-arena-online-session:${ROOM_ID}`, '{broken');
  assert.equal(loadRoomSession(storage, ROOM_ID), null);
});

test('validateServerMessage accepts canonical snapshots and rejects malformed authority', () => {
  assert.deepEqual(validateServerMessage(validState()), { ok: true, value: validState() });
  assert.equal(validateServerMessage(validState({ revision: -1 })).ok, false);
  assert.equal(validateServerMessage(validState({ turn: 'green' })).ok, false);
  assert.equal(validateServerMessage(validState({ players: {} })).ok, false);
  assert.deepEqual(validateServerMessage({ type: 'error', code: 'wrong_turn', message: 'wait', revision: 2 }), {
    ok: true,
    value: { type: 'error', code: 'wrong_turn', message: 'wait', revision: 2 },
  });
});

test('getOnlineApiUrl uses an explicit endpoint or the production page origin', () => {
  assert.equal(getOnlineApiUrl({ VITE_ONLINE_API_URL: 'https://rooms.example.workers.dev/' }), 'https://rooms.example.workers.dev');
  assert.equal(getOnlineApiUrl({}, { protocol: 'https:', origin: 'https://chess.example.workers.dev' }), 'https://chess.example.workers.dev');
  assert.equal(getOnlineApiUrl({}, { protocol: 'http:', origin: 'http://localhost:5173' }), '');
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

test('OnlineRoomClient uses bounded exponential reconnect and stops after its cap', () => {
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
  assert.deepEqual(delays, [500, 1_000, 2_000]);
  assert.equal(states.at(-1), 'failed');
});
