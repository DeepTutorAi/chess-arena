// Player display names come from the opponent (server only trims + length
// checks them), so every review surface must render them as text — never as
// markup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { escapeHtml } from '../src/html.js';
import { ReviewUI } from '../src/review-ui.js';
import { UI } from '../src/ui.js';

// A marker element instead of <img onerror>: a regression must fail the
// assertions, not make the DOM implementation start a network fetch.
const PAYLOAD = '<b data-pwn="1">x</b>';

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  return window;
}

test('escapeHtml neutralises markup and tolerates nullish input', () => {
  assert.equal(escapeHtml(PAYLOAD), '&lt;b data-pwn=&quot;1&quot;&gt;x&lt;/b&gt;');
  assert.equal(escapeHtml("a&b'c"), 'a&amp;b&#39;c');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(12), '12');
});

test('summary modal renders hostile player and opening names as text', (t) => {
  setup(t);
  const ui = new ReviewUI();
  ui.showReviewSummaryModal(
    {
      accuracy: { w: 90, b: 80 },
      players: { white: { name: PAYLOAD }, black: { name: '<b>bold</b>' } },
      counts: { w: {}, b: {} },
      positions: [{ whiteWinProb: 50, whiteEvalCp: 0 }],
      plies: [],
      criticalMoments: [],
      opening: { eco: 'X00', name: PAYLOAD },
    },
    () => {},
    () => {},
    () => {},
  );
  const overlay = document.querySelector('.review-summary-modal');
  assert.ok(overlay, 'summary modal rendered');
  assert.equal(overlay.querySelectorAll('[data-pwn]').length, 0, 'no element was injected');
  assert.equal(overlay.querySelectorAll('.gauge-name b').length, 0);
  const names = [...overlay.querySelectorAll('.gauge-name')].map((n) => n.textContent);
  assert.deepEqual(names, [PAYLOAD, '<b>bold</b>']);
  assert.ok(overlay.querySelector('.review-opening').textContent.includes(PAYLOAD));
});

test('game-over pill renders title and detail as text', (t) => {
  setup(t);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ui = new UI(root);
  ui._spawnGameOverPill(PAYLOAD, `${PAYLOAD} (1-0)`, () => {}, () => {}, null);
  const pill = document.querySelector('.gameover-pill');
  assert.ok(pill);
  assert.equal(pill.querySelectorAll('[data-pwn]').length, 0);
  assert.equal(pill.querySelector('.pill-title').textContent, PAYLOAD);
});
