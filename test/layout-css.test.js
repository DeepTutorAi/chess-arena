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
  assert.match(rule, /background:[^;]*,\s*var\(--bg\);/iu);
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
  // The close button sits in the summary's .modal-head, which components.css makes sticky.
  assert.match(css, /\.review-summary-modal \.modal-head\s*\{/u);
  const components = readFileSync(new URL('../src/components.css', import.meta.url), 'utf8');
  assert.match(components, /\.modal-head\s*\{[^}]*position:\s*sticky/u);
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

const readCss = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/giu;
const NON_TOKEN_FONT_SIZE = /font-size:(?!\s*var\()/gu;
// Measured on styles.css on 2026-10-15; each screen migration lowers these and
// the cleanup task sets both to 0.
const COLOUR_BASELINE = 19;
const FONT_SIZE_BASELINE = 12;

test('components.css uses tokens only', () => {
  assert.equal(readCss('components.css').match(RAW_COLOUR), null);
  assert.equal(readCss('components.css').match(NON_TOKEN_FONT_SIZE), null);
});

test('raw colours and font sizes in styles.css only go down', () => {
  const styles = readCss('styles.css');
  assert.ok((styles.match(RAW_COLOUR) ?? []).length <= COLOUR_BASELINE, `colours ${(styles.match(RAW_COLOUR) ?? []).length}`);
  assert.ok((styles.match(NON_TOKEN_FONT_SIZE) ?? []).length <= FONT_SIZE_BASELINE, `font sizes ${(styles.match(NON_TOKEN_FONT_SIZE) ?? []).length}`);
});

test('modal becomes a bottom sheet under 600px with sticky head and actions', () => {
  const c = readCss('components.css');
  assert.match(c, /@media \(max-width: 600px\)[\s\S]*?\.modal\s*\{[^}]*align-self:\s*flex-end/u);
  assert.match(c, /\.modal-head\s*\{[^}]*position:\s*sticky/u);
  assert.match(c, /\.modal-actions\s*\{[^}]*position:\s*sticky/u);
});

test('player bars are pinned to the board-size formula and clocks use tabular digits', () => {
  const styles = readCss('styles.css');
  assert.match(styles, /^\.player-bar\s*\{[^}]*height:\s*calc\(var\(--bars-h\) \/ 2\)[^}]*box-sizing:\s*border-box/mu);
  assert.match(styles, /^\.clock-badge\s*\{[^}]*font-variant-numeric:\s*tabular-nums/mu);
});

test('history actions keep the 40px button height and the import box keeps a focus ring', () => {
  const styles = readCss('styles.css');
  const rowBtn = styles.match(/\.history-row-actions \.btn\s*\{[^}]*\}/u)?.[0] ?? '';
  assert.doesNotMatch(rowBtn, /min-height|height:/u, 'row buttons inherit the shared 40px min-height');
  assert.match(readCss('components.css'), /^\.btn\s*\{[^}]*min-height:\s*40px/mu);
  const importFocus = styles.match(/\.import-text:focus[^{]*\{[^}]*\}/u)?.[0] ?? '';
  assert.doesNotMatch(importFocus, /outline:\s*none/u);
});
