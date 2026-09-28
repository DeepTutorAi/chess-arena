import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIERS,
  convertCentipawnsToWinProbability,
  winProbFromEval,
  negateEval,
  calculateDeltaWinProbability,
  classifyMove,
  moveAccuracy,
  calculatePlayerAccuracy,
  detectSacrifice,
  buildReplay,
  buildAnalysisResult,
  findCriticalMoments,
  pvToSan,
  uciToMove,
} from '../src/analyzer.js';

test('win probability curve follows the logistic benchmarks (todo.md 2.4)', () => {
  assert.equal(convertCentipawnsToWinProbability(0), 50);
  // todo.md quotes chess-platform chart values (58.7 / 88.5) — the exact
  // logistic formula lands within a point or two of them.
  assert.ok(Math.abs(convertCentipawnsToWinProbability(100) - 58.7) < 1.5);
  assert.ok(Math.abs(convertCentipawnsToWinProbability(500) - 88.5) < 3);
  assert.equal(convertCentipawnsToWinProbability(0, 1), 100);
  assert.equal(convertCentipawnsToWinProbability(0, -1), 0);
  assert.ok(convertCentipawnsToWinProbability(300) > convertCentipawnsToWinProbability(200));
  // Symmetry: a lost position mirrors the winning one (float-safe).
  assert.ok(
    Math.abs(convertCentipawnsToWinProbability(-150) - (100 - convertCentipawnsToWinProbability(150))) < 1e-9,
  );
});

test('eval helpers keep side-to-move perspective consistent', () => {
  assert.equal(winProbFromEval({ cp: null, mate: 3 }), 100);
  assert.equal(winProbFromEval({ cp: null, mate: -1 }), 0);
  assert.equal(negateEval({ cp: 80, mate: null }).cp, -80);
  assert.deepEqual(negateEval({ cp: null, mate: 2 }), { cp: null, mate: -2 });
  assert.equal(
    calculateDeltaWinProbability({ cp: 50 }, { cp: -100 }),
    convertCentipawnsToWinProbability(50) - convertCentipawnsToWinProbability(-100),
  );
  // A losing swing never produces a negative loss.
  assert.equal(calculateDeltaWinProbability({ cp: -100 }, { cp: 300 }), 0);
});

test('classification boundaries cover all ten canonical tiers', () => {
  const ctx = (extra = {}) => ({ ply: 30, ...extra });
  assert.equal(classifyMove(0, ctx()), 'best');
  assert.equal(classifyMove(1, ctx()), 'excellent');
  assert.equal(classifyMove(2, ctx()), 'excellent');
  assert.equal(classifyMove(2.1, ctx()), 'good');
  assert.equal(classifyMove(5, ctx()), 'good');
  assert.equal(classifyMove(5.1, ctx()), 'inaccuracy');
  assert.equal(classifyMove(10, ctx()), 'inaccuracy');
  assert.equal(classifyMove(10.1, ctx()), 'mistake');
  assert.equal(classifyMove(20, ctx()), 'mistake');
  assert.equal(classifyMove(20.1, ctx()), 'blunder');
  assert.equal(classifyMove(45, ctx()), 'blunder');
});

test('context tiers: book, brilliant, great, and miss take precedence', () => {
  // Early negligible-loss moves are book even when they are the engine's top move.
  assert.equal(classifyMove(0, { ply: 3 }), 'book');
  assert.equal(classifyMove(1.5, { ply: 9 }), 'book');
  assert.equal(classifyMove(0, { ply: 10 }), 'best');

  // Brilliant: best move + sound sacrifice + still winning afterwards.
  assert.equal(
    classifyMove(0, { ply: 20, isSacrifice: true, winProbAfter: 70 }),
    'brilliant',
  );
  // A sacrifice that relinquishes the advantage is just "best", not brilliant.
  assert.equal(
    classifyMove(0, { ply: 20, isSacrifice: true, winProbAfter: 40 }),
    'best',
  );

  // Great: only move — every alternative loses >= 15% win probability.
  assert.equal(classifyMove(0, { ply: 20, secondDelta: 15 }), 'great');
  assert.equal(classifyMove(0, { ply: 20, secondDelta: 14.9 }), 'best');
  assert.equal(classifyMove(0, { ply: 20, secondDelta: null }), 'best');

  // Miss: overlooked the opponent's fresh blunder or missed a forced mate.
  assert.equal(
    classifyMove(8, { ply: 20, opponentPrevTier: 'blunder' }),
    'miss',
  );
  assert.equal(
    classifyMove(8, { ply: 20, opponentPrevTier: 'inaccuracy' }),
    'inaccuracy',
  );
  assert.equal(
    classifyMove(12, { ply: 20, missedMate: true }),
    'miss',
  );
});

