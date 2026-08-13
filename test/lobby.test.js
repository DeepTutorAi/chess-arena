import test from 'node:test';
import assert from 'node:assert/strict';

import { AVATAR_ATLAS, AVATAR_GLYPHS, filterLobbyRooms, formatRoomAge, roomAction } from '../src/lobby.js';

const rooms = [
  { roomId: 'aaaaaaaaaaaaaaaa', title: 'Friday Blitz', status: 'waiting', host: { name: 'Alice' }, openColor: 'b', timeControlId: 'blitz_5_0', allowSpectators: true },
  { roomId: 'bbbbbbbbbbbbbbbb', title: 'Rapid Masters', status: 'active', host: { name: 'Bob' }, openColor: null, timeControlId: 'rapid_10_0', allowSpectators: true },
  { roomId: 'cccccccccccccccc', title: 'Private Practice', status: 'active', host: { name: 'Cara' }, openColor: null, timeControlId: 'blitz_5_0', allowSpectators: false },
];

test('filterLobbyRooms derives visible subsets without changing server summaries', () => {
  const before = structuredClone(rooms);
  assert.deepEqual(filterLobbyRooms(rooms, { tab: 'open', time: 'all', search: '' }).map((room) => room.roomId), ['aaaaaaaaaaaaaaaa']);
  assert.deepEqual(filterLobbyRooms(rooms, { tab: 'watch', time: 'all', search: '' }).map((room) => room.roomId), ['bbbbbbbbbbbbbbbb']);
  assert.deepEqual(filterLobbyRooms(rooms, { tab: 'all', time: 'rapid', search: 'bob' }).map((room) => room.roomId), ['bbbbbbbbbbbbbbbb']);
  assert.deepEqual(rooms, before);
});

test('roomAction chooses Join, Watch, or unavailable from authoritative status', () => {
  assert.equal(roomAction(rooms[0]), 'join');
  assert.equal(roomAction(rooms[1]), 'watch');
  assert.equal(roomAction(rooms[2]), 'unavailable');
});

test('formatRoomAge returns bounded human age buckets', () => {
  assert.equal(formatRoomAge(10_000, 15_000), 'เมื่อสักครู่');
  assert.equal(formatRoomAge(10_000, 130_000), '2 นาที');
  assert.equal(formatRoomAge(10_000, 7_210_000), '2 ชั่วโมง');
});

test('every fixed avatar has an atlas position and a semantic glyph fallback', () => {
  assert.deepEqual(Object.keys(AVATAR_ATLAS), Object.keys(AVATAR_GLYPHS));
  for (const avatar of Object.keys(AVATAR_GLYPHS)) {
    assert.match(AVATAR_ATLAS[avatar], /^\d+% \d+%$/u);
    assert.match(AVATAR_GLYPHS[avatar], /\S/u);
  }
});
