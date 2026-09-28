// Review-flow regressions: engine failures were reported as cancels (leaving a
// bare board), a silent engine hung forever, a cancel during the opening-book
// fetch didn't cancel, the graph click landed one ply late, the crosshair could
// never hide (SVG has no `hidden` property), and cpLoss was shown 10x too small.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';

import { GameReviewAnalyzer } from '../src/analyzer.js';
import { Controller, MODES } from '../src/controller.js';
import { CoachService, ReviewUI } from '../src/review-ui.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, { timeout = 3000, label = 'condition' } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

class FakeWorker {
  static instances = [];
  static mode = 'answer'; // 'answer' | 'silent' (says hello, never searches) | 'mute' (never says anything) | 'error'
  constructor() {
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.fen = null;
    FakeWorker.instances.push(this);
  }
  postMessage(cmd) {
    const line = String(cmd);
    this.messages.push(line);
    if (FakeWorker.mode !== 'mute' && line === 'uci') this.onmessage?.({ data: 'uciok' });
    if (FakeWorker.mode !== 'mute' && line === 'isready') this.onmessage?.({ data: 'readyok' });
    if (line.startsWith('position fen ')) this.fen = line.slice('position fen '.length);
    if (line.startsWith('go ')) {
      if (FakeWorker.mode === 'error') queueMicrotask(() => this.onerror?.(new Error('boom')));
      if (FakeWorker.mode === 'answer') {
        const move = new Chess(this.fen).moves({ verbose: true })[0];
        const uci = move.from + move.to + (move.promotion ?? '');
        this.onmessage?.({ data: `info depth 12 multipv 1 score cp 20 nodes 1 nps 1 time 1 pv ${uci}` });
        this.onmessage?.({ data: `bestmove ${uci}` });
      }
    }
  }
  terminate() { this.terminated = true; }
}

// Teardown must dispose controllers BEFORE the DOM globals go away (dispose
// touches `document` while a review is open), so both live in one hook.
let cleanups = [];

function installGlobals(t, { fetchImpl = async () => ({ ok: false }) } = {}) {
  cleanups = [];
  const window = new Window({ url: 'https://chess.example.test/' });
  const saved = { Worker: globalThis.Worker, fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Worker = FakeWorker;
  globalThis.fetch = fetchImpl;
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  FakeWorker.instances = [];
  FakeWorker.mode = 'answer';
  t.after(() => {
    for (const fn of cleanups.splice(0)) fn();
    window.close();
    Object.assign(globalThis, { Worker: saved.Worker, fetch: saved.fetch, window: saved.window, document: saved.document, requestAnimationFrame: saved.raf });
  });
  return window;
}

const RECORD = {
  initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }],
  players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
  result: '1/2-1/2',
  reason: 'draw',
};

// ---- analyzer --------------------------------------------------------------

test('analyzer: a worker error is an engine failure, not a cancel', async (t) => {
  installGlobals(t);
  FakeWorker.mode = 'error';
  const analyzer = new GameReviewAnalyzer();
  await assert.rejects(analyzer.analyzeGame(RECORD), (err) => err.message === 'engine_error');
  assert.equal(FakeWorker.instances[0].terminated, true, 'worker cleaned up');
});

test('analyzer: a silent engine is cut off by the idle watchdog', async (t) => {
  installGlobals(t);
  FakeWorker.mode = 'silent';
  const analyzer = new GameReviewAnalyzer({ firstIdleTimeoutMs: 30, idleTimeoutMs: 30 });
  await assert.rejects(analyzer.analyzeGame(RECORD), (err) => err.message === 'engine_timeout');
  assert.equal(FakeWorker.instances[0].terminated, true);
});

