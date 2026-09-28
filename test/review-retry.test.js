// Retry Mistake — simulation behavior tests (round 3 redesign).
// A wrong retry move must STAY on the board while the engine answers it
// visibly, and the user must be able to keep playing the simulated line.
// happy-dom + a fake Stockfish worker; no real engine or chessground.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Chess } from 'chess.js';

import { ReviewUI } from '../src/review-ui.js';
import { sounds } from '../src/sounds.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reply lands after the "see your own move first" beat.
const REPLY_BEAT_MS = 1200;

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
    // Real worker echoes readiness, which arms Stockfish.onReady -> first search.
    if (line === 'uci') this.onmessage?.({ data: 'uciok' });
    if (line === 'isready') this.onmessage?.({ data: 'readyok' });
  }
  terminate() {
    this.terminated = true;
  }
  /** Simulate the engine finishing one search. */
  finish(pvUci, scoreCp) {
    this.onmessage?.({
      data: `info depth 12 seldepth 15 multipv 1 score cp ${scoreCp} nodes 10000 nps 300000 time 33 pv ${pvUci.join(' ')}`,
    });
    this.onmessage?.({ data: `bestmove ${pvUci[0]}` });
  }
}

function basePly(ply, move) {
  return {
    ply,
    color: move.color,
    san: move.san,
    from: move.from,
    to: move.to,
    captured: null,
    fenAfter: '',
    turnAfter: move.color === 'w' ? 'b' : 'w',
    bestMove: null,
    bestSan: null,
    reply: null,
    replySan: null,
    tier: 'best',
    deltaW: 0,
    cpLoss: 0,
    bestEvalCp: 0,
  };
}

/** 1.e4 e5 2.Qh5 Nc6 3.Bc4 — black's 4th move (Nf6??) is the blunder; best
 *  was Qe7. Returns the analysis shape ReviewUI consumes. */
function buildAnalysis() {
  const game = new Chess();
  const fens = [game.fen()];
  const plies = [];
  for (const san of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4']) {
    const move = game.move(san);
    fens.push(game.fen());
    plies.push(basePly(plies.length, move));
  }
  const beforeFen = game.fen();
  const mistake = game.move('Nf6');
  fens.push(game.fen());
  plies.push({
    ...basePly(5, mistake),
    tier: 'blunder',
    deltaW: 34.5,
    cpLoss: 850,
    bestMove: { from: 'd8', to: 'e7' },
    bestSan: 'Qe7',
    reply: { from: 'h5', to: 'f7' },
    replySan: 'Qxf7#',
  });
  return {
    analysis: {
      initialFen: fens[0],
      fens,
      plies,
      positions: fens.map((fen, j) => ({
        ply: j,
        fen,
        turn: j % 2 ? 'b' : 'w',
        whiteWinProb: 50,
        whiteEvalCp: 0,
        clock: null,
        pvSan: [],
      })),
      accuracy: { w: 90, b: 40 },
      counts: { w: {}, b: {} },
      players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
    },
    beforeFen,
    plyIndex: 5,
  };
}

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Worker = FakeWorker;
  FakeWorker.latest = null;
  const layer = document.createElement('div');
  layer.id = 'review-badge-layer';
  document.body.appendChild(layer);
  sounds.play = () => {};
  return window;
}

function buildController() {
  const sets = [];
  const sidebar = document.createElement('div');
  sidebar.innerHTML = '<div class="sidebar-header"></div><div class="sidebar-content"></div><div class="action-strip"></div>';
  document.body.appendChild(sidebar);
  const controller = {
    ui: {
      refs: { gameSidebar: sidebar },
      showClocks: () => {},
      setClock: () => {},
      log: () => {},
    },
    ground: {
      set: (cfg) => sets.push(cfg),
      setAutoShapes: () => {},
    },
    orientation: 'white',
    flip: () => {},
    exitReview: () => {},
    onPromotion: async () => 'q',
  };
  return { controller, sets };
}

function coachCard() {
  return document.querySelector('[data-coach]');
}

