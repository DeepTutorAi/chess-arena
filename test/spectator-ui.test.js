import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { UI } from '../src/ui.js';

test('spectator eye button opens an accessible profile panel and restores focus', (t) => {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ui = new UI(root);

  ui.setOnlineRole('host');
  ui.setSpectators({
    visible: true,
    spectators: [
      { id: 'viewer-one', name: 'Viewer One', avatar: 'bishop' },
      { id: 'viewer-two', name: 'Viewer Two', avatar: 'shield' },
    ],
  });
  const button = ui.refs.spectatorButton;
  assert.equal(button.getAttribute('aria-label'), 'ผู้ชม 2 คน');
  button.focus();
  button.click();
  assert.equal(ui.refs.spectatorPanel.hidden, false);
  assert.equal(ui.refs.spectatorPanel.getAttribute('role'), 'dialog');
  assert.match(ui.refs.spectatorPanel.textContent, /Viewer One/u);
  assert.match(ui.refs.spectatorPanel.textContent, /Watching/u);

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(ui.refs.spectatorPanel.hidden, true);
  assert.equal(document.activeElement, button);
});

test('spectator role hides player-only actions and zero-viewer state is truthful', (t) => {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  globalThis.window = window;
  globalThis.document = window.document;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ui = new UI(root);

  ui.setOnlineRole('spectator');
  ui.setSpectators({ visible: true, spectators: [] });
  assert.equal(ui.refs.btnResign.classList.contains('hidden'), true);
  ui.refs.spectatorButton.click();
  assert.match(ui.refs.spectatorPanel.textContent, /ยังไม่มีผู้ชม/u);
});
