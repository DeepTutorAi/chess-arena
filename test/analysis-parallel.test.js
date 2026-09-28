// Review analysis (roadmap B4): MultiPV 3 lines feed same-search grades and the
// alternatives a puzzle accepts; positions are searched by several workers whose
// results must not depend on how the work was split; progress carries an ETA.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Chess } from 'chess.js';

import {
  EQUAL_ALTERNATIVE_DELTA,
  GameReviewAnalyzer,
  buildAnalysisResult,
  buildReplay,
  defaultWorkerCount,
  isAcceptableMove,
  sameMove,
} from '../src/analyzer.js';
import { ReviewUI, formatEta } from '../src/review-ui.js';
import { sounds } from '../src/sounds.js';

// ---- a deterministic multi-PV fake engine ---------------------------------------

/** Answers each position with three lines whose scores derive from the FEN alone,
 *  so any split of positions over workers yields identical results. */
class LineWorker {
  static instances = [];
  static failAt = null; // { instance, onGo } to make one worker die
  constructor() {
    this.id = LineWorker.instances.length;
    LineWorker.instances.push(this);
    this.sent = [];
    this.terminated = false;
    this.fen = null;
  }
  postMessage(cmd) {
    const line = String(cmd);
    this.sent.push(line);
    if (line === 'uci') queueMicrotask(() => this.onmessage?.({ data: 'uciok' }));
    if (line.startsWith('position fen ')) this.fen = line.slice('position fen '.length);
    if (line.startsWith('go ')) {
      if (LineWorker.failAt === this.id) {
        queueMicrotask(() => this.onerror?.(new Error('boom')));
        return;
      }
      queueMicrotask(() => this.answer());
    }
  }
  answer() {
    if (this.terminated) return;
    const game = new Chess(this.fen);
    const moves = game.moves({ verbose: true });
    const seed = [...this.fen].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7);
    const score = (rank) => (seed % 60) - rank * 10; // best, then 10 cp worse, then 20 worse
    const uci = (m) => m.from + m.to + (m.promotion ?? '');
    for (let rank = 0; rank < Math.min(3, moves.length); rank++) {
      this.onmessage?.({ data: `info depth 12 seldepth 14 multipv ${rank + 1} score cp ${score(rank)} wdl 100 800 100 nodes 10 pv ${uci(moves[rank])}` });
    }
    this.onmessage?.({ data: `bestmove ${uci(moves[0])}` });
  }
  terminate() { this.terminated = true; }
}

function withWorkers(fn) {
  return async (t) => {
    const original = globalThis.Worker;
    globalThis.Worker = LineWorker;
    LineWorker.instances = [];
    LineWorker.failAt = null;
    t.after(() => { globalThis.Worker = original; });
    await fn(t);
  };
}

function longRecord(plies = 14) {
  const game = new Chess();
  const moves = [];
  for (let i = 0; i < plies; i++) {
    const move = game.moves({ verbose: true })[i % 3];
    game.move(move);
    moves.push({ from: move.from, to: move.to, promotion: move.promotion });
  }
  return { initialFen: null, moves, result: '*' };
}

test('defaultWorkerCount leaves a core for the page and caps at 4', () => {
  assert.equal(defaultWorkerCount(8), 4);
  assert.equal(defaultWorkerCount(4), 3);
  assert.equal(defaultWorkerCount(2), 1);
  assert.equal(defaultWorkerCount(1), 1);
  assert.equal(defaultWorkerCount(null), 2);
  assert.equal(defaultWorkerCount(NaN), 2);
  assert.equal(defaultWorkerCount(0), 2);
  assert.equal(defaultWorkerCount(64), 4);
});

test('positions are shared out over the workers and every one is searched exactly once', withWorkers(async () => {
  const record = longRecord(14);
  const analyzer = new GameReviewAnalyzer({ workers: 3 });
  const result = await analyzer.analyzeGame(record);
  assert.equal(LineWorker.instances.length, 3);
  const searches = LineWorker.instances.map((w) => w.sent.filter((m) => m.startsWith('go ')).length);
  assert.equal(searches.reduce((a, b) => a + b, 0), 15, '15 positions for a 14-ply game');
  assert.ok(searches.every((n) => n >= 3), `work was spread out: ${searches}`);
  assert.equal(result.plies.length, 14);
  assert.ok(LineWorker.instances.every((w) => w.terminated), 'every worker is shut down afterwards');
  assert.equal(analyzer.hasPendingTimers(), false);
}));

