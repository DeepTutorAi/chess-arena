// Quick Play: pick the right open table, survive a lost race, or open one.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUICK_TIME, MAX_JOIN_ATTEMPTS, QUICK_TIMES, isQuickTime, quickPlayCandidates, quickPlayRoom, runQuickPlay,
} from '../src/quickplay.js';

const room = (id, extra = {}) => ({
  roomId: id, title: id, status: 'waiting', openColor: 'b', guest: null, timeControlId: 'blitz_5_0',
  createdAt: 1_000, expiresAt: 10_000_000, host: { name: 'H', avatar: 'knight' }, ...extra,
});

test('only tables that are open, ours-not, on the right clock and not expired qualify', () => {
  const rooms = [
    room('ok'),
    room('active', { status: 'active' }),
    room('nocolor', { openColor: null }),
    room('taken', { guest: { name: 'G' } }),
    room('mine'),
    room('slow', { timeControlId: 'rapid_10_0' }),
    room('old', { expiresAt: 500 }),
  ];
  const found = quickPlayCandidates(rooms, { timeControlId: 'blitz_5_0', ownRoomIds: ['mine'], now: 2_000 });
  assert.deepEqual(found.map((r) => r.roomId), ['ok']);
});

test('the table that has waited longest comes first', () => {
  const found = quickPlayCandidates([room('new', { createdAt: 9_000 }), room('old', { createdAt: 1_000 }), room('mid', { createdAt: 5_000 })], { timeControlId: 'blitz_5_0', now: 2_000 });
  assert.deepEqual(found.map((r) => r.roomId), ['old', 'mid', 'new']);
});

function deps({ rooms = [], joinFails = [], listFails = false } = {}) {
  const log = [];
  return {
    log,
    deps: {
      listLobby: async (filters) => { log.push(['list', filters]); if (listFails) throw new Error('offline'); return { rooms, serverTime: 2_000 }; },
      join: async (r) => { log.push(['join', r.roomId]); if (joinFails.includes(r.roomId)) throw new Error('room_full'); },
      create: async () => { log.push(['create']); },
    },
  };
}

test('joins the waiting table when there is one', async () => {
  const { deps: d, log } = deps({ rooms: [room('a'), room('b', { createdAt: 500 })] });
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0' });
  assert.equal(result.outcome, 'joined');
  assert.equal(result.room.roomId, 'b', 'the longest-waiting one');
  assert.deepEqual(log.map((l) => l[0]), ['list', 'join'], 'no table is created');
  assert.deepEqual(log[0][1], { status: 'open', time: 'all' });
});

test('a lost race falls through to the next table, then to creating one', async () => {
  const first = deps({ rooms: [room('a', { createdAt: 1 }), room('b', { createdAt: 2 })], joinFails: ['a'] });
  const r1 = await runQuickPlay(first.deps, { timeControlId: 'blitz_5_0' });
  assert.deepEqual([r1.outcome, r1.room.roomId, r1.tried], ['joined', 'b', 2]);

  const second = deps({ rooms: [room('a', { createdAt: 1 }), room('b', { createdAt: 2 })], joinFails: ['a', 'b'] });
  const r2 = await runQuickPlay(second.deps, { timeControlId: 'blitz_5_0' });
  assert.deepEqual([r2.outcome, r2.tried], ['created', 2]);
  assert.deepEqual(second.log.map((l) => l[0]), ['list', 'join', 'join', 'create']);
});

test('at most a few tables are tried before opening our own', async () => {
  const many = Array.from({ length: 10 }, (_, i) => room(`r${i}`, { createdAt: i }));
  const { deps: d, log } = deps({ rooms: many, joinFails: many.map((r) => r.roomId) });
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0' });
  assert.equal(result.outcome, 'created');
  assert.equal(log.filter((l) => l[0] === 'join').length, MAX_JOIN_ATTEMPTS);
});