test('analyzer: a worker that is still loading gets the long leash, a wedged one the short leash', async (t) => {
  installGlobals(t);
  // Nothing heard yet (wasm still downloading): must NOT be cut off at the idle timeout.
  FakeWorker.mode = 'mute';
  const loading = new GameReviewAnalyzer({ firstIdleTimeoutMs: 150, idleTimeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(loading.analyzeGame(RECORD), (err) => err.message === 'engine_timeout');
  assert.ok(Date.now() - started >= 120, 'a cold worker was allowed the long first-line timeout');

  // The engine spoke (uciok) and then went quiet: the short idle timeout applies.
  FakeWorker.mode = 'silent';
  const wedged = new GameReviewAnalyzer({ firstIdleTimeoutMs: 5_000, idleTimeoutMs: 30 });
  const t0 = Date.now();
  await assert.rejects(wedged.analyzeGame(RECORD), (err) => err.message === 'engine_timeout');
  assert.ok(Date.now() - t0 < 1_000, 'a wedged engine is cut off quickly, not after the 5s first-line leash');
});

test('analyzer: abort() before the run starts sticks and never spawns an engine', async (t) => {
  installGlobals(t);
  const analyzer = new GameReviewAnalyzer();
  analyzer.abort(); // user cancelled while the opening book was still loading
  await assert.rejects(analyzer.analyzeGame(RECORD), (err) => err.message === 'review_aborted');
  assert.equal(FakeWorker.instances.length, 0);
});

test('analyzer: healthy run completes, depth alone ends a search, no timers left behind', async (t) => {
  installGlobals(t);
  const analyzer = new GameReviewAnalyzer({ firstIdleTimeoutMs: 50, idleTimeoutMs: 50 });
  const result = await analyzer.analyzeGame(RECORD);
  assert.equal(result.plies.length, 2);
  const goLines = FakeWorker.instances[0].messages.filter((m) => m.startsWith('go '));
  assert.ok(goLines.length > 0);
  assert.ok(goLines.every((m) => m === 'go depth 12'), `no movetime cap (results must not depend on device speed): ${goLines.join('|')}`);
  assert.equal(analyzer._watchdog, null, 'watchdog cleared');
  await sleep(80); // a leaked timer would fire here and flip analyzer state
  assert.equal(analyzer._fatal, null);
});

// ---- controller ------------------------------------------------------------

function makeController() {
  const calls = { toasts: [], gameOvers: 0, logs: [] };
  const ui = new Proxy({
    log(message, level) { calls.logs.push([message, level]); },
    showFloatingToast(opts) { calls.toasts.push(opts); },
    showGameOver() {
      calls.gameOvers += 1;
      const overlay = { body: { isConnected: true }, close() { overlay.body.isConnected = false; } };
      return overlay;
    },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const ground = {
    state: { dom: { bounds: { clear() {} } } },
    set() {},
    setShapes() {},
    setAutoShapes() {},
  };
  const controller = new Controller({ ui, ground, onPromotion: async () => 'q', gameOverDelayMs: 0 });
  return { controller, calls };
}

async function finishedGame(t) {
  const { controller, calls } = makeController();
  cleanups.push(() => controller.dispose());
  await controller.start(MODES.ANALYZE, { timeControlId: 'unlimited' });
  await controller.handleUserMove('e2', 'e4');
  await controller.handleUserMove('e7', 'e5');
  controller.resign();
  assert.ok(controller._lastGameRecord?.moves?.length, 'game record captured');
  return { controller, calls };
}

test('controller: engine failure during review reports an error and restores the game-over card', async (t) => {
  installGlobals(t);
  const { controller, calls } = await finishedGame(t);
  FakeWorker.mode = 'error';
  const before = calls.gameOvers;
  controller.startReview();
  await until(() => calls.toasts.length > 0, { label: 'failure toast' });

  assert.equal(controller._reviewActive, false, 'review session ended, not stuck');
  assert.equal(calls.toasts[0].title, 'รีวิวเกมไม่สำเร็จ');
  assert.match(calls.toasts[0].detail, /เอนจิน/u);
  assert.ok(calls.gameOvers > before, 'game-over card is back');
  assert.equal(document.querySelector('.review-modal-overlay'), null, 'progress modal closed');
  assert.deepEqual(calls.toasts[0].actions.map((a) => a[0]), ['ลองใหม่', 'ปิด']);
});

test('controller: cancelling while the opening book loads cancels the analysis for good', async (t) => {
  let releaseBook;
  installGlobals(t, {
    fetchImpl: () => new Promise((resolve) => { releaseBook = () => resolve({ ok: false }); }),
  });
  const { controller } = await finishedGame(t);
  controller.startReview();
  await until(() => document.querySelector('[data-cancel]'), { label: 'progress modal' });
  document.querySelector('[data-cancel]').click(); // cancel BEFORE the book resolves
  assert.equal(controller._reviewActive, false);

  releaseBook();
  await sleep(60);
  assert.equal(FakeWorker.instances.length, 0, 'no engine was ever spawned for the cancelled run');
  assert.equal(document.querySelector('.review-summary-modal'), null, 'no summary from a cancelled run');
  assert.equal(document.querySelector('.review-modal-overlay'), null, 'no stray progress modal');
});

test('controller: re-entering review of the same game reuses the finished analysis', async (t) => {
  installGlobals(t);
  const { controller } = await finishedGame(t);
  controller.startReview();
  await until(() => document.querySelector('.review-summary-modal'), { label: 'summary' });
  const workersAfterFirst = FakeWorker.instances.length;
  assert.equal(workersAfterFirst, 1);

  document.querySelector('.review-modal-close').click(); // exit review
  assert.equal(controller._reviewActive, false);

  controller.startReview();
  assert.ok(document.querySelector('.review-summary-modal'), 'summary shown synchronously from cache');
  assert.equal(FakeWorker.instances.length, workersAfterFirst, 'no second analysis run');
});

// ---- review UI -------------------------------------------------------------

function graphAnalysis(plyCount = 3) {
  return {
    accuracy: { w: 90, b: null },
    players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
    counts: { w: {}, b: {} },
    positions: Array.from({ length: plyCount + 1 }, (_, i) => ({ whiteWinProb: 50, whiteEvalCp: 0, ply: i })),
    plies: Array.from({ length: plyCount }, (_, i) => ({ san: `m${i + 1}`, tier: 'good', deltaW: 0 })),
    criticalMoments: [],
  };
}

test('graph: clicking position p opens the stepper on ply p - 1 (0 = start position)', async (t) => {
  const window = installGlobals(t);
  const ui = new ReviewUI();
  const picked = [];
  ui.showReviewSummaryModal(graphAnalysis(3), (ply) => picked.push(ply), () => {}, () => {});
  const svg = document.querySelector('.advantage-graph-svg');
  svg.getBoundingClientRect = () => ({ left: 0, width: 560, top: 0, height: 150 });
  const click = (x) => svg.dispatchEvent(new window.MouseEvent('click', { clientX: x, bubbles: true }));

  click(0);      // position 0 = before any move
  click(560);    // position 3 = after the third ply
  click(560 / 3); // position 1 = after the first ply
  assert.deepEqual(picked, [-1, 2, 0]);
});

test('graph: the crosshair starts hidden, shows on hover and hides again on leave', (t) => {
  const window = installGlobals(t);
  const ui = new ReviewUI();
  ui.showReviewSummaryModal(graphAnalysis(3), () => {}, () => {}, () => {});
  const svg = document.querySelector('.advantage-graph-svg');
  const cross = document.querySelector('[data-crosshair]');
  svg.getBoundingClientRect = () => ({ left: 0, width: 560, top: 0, height: 150 });

  assert.equal(cross.style.display, 'none', 'hidden before any hover (SVG ignores the hidden property)');
  svg.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 280, bubbles: true }));
  assert.notEqual(cross.style.display, 'none');
  svg.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
  assert.equal(cross.style.display, 'none');
});

test('gauge: a side that never moved shows an em dash instead of a fake 0%', (t) => {
  installGlobals(t);
  new ReviewUI().showReviewSummaryModal(graphAnalysis(1), () => {}, () => {}, () => {});
  const pct = [...document.querySelectorAll('.gauge-pct')].map((n) => n.textContent);
  assert.deepEqual(pct, ['90%', '—']);
});

test('coach: centipawn loss is reported in pawns, not tenths of a pawn', () => {
  const coach = new CoachService();
  const base = { san: 'Qh5', tier: 'blunder', deltaW: 24, bestSan: 'Nf3', ply: 2, color: 'w' };
  const three = coach.generateInsight({ ...base, cpLoss: 300 });
  assert.match(three.explanation, /~3\.0 ตัว/u);
  const half = coach.generateInsight({ ...base, cpLoss: 45 });
  assert.match(half.explanation, /~0\.5 ตัว/u);
  const mate = coach.generateInsight({ ...base, cpLoss: 20000 });
  assert.doesNotMatch(mate.explanation, /ตัว\)/u, 'a mate-sized loss is not "200 pawns"');
});

