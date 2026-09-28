import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { Window } from 'happy-dom';

import { Controller, MODES } from '../src/controller.js';
import { sounds } from '../src/sounds.js';

class FakeWorker {
  static latest = null;
  constructor() {
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.latest = this;
  }
  postMessage(cmd) {
    const line = String(cmd);
    this.messages.push(line);
    if (line === 'uci') this.onmessage?.({ data: 'uciok' });
    if (line === 'isready') this.onmessage?.({ data: 'readyok' });
  }
  terminate() { this.terminated = true; }
  finish(pvUci, scoreCp) {
    this.onmessage?.({
      data: `info depth 10 multipv 1 score cp ${scoreCp} nodes 1 nps 1 time 1 pv ${pvUci.join(' ')}`,
    });
    this.onmessage?.({ data: `bestmove ${pvUci[0]}` });
  }
}

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
    afk: null,
    hostColor: 'w',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function makeHarness() {
  const calls = { moves: [], logs: [], ground: [], stopped: 0, rematch: [], actionStrip: [] };
  const ui = new Proxy({
    log(message, level) { calls.logs.push([message, level]); },
    renderMoves(moves) { calls.renderedMoves = moves; },
    setPlayers(top, bottom) { calls.players = [top, bottom]; },
    setAfkWarning(value) { calls.afk = value; },
    setActionStrip(opts) { calls.actionStrip.push(opts); },
    showGameOver(title, detail, onNewGame, onHome, onReview, rematch) {
      calls.gameOver = [title, detail];
      calls.gameOverRematch = rematch;
      calls.gameOverRenders = (calls.gameOverRenders ?? 0) + 1;
      const overlay = { body: { isConnected: true }, close() { overlay.body.isConnected = false; } };
      return overlay;
    },
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
    requestRematch(...args) { calls.rematch.push(['request', ...args]); },
    acceptRematch(...args) { calls.rematch.push(['accept', ...args]); },
    declineRematch(...args) { calls.rematch.push(['decline', ...args]); },
    stop() { calls.stopped += 1; },
  };
  const controller = new Controller({
    ui,
    ground,
    onPromotion: async () => 'q',
    gameOverDelayMs: 0, // popup must appear synchronously for assertions
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

test('online AFK snapshots render the authoritative countdown and clear it on recovery', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });

  controller._onOnlineState(stateAfter([], {
    revision: 2,
    afk: {
      strikes: { w: 1, b: 0 },
      countdown: { color: 'w', cause: 'hidden', deadlineAt: Date.now() + 40_000 },
    },
  }));
  assert.equal(calls.afk.visible, true);
  assert.match(calls.afk.title, /คุณกำลังถูกนับ AFK/u);
  assert.ok(calls.afk.remainingSeconds >= 39 && calls.afk.remainingSeconds <= 40);

  controller._onOnlineState(stateAfter([], {
    revision: 3,
    afk: { strikes: { w: 1, b: 0 }, countdown: null },
  }));
  assert.deepEqual(calls.afk, { visible: false });
  controller.dispose();
});

test('all AFK adjudications use the AFK sound and explain the popup result', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const played = [];
  const originalPlay = sounds.play;
  sounds.play = (name) => played.push(name);
  t.after(() => { sounds.play = originalPlay; });

  for (const [reason, expectedDetail] of [
    ['opening_afk_timeout', 'ไม่เดินหมากทันเวลาในช่วงเปิดเกม'],
    ['unlimited_afk_timeout', 'หมดเวลานับถอยหลัง AFK'],
    ['unlimited_afk_strikes', 'AFK ครบ 3 ครั้ง'],
  ]) {
    const { controller, calls } = makeHarness();
    await controller.start(MODES.ONLINE, {
      action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
    });
    controller._onOnlineState(stateAfter([], {
      revision: 2,
      status: 'finished',
      result: '0-1',
      reason,
      afk: { strikes: { w: 2, b: 0 }, countdown: null },
    }));
    assert.equal(calls.gameOver[0], 'คุณแพ้');
    assert.match(calls.gameOver[1], new RegExp(expectedDetail, 'u'));
    controller.dispose();
  }
  assert.deepEqual(played, ['afk', 'afk', 'afk']);
});

test('spectators see a neutral result title instead of being called the loser', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'watch', roomId: ROOM_ID, playerName: 'Viewer', avatar: 'bishop',
  });
  controller._onOnlineState(stateAfter([], {
    revision: 2, status: 'finished', result: '1-0', reason: 'opening_afk_timeout', afk: null,
  }));
  assert.equal(calls.gameOver[0], 'เกมจบแล้ว');
  controller.dispose();
});

test('accepted rematch resets the finished online game and swaps sides (roadmap B)', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  assert.equal(controller.onlineSide, 'w');

  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation', revision: 2,
  }));
  assert.ok(calls.gameOver, 'game over card shown for the finished game');

  const reset = stateAfter([], { status: 'active', revision: 4, hostColor: 'b' });
  controller._onOnlineState(reset);
  assert.equal(controller.onlineSide, 'b', 'the rematch swaps my color');
  assert.equal(controller.orientation, 'black', 'board reorients to my new side (chessground spelling)');
  assert.equal(controller.game.fen(), reset.fen);
  assert.equal(controller._onlineRematch, null);

  const moved = stateAfter(['e2e4'], { revision: 5, hostColor: 'b' });
  controller._onOnlineState(moved);
  assert.equal(controller.game.fen(), moved.fen);
  controller.dispose();
});

