// Puzzle Run (roadmap.md A3): "ฝึกแก้ตาพลาด" — a scored run over every
// retryable ply of the reviewed game. Correct move = +1; wrong move = the
// simulated opponent answers, the solution is revealed, then the run advances.
// happy-dom + a fake Stockfish worker; no real engine or chessground.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Chess } from 'chess.js';

import { ReviewUI } from '../src/review-ui.js';
import { sounds } from '../src/sounds.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    if (line === 'uci') this.onmessage?.({ data: 'uciok' });
    if (line === 'isready') this.onmessage?.({ data: 'readyok' });
  }
  terminate() {
    this.terminated = true;
  }
  finish(pvUci, scoreCp) {
    this.onmessage?.({
      data: `info depth 12 seldepth 15 multipv 1 score cp ${scoreCp} nodes 10000 nps 300000 time 33 pv ${pvUci.join(' ')}`,
    });
    this.onmessage?.({ data: `bestmove ${pvUci[0]}` });
  }
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
  return {
    sets,
    controller: {
      ui: { refs: { gameSidebar: sidebar }, showClocks: () => {}, setClock: () => {}, log: () => {} },
      ground: { set: (cfg) => sets.push(cfg), setAutoShapes: () => {} },
      orientation: 'white',
      flip: () => {},
      exitReview: () => {},
      onPromotion: async () => 'q',
    },
  };
}

const coachCard = () => document.querySelector('[data-coach]');