test('accuracy curve and harmonic mean behave per plan.md 3.4', () => {
  assert.equal(moveAccuracy(0), 100);
  assert.ok(moveAccuracy(25) > 30 && moveAccuracy(25) < 34);
  assert.equal(moveAccuracy(1000), 0); // clamped

  // Perfect game.
  assert.equal(calculatePlayerAccuracy([0, 0, 0, 0]), 100);
  // One 25% swing between perfect moves drags the harmonic mean way down.
  const mixed = calculatePlayerAccuracy([0, 25]);
  assert.ok(mixed > 46 && mixed < 50);
  // A side that never moved has no score.
  assert.equal(calculatePlayerAccuracy([]), null);
});

test('sacrifice heuristic: cheaper recapturer = offer, equal trade = not', () => {
  // Rook takes the knight on e5, black pawn d6 recaptures (1 < 5) -> sacrifice.
  const sac = detectSacrifice(
    '4k3/8/3p4/4n3/8/8/4R3/7K w - - 0 1',
    { from: 'e2', to: 'e5', piece: 'r', captured: 'n' },
  );
  assert.equal(sac, true);

  // Rook takes an undefended pawn and no enemy piece reaches e5 -> safe, no offer.
  const safe = detectSacrifice(
    'k7/8/8/4p3/8/8/4R3/7K w - - 0 1',
    { from: 'e2', to: 'e5', piece: 'r', captured: 'p' },
  );
  assert.equal(safe, false);

  // Equal-value trade (rook takes rook) -> early exit, never a sacrifice.
  const trade = detectSacrifice(
    '4k3/8/8/r7/8/8/8/R6K w - - 0 1',
    { from: 'a1', to: 'a5', piece: 'r', captured: 'r' },
  );
  assert.equal(trade, false);

  // Quiet rook move to an empty, uncontested square -> not a sacrifice.
  const quiet = detectSacrifice(
    '4k3/8/8/8/8/8/8/R6K w - - 0 1',
    { from: 'a1', to: 'a4', piece: 'r', captured: null },
  );
  assert.equal(quiet, false);
});

