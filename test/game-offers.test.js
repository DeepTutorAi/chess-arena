// Online game commands beyond move/resign: abort, draw offers, takebacks.

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyGameCommand, createGameState, joinGameState, toPublicState } from '../worker/game-state.js';
import { OFFER_COMMANDS, parseSocketCommand } from '../worker/protocol.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const HOST = { role: 'host', color: 'w' };
const GUEST = { role: 'guest', color: 'b' };

function active(overrides = {}) {
  const waiting = createGameState({
    roomId: 'abcdefgh23456789', title: 'Room', hostName: 'Host', hostColor: 'w', hostAvatar: 'knight',
    visibility: 'public', allowSpectators: true, timeControlId: 'unlimited', initialFen: START_FEN,
    timeControl: null, expiresAt: 86_401_000, ...overrides,
  }, 1_000);
  const joined = joinGameState(waiting, 'Guest', 2_000);
  assert.equal(joined.ok, true);
  return joined.state;
}

let clock = 10_000;
const send = (state, actor, command) => applyGameCommand(state, actor, { ...command, expectedRevision: state.revision }, (clock += 100));
const must = (result) => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.state; };
const move = (state, actor, from, to) => must(send(state, actor, { type: 'move', from, to }));

/** 1.e4 e5 — two plies each way so draws and aborts have their preconditions. */
const afterTwo = (overrides) => move(move(active(overrides), HOST, 'e2', 'e4'), GUEST, 'e7', 'e5');

// ---- abort -------------------------------------------------------------------------------

test('either player may abort before both sides have moved; nobody wins', () => {
  for (const actor of [HOST, GUEST]) {
    const state = active();
    const result = must(send(state, actor, { type: 'abort' }));
    assert.equal(result.status, 'finished');
    assert.equal(result.result, '*');
    assert.equal(result.reason, 'aborted');
    assert.equal(result.clock, null);
  }
  const oneMove = move(active(), HOST, 'e2', 'e4');
  assert.equal(must(send(oneMove, GUEST, { type: 'abort' })).reason, 'aborted', 'still allowed after one ply');
});

