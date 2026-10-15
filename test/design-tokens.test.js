// Night Club Chess design tokens: every value the spec defines exists, and the
// text and fill pairs stay readable (WCAG AA) on every surface level.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tokens = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
const value = (name) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`, 'u'))?.[1].trim();

// WCAG 2.x relative luminance and contrast ratio for #rrggbb colours.
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const REQUIRED = ['bg', 'surface-1', 'surface-2', 'surface-3', 'border', 'border-strong', 'text', 'text-muted',
  'text-subtle', 'accent', 'accent-hover', 'on-accent', 'gold', 'on-gold', 'win', 'loss', 'draw', 'warn', 'info',
  'scrim', 'glass', 'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'fs-2xl', 'fs-3xl', 'fs-display', 'space-1',
  'space-2', 'space-3', 'space-4', 'space-6', 'space-8', 'space-12', 'radius-sm', 'radius-md', 'radius-lg',
  'radius-full', 'shadow-1', 'shadow-2', 'shadow-3', 'ring-focus', 'dur-fast', 'dur-base', 'dur-slow', 'ease-out',
  'font-sans'];

test('every spec token is defined', () => {
  for (const name of REQUIRED) assert.ok(value(name), `--${name}`);
  assert.equal(value('text-subtle'), '#8a93a3');
  assert.equal(value('loss'), '#f36e68');
});

test('text and status tokens reach 4.5:1 on every surface', () => {
  for (const fg of ['text', 'text-muted', 'text-subtle', 'accent', 'gold', 'loss', 'warn', 'info']) {
    for (const bg of ['bg', 'surface-1', 'surface-2', 'surface-3']) {
      assert.ok(contrast(value(fg), value(bg)) >= 4.5, `--${fg} on --${bg}`);
    }
  }
});

test('fill pairs reach 4.5:1', () => {
  assert.ok(contrast(value('on-accent'), value('accent')) >= 4.5);
  assert.ok(contrast(value('on-gold'), value('gold')) >= 4.5);
});

test('no type token below 12px', () => {
  for (const name of ['fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'fs-2xl', 'fs-3xl']) {
    assert.ok(parseFloat(value(name)) >= 12, `--${name}`);
  }
  assert.equal(value('fs-display'), 'clamp(28px, 4vw, 44px)');
});

test('board coordinates reach 4.5:1 against the squares they sit on', () => {
  const board = readFileSync(new URL('../src/board-night.css', import.meta.url), 'utf8');
  const boardValue = (name) => board.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'iu'))?.[1];
  assert.ok(contrast(boardValue('board-coord-on-light'), boardValue('board-light')) >= 4.5);
  assert.ok(contrast(boardValue('board-coord-on-dark'), boardValue('board-dark')) >= 4.5);
});

test('legacy colour names are gone once every screen is migrated', () => {
  for (const name of ['panel', 'panel-2', 'line', 'muted', 'amber', 'red', 'lobby-green', 'lobby-gold']) {
    assert.equal(value(name), undefined, `--${name} is still defined`);
  }
});