test('finished online game exposes rematch request/accept actions (roadmap B)', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, client, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation', rematch: null, revision: 2,
  }));

  const request = controller._onlineRematchActions();
  assert.equal(request.mode, 'request');
  request.onRequest();
  assert.deepEqual(calls.rematch.at(-1), ['request', 2]);

  // Opponent counters with their own offer -> the card offers ACCEPT instead.
  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation',
    rematch: { requestedBy: 'b' }, revision: 3,
  }));
  const offer = controller._onlineRematchActions();
  assert.equal(offer.mode, 'accept');
  offer.onAccept();
  assert.deepEqual(calls.rematch.at(-1), ['accept', 3]);

  // Spectators never see rematch actions.
  const spectatorActions = (() => {
    const saved = controller.onlineRole;
    controller.onlineRole = 'spectator';
    try { return controller._onlineRematchActions(); } finally { controller.onlineRole = saved; }
  })();
  assert.equal(spectatorActions, null);
  assert.ok(client.requestRematch, 'client exposes the rematch API');
  controller.dispose();
});

test('spectator mode exposes the live-analysis toggle, player modes do not (roadmap C)', async (t) => {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Worker = FakeWorker;
  const layer = document.createElement('div');
  layer.id = 'review-badge-layer';
  document.body.appendChild(layer);
  const bar = document.createElement('div');
  bar.id = 'eval-bar';
  bar.innerHTML = '<div data-eval-fill></div><span data-eval-label></span>';
  document.body.appendChild(bar);
  sounds.play = () => {};

  const spectator = makeHarness();
  await spectator.controller.start(MODES.ONLINE, {
    action: 'watch', roomId: ROOM_ID, playerName: 'Viewer', avatar: 'bishop',
  });
  assert.equal(spectator.calls.actionStrip.at(-1).liveAnalysis, true);
  assert.ok(spectator.controller.spectatorEval, 'analysis session exists for spectators');

  assert.equal(spectator.controller.toggleSpectatorAnalysis(), true);
  assert.equal(spectator.controller.toggleSpectatorAnalysis(), false);
  spectator.controller.dispose();

  const player = makeHarness();
  await player.controller.start(MODES.HUMAN_VS_AI, {
    color: 'w', level: 1, timeControlId: 'unlimited',
  });
  assert.equal(player.calls.actionStrip.at(-1).liveAnalysis, false);
  assert.equal(player.controller.toggleSpectatorAnalysis(), null, 'players can never enable it');
  player.controller.dispose();
});

test('rematch offer re-renders the open game-over card with accept actions (P0-3)', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation', rematch: null, revision: 2,
  }));
  assert.equal(calls.gameOverRematch?.mode, 'request');
  const rendersAfterFirst = calls.gameOverRenders;

  // Opponent requests the rematch — the open card must re-render to ACCEPT.
  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation',
    rematch: { requestedBy: 'b' }, revision: 3,
  }));
  assert.equal(calls.gameOverRematch?.mode, 'accept', 'card re-rendered with the live offer');
  assert.equal(calls.gameOverRenders, rendersAfterFirst + 1);

  // A duplicate broadcast with the SAME rematch state must not re-render again.
  const rendersBefore = calls.gameOverRenders;
  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation',
    rematch: { requestedBy: 'b' }, revision: 3,
  }));
  assert.equal(calls.gameOverRenders, rendersBefore, 'same key does not re-render');
  controller.dispose();
});

test('spectator analysis is suppressed during review and resumes after (P1-1)', async (t) => {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Worker = FakeWorker;
  const layer = document.createElement('div');
  layer.id = 'review-badge-layer';
  document.body.appendChild(layer);
  const bar = document.createElement('div');
  bar.id = 'eval-bar';
  bar.innerHTML = '<div data-eval-fill></div><span data-eval-label></span>';
  document.body.appendChild(bar);
  sounds.play = () => {};

  const { controller } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'watch', roomId: ROOM_ID, playerName: 'Viewer', avatar: 'bishop',
  });
  controller.toggleSpectatorAnalysis(true);
  FakeWorker.latest.finish(['d2d4'], 40);
  const fill = document.querySelector('#eval-bar [data-eval-fill]');
  const heightWhileEnabled = fill.style.height;
  assert.ok(heightWhileEnabled, 'spectator analysis painted the bar');

  controller._reviewActive = true;
  controller._renderSpectatorAnalysis({ whiteCp: -500, whiteWinProb: 5, depth: 10, best: null, fen: START_FEN });
  assert.equal(fill.style.height, heightWhileEnabled, 'review owns the bar — no overwrite');

  controller._reviewActive = false;
  controller._spectatorAnalysisResume = true;
  controller._finishReviewSession();
  assert.equal(controller.spectatorEval.enabled, true, 'resumes after the review ends');
  controller.dispose();
});

test('rematch reset closes the review summary modal (P2)', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, calls } = makeHarness();
  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  controller._onOnlineState(stateAfter([], {
    status: 'finished', result: '0-1', reason: 'resignation', revision: 2,
  }));
  const closed = [];
  controller.reviewUI = {
    exitStepperMode() { closed.push('stepper'); },
    closeSummaryModal() { closed.push('summary'); },
    closeProgressModal() { closed.push('progress'); },
    hideEvalBar() { closed.push('bar'); },
  };
  controller._reviewActive = true;

  controller._onOnlineState(stateAfter([], { status: 'active', revision: 4, hostColor: 'b' }));
  assert.deepEqual(closed, ['summary', 'progress', 'stepper', 'bar'], 'no dead modals over the new game');
  controller.dispose();
});