test('once both sides have moved the game can no longer be aborted', () => {
  const result = send(afterTwo(), HOST, { type: 'abort' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'too_late_to_abort');
});

test('aborting stops a running clock', () => {
  const timed = active({ timeControlId: 'blitz_5_0', timeControl: { initialMs: 300_000, incrementMs: 0 } });
  const done = must(send(timed, HOST, { type: 'abort' }));
  assert.equal(done.clock.activeSince, null);
});

// ---- draw offers ---------------------------------------------------------------------------

test('a draw needs an offer and its acceptance; the game ends drawn by agreement', () => {
  let state = afterTwo();
  state = must(send(state, HOST, { type: 'draw-offer' }));
  assert.deepEqual(state.drawOffer, { by: 'w' });
  assert.deepEqual(toPublicState(state).drawOffer, { by: 'w' });
  state = must(send(state, GUEST, { type: 'draw-accept' }));
  assert.equal(state.status, 'finished');
  assert.equal(state.result, '1/2-1/2');
  assert.equal(state.reason, 'agreement');
  assert.equal(state.drawOffer, null);
});

test('you cannot accept your own offer, and accepting needs an offer', () => {
  const state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  assert.equal(send(state, HOST, { type: 'draw-accept' }).error.code, 'own_offer');
  assert.equal(send(afterTwo(), GUEST, { type: 'draw-accept' }).error.code, 'no_draw_offer');
  assert.equal(send(afterTwo(), GUEST, { type: 'draw-decline' }).error.code, 'no_draw_offer');
  assert.equal(send(afterTwo(), GUEST, { type: 'draw-cancel' }).error.code, 'no_draw_offer');
});

test('offering back at an open offer is an acceptance', () => {
  let state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  state = must(send(state, GUEST, { type: 'draw-offer' }));
  assert.equal(state.result, '1/2-1/2');
  assert.equal(state.reason, 'agreement');
});

test('offering twice is harmless', () => {
  const state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  const again = must(send(state, HOST, { type: 'draw-offer' }));
  assert.deepEqual(again.drawOffer, { by: 'w' });
  assert.equal(again.revision, state.revision, 'nothing changed');
});

test('a declined offer cannot be repeated until the offerer has moved', () => {
  let state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  state = must(send(state, GUEST, { type: 'draw-decline' }));
  assert.equal(state.drawOffer, null);
  assert.equal(state.status, 'active');
  assert.equal(send(state, HOST, { type: 'draw-offer' }).error.code, 'draw_blocked', 'no nagging');
  // the other side is not blocked
  assert.equal(must(send(state, GUEST, { type: 'draw-offer' })).drawOffer.by, 'b');
  // after white moves the block is lifted
  state = move(state, HOST, 'g1', 'f3');
  state = move(state, GUEST, 'b8', 'c6');
  assert.equal(must(send(state, HOST, { type: 'draw-offer' })).drawOffer.by, 'w');
});

test('the offerer can withdraw; nobody else can', () => {
  let state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  assert.equal(send(state, GUEST, { type: 'draw-cancel' }).error.code, 'not_your_offer');
  state = must(send(state, HOST, { type: 'draw-cancel' }));
  assert.equal(state.drawOffer, null);
  assert.equal(state.drawBlock, null, 'withdrawing is not a decline');
});

test('any move closes an open offer', () => {
  let state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  state = move(state, HOST, 'g1', 'f3');
  assert.equal(state.drawOffer, null);
  state = must(send(state, GUEST, { type: 'draw-offer' }));
  state = move(state, GUEST, 'b8', 'c6'); // ignoring an offer by playing on declines it
  assert.equal(state.drawOffer, null);
});

test('draws cannot be offered before each side has moved', () => {
  assert.equal(send(active(), HOST, { type: 'draw-offer' }).error.code, 'too_early');
  const oneMove = move(active(), HOST, 'e2', 'e4');
  assert.equal(send(oneMove, GUEST, { type: 'draw-offer' }).error.code, 'too_early');
});

test('offers only exist in an active game', () => {
  const finished = must(send(afterTwo(), HOST, { type: 'resign' }));
  assert.equal(send(finished, GUEST, { type: 'draw-offer' }).error.code, 'game_not_active');
  const waiting = createGameState({
    roomId: 'abcdefgh23456789', title: 'Room', hostName: 'Host', hostColor: 'w', visibility: 'public', allowSpectators: true,
    timeControlId: 'unlimited', initialFen: START_FEN, timeControl: null, expiresAt: 86_401_000,
  }, 1_000);
  assert.equal(applyGameCommand(waiting, HOST, { type: 'draw-offer', expectedRevision: 0 }, 5_000).error.code, 'game_not_active');
});

test('resigning, timing out and mate all clear the offers', () => {
  let state = must(send(afterTwo(), HOST, { type: 'draw-offer' }));
  assert.equal(must(send(state, GUEST, { type: 'resign' })).drawOffer, null);
  const timed = afterTwo({ timeControlId: 'blitz_5_0', timeControl: { initialMs: 300_000, incrementMs: 0 } });
  const offered = must(send(timed, GUEST, { type: 'draw-offer' }));
  const late = applyGameCommand(offered, HOST, { type: 'resign', expectedRevision: offered.revision }, offered.updatedAt + 10 * 60_000);
  assert.equal(late.ok, false);
  assert.equal(late.error.code, 'time_expired');
  assert.equal(late.state.drawOffer, null);
  assert.equal(late.state.reason, 'timeout');
});

// ---- takebacks -------------------------------------------------------------------------------

test('the player who just moved can ask to take that move back, and it is undone on acceptance', () => {
  let state = move(active(), HOST, 'e2', 'e4');
  state = must(send(state, HOST, { type: 'takeback-request' }));
  assert.deepEqual(toPublicState(state).takebackOffer, { by: 'w' });
  state = must(send(state, GUEST, { type: 'takeback-accept' }));
  assert.deepEqual(state.moves, []);
  assert.equal(state.turn, 'w', 'the requester moves again');
  assert.equal(state.fen, START_FEN);
  assert.equal(state.lastMove, null);
  assert.equal(state.lastMoveSan, null);
  assert.equal(state.takebackOffer, null);
  assert.equal(state.status, 'active');
  // and the game goes on normally
  state = move(state, HOST, 'd2', 'd4');
  assert.deepEqual(state.moves, ['d2d4']);
});

test('taking back rebuilds the last-move markers from the remaining history', () => {
  let state = afterTwo();
  state = move(state, HOST, 'g1', 'f3');
  state = must(send(state, HOST, { type: 'takeback-request' }));
  state = must(send(state, GUEST, { type: 'takeback-accept' }));
  assert.deepEqual(state.moves, ['e2e4', 'e7e5']);
  assert.equal(state.lastMove, 'e7e5');
  assert.equal(state.lastMoveSan, 'e5');
  assert.equal(state.turn, 'w');
});

test('a takeback is only for your own last move, before the opponent replies', () => {
  const state = move(active(), HOST, 'e2', 'e4'); // black to move
  assert.equal(send(state, GUEST, { type: 'takeback-request' }).error.code, 'nothing_to_take_back', 'it is not your move to take back');
  assert.equal(send(active(), HOST, { type: 'takeback-request' }).error.code, 'nothing_to_take_back', 'no move yet');
  const replied = move(state, GUEST, 'e7', 'e5');
  assert.equal(send(replied, HOST, { type: 'takeback-request' }).error.code, 'nothing_to_take_back', 'the opponent already answered');
});

test('declining blocks a repeat request until the requester moves; you cannot answer your own request', () => {
  let state = move(active(), HOST, 'e2', 'e4');
  state = must(send(state, HOST, { type: 'takeback-request' }));
  assert.equal(send(state, HOST, { type: 'takeback-accept' }).error.code, 'own_offer');
  state = must(send(state, GUEST, { type: 'takeback-decline' }));
  assert.equal(state.takebackOffer, null);
  assert.deepEqual(state.moves, ['e2e4'], 'nothing was undone');
  assert.equal(send(state, HOST, { type: 'takeback-request' }).error.code, 'takeback_blocked');
  state = move(state, GUEST, 'e7', 'e5');
  state = move(state, HOST, 'g1', 'f3');
  assert.equal(must(send(state, HOST, { type: 'takeback-request' })).takebackOffer.by, 'w');
});

test('a takeback request can be withdrawn, and the opponent replying closes it', () => {
  let state = move(active(), HOST, 'e2', 'e4');
  state = must(send(state, HOST, { type: 'takeback-request' }));
  assert.equal(send(state, GUEST, { type: 'takeback-cancel' }).error.code, 'not_your_offer');
  assert.equal(must(send(state, HOST, { type: 'takeback-cancel' })).takebackOffer, null);
  state = must(send(state, HOST, { type: 'takeback-request' }));
  state = move(state, GUEST, 'e7', 'e5');
  assert.equal(state.takebackOffer, null, 'the position the request was about no longer exists');
});

test('answering with no request open is an error', () => {
  const state = move(active(), HOST, 'e2', 'e4');
  for (const type of ['takeback-accept', 'takeback-decline', 'takeback-cancel']) {
    assert.equal(send(state, GUEST, { type }).error.code, 'no_takeback_request', type);
  }
});

test('timed game: the requester gives back the move\'s increment, the opponent is not charged for deciding', () => {
  let state = active({ timeControlId: 'blitz_3_1_5', timeControl: { initialMs: 180_000, incrementMs: 1_500 } });
  const t0 = state.updatedAt;
  state = applyGameCommand(state, HOST, { type: 'move', from: 'e2', to: 'e4', expectedRevision: state.revision }, t0 + 4_000).state;
  assert.equal(state.clock.whiteMs, 180_000 - 4_000 + 1_500);
  const asked = applyGameCommand(state, HOST, { type: 'takeback-request', expectedRevision: state.revision }, t0 + 5_000).state;
  const taken = applyGameCommand(asked, GUEST, { type: 'takeback-accept', expectedRevision: asked.revision }, t0 + 25_000).state; // 20 s of deliberation
  assert.equal(taken.turn, 'w');
  assert.equal(taken.clock.whiteMs, 180_000 - 4_000, 'the thinking time stays spent, the increment goes back');
  assert.equal(taken.clock.blackMs, 180_000, 'black was not charged for the 20 s');
  assert.equal(taken.clock.activeSince, t0 + 25_000, 'white\'s clock starts now');
});

test('opening AFK protection follows a takeback back to the first move', () => {
  let state = move(active({ timeControlId: 'unlimited' }), HOST, 'e2', 'e4');
  state = must(send(state, HOST, { type: 'takeback-request' }));
  state = must(send(state, GUEST, { type: 'takeback-accept' }));
  assert.ok(state.afk.openingDeadlineAt > state.updatedAt, 'a fresh opening deadline for white\'s first move');
  assert.equal(state.afk.turnStartedAt, state.updatedAt);
});

test('a rematch starts with no offers and no blocks', () => {
  let state = afterTwo();
  state = must(send(state, HOST, { type: 'draw-offer' }));
  state = must(send(state, GUEST, { type: 'draw-decline' }));
  state = must(send(state, HOST, { type: 'resign' }));
  state = must(send(state, HOST, { type: 'rematch-request' }));
  state = must(send(state, GUEST, { type: 'rematch-accept' }));
  assert.equal(state.drawBlock, null);
  assert.equal(state.takebackBlock, null);
  assert.equal(state.drawOffer, null);
});

test('rooms stored before these fields existed still work', () => {
  const state = afterTwo();
  delete state.drawOffer;
  delete state.drawBlock;
  delete state.takebackOffer;
  delete state.takebackBlock;
  const offered = must(send(state, HOST, { type: 'draw-offer' }));
  assert.deepEqual(offered.drawOffer, { by: 'w' });
  assert.equal(toPublicState(state).drawOffer, null);
});

// ---- protocol --------------------------------------------------------------------------------

test('the new commands parse as bare commands with a revision', () => {
  for (const type of [...OFFER_COMMANDS, 'abort']) {
    assert.deepEqual(parseSocketCommand({ type, expectedRevision: 4 }), { ok: true, value: { type, expectedRevision: 4 } }, type);
    assert.equal(parseSocketCommand({ type }).ok, false, `${type} without a revision`);
    assert.equal(parseSocketCommand({ type, expectedRevision: -1 }).ok, false);
    assert.equal(parseSocketCommand({ type, expectedRevision: 1.5 }).ok, false);
    assert.equal(parseSocketCommand({ type, expectedRevision: 1, extra: true }).ok, false, `${type} with extra keys`);
  }
  assert.equal(parseSocketCommand(JSON.stringify({ type: 'draw-offer', expectedRevision: 2 })).ok, true);
  assert.equal(parseSocketCommand({ type: 'draw-everything', expectedRevision: 1 }).ok, false);
});

test('spectators and the wrong seat cannot use the new commands', () => {
  const state = afterTwo();
  for (const type of ['draw-offer', 'takeback-request', 'abort']) {
    const spectator = applyGameCommand(state, { role: 'spectator', color: null }, { type, expectedRevision: state.revision }, 30_000);
    assert.equal(spectator.error.code, 'unauthorized', type);
    const impostor = applyGameCommand(state, { role: 'guest', color: 'w' }, { type, expectedRevision: state.revision }, 30_000);
    assert.equal(impostor.error.code, 'unauthorized', type);
  }
});

test('stale revisions are refused', () => {
  const state = afterTwo();
  const stale = applyGameCommand(state, HOST, { type: 'draw-offer', expectedRevision: state.revision - 1 }, 30_000);
  assert.equal(stale.error.code, 'stale_revision');
});
