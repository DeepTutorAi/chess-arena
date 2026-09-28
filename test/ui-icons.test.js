// Icon-system guards: text/emoji glyphs used as icons render differently per
// platform (♟ becomes a colour emoji on phones), the avatar SVGs were being
// overwritten with emoji on boot, and white-on-green buttons failed contrast.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Window } from 'happy-dom';

import { UI } from '../src/ui.js';
import * as icons from '../src/icons.js';

const root = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const srcFiles = readdirSync(`${root}src`).filter((f) => f.endsWith('.js'));

test('every icon in icons.js is used somewhere (no dead or duplicate icons)', () => {
  const others = srcFiles.filter((f) => f !== 'icons.js').map((f) => read(`src/${f}`)).join('\n');
  const unused = Object.keys(icons).filter((name) => name.startsWith('icon') && !new RegExp(`\\b${name}\\b`, 'u').test(others));
  assert.deepEqual(unused, []);
});

test('icon svgs are decorative by default and never focusable', () => {
  const markup = icons.iconClose({ size: 16 });
  assert.match(markup, /aria-hidden="true"/u);
  assert.match(markup, /focusable="false"/u);
  assert.match(markup, /stroke="currentColor"/u);
});

test('UI templates use SVG icons, not text/emoji glyphs', () => {
  const banned = ['✕', '▶', '⏸', '↺', '🔍', '🎯', '💡', '⏳', '⚠', '📖', '📌', '➔', '🏁', '♟️', '🤖', '👤'];
  for (const file of ['src/ui.js', 'src/review-ui.js', 'src/main.js']) {
    const text = read(file);
    const found = banned.filter((glyph) => text.includes(glyph));
    assert.deepEqual(found, [], `${file} still contains glyph icons: ${found.join(' ')}`);
  }
});

function makeUi(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  const root = document.createElement('div');
  document.body.appendChild(root);
  return new UI(root);
}

test('player avatars: built-in players get SVG icons, online glyphs become real pieces', (t) => {
  const ui = makeUi(t);
  ui.setPlayers({ name: 'Bot', icon: 'robot' }, { name: 'Me', icon: 'user' });
  assert.ok(ui.refs.avatarTop.querySelector('svg'), 'robot icon is an SVG');
  assert.ok(ui.refs.avatarBottom.querySelector('svg'));
  assert.equal(ui.refs.avatarTop.textContent.trim(), '', 'no emoji text');

  ui.setPlayers({ name: 'Guest', avatar: '♟' }, { name: 'Host', avatar: '♞' });
  assert.ok(ui.refs.avatarTop.querySelector('piece.pawn'), '♟ (emoji on phones) is drawn as the pawn piece');
  assert.ok(ui.refs.avatarBottom.querySelector('piece.knight'));
  assert.equal(ui.refs.avatarTop.querySelector('svg'), null);
});

test('an online avatar never leaks into the next bot game', (t) => {
  const ui = makeUi(t);
  ui.setPlayers({ name: 'Guest', avatar: '♜' }, { name: 'Host', avatar: '♞' });
  ui.setPlayers({ name: 'Bot', icon: 'robot' }, { name: 'Me', icon: 'user' });
  assert.equal(ui.refs.avatarTop.querySelector('piece'), null);
  assert.ok(ui.refs.avatarTop.querySelector('svg'));
});

// ---- contrast ---------------------------------------------------------------

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const css = read('src/styles.css');
const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'iu'))[1];

test('text on the accent-green fills meets WCAG AA (4.5:1)', () => {
  const onAccent = token('on-accent');
  assert.ok(contrast(onAccent, token('accent')) >= 4.5, `on-accent/accent ${contrast(onAccent, token('accent')).toFixed(2)}`);
  assert.ok(contrast(onAccent, token('accent-hover')) >= 4.5);
  for (const selector of ['\\.btn\\.primary', '\\.sandbox-start-btn', '\\.lobby-back-btn', '\\.exact-card-action-btn\\.join']) {
    const block = css.match(new RegExp(`^${selector}\\s*\\{[^}]*\\}`, 'mu'))?.[0] ?? '';
    assert.match(block, /color:\s*var\(--on-accent\)/u, `${selector} must use dark text on green`);
  }
});

test('danger hover keeps white text readable', () => {
  const hover = css.match(/\.btn\.danger:hover:not\(:disabled\)\s*\{\s*background:\s*(#[0-9a-f]{6})/iu)[1];
  assert.ok(contrast('#ffffff', hover) >= 4.5, `white on ${hover}: ${contrast('#ffffff', hover).toFixed(2)}`);
});
