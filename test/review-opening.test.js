// Opening names UI (roadmap.md A2): summary modal and the review stepper both
// surface the matched opening (eco · name) when the analysis carries one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Chess } from 'chess.js';

import { ReviewUI } from '../src/review-ui.js';

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  const layer = document.createElement('div');
  layer.id = 'review-badge-layer';
  document.body.appendChild(layer);
  return window;
}

function summaryAnalysis(opening) {
  return {
    accuracy: { w: 90, b: 80 },
    players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
    counts: { w: {}, b: {} },
    positions: [{ whiteWinProb: 50, whiteEvalCp: 0 }],
    plies: [],
    criticalMoments: [],
    opening,
  };
}

function buildController() {
  const sidebar = document.createElement('div');
  sidebar.innerHTML = '<div class="sidebar-header"></div><div class="sidebar-content"></div><div class="action-strip"></div>';
  document.body.appendChild(sidebar);
  const game = new Chess();
  return {
    controller: {
      ui: { refs: { gameSidebar: sidebar }, showClocks: () => {}, setClock: () => {}, log: () => {} },
      ground: { set: () => {}, setAutoShapes: () => {} },
      orientation: 'white',
      flip: () => {},
      exitReview: () => {},
      onPromotion: async () => 'q',
    },
    analysis: {
      initialFen: game.fen(),
      fens: [game.fen()],
      plies: [],
      positions: [{ ply: 0, fen: game.fen(), turn: 'w', whiteWinProb: 50, whiteEvalCp: 0, clock: null, pvSan: [] }],
      criticalMoments: [],
      accuracy: { w: 90, b: 80 },
      counts: { w: {}, b: {} },
      players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
    },
  };
}

test('summary modal shows the matched opening under the title', (t) => {
  setup(t);
  const ui = new ReviewUI();
  ui.showReviewSummaryModal(
    summaryAnalysis({ eco: 'B50', name: 'Modern Variations' }),
    () => {},
    () => {},
    () => {},
  );
  const line = document.querySelector('.review-opening');
  assert.ok(line, 'opening line exists');
  assert.match(line.textContent, /B50/u);
  assert.match(line.textContent, /Modern Variations/u);
});

test('summary modal omits the opening line when no opening matched', (t) => {
  setup(t);
  const ui = new ReviewUI();
  ui.showReviewSummaryModal(summaryAnalysis(null), () => {}, () => {}, () => {});
  assert.equal(document.querySelector('.review-opening'), null);
});

test('review stepper overview shows the opening name', (t) => {
  setup(t);
  const { controller, analysis } = buildController();
  analysis.opening = { eco: 'C60', name: 'Ruy Lopez' };
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, analysis, 0);
  const overview = document.querySelector('[data-overview]');
  assert.match(overview.textContent, /C60/u);
  assert.match(overview.textContent, /Ruy Lopez/u);
  ui.exitStepperMode();
});

test('review stepper omits the opening when none matched', (t) => {
  setup(t);
  const { controller, analysis } = buildController();
  const ui = new ReviewUI();
  ui.enterStepperMode(controller, analysis, 0);
  assert.equal(document.querySelector('[data-overview] .review-opening'), null);
  ui.exitStepperMode();
});