test('no open table: one is created', async () => {
  const { deps: d, log } = deps({ rooms: [room('other-clock', { timeControlId: 'rapid_10_0' })] });
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0' });
  assert.equal(result.outcome, 'created');
  assert.deepEqual(log.map((l) => l[0]), ['list', 'create']);
});

test('an unreadable lobby still gets the player a table', async () => {
  const { deps: d, log } = deps({ listFails: true });
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0' });
  assert.equal(result.outcome, 'created');
  assert.deepEqual(log.map((l) => l[0]), ['list', 'create']);
});

test('our own waiting table is never "found" again', async () => {
  const { deps: d } = deps({ rooms: [room('mine')] });
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0', ownRoomIds: ['mine'] });
  assert.equal(result.outcome, 'created');
});

test('cancelling while the lobby is being read stops before joining or creating anything', async () => {
  let cancelled = false;
  const { deps: d, log } = deps({ rooms: [room('a')] });
  const original = d.listLobby;
  d.listLobby = async (f) => { const r = await original(f); cancelled = true; return r; };
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0', cancelled: () => cancelled });
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(log.map((l) => l[0]), ['list'], 'no seat taken, no table opened behind the player\'s back');
});

test('the phases are reported, so the UI can stop offering "cancel" once a join is under way', async () => {
  const phases = [];
  const { deps: d } = deps({ rooms: [room('a')] });
  await runQuickPlay(d, { timeControlId: 'blitz_5_0', onPhase: (p) => phases.push(p) });
  assert.deepEqual(phases, ['searching', 'joining']);

  const created = [];
  await runQuickPlay(deps().deps, { timeControlId: 'blitz_5_0', onPhase: (p) => created.push(p) });
  assert.deepEqual(created, ['searching', 'creating']);
});

test('a table of ours that is still waiting on this clock is resumed, not duplicated', async () => {
  const { deps: d, log } = deps({ rooms: [room('mine'), room('other', { createdAt: 5 })] });
  const resumed = [];
  d.resume = async (r) => { resumed.push(r.roomId); log.push(['resume', r.roomId]); };
  const result = await runQuickPlay(d, { timeControlId: 'blitz_5_0', ownRoomIds: ['mine'] });
  assert.equal(result.outcome, 'resumed');
  assert.deepEqual(resumed, ['mine']);
  assert.deepEqual(log.map((l) => l[0]), ['list', 'resume'], 'nobody else\'s table is joined and none is created');
});

test('our waiting table on a different clock, or one that cannot be resumed, does not block a normal search', async () => {
  const other = deps({ rooms: [room('mine', { timeControlId: 'rapid_10_0' })] });
  other.deps.resume = async () => { throw new Error('should not be tried'); };
  assert.equal((await runQuickPlay(other.deps, { timeControlId: 'blitz_5_0', ownRoomIds: ['mine'] })).outcome, 'created');

  const gone = deps({ rooms: [room('mine'), room('other', { createdAt: 5 })] });
  gone.deps.resume = async () => { throw new Error('session lost'); };
  const result = await runQuickPlay(gone.deps, { timeControlId: 'blitz_5_0', ownRoomIds: ['mine'] });
  assert.equal(result.outcome, 'joined', 'falls through to the other table');
  assert.equal(result.room.roomId, 'other');
});

test('only the offered time controls are accepted', async () => {
  await assert.rejects(runQuickPlay(deps().deps, { timeControlId: 'bullet_1_0' }), /รูปแบบเวลา/u);
  assert.equal(isQuickTime('rapid_10_0'), true);
  assert.equal(isQuickTime('unlimited'), false);
  assert.ok(QUICK_TIMES.some((t) => t.id === DEFAULT_QUICK_TIME));
});

test('the table Quick Play opens is public, watchable and random-coloured', () => {
  assert.deepEqual(quickPlayRoom({ playerName: 'Me', avatar: 'rook', timeControlId: 'rapid_10_0' }), {
    action: 'create', playerName: 'Me', avatar: 'rook', title: 'Quick Play', color: 'random',
    timeControlId: 'rapid_10_0', visibility: 'public', allowSpectators: true,
  });
});
