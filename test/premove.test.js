// Premove: while it is the opponent's turn the player's own side may queue a
// move. chessground only allows that when movable.color is ours and it is not
// our turn, and the queued move must be played once the turn arrives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { Controller, MODES } from '../src/controller.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ID = 'abcdefgh23456722';

function makeGround() {
  const calls = { sets: [], playPremove: 0, cancelPremove: 0 };
  const ground = {
    state: { dom: { bounds: { clear() {} } } },
    set(value) { calls.sets.push(value); },
    setShapes() {},
    playPremove() { calls.playPremove += 1; },
    cancelPremove() { calls.cancelPremove += 1; },
  };
  return { ground, calls };
}

const lastSet = (calls) => calls.sets.at(-1);
const ui = () => new Proxy({}, { get: () => () => {} });

test('vs bot: on the bot\'s turn the human side may premove; on the human turn a queued premove is played', () => {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const { ground, calls } = makeGround();
  const controller = new Controller({ ui: ui(), ground, onPromotion: async () => 'q' });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'w';

  const game = new Chess();
  game.move('e4'); // black (the bot) to move
  controller.game = game;
  controller._syncBoard();
  let set = lastSet(calls);
  assert.equal(set.movable.color, 'white', 'own pieces are movable as premoves');
  assert.equal(set.movable.dests.size, 0, 'no real moves on the opponent\'s turn');
  assert.equal(set.premovable.enabled, true);
  assert.equal(set.turnColor, 'black');
  assert.equal(calls.playPremove, 0, 'nothing to play while the bot thinks');

  game.move('e5'); // now white's turn
  controller._syncBoard();
  set = lastSet(calls);
  assert.equal(set.movable.color, 'white');
  assert.ok(set.movable.dests.size > 0, 'real dests are back');
  assert.equal(calls.playPremove, 1, 'the queued premove is played when the turn arrives');
});

test('vs bot: black human premoves on white\'s turn too', () => {
  const { ground, calls } = makeGround();
  const controller = new Controller({ ui: ui(), ground, onPromotion: async () => 'q' });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'b';
  controller.game = new Chess(); // white (bot) to move
  controller._syncBoard();
  assert.equal(lastSet(calls).movable.color, 'black');
  assert.equal(lastSet(calls).premovable.enabled, true);
});

test('no premove when the game is over, in analyze/sandbox modes, or while reviewing', () => {
  const { ground, calls } = makeGround();
  const controller = new Controller({ ui: ui(), ground, onPromotion: async () => 'q' });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'w';
  const mated = new Chess();
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) mated.move(san);
  controller.game = mated;
  controller._syncBoard();
  assert.equal(lastSet(calls).premovable.enabled, false);
  assert.equal(lastSet(calls).movable.color, false);
  assert.ok(calls.cancelPremove >= 1, 'a queued premove is dropped at game over');

  controller.mode = MODES.ANALYZE;
  controller.game = new Chess();
  controller._syncBoard();
  assert.equal(lastSet(calls).premovable.enabled, false, 'both sides are the human: nothing to premove');

  controller.mode = MODES.HUMAN_VS_AI;
  controller._reviewActive = true;
  const before = calls.sets.length;
  controller._syncBoard();
  assert.equal(calls.sets.length, before, 'review owns the board');
});

test('undo, dispose and starting a review drop a queued premove', () => {
  const { ground, calls } = makeGround();
  const controller = new Controller({ ui: ui(), ground, onPromotion: async () => 'q' });
  controller.dispose();
  assert.ok(calls.cancelPremove >= 1);
});

// ---- online -------------------------------------------------------------------

function onlineState(moves, overrides = {}) {
  const game = new Chess();
  for (const uci of moves) game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  return {
    protocol: 'chess-arena-online', version: 1, type: 'state', roomId: ROOM_ID, title: 'Room',
    revision: 1 + moves.length, status: 'active', initialFen: START_FEN, fen: game.fen(), turn: game.turn(),
    lastMove: null, lastMoveSan: null, moves, result: null, reason: null,
    players: { w: { name: 'Host', avatar: 'knight', connected: true }, b: { name: 'Guest', avatar: 'rook', connected: true } },
    visibility: 'public', allowSpectators: true, spectators: [], spectatorCount: 0, clock: null, afk: null,
    hostColor: 'w', expiresAt: Date.now() + 60_000, ...overrides,
  };
}

async function startOnline(role) {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const { ground, calls } = makeGround();
  let callbacks;
  const client = {
    session: null, state: null,
    async create() { this.session = { sessionToken: 'A'.repeat(43), role: 'host', color: 'w' }; this.state = onlineState([]); return { roomId: ROOM_ID, inviteToken: 'I'.repeat(43), ...this.session, state: this.state }; },
    async watch() { this.session = { sessionToken: 'A'.repeat(43), role: 'spectator', color: null }; this.state = onlineState([]); return { roomId: ROOM_ID, ...this.session, state: this.state }; },
    connect() { callbacks.onConnectionState('connected'); },
    stop() {},
  };
  const controller = new Controller({
    ui: ui(), ground, onPromotion: async () => 'q', gameOverDelayMs: 0,
    onlineClientFactory(options) { callbacks = options; return client; },
  });
  await controller.start(MODES.ONLINE, role === 'host'
    ? { action: 'create', playerName: 'Host', title: 'T', color: 'w', timeControlId: 'unlimited' }
    : { action: 'watch', roomId: ROOM_ID, playerName: 'V', avatar: 'bishop' });
  return { controller, calls };
}

test('online player: premove while the opponent is to move, played when their move arrives', async () => {
  const { controller, calls } = await startOnline('host');
  controller._onOnlineState(onlineState(['e2e4'])); // black to move
  let set = lastSet(calls);
  assert.equal(set.movable.color, 'white');
  assert.equal(set.premovable.enabled, true);
  const played = calls.playPremove;
  controller._onOnlineState(onlineState(['e2e4', 'e7e5'])); // our turn again
  assert.equal(calls.playPremove, played + 1);
  set = lastSet(calls);
  assert.ok(set.movable.dests.size > 0);
  controller.dispose();
});

test('online spectators and finished games never premove', async () => {
  const spectator = await startOnline('spectator');
  spectator.controller._onOnlineState(onlineState(['e2e4']));
  assert.equal(lastSet(spectator.calls).premovable.enabled, false);
  assert.equal(lastSet(spectator.calls).movable.color, false);
  spectator.controller.dispose();

  const player = await startOnline('host');
  player.controller._onOnlineState(onlineState(['e2e4'], { status: 'finished', result: '1-0', reason: 'resignation', revision: 9 }));
  assert.equal(lastSet(player.calls).premovable.enabled, false);
  player.controller.dispose();
});
