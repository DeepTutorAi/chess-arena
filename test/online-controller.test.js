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
    setStatus(text, tone) { calls.status = [text, tone]; },
    setActionStrip(opts) { calls.actionStrip.push(opts); },
    showGameOver(title, detail, onNewGame, onHome, onReview, rematch, onRestore, outcome) {
      calls.gameOver = [title, detail];
      calls.gameOverRematch = rematch;
      calls.gameOverOutcome = outcome;
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

test('offline resignation ends the game: no engine reply, no further moves, AI vs AI cannot resign', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.Worker = FakeWorker;
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });

  const { controller, calls } = makeHarness();
  t.after(() => controller.dispose());
  await controller.start(MODES.HUMAN_VS_AI, { color: 'w', level: 4, timeControlId: 'unlimited' });
  const engineWorker = FakeWorker.latest;

  await controller.handleUserMove('e2', 'e4');
  assert.ok(controller._aiTimer, 'engine reply is pending in its think delay');

  controller.resign();
  assert.equal(controller._isOver(), true, 'resignation is a finished game');
  assert.equal(controller._aiTimer, null, 'pending engine think is cancelled');
  assert.equal(calls.ground.at(-1).movable.color, false, 'board is locked after resigning');
  assert.equal(calls.gameOver[0], 'ยอมแพ้! ฝ่ายดำชนะ');
  assert.match(calls.gameOver[1], /^ฝ่ายขาวยอมแพ้ \(0-1\)/u);

  const fenAfterResign = controller.game.fen();
  engineWorker.onmessage({ data: 'bestmove e7e5' }); // late reply to the stopped search
  assert.equal(controller.game.fen(), fenAfterResign, 'a late engine move is not played');
  await controller.handleUserMove('d2', 'd4');
  assert.equal(controller.game.fen(), fenAfterResign, 'the human cannot keep moving');

  // A new game clears the resignation.
  await controller.start(MODES.ANALYZE, {});
  assert.equal(controller._isOver(), false);

  await controller.start(MODES.AI_VS_AI, { levelWhite: 2, levelBlack: 2, timeControlId: 'unlimited' });
  calls.gameOver = undefined;
  controller.resign();
  assert.equal(controller._isOver(), false, 'nobody resigns in AI vs AI');
  assert.equal(calls.gameOver, undefined);
});

test('undo after a game end cancels the pending game-over card and keeps the game playable', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });

  const { controller, calls } = makeHarness();
  t.after(() => controller.dispose());
  controller._gameOverDelayMs = 30;
  await controller.start(MODES.ANALYZE, {});
  for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    await controller.handleUserMove(from, to);
  }
  assert.equal(controller.game.isCheckmate(), true);
  assert.ok(controller._gameOverDelayTimer, 'the result card is waiting for its delay');

  await controller.undo();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.gameOver, undefined, 'no stale result card pops over the resumed game');
  assert.equal(controller._isOver(), false);
  assert.equal(controller._lastGameOver, null);
});

test('undo after a flag-fall restores the clock instead of flagging again', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });

  const { controller } = makeHarness();
  t.after(() => controller.dispose());
  await controller.start(MODES.ANALYZE, { timeControlId: 'bullet_1_0' });
  await controller.handleUserMove('e2', 'e4');
  await controller.handleUserMove('e7', 'e5');
  const afterWhiteMove = { ...controller._clockSnapshots.find((s) => s.ply === 1) };

  controller.clock.times.w = 0; // white's time drains on move 2...
  controller.clock._tick(); // ...and the next tick flags it
  assert.equal(controller._isTimeout, true);
  assert.ok(controller._gameOverOverlay, 'the timeout card is shown');

  await controller.undo();
  assert.equal(controller._isOver(), false);
  assert.equal(controller._gameOverOverlay, null, 'the stale card is closed');
  assert.equal(controller.clock.times.w, afterWhiteMove.w, 'white gets back the time it had at that position');
  assert.equal(controller.clock.times.b, afterWhiteMove.b);
  controller.clock._tick();
  assert.equal(controller._isTimeout, false, 'the restored clock does not flag immediately');
  assert.deepEqual(controller._clockSnapshots.map((s) => s.ply), [1], 'snapshots past the restored ply are dropped');
});

