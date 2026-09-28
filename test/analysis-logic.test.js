// Review grading logic fixes (round 1): a blunder is never demoted to "Miss",
// the engine's own move is never graded below "Best" by search noise, "Book"
// follows the matched theory line (not a 10-ply cap, not from custom starts),
// "Brilliant" needs a sacrifice that is not already crushing, and one
// catastrophic move no longer collapses accuracy to ~29%.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnalysisResult,
  buildReplay,
  calculateBlendedAccuracy,
  calculatePlayerAccuracy,
  classifyMove,
  isStandardStart,
  volatilityWeights,
} from '../src/analyzer.js';
import { CoachService } from '../src/review-ui.js';

test('a >20% loss is a blunder even right after the opponent\'s mistake', () => {
  assert.equal(classifyMove(45, { ply: 20, opponentPrevTier: 'blunder' }), 'blunder');
  assert.equal(classifyMove(21, { ply: 20, opponentPrevTier: 'mistake' }), 'blunder');
  // ...while a smaller lapse after their mistake is still "Miss"
  assert.equal(classifyMove(8, { ply: 20, opponentPrevTier: 'blunder' }), 'miss');
  assert.equal(classifyMove(20, { ply: 20, opponentPrevTier: 'blunder' }), 'miss');
  // and missing a forced mate stays "Miss"
  assert.equal(classifyMove(60, { ply: 20, missedMate: true }), 'miss');
});

test('Brilliant needs a working sacrifice in a position that was not already crushing', () => {
  const base = { ply: 20, isSacrifice: true, winProbAfter: 70 };
  assert.equal(classifyMove(0, base), 'brilliant');
  assert.equal(classifyMove(0, { ...base, winProbBefore: 95 }), 'best', 'already winning: not brilliant');
  assert.equal(classifyMove(0, { ...base, winProbBefore: 55, secondDelta: 2 }), 'best', 'alternatives were just as good');
  assert.equal(classifyMove(0, { ...base, winProbBefore: 55, secondDelta: 12 }), 'brilliant');
});

test('Book follows the matched line, including plies beyond the 10-ply heuristic', () => {
  assert.equal(classifyMove(0.05, { ply: 12, inBookLine: true }), 'book', 'theory runs to 14 plies');
  assert.equal(classifyMove(0.05, { ply: 12, inBookLine: null }), 'best', 'heuristic still stops at 10');
  assert.equal(classifyMove(0.5, { ply: 3, inBookLine: false }), 'excellent', 'left the line / custom start');
  assert.equal(classifyMove(3, { ply: 5, inBookLine: true }), 'good', 'a book ply that loses >2% is not book');
});