test('graph: end tick labels are anchored inward and use full-move numbers', (t) => {
  installGlobals(t);
  new ReviewUI().showReviewSummaryModal(graphAnalysis(4), () => {}, () => {}, () => {});
  const ticks = [...document.querySelectorAll('.adv-tick')];
  assert.ok(ticks.length >= 2);
  assert.equal(ticks[0].getAttribute('text-anchor'), 'start');
  assert.equal(ticks.at(-1).getAttribute('text-anchor'), 'end');
  assert.equal(ticks[0].textContent, 'เริ่ม');
  assert.equal(ticks.at(-1).textContent, 'ตา 2', 'position after 4 plies = move 2');
  assert.doesNotMatch(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), /\.adv-tick\s*\{[^}]*text-anchor/u,
    'a CSS text-anchor would override the per-tick attribute');
});

// ---- template literal regression (single-quoted ${} rendered as raw text) -----

test('coach card retry button renders its icon instead of a raw ${...} placeholder', (t) => {
  installGlobals(t);
  const ui = new ReviewUI();
  const panel = document.createElement('div');
  panel.innerHTML = '<div data-coach></div>';
  document.body.appendChild(panel);
  ui._panel = panel;
  ui._analysis = { positions: [], plies: [] };
  ui._renderCoach({
    ply: 2, color: 'w', san: 'Qh5', tier: 'blunder', deltaW: 24, cpLoss: 300,
    bestSan: 'Nf3', bestMove: { from: 'g1', to: 'f3' },
  });
  const button = panel.querySelector('.coach-retry-btn');
  assert.ok(button, 'retry button rendered');
  assert.ok(button.querySelector('svg'), 'lightbulb icon rendered');
  assert.match(button.textContent, /ลองเดินแก้ตัว/u);
  assert.equal(panel.innerHTML.includes('${'), false, 'no uninterpolated placeholder');
});

