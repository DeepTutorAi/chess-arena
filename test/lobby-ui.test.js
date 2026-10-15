import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { createLobbyView } from '../src/lobby.js';

const room = {
  roomId: 'aaaaaaaaaaaaaaaa',
  title: 'Friday Blitz',
  status: 'waiting',
  host: { name: 'Alice', avatar: 'knight' },
  guest: null,
  openColor: 'b',
  timeControlId: 'blitz_5_0',
  createdAt: 1_000,
  updatedAt: 2_000,
  spectatorCount: 2,
  allowSpectators: true,
  expiresAt: 99_999,
};

function setup(t, rooms = [room]) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  const root = window.document.createElement('div');
  window.document.body.appendChild(root);
  const calls = [];
  const view = createLobbyView({
    root,
    document: window.document,
    client: { async listLobby() { return { rooms, nextCursor: null, serverTime: 5_000 }; } },
    profile: { name: 'Guest', avatar: 'rook' },
    recentRooms: [],
    onJoin: (selected) => calls.push(['join', selected.roomId]),
    onWatch: (selected) => calls.push(['watch', selected.roomId]),
    onReconnect: () => {},
    onCreate: () => calls.push(['create']),
    onClose: () => calls.push(['close']),
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  return { window, root, calls, view };
}

test('live lobby renders authoritative cards and never shows an invite textbox', async (t) => {
  const { root, calls, view } = setup(t);
  await view.ready;

  assert.equal(root.querySelector('input[type="url"]'), null);
  assert.match(root.textContent, /Friday Blitz/u);
  assert.match(root.textContent, /Alice/u);
  assert.match(root.textContent, /1\/2/u);
  assert.match(root.textContent, /ผู้ชม 2/u);
  const join = root.querySelector('.room-action.join');
  assert.ok(join);
  join.click();
  assert.deepEqual(calls, [['join', room.roomId]]);
  view.destroy();
});

test('live lobby renders Watch and a truthful empty state', async (t) => {
  const active = { ...room, status: 'active', openColor: null, guest: { name: 'Bob', avatar: 'bishop' } };
  const first = setup(t, [active]);
  await first.view.ready;
  const watch = first.root.querySelector('.room-action.watch');
  assert.ok(watch);
  watch.click();
  assert.deepEqual(first.calls, [['watch', active.roomId]]);
  first.view.destroy();

  const empty = setup(t, []);
  await empty.view.ready;
  assert.match(empty.root.textContent, /ยังไม่มีห้องสาธารณะ/u);
  empty.view.destroy();
});

test('failed refresh labels stale cards and disables room actions', async (t) => {
  const { window, root, view } = setup(t);
  await view.ready;
  view.client.listLobby = async () => { throw new Error('offline'); };
  await view.refresh();

  assert.match(root.textContent, /รายการอาจไม่ใช่สถานะล่าสุด/u);
  const roomAction = root.querySelector('.room-action');
  assert.equal(roomAction.disabled, true);
  assert.ok(root.querySelector('[role="alert"]'));
  assert.equal(window.document.activeElement === roomAction, false);
  view.destroy();
});

test('lobby filters on the server and pages with nextCursor instead of slicing one page', async (t) => {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  const root = window.document.createElement('div');
  window.document.body.appendChild(root);
  const second = { ...room, roomId: 'bbbbbbbbbbbbbbbb', title: 'Older Open Table', host: { name: 'Carol', avatar: 'king' } };
  const requests = [];
  const client = {
    async listLobby(filters) {
      requests.push({ ...filters });
      if (filters.cursor === 'page2') return { rooms: [second], nextCursor: null, serverTime: 5_000 };
      return { rooms: [room], nextCursor: 'page2', serverTime: 5_000 };
    },
  };
  const view = createLobbyView({
    root,
    document: window.document,
    client,
    profile: { name: 'Guest', avatar: 'rook' },
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  t.after(() => view.destroy());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await view.ready;

  assert.deepEqual(requests, [{ status: 'all', time: 'all', search: '' }]);
  const loadMore = root.querySelector('.lobby-load-more-btn');
  assert.equal(loadMore.hidden, false, 'more pages are offered while the server has a cursor');
  assert.doesNotMatch(root.textContent, /Older Open Table/u);

  loadMore.click();
  await settle();
  assert.deepEqual(requests.slice(1), [
    { status: 'all', time: 'all', search: '' },
    { status: 'all', time: 'all', search: '', cursor: 'page2' },
  ]);
  assert.match(root.textContent, /Older Open Table/u, 'the second server page is shown');
  assert.equal(loadMore.hidden, true, 'no more pages after the last cursor');

  requests.length = 0;
  root.querySelector('[data-tab="open"]').click();
  await settle();
  assert.deepEqual(requests, [{ status: 'open', time: 'all', search: '' }], 'tab filter goes to the server and restarts paging');

  requests.length = 0;
  const time = root.querySelector('.lobby-time-filter');
  time.value = 'blitz';
  time.dispatchEvent(new window.Event('change'));
  await settle();
  assert.deepEqual(requests, [{ status: 'open', time: 'blitz', search: '' }]);
});
