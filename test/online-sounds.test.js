// Online games used to be silent: move/capture/check sounds only lived in
// _afterMove, which the online path never runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { Controller, MODES } from '../src/controller.js';
import { sounds } from '../src/sounds.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ID = 'abcdefgh23456722';

function stateAfter(moves = [], overrides = {}) {
  const game = new Chess();
  for (const uci of moves) game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return {
    protocol: 'chess-arena-online',
    version: 1,
    type: 'state',
    roomId: ROOM_ID,
    title: 'Test room',
    revision: 1 + moves.length,
    status: 'active',
    initialFen: START_FEN,
    fen: game.fen(),
    turn: game.turn(),
    lastMove: null,
    lastMoveSan: null,
    moves,
    result: null,
    reason: null,
    players: {
      w: { name: 'Host', avatar: 'knight', connected: true },
      b: { name: 'Guest', avatar: 'rook', connected: true },
    },
    visibility: 'public',
    allowSpectators: true,
    spectators: [],
    spectatorCount: 0,
    clock: null,
    afk: null,
    hostColor: 'w',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

async function startOnline(t, initial) {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const played = [];
  const originalPlay = sounds.play;
  sounds.play = (name) => played.push(name);
  t.after(() => { sounds.play = originalPlay; });

  const ui = new Proxy({}, { get: () => () => {} });
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {} };
  const client = {
    session: null,
    state: null,
    async create() {
      this.session = { sessionToken: 'A'.repeat(43), role: 'host', color: 'w' };
      this.state = initial;
      return { roomId: ROOM_ID, inviteToken: 'I'.repeat(43), ...this.session, state: this.state };
    },
    connect() {},
    stop() {},
  };
  const controller = new Controller({
    ui, ground, onPromotion: async () => 'q', gameOverDelayMs: 0, onlineClientFactory() { return client; },
  });
  t.after(() => controller.dispose());
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  return { controller, played };
}

test('joining or resuming a game with moves already played stays silent', async (t) => {
  const { played } = await startOnline(t, stateAfter(['e2e4', 'e7e5']));
  assert.deepEqual(played, []);
});

test('a new ply plays move / capture / check, a repeated snapshot does not', async (t) => {
  const { controller, played } = await startOnline(t, stateAfter());

  controller._onOnlineState(stateAfter(['e2e4']));
  assert.deepEqual(played, ['move']);

  controller._onOnlineState(stateAfter(['e2e4']));
  assert.deepEqual(played, ['move'], 'same ply again is not a new move');

  controller._onOnlineState(stateAfter(['e2e4', 'd7d5', 'e4d5']));
  assert.deepEqual(played, ['move', 'capture'], 'catching up several plies makes one sound for the latest');

  // 1.e4 e5 2.Qh5 Nc6 3.Qxf7+ — capture that also gives check.
  const { controller: c2, played: p2 } = await startOnline(t, stateAfter());
  c2._onOnlineState(stateAfter(['e2e4', 'e7e5', 'd1h5', 'b8c6']));
  p2.length = 0;
  c2._onOnlineState(stateAfter(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5f7']));
  assert.deepEqual(p2, ['capture', 'check']);
});

test('a game-ending move leaves the sound to the result announcement', async (t) => {
  const { controller, played } = await startOnline(t, stateAfter(['f2f3', 'e7e5', 'g2g4']));
  played.length = 0;
  controller._onOnlineState(stateAfter(['f2f3', 'e7e5', 'g2g4', 'd8h4'], {
    status: 'finished', result: '0-1', reason: 'checkmate',
  }));
  assert.ok(!played.includes('move') && !played.includes('check'), `unexpected move sounds: ${played}`);
  assert.deepEqual(played, ['lose']);
});

test('a rematch reset and later moves do not replay stale sounds', async (t) => {
  const { controller, played } = await startOnline(t, stateAfter(['e2e4']));
  controller._onOnlineState(stateAfter(['e2e4', 'e7e5']));
  assert.deepEqual(played, ['move']);

  played.length = 0;
  controller._onOnlineState(stateAfter([], { revision: 10 })); // reset to move 0
  assert.deepEqual(played, [], 'reset itself is silent');
  controller._onOnlineState(stateAfter(['d2d4'], { revision: 11 }));
  assert.deepEqual(played, ['move'], 'first move of the new game is heard');
});

test('a takeback is heard as a move, a rematch reset is not', async (t) => {
  const { controller, played } = await startOnline(t, stateAfter(['e2e4']));
  controller._onOnlineState(stateAfter(['e2e4', 'e7e5'], { revision: 3 }));
  played.length = 0;
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 4 })); // black's e5 taken back
  assert.deepEqual(played, ['move']);
});