test('buildReplay normalizes UCI-style records: castling and promotion get SAN (Hole 6)', () => {
  const scholar = buildReplay({
    initialFen: null,
    moves: [
      { from: 'e2', to: 'e4' },
      { from: 'e7', to: 'e5' },
      { from: 'd1', to: 'h5' },
      { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'c4' },
      { from: 'g8', to: 'f6' },
      { from: 'h5', to: 'f7' },
    ],
  });
  assert.equal(scholar.moves[6].san, 'Qxf7#');
  assert.equal(scholar.terminal[7], 'checkmate');
  assert.equal(scholar.fens.length, 8);

  const promoted = buildReplay({
    initialFen: '8/P7/8/8/8/8/k1K5/8 w - - 0 1',
    moves: [{ from: 'a7', to: 'a8', promotion: 'q' }],
  });
  assert.equal(promoted.moves[0].san, 'a8=Q#');

  const castled = buildReplay({
    initialFen: null,
    moves: [
      { from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' },
      { from: 'g1', to: 'f3' }, { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'c4' }, { from: 'g8', to: 'f6' },
      { from: 'e1', to: 'g1' },
    ],
  });
  assert.equal(castled.moves[6].san, 'O-O');

  assert.throws(() => buildReplay({ moves: [{ from: 'e2', to: 'e5' }] }));
});

test('buildAnalysisResult grades a Scholars Mate blunder end-to-end', () => {
  const record = {
    initialFen: null,
    moves: [
      { from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' },
      { from: 'd1', to: 'h5' }, { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'c4' }, { from: 'g8', to: 'f6' },
      { from: 'h5', to: 'f7' },
    ],
    result: '1-0',
    reason: 'checkmate',
    players: { white: { name: 'A' }, black: { name: 'B' } },
    gamemode: 'hva',
  };
  const replay = buildReplay(record);
  // Engine evals are mocked at the boundary this unit test owns: black holds a
  // balanced game until Nf6?? (ply 5) hands white a +500cp mating attack, and
  // the final position is terminal checkmate. Aggregation math (not Stockfish)
  // is what is under test.
  const evals = replay.fens.map((_, j) => {
    if (replay.terminal[j]) return { cp: null, mate: -1 }; // black is mated
    if (j === 6) return { cp: 500, mate: null }; // white to move, attack won
    return { cp: 0, mate: null };
  });
  const result = buildAnalysisResult(record, replay, evals, evals.map(() => null), replay.fens.map(() => null));

  assert.equal(result.plies.length, 7);
  assert.equal(result.positions.length, 8);
  assert.equal(result.positions[0].whiteWinProb, 50);
  assert.equal(result.positions[7].whiteWinProb, 100); // white delivered mate
  assert.equal(result.accuracy.w, 100); // every white move kept the win on track
  assert.ok(result.accuracy.b < 60); // black lost everything on Nf6??
  assert.equal(result.counts.b.blunder, 1);
  assert.equal(result.plies[6].tier, 'best'); // Qxf7# ends the game — never "book"
  for (const tier of TIERS) {
    assert.ok(tier.key in result.counts.w);
  }
  assert.equal(result.gamemode, 'hva');
});

test('replay clocks map per-ply times onto positions (gap-tolerant)', () => {
  const record = {
    initialFen: null,
    moves: [
      { from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' },
      { from: 'd1', to: 'h5' },
    ],
    result: '*',
    // snapshots keyed by history length AFTER each move
    times: [
      { ply: 1, w: 59000, b: 60000 },
      { ply: 2, w: 59000, b: 58000 },
      { ply: 3, w: 57000, b: 58000 },
    ],
    initial: { w: 60000, b: 60000 },
  };
  const replay = buildReplay(record);
  const evals = replay.fens.map(() => ({ cp: 0, mate: null }));
  const result = buildAnalysisResult(record, replay, evals, evals.map(() => null), replay.fens.map(() => null));

  assert.equal(result.positions.length, 4);
  assert.equal(result.positions[0].turn, 'w');
  assert.deepEqual(result.positions[0].clock, { w: 60000, b: 60000 }); // start
  assert.deepEqual(result.positions[1].clock, { w: 59000, b: 60000 }); // after e4
  assert.deepEqual(result.positions[3].clock, { w: 57000, b: 58000 }); // after Qh5

  // Games without time data keep clock null (unlimited stays hidden).
  const noClock = buildAnalysisResult(
    { initialFen: null, moves: record.moves, result: '*' },
    buildReplay({ initialFen: null, moves: record.moves, result: '*' }),
    evals, evals.map(() => null), replay.fens.map(() => null),
  );
  assert.equal(noClock.positions[1].clock, null);

  // A gap in snapshots falls back to the previous known time.
  const gappy = buildAnalysisResult(
    { ...record, times: [record.times[0], record.times[2]] },
    replay, evals, evals.map(() => null), replay.fens.map(() => null),
  );
  assert.deepEqual(gappy.positions[2].clock, { w: 59000, b: 60000 }); // carried from ply 1
});

test('pvToSan converts engine PV UCI lines to SAN and buildAnalysisResult attaches it', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.deepEqual(pvToSan(startFen, ['e2e4', 'e7e5', 'g1f3']), ['e4', 'e5', 'Nf3']);
  // illegal tail stops the conversion instead of throwing
  assert.deepEqual(pvToSan(startFen, ['e2e4', 'a1a2']), ['e4']);
  assert.deepEqual(pvToSan(startFen, [], 4), []);

  const record = {
    initialFen: null,
    moves: [{ from: 'e2', to: 'e4' }],
    result: '*',
  };
  const replay = buildReplay(record);
  const evals = replay.fens.map(() => ({ cp: 0, mate: null }));
  const pvs = [['d2d4', 'g8f6'], []];
  const result = buildAnalysisResult(record, replay, evals, evals.map(() => null), replay.fens.map(() => null), pvs);
  assert.deepEqual(result.positions[0].pvSan, ['d4', 'Nf6']);
  assert.deepEqual(result.positions[1].pvSan, []);
  // backward compatible: no PVs passed → empty arrays, not crashes
  const noPv = buildAnalysisResult(record, replay, evals, evals.map(() => null), replay.fens.map(() => null));
  assert.deepEqual(noPv.positions[0].pvSan, []);
});

test('uciToMove parses promotions (Hole 6)', () => {
  assert.deepEqual(uciToMove('e7e8q'), { from: 'e7', to: 'e8', promotion: 'q' });
  assert.deepEqual(uciToMove('e1g1'), { from: 'e1', to: 'g1', promotion: undefined });
});

// ---- critical moments (roadmap.md A1) -------------------------------------

const pos = (w) => w.map((whiteWinProb) => ({ whiteWinProb }));
const pliesOf = (colors) => colors.map((color, i) => ({ color, san: `M${i + 1}` }));

test('findCriticalMoments flags a big loss from the MOVER perspective', () => {
  // 50 -> 80 white win prob: the black move handed white +30.
  const moments = findCriticalMoments(pos([50, 50, 80]), pliesOf(['w', 'b']));
  assert.equal(moments.length, 1);
  assert.deepEqual(moments[0], { ply: 1, san: 'M2', lost: true, swingPct: 30 });
});

test('findCriticalMoments marks a big gain as lost:false', () => {
  // 50 -> 85 white win prob after a white move: white GAINED 35.
  const moments = findCriticalMoments(pos([50, 85]), pliesOf(['w']));
  assert.equal(moments.length, 1);
  assert.deepEqual(moments[0], { ply: 0, san: 'M1', lost: false, swingPct: 35 });
});

test('findCriticalMoments ignores quiet games below the threshold', () => {
  const moments = findCriticalMoments(pos([50, 52, 49, 51]), pliesOf(['w', 'b', 'w']));
  assert.deepEqual(moments, []);
});

test('findCriticalMoments collapses adjacent swings into one moment per cluster', () => {
  // plies 0 and 1 both swing >= 15 back to back -> one moment, not two.
  const moments = findCriticalMoments(pos([50, 30, 10, 12]), pliesOf(['w', 'b', 'w']));
  assert.equal(moments.length, 1);
  assert.equal(moments[0].swingPct, 20);
  assert.ok(moments[0].ply === 0 || moments[0].ply === 1);
});

test('findCriticalMoments caps at the 3 strongest and returns them chronologically', () => {
  const w = [50, 30, 30, 70, 70, 10, 10, 90, 90, 65];
  const moments = findCriticalMoments(pos(w), pliesOf(['w', 'b', 'w', 'b', 'w', 'b', 'w', 'b', 'w']));
  assert.deepEqual(moments.map((m) => m.ply), [2, 4, 6]);
  assert.deepEqual(moments.map((m) => m.swingPct), [40, 60, 80]);
  assert.deepEqual(moments.map((m) => m.lost), [false, true, false]);
});

test('findCriticalMoments threshold is inclusive at 15 and skips 14', () => {
  assert.equal(findCriticalMoments(pos([50, 35]), pliesOf(['w'])).length, 1);
  assert.equal(findCriticalMoments(pos([50, 36]), pliesOf(['w'])).length, 0);
});

test('buildAnalysisResult attaches criticalMoments to the review payload', () => {
  const record = {
    initialFen: null,
    moves: [
      { from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' },
      { from: 'd1', to: 'h5' }, { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'c4' }, { from: 'g8', to: 'f6' },
      { from: 'h5', to: 'f7' },
    ],
    result: '1-0',
    reason: 'checkmate',
  };
  const replay = buildReplay(record);
  const evals = replay.fens.map((_, j) => {
    if (replay.terminal[j]) return { cp: null, mate: -1 };
    if (j === 6) return { cp: 500, mate: null };
    return { cp: 0, mate: null };
  });
  const result = buildAnalysisResult(record, replay, evals, evals.map(() => null), replay.fens.map(() => null));
  assert.equal(result.criticalMoments.length, 1);
  assert.equal(result.criticalMoments[0].ply, 5); // Nf6?? is the decisive swing
  assert.equal(result.criticalMoments[0].san, 'Nf6');
  assert.equal(result.criticalMoments[0].lost, true);
  assert.equal(
    result.criticalMoments[0].swingPct,
    Math.round(convertCentipawnsToWinProbability(500) - 50),
  );
});

test('buildAnalysisResult grades Book from a matched OPENING, not just early plies (A2)', () => {
  const record = {
    initialFen: null,
    moves: [
      { from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' },
      { from: 'g1', to: 'f3' }, { from: 'b8', to: 'c6' },
      { from: 'f1', to: 'b5' }, { from: 'g8', to: 'f6' },
      { from: 'd2', to: 'd4' },
    ],
    result: '*',
  };
  const replay = buildReplay(record);
  const evals = replay.fens.map((_, j) => {
    if (replay.terminal[j]) return { cp: null, mate: -1 };
    if (j === 6) return { cp: 500, mate: null };
    return { cp: 0, mate: null };
  });
  const args = () => [record, replay, evals, evals.map(() => null), replay.fens.map(() => null)];

  // Book matched for 4 plies (0..3): those grade "book"; moves past the matched
  // prefix — even inside the old ply<10 heuristic — grade normally.
  const withBook = buildAnalysisResult(...args(), replay.fens.map(() => null), {
    eco: 'C60',
    name: 'Ruy Lopez',
    plies: 4,
  });
  assert.deepEqual(withBook.opening, { eco: 'C60', name: 'Ruy Lopez' });
  assert.deepEqual(withBook.plies.slice(0, 4).map((p) => p.tier), ['book', 'book', 'book', 'book']);
  assert.equal(withBook.plies[4].tier, 'best'); // past the matched book -> normal grading
  assert.equal(withBook.plies[5].tier, 'blunder');

  // No book match -> the old ply<10 heuristic still applies (fallback preserved).
  const noBook = buildAnalysisResult(...args(), replay.fens.map(() => null));
  assert.equal(noBook.opening, null);
  assert.deepEqual(noBook.plies.slice(0, 4).map((p) => p.tier), ['book', 'book', 'book', 'book']);
  assert.equal(noBook.plies[4].tier, 'book'); // ply 4 < 10 with zero loss = heuristic book
});
