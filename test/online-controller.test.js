import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { Controller, MODES } from '../src/controller.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ID = 'abcdefgh23456722';
const TOKEN = 'A'.repeat(43);

function stateAfter(moves = [], overrides = {}) {
  const game = new Chess();
  let last = null;
  for (const uci of moves) {
    last = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
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
    lastMove: last ? last.from + last.to + (last.promotion ?? '') : null,
    lastMoveSan: last?.san ?? null,
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
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function makeHarness() {
  const calls = { moves: [], logs: [], ground: [], stopped: 0 };
  const ui = new Proxy({
    log(message, level) { calls.logs.push([message, level]); },
    renderMoves(moves) { calls.renderedMoves = moves; },
    setPlayers(top, bottom) { calls.players = [top, bottom]; },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return () => {};
    },
  });
  const ground = {
    state: { dom: { bounds: { clear() {} } } },
    set(value) { calls.ground.push(value); },
    setShapes() {},
  };
  let callbacks;
  const client = {
    session: null,
    state: null,
    async create() {
      this.session = { sessionToken: TOKEN, role: 'host', color: 'w' };
      this.state = stateAfter();
      return { roomId: ROOM_ID, inviteToken: 'I'.repeat(43), ...this.session, state: this.state };
    },
    async joinPublic() {
      this.session = { sessionToken: TOKEN, role: 'guest', color: 'b' };
      this.state = stateAfter();
      return { roomId: ROOM_ID, ...this.session, state: this.state };
    },
    async watch() {
      this.session = { sessionToken: TOKEN, role: 'spectator', color: null };
      this.state = stateAfter();
      return { roomId: ROOM_ID, ...this.session, state: this.state };
    },
    connect() { callbacks.onConnectionState('connected'); },
    sendMove(...args) { calls.moves.push(args); },
    resign() { calls.resigned = true; },
    stop() { calls.stopped += 1; },
  };
  const controller = new Controller({
    ui,
    ground,
    onPromotion: async () => 'q',
    onlineClientFactory(options) { callbacks = options; return client; },
  });
  return { controller, client, calls };
}

test('online mode sends move intent without committing local canonical state', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  assert.equal(calls.ground.at(-1).movable.color, 'white');
  assert.deepEqual(calls.players, [
    { name: 'Guest', avatar: '♜' },
    { name: 'Host', avatar: '♞' },
  ]);
  const before = controller.game.fen();

  await controller.handleUserMove('e2', 'e4');

  assert.equal(controller.game.fen(), before);
  assert.deepEqual(calls.moves, [['e2', 'e4', null, 1]]);
});

test('online mode commits only a newer canonical snapshot and locks the wrong side', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });

  const moved = stateAfter(['e2e4']);
  controller._onOnlineState(moved);
  assert.equal(controller.game.fen(), moved.fen);
  assert.deepEqual(calls.renderedMoves, ['e4']);

  controller._onOnlineState(stateAfter([], { revision: 1 }));
  assert.equal(controller.game.fen(), moved.fen, 'older snapshots must be ignored');

  await controller.handleUserMove('e7', 'e5');
  assert.equal(calls.moves.length, 0, 'white client cannot move black pieces');
});

test('online resignation waits for server authority and dispose stops transport', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });

  controller.resign();
  assert.equal(calls.resigned, true);
  assert.equal(controller._overPopupShown, false);

  controller.dispose();
  assert.equal(calls.stopped, 1);
});

test('spectator mode renders canonical snapshots with a locked board and no resign authority', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'watch', roomId: ROOM_ID, playerName: 'Viewer', avatar: 'bishop',
  });

  assert.equal(controller.onlineRole, 'spectator');
  assert.equal(controller.onlineSide, null);
  assert.equal(calls.ground.at(-1).movable.color, false);
  assert.deepEqual(calls.ground.at(-1).movable.dests, new Map());
  await controller.handleUserMove('e2', 'e4');
  assert.equal(calls.moves.length, 0);
  controller.resign();
  assert.equal(calls.resigned, undefined);
});
