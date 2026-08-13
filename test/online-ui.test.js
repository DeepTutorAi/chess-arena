import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { UI } from '../src/ui.js';

test('player-facing online shell contains no GitHub token control and routes to online mode', (t) => {
  const window = new Window({ url: 'http://localhost:5173/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);

  const ui = new UI(root);
  const onlineButton = root.querySelector('#sb-mode-online');

  assert.equal(onlineButton.dataset.mode, 'online');
  assert.equal(root.textContent.includes('GitHub Token'), false);
  assert.equal(root.querySelector('input[type="password"]'), null);
  assert.equal('sbTokenInput' in ui.refs, false);
});