const SCHOLAR = (() => {
  const g = new Chess();
  for (const san of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4']) g.move(san);
  return g.fen();
})();
const ROOK_ENDGAME = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const ROOK_MATE_THREAT = 'k7/8/8/8/8/8/1r6/K7 b - - 0 1';

/** 4-ply game whose plies 1, 2, 3 are retryable mistakes (3 puzzles). */
function buildAnalysis() {
  const plies = [
    { ply: 0, color: 'w', san: 'e4', from: 'e2', to: 'e4', tier: 'best', bestMove: null, bestSan: null, reply: null, replySan: null, deltaW: 0, cpLoss: 0 },
    { ply: 1, color: 'b', san: 'Nf6', from: 'g8', to: 'f6', tier: 'blunder', bestMove: { from: 'd8', to: 'e7' }, bestSan: 'Qe7', reply: { from: 'h5', to: 'f7' }, replySan: 'Qxf7#', deltaW: 34, cpLoss: 850 },
    { ply: 2, color: 'w', san: 'Rb1', from: 'a1', to: 'b1', tier: 'mistake', bestMove: { from: 'a1', to: 'a8' }, bestSan: 'Ra8#', reply: null, replySan: null, deltaW: 12, cpLoss: 400 },
    { ply: 3, color: 'b', san: 'Rb7', from: 'b2', to: 'b7', tier: 'inaccuracy', bestMove: { from: 'b2', to: 'b1' }, bestSan: 'Rb1+', reply: null, replySan: null, deltaW: 6, cpLoss: 150 },
  ];
  const fens = [
    new Chess().fen(),
    SCHOLAR,
    ROOK_ENDGAME,
    ROOK_MATE_THREAT,
    ROOK_MATE_THREAT.replace(' b ', ' w '),
  ];
  return {
    initialFen: fens[0],
    fens,
    plies,
    positions: fens.map((fen, j) => ({ ply: j, fen, turn: 'w', whiteWinProb: 50, whiteEvalCp: 0, clock: null, pvSan: [] })),
    criticalMoments: [],
    opening: null,
    accuracy: { w: 80, b: 50 },
    counts: { w: {}, b: {} },
    players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
  };
}

test('summary modal offers the puzzle run for every retryable move', (t) => {
  setup(t);
  const ui = new ReviewUI();
  let runs = 0;
  ui.showReviewSummaryModal(buildAnalysis(), () => {}, () => {}, () => {}, () => { runs += 1; });
  const btn = document.querySelector('[data-puzzle-run]');
  assert.ok(btn, 'run button exists');
  assert.match(btn.textContent, /ฝึกแก้ตาพลาด/u);
  assert.match(btn.textContent, /3 ตา/u);
  btn.click();
  assert.equal(runs, 1, 'click delegates to the controller hook');
});

test('summary modal hides the run when nothing is retryable', (t) => {
  setup(t);
  const ui = new ReviewUI();
  const analysis = buildAnalysis();
  analysis.plies.forEach((p) => { p.tier = 'best'; });
  ui.showReviewSummaryModal(analysis, () => {}, () => {}, () => {}, () => {});
  assert.equal(document.querySelector('[data-puzzle-run]'), null);
});

test('a full run: correct answers score, wrong answers reveal, summary persists streak', async (t) => {
  const window = setup(t);
  const { controller, sets } = buildController();
  const analysis = buildAnalysis();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, analysis, 0);
  ui.startPuzzleRun();

  // Puzzle 1/3 — scholar position, play the best Qe7.
  assert.match(coachCard().textContent, /ข้อ 1\/3/u);
  assert.match(coachCard().textContent, /คะแนน 0/u);
  let cfg = sets.at(-1);
  assert.equal(cfg.fen, SCHOLAR);
  assert.equal(cfg.movable.color, 'black');
  await cfg.movable.events.after('d8', 'e7');
  assert.match(coachCard().textContent, /ข้อ 2\/3/u);
  assert.match(coachCard().textContent, /คะแนน 1/u);

  // Puzzle 2/3 — play a WRONG move; the simulated opponent must answer on board.
  cfg = sets.at(-1);
  assert.equal(cfg.fen, ROOK_ENDGAME);
  await cfg.movable.events.after('a1', 'b1');
  const worker = FakeWorker.latest;
  assert.ok(worker, 'sim engine spawned for the wrong answer');
  worker.finish(['g7g6'], 120);
  await sleep(REPLY_BEAT_MS);
  assert.match(coachCard().textContent, /Ra8#/u, 'the solution is revealed');
  assert.match(coachCard().textContent, /g6/u, 'the opponent answer is shown');
  assert.match(coachCard().textContent, /ข้อถัดไป/u);
  assert.equal(sets.at(-1).movable.color, false, 'board locked while the lesson shows');
  coachCard().querySelector('[data-next]').click();
  assert.match(coachCard().textContent, /ข้อ 3\/3/u);
  assert.match(coachCard().textContent, /คะแนน 1/u, 'score unchanged, streak reset');

  // Puzzle 3/3 — play the best Rb1+; the run completes into a summary.
  cfg = sets.at(-1);
  assert.equal(cfg.fen, ROOK_MATE_THREAT);
  await cfg.movable.events.after('b2', 'b1');
  assert.match(coachCard().textContent, /จบการฝึก/u);
  assert.match(coachCard().textContent, /2\/3/u);
  assert.match(coachCard().textContent, /สตรีคยาวสุด 1/u);
  assert.ok(worker.terminated, 'engine worker is released when the run ends');

  const key = `chess-arena:puzzle-best:${analysis.initialFen}#${analysis.plies.length}`;
  assert.equal(window.localStorage.getItem(key), '1', 'best streak persisted per game');
});

test('skip jumps to the next puzzle without scoring', (t) => {
  setup(t);
  const { controller, sets } = buildController();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, buildAnalysis(), 0);
  ui.startPuzzleRun();
  coachCard().querySelector('[data-skip]').click();
  assert.match(coachCard().textContent, /ข้อ 2\/3/u);
  assert.match(coachCard().textContent, /คะแนน 0/u);
  assert.equal(sets.at(-1).fen, ROOK_ENDGAME);
});

test('finishing early summarizes and returns to the review stepper', (t) => {
  setup(t);
  const { controller, sets } = buildController();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, buildAnalysis(), 0);
  ui.startPuzzleRun();
  coachCard().querySelector('[data-finish]').click();
  assert.match(coachCard().textContent, /0\/3/u);
  coachCard().querySelector('[data-run-review]').click();
  assert.equal(sets.at(-1).movable.color, false, 'review board re-locked');
});

test('exiting review during a run tears everything down', (t) => {
  setup(t);
  const { controller } = buildController();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, buildAnalysis(), 0);
  ui.startPuzzleRun();
  ui.exitStepperMode();
  assert.equal(coachCard(), null, 'panel removed without errors');
});
