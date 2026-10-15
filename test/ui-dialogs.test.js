// Shared dialog and card behaviour: confirmations keep the safe choice under
// the keyboard, clickable cards work from the keyboard, and the game-over
// title is coloured by the viewer's outcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { UI, boardAnimationEnabled, makeActivatable } from '../src/ui.js';

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

test('Tab and Shift+Tab stay inside an open modal, including buttons added after it opened', (t) => {
  const { window, ui } = setup(t);
  const body = document.createElement('div');
  body.innerHTML = '<button id="first">a</button>';
  ui.openModal('T', body);
  const late = document.createElement('button');
  late.id = 'last';
  body.appendChild(late);
  late.focus();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.className, 'modal-close', 'wraps to the first focusable (the close button)');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'last');
});

test('openModal applies the requested size', (t) => {
  const { ui } = setup(t);
  ui.openModal('T', null, { size: 'lg' });
  assert.ok(document.querySelector('.modal').classList.contains('modal--lg'));
  ui.openModal('T', null);
  assert.ok(document.querySelector('.modal').classList.contains('modal--md'), 'md is the default');
});

test('board animation follows the reduced-motion preference', () => {
  assert.equal(boardAnimationEnabled(() => ({ matches: true })), false);
  assert.equal(boardAnimationEnabled(() => ({ matches: false })), true);
  assert.equal(boardAnimationEnabled(undefined), true, 'no matchMedia (tests, old browsers): animate');
});

test('openModal reports every way it closes exactly once', (t) => {
  const { window, ui } = setup(t);
  let closed = 0;
  const modal = ui.openModal('T', null, { onClose: () => { closed += 1; } });
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  modal.close();
  assert.equal(closed, 1, 'Escape closes and reports once; a later close() is a no-op');
});

test('confirmations put their buttons in the sticky action bar; danger is outlined, not primary', (t) => {
  const { ui } = setup(t);
  ui.confirm({ title: 'T', message: 'M', confirmLabel: 'ยอมแพ้', cancelLabel: 'เล่นต่อ', danger: true, onConfirm() {} });
  const actions = document.querySelector('.confirm-dialog .modal-actions');
  assert.ok(actions, 'buttons live in .modal-actions');
  const danger = [...actions.querySelectorAll('button')].find((b) => b.textContent === 'ยอมแพ้');
  assert.ok(danger.classList.contains('btn') && danger.classList.contains('danger'));
  assert.equal(danger.classList.contains('primary'), false);
});

test('a toast takes a tone and defaults to info', (t) => {
  const { ui } = setup(t);
  const warn = ui.showFloatingToast({ title: 'Bob ออกจากห้องแล้ว', tone: 'warn', channel: 'a' });
  assert.ok(warn.classList.contains('toast') && warn.classList.contains('toast--warn'));
  const info = ui.showFloatingToast({ title: 'ส่งข้อเสนอเสมอแล้ว', channel: 'b' });
  assert.ok(info.classList.contains('toast--info'));
  assert.ok(info.classList.contains('floating-toast'), 'the positioning class stays');
});

test('Shift+Tab from the dialog container itself stays inside the modal', (t) => {
  const { window, ui } = setup(t);
  const body = document.createElement('div');
  body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
  ui.openModal('T', body);
  assert.equal(document.activeElement.classList.contains('modal'), true, 'focus starts on the container');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'b', 'wraps to the last control instead of escaping');
});

test('Escape closes a modal and returns focus to the control that opened it', (t) => {
  const { window, ui } = setup(t);
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  ui.openModal('T', null);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.modal'), null);
  assert.equal(document.activeElement, opener);
});
