import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGameCommand,
  createGameState,
  joinGameState,
  realizeTimeout,
  toPublicState,
} from '../worker/game-state.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function createWaiting(overrides = {}) {
  return createGameState(
    {
      roomId: 'abcdefgh23456789',
      title: 'Friday chess',
      hostName: 'Host',
      hostColor: 'w',
      hostAvatar: 'knight',
      visibility: 'public',
      allowSpectators: true,
      timeControlId: 'unlimited',
      initialFen: START_FEN,
      timeControl: null,
      expiresAt: 86_401_000,
      ...overrides,
    },
    1_000,
  );
}

function createActive(overrides = {}, joinedAt = 2_000) {
  const waiting = createWaiting(overrides);
  const joined = joinGameState(waiting, 'Guest', joinedAt);
  assert.equal(joined.ok, true);
  return joined.state;
}

test('createGameState creates a waiting canonical position without starting the clock', () => {
  const state = createWaiting({
    timeControl: { initialMs: 300_000, incrementMs: 2_000 },
  });

  assert.equal(state.status, 'waiting');
  assert.equal(state.revision, 0);
  assert.equal(state.fen, START_FEN);
  assert.deepEqual(state.players, {
    w: { role: 'host', name: 'Host', avatar: 'knight' },
    b: { role: 'guest', name: null, avatar: null },
  });
  assert.deepEqual(state.clock, {
    initialMs: 300_000,
    incrementMs: 2_000,
    whiteMs: 300_000,
    blackMs: 300_000,
    activeSince: null,
  });
});

test('joinGameState claims the guest seat once and starts a timed game', () => {
  const waiting = createWaiting({
    hostColor: 'b',
    timeControl: { initialMs: 60_000, incrementMs: 1_000 },
  });

  const joined = joinGameState(waiting, ' Guest ', 5_000, 'rook');
  assert.equal(joined.ok, true);
  assert.equal(joined.state.status, 'active');
  assert.equal(joined.state.revision, 1);
  assert.equal(joined.state.players.w.name, 'Guest');
  assert.equal(joined.state.players.w.avatar, 'rook');
  assert.equal(joined.state.clock.activeSince, 5_000);

  const second = joinGameState(joined.state, 'Other', 6_000);
  assert.deepEqual(second, {
    ok: false,
    error: { code: 'room_full', message: 'ห้องนี้มีผู้เล่นครบแล้ว' },
  });
});

test('applyGameCommand accepts a legal move and derives canonical state', () => {
  const state = createActive();
  const before = structuredClone(state);

  const result = applyGameCommand(
    state,
    { role: 'host', color: 'w' },
    { type: 'move', from: 'e2', to: 'e4', expectedRevision: 1 },
    3_000,
  );

  assert.equal(result.ok, true);
  assert.equal(result.state.revision, 2);
  assert.equal(result.state.turn, 'b');
  assert.equal(result.state.lastMove, 'e2e4');
  assert.equal(result.state.lastMoveSan, 'e4');
  assert.deepEqual(result.state.moves, ['e2e4']);
  assert.equal(state.fen, before.fen, 'the input state must not be mutated');
});

test('applyGameCommand rejects an illegal move without changing state', () => {
  const state = createActive();
  const result = applyGameCommand(
    state,
    { role: 'host', color: 'w' },
    { type: 'move', from: 'e2', to: 'e5', expectedRevision: 1 },
    3_000,
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'illegal_move', message: 'ตาเดินนี้ไม่ถูกต้องตามกติกา' },
  });
  assert.equal(state.fen, START_FEN);
});

test('applyGameCommand rejects wrong color and stale revisions', () => {
  const state = createActive();

  const wrongTurn = applyGameCommand(
    state,
    { role: 'guest', color: 'b' },
    { type: 'move', from: 'e7', to: 'e5', expectedRevision: 1 },
    3_000,
  );
  assert.equal(wrongTurn.ok, false);
  assert.equal(wrongTurn.error.code, 'wrong_turn');

  const stale = applyGameCommand(
    state,
    { role: 'host', color: 'w' },
    { type: 'move', from: 'e2', to: 'e4', expectedRevision: 0 },
    3_000,
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_revision');
});

test('timed moves deduct elapsed time and add increment', () => {
  const state = createActive({
    timeControl: { initialMs: 60_000, incrementMs: 2_000 },
  }, 10_000);

  const result = applyGameCommand(
    state,
    { role: 'host', color: 'w' },
    { type: 'move', from: 'e2', to: 'e4', expectedRevision: 1 },
    15_000,
  );

  assert.equal(result.ok, true);
  assert.equal(result.state.clock.whiteMs, 57_000);
  assert.equal(result.state.clock.blackMs, 60_000);
  assert.equal(result.state.clock.activeSince, 15_000);
});

test('realizeTimeout finishes a timed game when the active side runs out', () => {
  const state = createActive({
    timeControl: { initialMs: 10_000, incrementMs: 0 },
  }, 20_000);

  const result = realizeTimeout(state, 30_001);
  assert.equal(result.changed, true);
  assert.equal(result.state.status, 'finished');
  assert.equal(result.state.result, '0-1');
  assert.equal(result.state.reason, 'timeout');
  assert.equal(result.state.clock.whiteMs, 0);
});

test('resignation and checkmate results are derived by the domain', () => {
  let state = createActive();
  const resigned = applyGameCommand(
    state,
    { role: 'guest', color: 'b' },
    { type: 'resign', expectedRevision: 1 },
    3_000,
  );
  assert.equal(resigned.ok, true);
  assert.equal(resigned.state.result, '1-0');
  assert.equal(resigned.state.reason, 'resignation');

  state = createActive();
  const sequence = [
    ['host', 'w', 'f2', 'f3'],
    ['guest', 'b', 'e7', 'e5'],
    ['host', 'w', 'g2', 'g4'],
    ['guest', 'b', 'd8', 'h4'],
  ];
  for (const [role, color, from, to] of sequence) {
    const moved = applyGameCommand(
      state,
      { role, color },
      { type: 'move', from, to, expectedRevision: state.revision },
      3_000 + state.revision,
    );
    assert.equal(moved.ok, true);
    state = moved.state;
  }
  assert.equal(state.status, 'finished');
  assert.equal(state.result, '0-1');
  assert.equal(state.reason, 'checkmate');
});

test('toPublicState exposes connection flags without private authority data', () => {
  const state = createActive();
  const view = toPublicState(state, { host: true, guest: false });

  assert.equal(view.type, 'state');
  assert.equal(view.players.w.connected, true);
  assert.equal(view.players.b.connected, false);
  assert.equal(view.players.w.avatar, 'knight');
  assert.equal(view.players.b.avatar, 'pawns');
  assert.equal(view.visibility, 'public');
  assert.equal(view.allowSpectators, true);
  assert.equal('capabilities' in view, false);
});