test('isStandardStart ignores the move counters but not the position', () => {
  assert.equal(isStandardStart('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), true);
  assert.equal(isStandardStart('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3 9'), true);
  assert.equal(isStandardStart('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'), false);
  assert.equal(isStandardStart('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'), false);
});

function analyse(record, evals, bests) {
  const replay = buildReplay(record);
  return buildAnalysisResult(record, replay, evals(replay), replay.fens.map(() => null), bests(replay));
}

test('the engine\'s own top move is never graded below Best because of search noise', () => {
  const record = { initialFen: null, moves: [{ from: 'e2', to: 'e4' }], result: '*' };
  // white to move: +60cp at the start; after e4 the (independent) search says
  // black is at -20cp (= +20 for white) — a ~3.6% "loss" that is pure noise
  const result = analyse(
    record,
    (replay) => replay.fens.map((_, j) => ({ cp: j === 0 ? 60 : -20, mate: null })),
    (replay) => replay.fens.map((_, j) => (j === 0 ? { from: 'e2', to: 'e4' } : null)),
  );
  assert.equal(result.plies[0].deltaW, 0);
  assert.equal(result.plies[0].cpLoss, 0);
  assert.notEqual(result.plies[0].tier, 'excellent');
  assert.notEqual(result.plies[0].tier, 'good');

  // ...but a DIFFERENT move with the same evals is really graded by the loss
  const other = analyse(
    record,
    (replay) => replay.fens.map((_, j) => ({ cp: j === 0 ? 60 : -20, mate: null })),
    (replay) => replay.fens.map((_, j) => (j === 0 ? { from: 'd2', to: 'd4' } : null)),
  );
  assert.ok(other.plies[0].deltaW > 3);
});

test('custom start positions never get theory: no opening, no fake Book', () => {
  const record = { initialFen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', moves: [{ from: 'e2', to: 'e4' }], result: '*' };
  const flat = (replay) => replay.fens.map(() => ({ cp: 0, mate: null }));
  const none = (replay) => replay.fens.map(() => null);
  assert.notEqual(analyse(record, flat, none).plies[0].tier, 'book');

  const standard = { initialFen: null, moves: [{ from: 'e2', to: 'e4' }], result: '*' };
  assert.equal(analyse(standard, flat, none).plies[0].tier, 'book', 'from the real start the heuristic still applies');
});

test('a matched 14-ply line grades all 14 plies as Book', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6'];
  // build a UCI record by replaying the SANs
  const record = { initialFen: null, moves: [], result: '*' };
  const probe = buildReplay({ initialFen: null, moves: [] });
  void probe;
  const uci = [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'b5'], ['a7', 'a6'], ['b5', 'a4'], ['g8', 'f6'], ['e1', 'g1'], ['f8', 'e7'], ['f1', 'e1'], ['b7', 'b5'], ['a4', 'b3'], ['d7', 'd6']];
  record.moves = uci.map(([from, to]) => ({ from, to }));
  const replay = buildReplay(record);
  assert.deepEqual(replay.moves.map((m) => m.san), sans);
  const flat = replay.fens.map(() => ({ cp: 0, mate: null }));
  const result = buildAnalysisResult(record, replay, flat, flat.map(() => null), flat.map(() => null), null, { eco: 'C92', name: 'Ruy Lopez', plies: 14 });
  assert.equal(result.plies.filter((p) => p.tier === 'book').length, 14);
});

test('one catastrophic move no longer collapses a long game to ~29%', () => {
  const clean = Array(39).fill(0.5);
  const withMateBlunder = [...clean, 100];
  const harmonic = calculatePlayerAccuracy(withMateBlunder);
  assert.ok(harmonic < 30, `harmonic alone: ${harmonic.toFixed(1)}`);

  // the blunder happens while the evaluation is swinging wildly
  const series = Array.from({ length: 41 }, (_, i) => (i < 39 ? 50 : i === 39 ? 50 : 100));
  const blended = calculateBlendedAccuracy(withMateBlunder, volatilityWeights(series).slice(0, 40));
  assert.ok(blended > harmonic + 10, `blended ${blended.toFixed(1)} vs harmonic ${harmonic.toFixed(1)}`);
  assert.ok(blended < 80, 'still clearly punished');

  const perfect = calculateBlendedAccuracy(clean, volatilityWeights(Array(41).fill(50)).slice(0, 39));
  assert.ok(perfect > 95);
});

test('volatility weights are clamped and follow the swings', () => {
  const flat = volatilityWeights([50, 50, 50, 50, 50, 50]);
  assert.ok(flat.every((w) => w === 0.5));
  const wild = volatilityWeights([50, 50, 50, 0, 100, 0, 100, 50, 50, 50, 50, 50]);
  assert.ok(wild.every((w) => w >= 0.5 && w <= 12));
  assert.ok(Math.max(...wild) > 10 && wild[wild.length - 1] < 5);
  assert.equal(calculateBlendedAccuracy([], []), null);
  assert.equal(calculateBlendedAccuracy([0, 25]), calculatePlayerAccuracy([0, 25]), 'no weights -> harmonic');
});

test('coach text does not claim a lost advantage for a negligible loss on a good move', () => {
  const coach = new CoachService();
  const best = coach.generateInsight({ ply: 4, color: 'w', san: 'Nf3', tier: 'best', deltaW: 0.05, cpLoss: 1, bestSan: 'd4' });
  assert.doesNotMatch(best.explanation, /เสียความได้เปรียบ/u);
  const excellent = coach.generateInsight({ ply: 4, color: 'w', san: 'Nf3', tier: 'excellent', deltaW: 1.4, cpLoss: 10, bestSan: 'd4' });
  assert.doesNotMatch(excellent.explanation, /เสียความได้เปรียบ/u);
  const good = coach.generateInsight({ ply: 4, color: 'w', san: 'Nf3', tier: 'good', deltaW: 3.5, cpLoss: 40, bestSan: 'd4' });
  assert.match(good.explanation, /เสียความได้เปรียบ 3\.5%/u);
});

test('...but a large drop after the engine\'s own choice is real (a tactic the first search missed)', () => {
  const record = { initialFen: null, moves: [{ from: 'e2', to: 'e4' }], result: '*' };
  const result = analyse(
    record,
    // before: +100 for white; after: black now stands at +300 => white is at -300
    (replay) => replay.fens.map((_, j) => ({ cp: j === 0 ? 100 : 300, mate: null })),
    (replay) => replay.fens.map((_, j) => (j === 0 ? { from: 'e2', to: 'e4' } : null)),
  );
  assert.ok(result.plies[0].deltaW > 20, `deltaW ${result.plies[0].deltaW}`);
  assert.ok(['blunder', 'miss', 'mistake'].includes(result.plies[0].tier), result.plies[0].tier);
  assert.ok(result.plies[0].cpLoss > 300);
});
