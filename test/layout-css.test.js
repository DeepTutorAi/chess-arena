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