test('the result does not depend on how many workers did the work', withWorkers(async () => {
  const record = longRecord(14);
  const one = await new GameReviewAnalyzer({ workers: 1 }).analyzeGame(record);
  const three = await new GameReviewAnalyzer({ workers: 3 }).analyzeGame(record);
  assert.deepEqual(three, one);
}));

test('every search starts from a cleared hash, so an earlier position cannot leak into the next', withWorkers(async () => {
  await new GameReviewAnalyzer({ workers: 2 }).analyzeGame(longRecord(8));
  for (const worker of LineWorker.instances) {
    const commands = worker.sent;
    commands.forEach((cmd, i) => {
      if (cmd.startsWith('go ')) {
        assert.equal(commands[i - 2], 'ucinewgame', 'ucinewgame right before position + go');
        assert.ok(commands[i - 1].startsWith('position fen '));
      }
    });
    assert.ok(commands.includes('setoption name MultiPV value 3'));
    assert.ok(commands.includes('setoption name UCI_ShowWDL value true'));
  }
}));

test('never more workers than positions to search', withWorkers(async () => {
  await new GameReviewAnalyzer({ workers: 4 }).analyzeGame(longRecord(1)); // 2 positions
  assert.equal(LineWorker.instances.length, 2);
}));

test('progress counts every position once, finishes at 100% and carries an ETA that ends at null', withWorkers(async () => {
  let now = 0;
  const analyzer = new GameReviewAnalyzer({ workers: 2, now: () => (now += 1000) });
  const events = [];
  await analyzer.analyzeGame(longRecord(9), (p) => events.push(p));
  assert.ok(events.length >= 10);
  const done = events.map((e) => e.currentPly);
  assert.deepEqual(done, [...done].sort((a, b) => a - b), 'monotonic');
  assert.equal(events.at(-1).percentage, 100);
  assert.equal(events.at(-1).etaMs, null, 'nothing left to wait for');
  assert.equal(events[0].etaMs, null, 'no estimate before anything has finished');
  const withEta = events.filter((e) => e.etaMs !== null);
  assert.ok(withEta.length > 0, 'an estimate appears once a few positions are done');
  assert.ok(withEta.every((e) => e.etaMs > 0));
  assert.ok(withEta.at(-1).etaMs < withEta[0].etaMs, 'and shrinks as work completes');
}));

test('one worker dying stops the whole review with that error and shuts everything down', withWorkers(async () => {
  LineWorker.failAt = 1;
  const analyzer = new GameReviewAnalyzer({ workers: 3 });
  await assert.rejects(analyzer.analyzeGame(longRecord(14)), (err) => err.message === 'engine_error');
  assert.ok(LineWorker.instances.every((w) => w.terminated));
  assert.equal(analyzer.hasPendingTimers(), false);
}));

test('abort() during a parallel run rejects with review_aborted and terminates every worker', withWorkers(async () => {
  const analyzer = new GameReviewAnalyzer({ workers: 3 });
  const run = analyzer.analyzeGame(longRecord(14));
  await Promise.resolve();
  analyzer.abort();
  await assert.rejects(run, (err) => err.message === 'review_aborted');
  assert.ok(LineWorker.instances.every((w) => w.terminated));
}));

// ---- same-search grading ---------------------------------------------------------

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const e4 = { from: 'e2', to: 'e4' };
const d4 = { from: 'd2', to: 'd4' };
const a3 = { from: 'a2', to: 'a3' };

function gradeFirstMove({ played, afterCp, lines }) {
  const record = { initialFen: START, moves: [played], result: '*' };
  const replay = buildReplay(record);
  // white to move at the start, black (to move) after: eval2 is black's view
  const evals = [{ cp: lines[0].cp, mate: null }, { cp: -afterCp, mate: null }];
  const bests = [lines[0].move, null];
  const laneLines = [lines.map((l) => ({ move: l.move, eval: { cp: l.cp, mate: null } })), null];
  return buildAnalysisResult(record, replay, evals, [null, null], bests, null, null, laneLines);
}