test('wrong retry move stays on the board and the simulated opponent answers with mate', async (t) => {
  setup(t);
  const { analysis, beforeFen, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const review = new ReviewUI();
  review.enterStepperMode(controller, analysis, plyIndex - 1);
  review.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  assert.equal(puzzle.fen, beforeFen);
  assert.equal(puzzle.movable.color, 'black');
  assert.ok(puzzle.movable.dests.get('g8')?.includes('f6'));

  await puzzle.movable.events.after('g8', 'f6');
  const landed = sets.at(-1);
  assert.equal(landed.fen, afterNf6(beforeFen), 'the wrong move must STAY on the board');
  assert.equal(landed.movable.color, false, 'board locked while the engine answers');

  const worker = FakeWorker.latest;
  assert.ok(worker, 'sim engine spawned for the consequence search');
  worker.finish(['h5f7'], 9999); // Qxf7#
  await sleep(REPLY_BEAT_MS);

  const answered = sets.at(-1);
  const mated = new Chess(afterNf6(beforeFen));
  mated.move({ from: 'h5', to: 'f7' });
  assert.equal(answered.fen, mated.fen(), 'the punishment move is played on the board');
  assert.deepEqual(answered.lastMove, ['h5', 'f7']);
  assert.equal(answered.movable.color, false, 'sim is over — board stays locked');
  assert.match(coachCard().textContent, /จบเกม|หมาจบ/u);
  review.exitStepperMode();
});

test('after a non-mating answer the user can keep exploring and each move gets an answer', async (t) => {
  setup(t);
  const { analysis, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const review = new ReviewUI();
  review.enterStepperMode(controller, analysis, plyIndex - 1);
  review.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  await puzzle.movable.events.after('g8', 'f6');
  FakeWorker.latest.finish(['h5f3'], 300); // Qf3 — strong but not mate
  await sleep(REPLY_BEAT_MS);

  const answered = sets.at(-1);
  assert.equal(answered.movable.color, 'black', 'board unlocked for continued exploration');
  assert.ok(answered.movable.dests.get('a7')?.includes('a6'));
  assert.match(coachCard().textContent, /ตอบ/u);
  assert.match(coachCard().textContent, /Qf3/u);

  await answered.movable.events.after('a7', 'a6');
  const next = new Chess(answered.fen);
  next.move({ from: 'a7', to: 'a6' });
  const thinking = sets.at(-1);
  assert.equal(thinking.fen, next.fen());
  assert.equal(thinking.movable.color, false);
  assert.ok(
    FakeWorker.latest.messages.includes(`position fen ${next.fen()}`),
    'each simulated move triggers a fresh engine search',
  );
  review.exitStepperMode();
});

test('finding the best move still resolves the retry with confirmation', async (t) => {
  setup(t);
  const { analysis, beforeFen, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const review = new ReviewUI();
  review.enterStepperMode(controller, analysis, plyIndex - 1);
  review.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  await puzzle.movable.events.after('d8', 'e7'); // the best move

  const solved = sets.at(-1);
  const afterBest = new Chess(beforeFen);
  afterBest.move({ from: 'd8', to: 'e7' });
  assert.equal(solved.fen, afterBest.fen(), 'the best move is shown on the board');
  assert.deepEqual(solved.lastMove, ['d8', 'e7']);
  assert.equal(solved.movable.color, false);
  assert.equal(FakeWorker.latest, null, 'no engine search needed on success');
  assert.match(coachCard().textContent, /ถูกต้อง/u);
  review.exitStepperMode();
});

test('restart returns to the pre-mistake position and re-arms the puzzle', async (t) => {
  setup(t);
  const { analysis, beforeFen, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const review = new ReviewUI();
  review.enterStepperMode(controller, analysis, plyIndex - 1);
  review.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  await puzzle.movable.events.after('g8', 'f6');
  FakeWorker.latest.finish(['h5f3'], 300);
  await sleep(REPLY_BEAT_MS);

  coachCard().querySelector('[data-restart]').click();
  const restarted = sets.at(-1);
  assert.equal(restarted.fen, beforeFen);
  assert.equal(restarted.movable.color, 'black');

  await restarted.movable.events.after('d8', 'e7');
  assert.match(coachCard().textContent, /ถูกต้อง/u, 'judging works again after restart');
  review.exitStepperMode();
});

test('cancel quits the sim engine and returns to the review ply', async (t) => {  setup(t);
  const { analysis, beforeFen, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const review = new ReviewUI();
  review.enterStepperMode(controller, analysis, plyIndex - 1);
  review.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  assert.equal(puzzle.fen, beforeFen);
  assert.equal(puzzle.movable.color, 'black');
  assert.ok(puzzle.movable.dests.get('g8')?.includes('f6'));
  assert.ok(coachCard().querySelector('[data-cancel]'), 'the puzzle phase always offers a way out');

  await puzzle.movable.events.after('g8', 'f6');
  const worker = FakeWorker.latest;
  assert.ok(worker);

  coachCard().querySelector('[data-cancel]').click();
  assert.equal(worker.terminated, true, 'sim engine worker is terminated on cancel');
  const restored = sets.at(-1);
  // The stepper's review view of ply 5 is the position AFTER the mistake.
  assert.equal(restored.fen, afterNf6(beforeFen), 'board returns to the reviewed ply');
  assert.equal(restored.movable.color, false, 'review board is locked again');
  review.exitStepperMode();
});

test('a crashed sim engine shows a system-error card and research respawns it (P1)', async (t) => {
  setup(t);
  const { analysis, beforeFen, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, analysis, plyIndex - 1);
  ui.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  await puzzle.movable.events.after('g8', 'f6');
  const first = FakeWorker.latest;
  assert.match(coachCard().textContent, /กำลังคำนวณ/u);

  first.onerror?.({ message: 'worker crashed' });
  assert.match(coachCard().textContent, /ขัดข้อง/u, 'system-error card replaces the spinner');
  assert.ok(first.terminated, 'crashed worker is disposed');
  assert.match(coachCard().textContent, /ไม่นับเป็นการเดินผิด/u);

  coachCard().querySelector('[data-research]').click();
  const second = FakeWorker.latest;
  assert.notEqual(second, first, 'research spawns a fresh worker');
  assert.ok(second.messages.includes(`position fen ${afterNf6(beforeFen)}`));
  assert.ok(second.messages.includes('go depth 12'));

  second.finish(['h5f3'], 300);
  await sleep(REPLY_BEAT_MS);
  assert.equal(sets.at(-1).movable.color, 'black', 'consequence flow works after research');
});

test('engine returning (none) is a system fault — not scored as a player mistake (P1)', async (t) => {
  setup(t);
  const { analysis, plyIndex } = buildAnalysis();
  const { controller, sets } = buildController();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, analysis, plyIndex - 1);
  ui.startRetryMistake(plyIndex);

  const puzzle = sets.at(-1);
  await puzzle.movable.events.after('g8', 'f6');
  FakeWorker.latest.finish(['(none)'], 0);
  assert.match(coachCard().textContent, /ขัดข้อง/u);
  assert.equal(sets.at(-1).movable.color, false, 'board stays locked while the error shows');
});

function afterNf6(beforeFen) {
  const game = new Chess(beforeFen);
  game.move({ from: 'g8', to: 'f6' });
  return game.fen();
}
