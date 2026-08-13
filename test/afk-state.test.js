import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceAfkAfterMove,
  applyPlayerHeartbeat,
  applyPlayerPresence,
  createAfkState,
  nextAfkDeadline,
  openingAfkLimitMs,
  realizeAfk,
  toPublicAfk,
} from '../worker/afk-state.js';

const LIMITS = [
  ['bullet_1_0', 15_000],
  ['bullet_1_1', 15_000],
  ['blitz_3_1_5', 20_000],
  ['blitz_5_0', 25_000],
  ['rapid_10_0', 30_000],
  ['rapid_15_0', 35_000],
  ['classical_30_0', 40_000],
  ['unlimited', 40_000],
];

function activeState({ timeControlId = 'unlimited', moves = [], turn = 'w', now = 1_000 } = {}) {
  return {
    status: 'active',
    timeControlId,
    moves: [...moves],
    turn,
    revision: 1 + moves.length,
    result: null,
    reason: null,
    updatedAt: now,
    clock: null,
    afk: createAfkState(timeControlId, now),
  };
}

test('opening limits map every time control to the approved literal deadline', () => {
  for (const [timeControlId, expected] of LIMITS) {
    assert.equal(openingAfkLimitMs(timeControlId), expected, timeControlId);
  }
  assert.throws(() => openingAfkLimitMs('unknown'));
});

test('opening AFK applies to only the first two plies and never reactivates', () => {
  let state = activeState({ timeControlId: 'bullet_1_0', now: 1_000 });
  assert.equal(state.afk.openingDeadlineAt, 16_000);
  assert.equal(nextAfkDeadline(state), 16_000);

  state.moves.push('e2e4');
  state.turn = 'b';
  state = advanceAfkAfterMove(state, 5_000);
  assert.equal(state.afk.openingDeadlineAt, 20_000);

  state.moves.push('e7e5');
  state.turn = 'w';
  state = advanceAfkAfterMove(state, 8_000);
  assert.equal(state.afk.openingDeadlineAt, null);

  state.moves.push('g1f3');
  state.turn = 'b';
  state = advanceAfkAfterMove(state, 9_000);
  assert.equal(state.afk.openingDeadlineAt, null);
});

test('opening deadline produces one canonical opening AFK loss', () => {
  const state = activeState({ timeControlId: 'blitz_3_1_5', now: 1_000 });
  const before = structuredClone(state);
  const result = realizeAfk(state, 21_000);

  assert.equal(result.changed, true);
  assert.equal(result.state.status, 'finished');
  assert.equal(result.state.result, '0-1');
  assert.equal(result.state.reason, 'opening_afk_timeout');
  assert.equal(result.state.revision, 2);
  assert.equal(state.status, before.status, 'input state is immutable');
  assert.equal(realizeAfk(result.state, 21_001).changed, false, 'repeated alarms are idempotent');
});

test('Unlimited hidden episodes recover twice and the third distinct episode loses immediately', () => {
  let state = activeState({ moves: ['e2e4', 'e7e5'], now: 10_000 });
  state.afk = advanceAfkAfterMove(state, 10_000).afk;

  let result = applyPlayerPresence(state, 'w', 'hidden', 20_000);
  assert.equal(result.changed, true);
  state = result.state;
  assert.deepEqual(state.afk.episode, {
    color: 'w', cause: 'hidden', startedAt: 20_000, deadlineAt: 60_000,
  });
  assert.equal(state.afk.strikes.w, 1);

  result = applyPlayerPresence(state, 'w', 'hidden', 21_000);
  assert.equal(result.changed, false);
  assert.equal(result.state.afk.strikes.w, 1);

  state = applyPlayerPresence(state, 'w', 'visible', 22_000).state;
  assert.equal(state.afk.episode, null);
  assert.equal(state.afk.strikes.w, 1);

  state = applyPlayerPresence(state, 'w', 'hidden', 23_000).state;
  assert.equal(state.afk.strikes.w, 2);
  state = applyPlayerPresence(state, 'w', 'visible', 24_000).state;

  result = applyPlayerPresence(state, 'w', 'hidden', 25_000);
  assert.equal(result.state.status, 'finished');
  assert.equal(result.state.result, '0-1');
  assert.equal(result.state.reason, 'unlimited_afk_strikes');
  assert.equal(result.state.revision, state.revision + 1);
});

test('Unlimited visible inactivity and missing heartbeat start bounded episodes', () => {
  let inactive = activeState({ moves: ['e2e4', 'e7e5'], now: 1_000 });
  inactive = advanceAfkAfterMove(inactive, 1_000);
  inactive.afk.presence.w.lastHeartbeatAt = 240_900;
  let result = realizeAfk(inactive, 241_000);
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.afk.episode, {
    color: 'w', cause: 'inactivity', startedAt: 241_000, deadlineAt: 281_000,
  });

  let heartbeat = activeState({ moves: ['e2e4', 'e7e5'], now: 1_000 });
  heartbeat = advanceAfkAfterMove(heartbeat, 1_000);
  heartbeat.afk.turnStartedAt = 100_000;
  heartbeat.afk.presence.w.lastHeartbeatAt = 1_000;
  result = realizeAfk(heartbeat, 31_000);
  assert.equal(result.changed, true);
  assert.equal(result.state.afk.episode.cause, 'heartbeat');
  assert.equal(result.state.afk.episode.deadlineAt, 71_000);
});

test('Unlimited episode expiry loses while heartbeat recovery and a legal move clear only allowed episodes', () => {
  let state = activeState({ moves: ['e2e4', 'e7e5'], now: 1_000 });
  state = advanceAfkAfterMove(state, 1_000);
  state = applyPlayerHeartbeat(state, 'w', 'hidden', 2_000).state;
  assert.equal(state.afk.episode.cause, 'hidden');
  state = applyPlayerHeartbeat(state, 'w', 'visible', 3_000).state;
  assert.equal(state.afk.episode, null);

  state.afk.turnStartedAt = 1_000;
  state.afk.presence.w.lastHeartbeatAt = 240_900;
  state = realizeAfk(state, 241_000).state;
  assert.equal(state.afk.episode.cause, 'inactivity');
  assert.notEqual(applyPlayerPresence(state, 'w', 'visible', 242_000).state.afk.episode, null);

  const expired = realizeAfk(state, 281_000);
  assert.equal(expired.state.reason, 'unlimited_afk_timeout');
  assert.equal(expired.state.result, '0-1');

  let moved = activeState({ moves: ['e2e4', 'e7e5', 'g1f3'], turn: 'b', now: 300_000 });
  moved.afk.episode = { color: 'w', cause: 'inactivity', startedAt: 250_000, deadlineAt: 290_000 };
  moved = advanceAfkAfterMove(moved, 300_000);
  assert.equal(moved.afk.episode, null);
  assert.equal(moved.afk.turnStartedAt, 300_000);
});

test('timed games never start post-opening AFK and public AFK omits heartbeat authority', () => {
  let state = activeState({ timeControlId: 'blitz_5_0', moves: ['e2e4', 'e7e5'], now: 1_000 });
  state = advanceAfkAfterMove(state, 1_000);
  const result = applyPlayerPresence(state, 'w', 'hidden', 2_000);
  assert.equal(result.changed, false);
  assert.equal(realizeAfk(state, 500_000).changed, false);

  state.afk.strikes.w = 2;
  const view = toPublicAfk(state);
  assert.deepEqual(view, { strikes: { w: 2, b: 0 }, countdown: null });
  assert.equal(JSON.stringify(view).includes('lastHeartbeatAt'), false);
});
