// Shared dialog and card behaviour: confirmations keep the safe choice under
// the keyboard, clickable cards work from the keyboard, and the game-over
// title is coloured by the viewer's outcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { UI, makeActivatable } from '../src/ui.js';

function setup(t) {
  const window = new Window({ url: 'http://localhost:5173/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement; // openModal's close restores focus
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  return { window, ui: new UI(root) };
}

test('a destructive confirmation focuses the safe button; confirming runs the action once', (t) => {
  const { ui } = setup(t);
  let confirmed = 0;
  ui.confirm({
    title: 'ยืนยันการยอมแพ้',
    message: 'แน่ใจไหม?',
    confirmLabel: 'ยอมแพ้',
    cancelLabel: 'เล่นต่อ',
    danger: true,
    onConfirm: () => { confirmed += 1; },
  });
  assert.equal(document.activeElement.textContent, 'เล่นต่อ', 'Enter on open keeps playing');

  const buttons = [...document.querySelectorAll('.confirm-dialog button')];
  buttons.find((b) => b.textContent === 'ยอมแพ้').click();
  assert.equal(confirmed, 1);
  assert.equal(document.querySelector('.confirm-dialog'), null, 'the dialog closes');
});

test('cancelling a confirmation does nothing; a non-destructive one focuses confirm', (t) => {
  const { ui } = setup(t);
  let confirmed = 0;
  ui.confirm({ title: 'T', message: 'M', confirmLabel: 'ตกลง', danger: true, onConfirm: () => { confirmed += 1; } });
  [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent === 'ยกเลิก').click();
  assert.equal(confirmed, 0);

  ui.confirm({ title: 'T', message: 'M', confirmLabel: 'ตกลง', onConfirm() {} });
  assert.equal(document.activeElement.textContent, 'ตกลง');
});

test('an activatable card is a focusable button for Enter, Space and click', (t) => {
  const { window } = setup(t);
  const card = document.createElement('div');
  document.body.appendChild(card);
  let activations = 0;
  makeActivatable(card, () => { activations += 1; });
  assert.equal(card.getAttribute('role'), 'button');
  assert.equal(card.tabIndex, 0);

  card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  card.dispatchEvent(space);
  card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  card.click();
  assert.equal(activations, 3);
  assert.equal(space.defaultPrevented, true, 'Space does not scroll the dialog');
});

test('the game-over title takes the outcome colour class, or none for a neutral result', (t) => {
  const { ui } = setup(t);
  ui.showGameOver('คุณแพ้', 'รุกฆาต', () => {}, () => {}, null, null, null, 'loss');
  assert.ok(document.querySelector('.gameover-title').classList.contains('gameover-title--loss'));

  ui.showGameOver('เกมจบแล้ว', '', () => {}, () => {});
  assert.equal(document.querySelector('.gameover-title').className, 'gameover-title');
});
