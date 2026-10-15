// Static guards for the game-page layout. Real geometry needs a browser (the
// task was verified with Playwright at 9 viewports); these keep the rules that
// fixed the clipping from being quietly undone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('no raw vh units — dvh-aware --vh is used so mobile browser chrome is excluded', () => {
  const stripped = css.replace(/--vh:\s*1(d)?vh;/g, '');
  const offenders = stripped.match(/[^\w-]\d+(\.\d+)?vh\b/g) ?? [];
  assert.deepEqual(offenders, [], `raw vh found: ${offenders.join(', ')}`);
  assert.match(css, /@supports \(height: 1dvh\)\s*\{\s*:root\s*\{\s*--vh:\s*1dvh;/u);
});

test('board size follows the viewport instead of a fixed 520px cap', () => {
  const layout = css.match(/\.chesscom-layout\s*\{[^}]*\}/u)?.[0] ?? '';
  assert.match(layout, /--board-size:\s*max\(/u);
  assert.match(layout, /100 \* var\(--vh\) - var\(--board-chrome\)/u);
  assert.doesNotMatch(css, /--board-size:\s*min\(calc\(100vh - 120px\), 520px\)/u);
});

test('sandbox, review eval bar and landscape phones have their own sizing rules', () => {
  assert.match(css, /\.chesscom-layout\.sandbox-layout\s*\{[^}]*--board-max-w:[^}]*280px[^}]*300px/u);
  assert.match(css, /\.chesscom-layout:has\(\.eval-bar-container:not\(\.hidden\)\)\s*\{[^}]*--eval-reserve/u);
  assert.match(css, /@media \(max-width: 1000px\) and \(orientation: landscape\) and \(max-height: 560px\)/u);
});

test('the move list cannot push the action strip off-screen in single-column layout', () => {
  assert.match(css, /@media \(max-width: 1000px\)[\s\S]*?\.sidebar-content\s*\{\s*max-height:/u);
});

test('full-screen lobby ends in a solid colour so the home screen never shows through', () => {
  const rule = css.match(/\.live-lobby-overlay\s*\{[^}]*\}/u)?.[0] ?? '';
  assert.match(rule, /background:[^;]*,\s*#[0-9a-f]{6};/iu);
});

test('board coordinates scale with the board, respect the 12px floor and stay inside it', () => {
  const board = readFileSync(new URL('../src/board-night.css', import.meta.url), 'utf8');
  assert.match(board, /\.board-wrap\.cg-wrap coords\s*\{[^}]*font-size:\s*clamp\(12px,[^)]*var\(--board-size\)[^}]*opacity:\s*1/u);
  assert.match(board, /\.board-wrap\.cg-wrap coords\.files\s*\{\s*left:\s*0;/u);
});

test('mode descriptions wrap to two lines instead of being cut to one', () => {
  const rule = css.match(/\.chesscom-play-card \.c-desc\s*\{[^}]*\}/u)?.[0] ?? '';
  assert.match(rule, /-webkit-line-clamp:\s*2/u);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/u);
});

test('game-over and history results are neutral unless the viewer won, lost or drew', () => {
  assert.match(css, /\.gameover-title\s*\{[^}]*color:\s*var\(--text\)/u);
  for (const outcome of ['win', 'loss', 'draw']) {
    assert.ok(css.includes(`.gameover-title--${outcome} {`), `.gameover-title--${outcome}`);
    assert.ok(css.includes(`.history-result--${outcome} {`), `.history-result--${outcome}`);
  }
});

test('the review summary keeps its close button visible while scrolling', () => {
  assert.match(css, /\.review-summary-modal \.review-modal-close\s*\{[^}]*position:\s*sticky/u);
});

test('the night board replaces the brown theme', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /chessground\.brown\.css/u);
  assert.match(main, /import '\.\/board-night\.css';/u);
  const board = readFileSync(new URL('../src/board-night.css', import.meta.url), 'utf8');
  for (const name of ['board-light', 'board-dark', 'board-coord-on-light', 'board-coord-on-dark', 'board-last-move', 'board-selected', 'board-check']) {
    assert.match(board, new RegExp(`--${name}:`, 'u'), `--${name}`);
  }
});
