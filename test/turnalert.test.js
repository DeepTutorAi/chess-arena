// "It's your turn" alert for a hidden tab: blinking title + vibration, gone as
// soon as the tab is visible again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { createTurnAlert } from '../src/turnalert.js';
import { Controller, MODES } from '../src/controller.js';

function fakeDoc({ hidden = true, title = 'Chess Arena' } = {}) {
  const listeners = {};
  return {
    hidden,
    title,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { (listeners[type] ?? []).forEach((fn) => fn()); },
  };
}

function fakeTimers() {
  const timers = [];
  return {
    setIntervalImpl: (fn) => { timers.push({ fn, cleared: false }); return timers.length; },
    clearIntervalImpl: (id) => { timers[id - 1].cleared = true; },
    tick: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()),
    timers,
  };
}

test('hidden tab: the title announces the turn, blinks, and the phone vibrates', () => {
  const doc = fakeDoc();
  const timers = fakeTimers();
  const vibrations = [];
  const alert = createTurnAlert({ doc, nav: { vibrate: (p) => vibrations.push(p) }, ...timers });

  assert.equal(alert.notify('ถึงตาคุณ'), true);
  assert.equal(doc.title, '● ถึงตาคุณ — Chess Arena');
  assert.equal(alert.active, true);
  assert.equal(vibrations.length, 1);

  timers.tick();
  assert.equal(doc.title, 'Chess Arena', 'blinks back to the plain title');
  timers.tick();
  assert.equal(doc.title, '● ถึงตาคุณ — Chess Arena');

  alert.notify('ถึงตาคุณ'); // a second alert must not stack timers
  assert.equal(timers.timers.length, 1);
});

test('the alert ends the moment the tab becomes visible, restoring the real title', () => {
  const doc = fakeDoc();
  const timers = fakeTimers();
  const alert = createTurnAlert({ doc, nav: {}, ...timers });
  alert.notify();
  doc.hidden = false;
  doc.fire('visibilitychange');
  assert.equal(doc.title, 'Chess Arena');
  assert.equal(alert.active, false);
  assert.equal(timers.timers[0].cleared, true);
});

test('a visible tab is never alerted, and missing vibrate support is fine', () => {
  const visible = fakeDoc({ hidden: false });
  const alert = createTurnAlert({ doc: visible, nav: { vibrate: () => { throw new Error('should not vibrate'); } }, ...fakeTimers() });
  assert.equal(alert.notify(), false);
  assert.equal(visible.title, 'Chess Arena');

  const noVibrate = createTurnAlert({ doc: fakeDoc(), nav: {}, ...fakeTimers() });
  assert.equal(noVibrate.notify(), true);
  const throwing = createTurnAlert({ doc: fakeDoc(), nav: { vibrate: () => { throw new Error('blocked'); } }, ...fakeTimers() });
  assert.equal(throwing.notify(), true, 'a blocked vibrate() does not break the alert');
});

test('clear() restores the title (used when the game is torn down)', () => {
  const doc = fakeDoc();
  const alert = createTurnAlert({ doc, nav: {}, ...fakeTimers() });
  alert.notify();
  alert.clear();
  assert.equal(doc.title, 'Chess Arena');
  assert.equal(alert.active, false);
});

test('no document at all (node) is a harmless no-op', () => {
  const alert = createTurnAlert({ doc: undefined, nav: undefined });
  assert.equal(alert.notify(), false);
  alert.clear();
});

// ---- controller wiring ---------------------------------------------------------

function botGame(alerts) {
  const ui = new Proxy({}, { get: () => () => {} });
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {} };
  const controller = new Controller({
    ui, ground, onPromotion: async () => 'q', turnAlert: { notify: (m) => alerts.push(m), clear: () => alerts.push('clear') },
  });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'w';
  controller.game = new Chess();
  controller.engineReady = false; // never reach the real engine
  return controller;
}

test('vs bot: the bot\'s reply that hands the move to the human raises the alert', () => {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const alerts = [];
  const controller = botGame(alerts);
  controller.game.move('e4');
  controller.game.move('e5'); // the bot has answered: white to move
  controller._afterMove(controller.game.history({ verbose: true }).at(-1));
  assert.ok(alerts.includes('ถึงตาคุณ'), JSON.stringify(alerts));
});

test('vs bot: the human\'s own move does not alert (the bot is to move)', () => {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const alerts = [];
  const controller = botGame(alerts);
  controller.game.move('e4'); // human moved, bot to move
  controller._afterMove(controller.game.history({ verbose: true }).at(-1));
  assert.ok(!alerts.includes('ถึงตาคุณ'));
});

test('dispose clears any running alert', () => {
  const alerts = [];
  const controller = botGame(alerts);
  controller.dispose();
  assert.ok(alerts.includes('clear'));
});