test('a move that is the engine\'s second line is graded against its own line, not a noisy later search', () => {
  // Best e4 +60. d4 is the 2nd line at +58 (2% worse in the same search), but a
  // separate search of the position after d4 happens to say only +40 (a 7% drop).
  const result = gradeFirstMove({
    played: d4, afterCp: 40, lines: [{ move: e4, cp: 60 }, { move: d4, cp: 58 }],
  });
  assert.ok(result.plies[0].deltaW <= 2.5, `graded ${result.plies[0].deltaW}`);
  assert.ok(['best', 'excellent', 'book'].includes(result.plies[0].tier), result.plies[0].tier);
});

test('...unless the deeper search shows a real tactic (drop beyond noise)', () => {
  const result = gradeFirstMove({
    played: d4, afterCp: -150, lines: [{ move: e4, cp: 60 }, { move: d4, cp: 58 }],
  });
  assert.ok(result.plies[0].deltaW > 10, `the refutation is graded by the after-search: ${result.plies[0].deltaW}`);
});

test('a move outside the top lines is graded by the cross-search delta as before', () => {
  const result = gradeFirstMove({
    played: a3, afterCp: -100, lines: [{ move: e4, cp: 60 }, { move: d4, cp: 58 }],
  });
  assert.ok(result.plies[0].deltaW > 10);
});

test('without lines the old behaviour is unchanged (engine choice, noise floor)', () => {
  const record = { initialFen: START, moves: [e4], result: '*' };
  const replay = buildReplay(record);
  const result = buildAnalysisResult(record, replay, [{ cp: 60, mate: null }, { cp: -45, mate: null }], [null, null], [e4, null]);
  assert.equal(result.plies[0].deltaW, 0);
});

// ---- alternatives a puzzle accepts -------------------------------------------------

test('acceptable moves: the best plus alternatives within the equal-alternative margin', () => {
  const result = gradeFirstMove({
    played: a3, afterCp: -100,
    lines: [{ move: e4, cp: 60 }, { move: d4, cp: 58 }, { move: { from: 'g1', to: 'f3' }, cp: -80 }],
  });
  const ply = result.plies[0];
  assert.deepEqual(ply.acceptable.map((m) => `${m.from}${m.to}`), ['e2e4', 'd2d4'], 'Nf3 at -80 is not equal');
  assert.equal(isAcceptableMove(ply, 'd2', 'd4'), true);
  assert.equal(isAcceptableMove(ply, 'e2', 'e4'), true);
  assert.equal(isAcceptableMove(ply, 'g1', 'f3'), false);
  assert.equal(EQUAL_ALTERNATIVE_DELTA, 3);
});

test('when the best move mates, an alternative that does not mate is not equal', () => {
  const record = { initialFen: START, moves: [a3], result: '*' };
  const replay = buildReplay(record);
  const mateLine = { move: e4, eval: { cp: null, mate: 2 } };
  const almost = { move: d4, eval: { cp: 2000, mate: null } }; // huge, but not a mate
  const result = buildAnalysisResult(record, replay, [{ cp: null, mate: 2 }, { cp: 0, mate: null }], [null, null], [e4, null], null, null, [[mateLine, almost], null]);
  assert.deepEqual(result.plies[0].acceptable.map((m) => m.to), ['e4']);
});

test('older analyses without an acceptable list fall back to the engine move alone', () => {
  const ply = { bestMove: { from: 'e2', to: 'e4' } };
  assert.equal(isAcceptableMove(ply, 'e2', 'e4'), true);
  assert.equal(isAcceptableMove(ply, 'd2', 'd4'), false);
  assert.equal(isAcceptableMove({ bestMove: null }, 'e2', 'e4'), false);
  assert.equal(sameMove({ from: 'a7', to: 'a8', promotion: 'q' }, { from: 'a7', to: 'a8' }), false);
});

// ---- the retry flow accepts an equal alternative ------------------------------------