test('retry card restart button renders its icon instead of a raw ${...} placeholder', (t) => {
  installGlobals(t);
  const ui = new ReviewUI();
  const panel = document.createElement('div');
  panel.innerHTML = '<div data-coach></div>';
  document.body.appendChild(panel);
  ui._panel = panel;
  ui._retry = { userColor: 'white', game: new Chess(), ply: { tier: 'mistake', bestSan: 'e4' }, phase: 'thinking' };
  ui._renderRetryCard('thinking');
  const restart = panel.querySelector('[data-restart]');
  assert.ok(restart?.querySelector('svg'));
  assert.equal(panel.innerHTML.includes('${'), false);
});

test('no plain string literal in the UI modules contains a ${...} placeholder', async () => {
  // Uses a real parser (rollup ships with Vite): a line-based regex can't tell a
  // '${x}' string from a template literal that spans lines.
  const { parseAst } = await import('rollup/parseAst');
  const offenders = [];
  const walk = (node, file) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child) => walk(child, file)); return; }
    if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('${')) {
      offenders.push(`${file}@${node.start}: ${node.raw.slice(0, 60)}`);
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, file);
  };
  for (const file of ['ui.js', 'review-ui.js', 'main.js']) {
    walk(parseAst(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')), file);
  }
  assert.deepEqual(offenders, [], 'these strings need backticks to interpolate');
});