test('resuming a hosted room restores the invite links for Share', async () => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  const { controller, client } = makeHarness();
  // The saved host session, as OnlineRoomClient.restoreSession loads it.
  client.restoreSession = (roomId) => {
    client.session = {
      sessionToken: TOKEN, role: 'host', color: 'w', inviteToken: 'I'.repeat(43), watchInviteToken: 'W'.repeat(43),
    };
    return roomId === ROOM_ID;
  };
  await controller.start(MODES.ONLINE, { action: 'resume', roomId: ROOM_ID });
  assert.equal(controller.onlineInviteToken, 'I'.repeat(43));
  assert.equal(controller.onlineWatchInviteToken, 'W'.repeat(43));
  controller.dispose();
});

test('leaving mid-game warns only when something is at stake', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.Worker = FakeWorker;
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });

  const { controller } = makeHarness();
  t.after(() => controller.dispose());

  await controller.start(MODES.HUMAN_VS_AI, { color: 'w', level: 4, timeControlId: 'unlimited' });
  assert.equal(controller.leaveGameWarning(), null, 'no move played yet: nothing to lose');
  await controller.handleUserMove('e2', 'e4');
  assert.ok(controller.leaveGameWarning(), 'a started bot game warns before it is abandoned');
  controller.resign();
  assert.equal(controller.leaveGameWarning(), null, 'a finished game can be left freely');

  await controller.start(MODES.AI_VS_AI, { levelWhite: 2, levelBlack: 2, timeControlId: 'unlimited' });
  assert.equal(controller.leaveGameWarning(), null, 'watching AI vs AI costs nothing');

  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  assert.match(controller.leaveGameWarning(), /ออกจากห้อง/u, 'an active online seat warns');
  controller._onOnlineState(stateAfter(['e2e4'], { status: 'finished', result: '1-0', reason: 'resignation' }));
  assert.equal(controller.leaveGameWarning(), null);
});

test('the game-over card is coloured from the player side: loss, win, or neutral', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.Worker = FakeWorker;
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });

  const { controller, calls } = makeHarness();
  t.after(() => controller.dispose());

  await controller.start(MODES.HUMAN_VS_AI, { color: 'w', level: 4, timeControlId: 'unlimited' });
  await controller.handleUserMove('e2', 'e4');
  controller.resign();
  assert.equal(calls.gameOverOutcome, 'loss', 'resigning is shown as a loss, not in winner green');

  await controller.start(MODES.ANALYZE, {});
  for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    await controller.handleUserMove(from, to);
  }
  assert.equal(calls.gameOverOutcome, null, 'sandbox play has no "you", so the card stays neutral');

  await controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  controller._onOnlineState(stateAfter(['e2e4'], { status: 'finished', result: '1-0', reason: 'resignation' }));
  assert.equal(calls.gameOverOutcome, 'win', 'the white host won 1-0');
});

test('the status bar tone follows the game from the player side', async (t) => {
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.Worker = FakeWorker;
  const originalPlay = sounds.play;
  sounds.play = () => {};
  t.after(() => { sounds.play = originalPlay; });

  const bot = makeHarness();
  t.after(() => bot.controller.dispose());
  await bot.controller.start(MODES.HUMAN_VS_AI, { color: 'w', level: 4, timeControlId: 'unlimited' });
  await bot.controller.handleUserMove('e2', 'e4');
  assert.equal(bot.calls.status[1], 'thinking', 'the engine is thinking');
  bot.controller.resign();
  assert.equal(bot.calls.status[1], 'loss', 'resigning shows the loss tone');

  const host = makeHarness();
  t.after(() => host.controller.dispose());
  await host.controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  // The connect message replaces the status once; the next snapshot restores it.
  host.controller._onOnlineState(stateAfter([]));
  assert.equal(host.calls.status[1], 'turn', 'the white host moves first');
  host.controller._onOnlineState(stateAfter(['e2e4'], { status: 'finished', result: '1-0', reason: 'resignation' }));
  assert.equal(host.calls.status[1], 'win');

  const drawn = makeHarness();
  t.after(() => drawn.controller.dispose());
  await drawn.controller.start(MODES.ONLINE, {
    action: 'create', playerName: 'Host', title: 'Test', color: 'w', timeControlId: 'unlimited',
  });
  drawn.controller._onOnlineState(stateAfter(['e2e4'], { status: 'finished', result: '1/2-1/2', reason: 'agreement' }));
  assert.equal(drawn.calls.status[1], 'draw');

  const sandbox = makeHarness();
  t.after(() => sandbox.controller.dispose());
  await sandbox.controller.start(MODES.ANALYZE, {});
  for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    await sandbox.controller.handleUserMove(from, to);
  }
  assert.equal(sandbox.calls.status[1], '', 'nobody plays from this screen, so no outcome tone');
});