class RetryWorker {
  constructor() { RetryWorker.latest = this; this.terminated = false; }
  postMessage(cmd) {
    if (cmd === 'uci') this.onmessage?.({ data: 'uciok' });
    if (cmd === 'isready') this.onmessage?.({ data: 'readyok' });
  }
  terminate() { this.terminated = true; }
}
RetryWorker.latest = null;

function retryHarness(t, acceptable) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Worker = RetryWorker;
  RetryWorker.latest = null;
  const layer = document.createElement('div');
  layer.id = 'review-badge-layer';
  document.body.appendChild(layer);
  sounds.play = () => {};

  const game = new Chess();
  const fens = [game.fen()];
  const plies = [];
  const first = game.move('e4');
  fens.push(game.fen());
  plies.push({
    ply: 0, color: 'w', san: first.san, from: 'e2', to: 'e4', promotion: null, captured: null, fenAfter: fens[1],
    turnAfter: 'b', bestMove: { from: 'd2', to: 'd4' }, bestSan: 'd4', acceptable, reply: null, replySan: null,
    tier: 'mistake', deltaW: 12, cpLoss: 120, bestEvalCp: 30,
  });
  const analysis = {
    initialFen: fens[0], fens, plies,
    positions: fens.map((fen, j) => ({ ply: j, fen, turn: j % 2 ? 'b' : 'w', whiteWinProb: 50, whiteEvalCp: 0, clock: null, pvSan: [] })),
    accuracy: { w: 80, b: 80 }, counts: { w: {}, b: {} }, players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
  };
  const sidebar = document.createElement('div');
  sidebar.innerHTML = '<div class="sidebar-header"></div><div class="sidebar-content"></div><div class="action-strip"></div>';
  document.body.appendChild(sidebar);
  const sets = [];
  const controller = {
    ui: { refs: { gameSidebar: sidebar }, showClocks() {}, setClock() {}, log() {} },
    ground: { set: (cfg) => sets.push(cfg), setAutoShapes() {} },
    orientation: 'white', flip() {}, exitReview() {}, onPromotion: async () => 'q',
  };
  const review = new ReviewUI();
  review.enterStepperMode(controller, analysis, -1);
  review.startRetryMistake(0);
  return { review, sets };
}

test('retry: an alternative the engine rates equal solves the puzzle and is said to be as good', async (t) => {
  const { review, sets } = retryHarness(t, [{ from: 'd2', to: 'd4' }, { from: 'c2', to: 'c4' }]);
  await sets.at(-1).movable.events.after('c2', 'c4');
  assert.equal(RetryWorker.latest, null, 'no simulated reply: it counted as solved');
  assert.match(document.querySelector('[data-coach]').textContent, /ก็ดีเท่ากัน/u);
  assert.match(document.querySelector('[data-coach]').textContent, /c4/u);
  assert.equal(sets.at(-1).movable.color, false);
  review.exitStepperMode();
});

test('retry: a move outside the acceptable list is still answered by the engine', async (t) => {
  const { review, sets } = retryHarness(t, [{ from: 'd2', to: 'd4' }]);
  await sets.at(-1).movable.events.after('c2', 'c4');
  assert.ok(RetryWorker.latest, 'a simulated reply is requested for a wrong move');
  review.exitStepperMode();
});

// ---- ETA text -------------------------------------------------------------------------

test('formatEta reads naturally and stays silent while unknown', () => {
  assert.equal(formatEta(null), '');
  assert.equal(formatEta(undefined), '');
  assert.equal(formatEta(NaN), '');
  assert.equal(formatEta(-5), '');
  assert.equal(formatEta(2500), 'เหลืออีกไม่กี่วินาที');
  assert.equal(formatEta(12_000), 'เหลือประมาณ 15 วินาที');
  assert.equal(formatEta(59_000), 'เหลือประมาณ 60 วินาที');
  assert.equal(formatEta(60_000), 'เหลือประมาณ 1 นาที');
  assert.equal(formatEta(95_000), 'เหลือประมาณ 1 นาที 40 วินาที');
  assert.equal(formatEta(180_000), 'เหลือประมาณ 3 นาที');
});
