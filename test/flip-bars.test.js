// Flipping the board must move everything that lives in the top/bottom player
// bars with it. Regression: only the board and (on the next tick) the clocks
// flipped, so "คุณ (ฝ่ายขาว)" ended up showing Black's clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { Controller, MODES } from '../src/controller.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ID = 'abcdefgh23456722';

function makeHarness({ onlineState = null } = {}) {
  const rec = { players: null, clocks: {}, active: {}, captured: {}, score: {} };
  const ui = new Proxy({
    setPlayers(top, bottom) { rec.players = { top, bottom }; },
    setClock(side, text, active) { rec.clocks[side] = { text, active }; },
    setPlayerActive(side, active) { rec.active[side] = active; },
    setScore(side, text) { rec.score[side] = text; },
    setCaptured(side, roles) { rec.captured[side] = roles.join(''); },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return () => {};
    },
  });
  const ground = {
    state: { dom: { bounds: { clear() {} } } },
    set(value) { if (value.orientation) rec.orientation = value.orientation; },
    setShapes() {},
  };
  const client = {
    session: null,
    state: null,
    async create() {
      this.session = { sessionToken: 'A'.repeat(43), role: 'host', color: 'w' };
      this.state = onlineState;
      return { roomId: ROOM_ID, inviteToken: 'I'.repeat(43), ...this.session, state: this.state };
    },
    connect() {},
    stop() {},
  };
  const controller = new Controller({
    ui,
    ground,
    onPromotion: async () => 'q',
    gameOverDelayMs: 0,
    onlineClientFactory() { return client; },
  });
  return { controller, rec };
}

test('flip re-seats names, turn highlight and clocks together (local clock game)', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, rec } = makeHarness();
  t.after(() => controller.dispose());
  await controller.start(MODES.ANALYZE, { timeControlId: 'blitz_5_0' });

  // White at the bottom, White to move and White's clock running.
  assert.equal(rec.players.top.name, 'ฝ่ายดำ (มือคุณ)');
  assert.equal(rec.players.bottom.name, 'ฝ่ายขาว (มือคุณ)');
  assert.equal(rec.active.bottom, true);
  assert.equal(rec.clocks.bottom.active, true);

  controller.flip();

  assert.equal(rec.orientation, 'black');
  assert.equal(rec.players.top.name, 'ฝ่ายขาว (มือคุณ)', 'White moved to the top bar');
  assert.equal(rec.players.bottom.name, 'ฝ่ายดำ (มือคุณ)');
  assert.equal(rec.active.top, true, 'turn highlight followed White to the top');
  assert.equal(rec.active.bottom, false);
  assert.equal(rec.clocks.top.active, true, 'running clock sits next to White');
  assert.equal(rec.clocks.bottom.active, false);

  controller.flip();
  assert.equal(rec.players.bottom.name, 'ฝ่ายขาว (มือคุณ)');
  assert.equal(rec.active.bottom, true);
});

test('flip swaps the captured-piece rows with the bars', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, rec } = makeHarness();
  t.after(() => controller.dispose());
  await controller.start(MODES.ANALYZE, {
    timeControlId: 'unlimited',
    initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  });
  // 1.e4 d5 2.exd5 — White has captured one pawn.
  for (const [from, to] of [['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5']]) {
    await controller.handleUserMove(from, to);
  }
  assert.equal(rec.captured.bottom, 'p', 'White (bottom) shows its captured pawn');
  assert.equal(rec.captured.top, '');
  assert.equal(rec.score.bottom, '1+');

  controller.flip();

  assert.equal(rec.captured.top, 'p', 'the pawn row moved with White');
  assert.equal(rec.captured.bottom, '');
  assert.equal(rec.score.top, '1+');
  assert.equal(rec.score.bottom, '');
});

test('online flip re-seats the player bars and the server clocks', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const game = new Chess();
  const state = {
    protocol: 'chess-arena-online',
    version: 1,
    type: 'state',
    roomId: ROOM_ID,
    title: 'Test room',
    revision: 1,
    status: 'waiting', // clock frozen: deterministic text, no interval
    initialFen: START_FEN,
    fen: game.fen(),
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
    visibility: 'public',
    allowSpectators: true,
    spectators: [],
    spectatorCount: 0,
    clock: { whiteMs: 60_000, blackMs: 30_000, activeSince: null },
    afk: null,
    hostColor: 'w',
    expiresAt: Date.now() + 60_000,
  };
  const { controller, rec } = makeHarness({ onlineState: state });
  t.after(() => controller.dispose());
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'blitz_5_0',
  });

  assert.equal(rec.players.bottom.name, 'Host');
  assert.equal(rec.clocks.bottom.text, '1:00');
  assert.equal(rec.clocks.top.text, '0:30');

  controller.flip();

  assert.equal(rec.players.top.name, 'Host', 'own name moved to the top bar');
  assert.equal(rec.players.bottom.name, 'Guest');
  assert.equal(rec.clocks.top.text, '1:00', "Host's clock sits next to Host's name");
  assert.equal(rec.clocks.bottom.text, '0:30');
});
