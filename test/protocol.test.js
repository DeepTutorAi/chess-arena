import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATARS,
  parseCreateRequest,
  parseJoinRequest,
  parseLobbyQuery,
  parsePublicJoinRequest,
  parseSocketCommand,
  parseWatchRequest,
} from '../worker/protocol.js';

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
      visibility: 'public',
      allowSpectators: true,
      avatar: 'knight',
    },
  });
});

test('parseCreateRequest rejects malformed and authority-claiming input', () => {
  assert.equal(parseCreateRequest(null).ok, false);
  assert.equal(parseCreateRequest({ playerName: '' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', color: 'green' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', fen: 'client owned' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', result: '1-0' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', avatar: 'dragon' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', visibility: 'friends' }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A'.repeat(41) }).ok, false);
  assert.equal(parseCreateRequest({ playerName: 'A', title: 'T'.repeat(81) }).ok, false);
});

test('public join and watch requests accept bounded guest profiles only', () => {
  assert.deepEqual(AVATARS, ['knight', 'king', 'rook', 'bishop', 'pawns', 'shield']);
  assert.deepEqual(parsePublicJoinRequest({ playerName: ' Bob ', avatar: 'rook' }), {
    ok: true,
    value: { playerName: 'Bob', avatar: 'rook' },
  });
  assert.equal(parsePublicJoinRequest({ playerName: 'Bob', avatar: 'url:https://example.test' }).ok, false);
  assert.equal(parsePublicJoinRequest({ playerName: 'Bob', avatar: 'rook', color: 'b' }).ok, false);

  const watchToken = 'W'.repeat(43);
  assert.deepEqual(parseWatchRequest({ playerName: 'Viewer', avatar: 'bishop' }), {
    ok: true,
    value: { playerName: 'Viewer', avatar: 'bishop', watchInviteToken: undefined },
  });
  assert.equal(parseWatchRequest({ playerName: 'Viewer', avatar: 'bishop', watchInviteToken: watchToken }).ok, true);
  assert.equal(parseWatchRequest({ playerName: 'Viewer', avatar: 'bishop', watchInviteToken: 'short' }).ok, false);
});

test('lobby query accepts bounded filters and rejects malformed discovery input', () => {
  assert.deepEqual(parseLobbyQuery(new URL('https://example.test/api/lobby?status=open&time=blitz&search=%20Friday%20')), {
    ok: true,
    value: { status: 'open', time: 'blitz', search: 'Friday', cursor: undefined },
  });
  assert.equal(parseLobbyQuery(new URL('https://example.test/api/lobby?status=private')).ok, false);
  assert.equal(parseLobbyQuery(new URL('https://example.test/api/lobby?time=weekly')).ok, false);
  assert.equal(parseLobbyQuery(new URL(`https://example.test/api/lobby?search=${'x'.repeat(61)}`)).ok, false);
  assert.equal(parseLobbyQuery(new URL('https://example.test/api/lobby?cursor=not%20opaque%21')).ok, false);
  assert.equal(parseLobbyQuery(new URL('https://example.test/api/lobby?unknown=1')).ok, false);
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
  assert.deepEqual(parseSocketCommand({ type: 'presence', visibility: 'visible' }), {
    ok: true, value: { type: 'presence', visibility: 'visible' },
  });
  assert.deepEqual(parseSocketCommand({ type: 'presence', visibility: 'hidden' }), {
    ok: true, value: { type: 'presence', visibility: 'hidden' },
  });
  assert.deepEqual(parseSocketCommand({ type: 'heartbeat', visibility: 'visible' }), {
    ok: true, value: { type: 'heartbeat', visibility: 'visible' },
  });
});

test('parseSocketCommand rejects invalid moves and client-owned canonical fields', () => {
  assert.equal(parseSocketCommand('{').ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e9', to: 'e4', expectedRevision: 1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e2', to: 'e4', promotion: 'k', expectedRevision: 1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e2', to: 'e4', expectedRevision: -1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'move', from: 'e2', to: 'e4', expectedRevision: 1, fen: 'fake' }).ok, false);
  assert.equal(parseSocketCommand({ type: 'resign', expectedRevision: 1, result: '1-0' }).ok, false);
  assert.equal(parseSocketCommand({ type: 'presence', visibility: 'away' }).ok, false);
  assert.equal(parseSocketCommand({ type: 'presence', visibility: 'hidden', color: 'w' }).ok, false);
  assert.equal(parseSocketCommand({ type: 'heartbeat', visibility: 'visible', now: 1 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'heartbeat', visibility: 'visible', strikes: 2 }).ok, false);
  assert.equal(parseSocketCommand({ type: 'unknown' }).ok, false);
});
