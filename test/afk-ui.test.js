import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { UI } from '../src/ui.js';

test('AFK warning is an accessible live region with a visible countdown', (t) => {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ui = new UI(root);

  ui.setAfkWarning({
    visible: true,
    title: 'คู่แข่งกำลังถูกนับ AFK',
    detail: 'ออกจากแท็บระหว่างตา',
    remainingSeconds: 40,
    danger: false,
  });

  assert.equal(ui.refs.afkWarning.classList.contains('hidden'), false);
  assert.equal(ui.refs.afkWarning.getAttribute('role'), 'status');
  assert.equal(ui.refs.afkWarning.getAttribute('aria-live'), 'polite');
  assert.match(ui.refs.afkWarning.textContent, /คู่แข่งกำลังถูกนับ AFK/u);
  assert.match(ui.refs.afkWarning.textContent, /40/u);

  ui.setAfkWarning({ visible: false });
  assert.equal(ui.refs.afkWarning.classList.contains('hidden'), true);
});
