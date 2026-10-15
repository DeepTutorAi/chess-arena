// Critical moments UI (roadmap.md A1): the summary modal shows a jump row and
// the advantage graph pins markers — both jump the stepper to the swing ply.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { ReviewUI } from '../src/review-ui.js';

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  return window;
}

function analysisWithMoments() {
  return {
    accuracy: { w: 90, b: 40 },
    players: { white: { name: 'ขาว' }, black: { name: 'ดำ' } },
    counts: { w: {}, b: {} },
    positions: [
      { whiteWinProb: 50, whiteEvalCp: 0 },
      { whiteWinProb: 15, whiteEvalCp: -350 },
    ],
    plies: [{ san: 'Qh4#' }],
    criticalMoments: [{ ply: 0, san: 'Qh4#', lost: true, swingPct: 35 }],
  };
}

test('summary modal lists critical moments and jumps to the ply on click', (t) => {
  setup(t);
  const ui = new ReviewUI();
  const picked = [];
  ui.showReviewSummaryModal(
    analysisWithMoments(),
    (ply) => picked.push(ply),
    () => {},
    () => {},
  );

  const row = document.querySelector('[data-critical]');
  assert.ok(row, 'critical moments row exists');
  assert.match(row.textContent, /จังหวะชี้ขาด|ตา 1/u);

  const btn = row.querySelector('.cm-btn');
  assert.ok(btn);
  assert.match(btn.textContent, /ตา 1/u);
  assert.match(btn.textContent, /Qh4#/u);
  assert.match(btn.textContent, /เสีย 35%/u);
  assert.ok(btn.classList.contains('cm-lost'));

  btn.click();
  assert.deepEqual(picked, [0], 'button jumps the stepper to the swing ply');
  assert.equal(document.querySelector('.review-modal-overlay'), null, 'modal closed before jumping');
});

test('advantage graph pins a marker per critical moment with a label', (t) => {
  setup(t);
  const ui = new ReviewUI();
  ui.showReviewSummaryModal(
    analysisWithMoments(),
    () => {},
    () => {},
    () => {},
  );

  const dot = document.querySelector('.advantage-graph-svg .adv-cm-dot[data-ply="0"]');
  assert.ok(dot, 'graph marker exists for the swing ply');
  assert.match(dot.querySelector('title')?.textContent ?? '', /จังหวะชี้ขาด/u);
  assert.match(dot.querySelector('title')?.textContent ?? '', /Qh4#/u);
});

test('games without critical moments render no critical section (backward compatible)', (t) => {
  setup(t);
  const ui = new ReviewUI();
  const analysis = analysisWithMoments();
  delete analysis.criticalMoments;
  ui.showReviewSummaryModal(
    analysis,
    () => {},
    () => {},
    () => {},
  );
  assert.equal(document.querySelector('[data-critical]'), null);
  assert.equal(document.querySelector('.adv-cm-dot'), null);
});

test('the summary is a large shared modal whose close button lives in its sticky header', (t) => {
  setup(t);
  const ui = new ReviewUI();
  ui.showReviewSummaryModal(analysisWithMoments(), () => {}, () => {}, () => {});
  const dialog = document.querySelector('.review-summary-modal');
  assert.ok(dialog.classList.contains('modal') && dialog.classList.contains('modal--lg'));
  const head = dialog.querySelector('.modal-head');
  assert.ok(head, 'header row');
  assert.ok(head.querySelector('.review-modal-close'), 'close button sits in the header');
  assert.ok(head.querySelector('.review-summary-title'), 'title sits in the header');
});

test('the review summary traps Tab and closes on Escape like every other modal', (t) => {
  const window = setup(t);
  const ui = new ReviewUI();
  let exited = 0;
  ui.showReviewSummaryModal(analysisWithMoments(), () => {}, () => {}, () => { exited += 1; });
  const dialog = document.querySelector('.review-summary-modal');
  const focusables = [...dialog.querySelectorAll('button')];
  focusables.at(-1).focus();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, focusables[0], 'Tab wraps inside the summary');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.review-summary-modal'), null, 'Escape closes it');
  assert.equal(exited, 1, 'through the same path as the close button');
});
