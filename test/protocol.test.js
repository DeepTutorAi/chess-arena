import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCreateRequest, parseJoinRequest, parseSocketCommand } from '../worker/protocol.js';

test('parseCreateRequest normalizes valid player-controlled room settings', () => {
  const result = parseCreateRequest({
    playerName: '  Alice  ',
    title: '  Friday game  ',
    color: 'random',
    timeControlId: 'blitz_5_0',
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      playerName: 'Alice',
      title: 'Friday game',
      color: 'random',
      timeControlId: 'blitz_5_0',
      initialFen: undefined,
    },
  });
});

test('parseCreateRequest rejects malformed and authority-claiming input', () => {
  assert.equal(parseCreateRequest(null).ok, false);
  assert.equal(parseCreateRequest({ playerName: '' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', color: 'green' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', fen: 'client owned' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', result: '1-0' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A'.repeat(41) }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', title: 'T'.repeat(81) }).ok, false);
});

test('parseJoinRequest accepts only a player name and capability', () => {
  const token = 'A'.repeat(43);
  assert.deepEqual(parseJoinRequest({ playerName: ' Bob ', inviteToken: token }), {
    ok: true,
    value: { playerName: 'Bob', inviteToken: token },
  });
  assert.equal(parseJoinRequest({ playerName: 'Bob', inviteToken: 'short' }).ok, false);
  assert.equal(parseJoinRequest({ playerName: 'Bob', inviteToken: token, color: 'b' }).ok, false);
});

test('parseSocketCommand accepts move, resign, sync, and ping commands', () => {
  assert.deepEqual(
    parseSocketCommand(JSON.stringify({
      type: 'move', from: 'e7', to: 'e8', promotion: 'q', expectedRevision: 4,
    })),
    {
      ok: true,
      value: { type: 'move', from: 'e7', to: 'e8', promotion: 'q', expectedRevision: 4 },
    },
  );
  assert.equal(parseSocketCommand({ type: 'resign', expectedRevision: 4 }).ok, true);
  assert.deepEqual(parseSocketCommand({ type: 'sync' }), { ok: true, value: { type: 'sync' } });
  assert.deepEqual(parseSocketCommand({ type: 'ping' }), { ok: true, value: { type: 'ping' } });
});

test('parseSocketCommand rejects invalid moves and client-owned canonical fields', () => {
  assert.equal(parseSocketCommand('{').ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e9', to: 'e4', expectedRevision: 1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e2', to: 'e4', promotion: 'k', expectedRevision: 1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e2', to: 'e4', expectedRevision: -1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e2', to: 'e4', expectedRevision: 1, fen: 'fake' }).ok, false);
  assert.equal(parseSocketCommand({ type: 'resign', expectedRevision: 1, result: '1-0' }).ok, false);
  assert.equal(parseSocketCommand({ type: 'unknown' }).ok, false);
});
