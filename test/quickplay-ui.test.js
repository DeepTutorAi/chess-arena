// Quick Play box: what it asks, what it does with the answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { createQuickPlayView } from '../src/quickplay-ui.js';
import { QUICK_TIMES } from '../src/quickplay.js';

function setup(t, overrides = {}) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  const calls = { starts: [], cancels: 0 };
  const view = createQuickPlayView({
    document: window.document,
    apiReady: true,
    profile: { name: 'Mali', avatar: 'rook' },
    times: QUICK_TIMES,
    timeControlId: 'blitz_5_0',
    onStart: async (request) => { calls.starts.push(request); return { ok: true }; },
    onCancel: () => { calls.cancels += 1; },
    ...overrides,
  });
  return { view, calls, document: window.document };
}

test('without a server the box explains why and offers nothing to press', (t) => {
  const { view } = setup(t, { apiReady: false });
  assert.match(view.textContent, /ยังไม่ได้ตั้งค่า/u);
  assert.equal(view.querySelector('button'), null);
});

test('the box is prefilled from the profile and preselects the remembered clock', (t) => {
  const { view } = setup(t, { timeControlId: 'rapid_10_0' });
  assert.equal(view.querySelector('input:not([type])').value, 'Mali');
  assert.equal(view.querySelector('select').value, 'rook');
  assert.equal(view.querySelector('input[name="quick-time"]:checked').value, 'rapid_10_0');
  assert.equal(view.querySelectorAll('input[name="quick-time"]').length, QUICK_TIMES.length);
});

test('starting sends the name, avatar and the clock that is chosen', async (t) => {
  const { view, calls } = setup(t);
  view.querySelector('input[value="blitz_3_1_5"]').checked = true;
  view.querySelector('input:not([type])').value = '  Somchai  ';
  view.querySelector('select').value = 'king';
  await view.submit();
  assert.deepEqual(calls.starts, [{ playerName: 'Somchai', avatar: 'king', timeControlId: 'blitz_3_1_5' }]);
});

test('a missing name is asked for and nothing is started', async (t) => {
  const { view, calls } = setup(t, { profile: { name: '', avatar: 'knight' } });
  await view.submit();
  assert.equal(calls.starts.length, 0);
  const status = view.querySelector('.quick-status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /ใส่ชื่อ/u);
  assert.equal(status.classList.contains('import-error'), true);
});

test('while searching the start button is off and cancel is shown; afterwards both reset', async (t) => {
  let release;
  const { view, calls } = setup(t, { onStart: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }) });
  const start = view.querySelector('.btn.primary');
  const cancel = [...view.querySelectorAll('button')].find((b) => b.textContent === 'ยกเลิก');
  const pending = view.submit();
  assert.equal(start.disabled, true);
  assert.equal(cancel.hidden, false);
  assert.match(view.querySelector('.quick-status').textContent, /กำลังหา/u);
  cancel.click();
  assert.equal(calls.cancels, 1);
  release();
  await pending;
  assert.equal(start.disabled, false);
  assert.equal(cancel.hidden, true);
});

test('a refusal or a thrown error is shown and the box can be used again', async (t) => {
  const refused = setup(t, { onStart: async () => ({ ok: false, message: 'ห้องเต็ม' }) });
  await refused.view.submit();
  assert.equal(refused.view.querySelector('.quick-status').textContent, 'ห้องเต็ม');
  assert.equal(refused.view.querySelector('.btn.primary').disabled, false);

  const thrown = setup(t, { onStart: async () => { throw new Error('offline'); } });
  await thrown.view.submit();
  assert.match(thrown.view.querySelector('.quick-status').textContent, /offline/u);
  assert.equal(thrown.view.querySelector('.btn.primary').disabled, false);
});

test('names are text, never markup', (t) => {
  const { view } = setup(t, { profile: { name: '<img src=x onerror=alert(1)>', avatar: 'knight' } });
  assert.equal(view.querySelector('img'), null);
  assert.equal(view.querySelector('input:not([type])').value, '<img src=x onerror=alert(1)>');
});

test('cancel is only offered while searching, not once a join or create is under way', async (t) => {
  let controls;
  let release;
  const { view } = setup(t, {
    onStart: (request, c) => { controls = c; return new Promise((resolve) => { release = () => resolve({ ok: true }); }); },
  });
  const cancel = [...view.querySelectorAll('button')].find((b) => b.textContent === 'ยกเลิก');
  const pending = view.submit();
  assert.equal(cancel.hidden, false, 'searching: can be cancelled');
  controls.setCancelable(false);
  assert.equal(cancel.hidden, true, 'joining: too late to cancel');
  controls.setCancelable(true);
  assert.equal(cancel.hidden, false);
  release();
  await pending;
  assert.equal(cancel.hidden, true);
});
