// The motif coach: concrete reasons from the board (hung pieces, forks, mates,
// missed captures) — and silence when the board does not show one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { explainGoodMove, explainMistake, forkTargets, isBackRankMate } from '../src/motifs.js';

const mv = (from, to, promotion) => ({ from, to, promotion });
const keys = (reasons) => reasons.map((r) => r.key);

test('a move that allows mate in one names it', () => {
  // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
  const reasons = explainMistake({
    fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
    played: mv('g8', 'f6'),
    reply: mv('h5', 'f7'),
  });
  assert.deepEqual(keys(reasons), ['allowed-mate']);
  assert.match(reasons[0].text, /รุกฆาต/u);
});

test('a back-rank mate is recognised as such', () => {
  const fenBefore = '6k1/p4ppp/8/8/8/8/5PPP/4R1K1 b - - 0 1';
  const reasons = explainMistake({ fenBefore, played: mv('a7', 'a6'), reply: mv('e1', 'e8') });
  assert.deepEqual(keys(reasons), ['allowed-mate']);
  assert.match(reasons[0].text, /back-rank/u);
  const mated = new Chess('4R1k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1');
  assert.equal(isBackRankMate(mated), true);
  // a king with an escape square is not back-rank mated
  assert.equal(isBackRankMate(new Chess('4R1k1/5p1p/8/8/8/8/8/6K1 b - - 0 1')), false);
});

test('a forced mate that was there and not played is called out', () => {
  const reasons = explainMistake({
    fenBefore: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1',
    played: mv('g1', 'h1'),
    best: mv('e1', 'e8'),
    bestMate: 1,
  });
  assert.equal(reasons[0].key, 'missed-mate');
  assert.match(reasons[0].text, /ใน 1 ตา/u);
  assert.match(reasons[0].text, /Re8#/u);
});

test('leaving a piece undefended for the opponent to take is a hanging piece', () => {
  // The rook on a1 is attacked by the queen on d4 and nothing defends it; Ke2 ignores that.
  const reasons = explainMistake({
    fenBefore: '4k3/8/8/8/3q4/8/8/R3K3 w - - 0 1',
    played: mv('e1', 'e2'),
    reply: mv('d4', 'a1'),
  });
  assert.equal(reasons[0].key, 'hanging');
  assert.match(reasons[0].text, /เรือที่ a1 ไม่มีหมากคุ้มกัน/u);
});

test('the opponent\'s best answer being a fork is named, with what it hits', () => {
  // 1.Kh3?? lets Nf2+ hit the king, queen and rook at once.
  const reasons = explainMistake({
    fenBefore: '4k3/8/8/8/4n3/8/7K/3Q3R w - - 0 1',
    played: mv('h2', 'h3'),
    reply: mv('e4', 'f2'),
  });
  assert.equal(reasons[0].key, 'allowed-fork');
  assert.match(reasons[0].text, /ม้า/u);
  assert.match(reasons[0].text, /คิงที่ h3/u);
  assert.match(reasons[0].text, /ควีนที่ d1 และ เรือที่ h1 พร้อมกัน|เรือที่ h1 พร้อมกัน/u);
  assert.match(reasons[0].text, /ควีนที่ d1/u);
});

test('a free capture that was passed up is reported', () => {
  const reasons = explainMistake({
    fenBefore: '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1',
    played: mv('e1', 'e2'),
    best: mv('d1', 'd5'),
  });
  assert.equal(reasons[0].key, 'missed-capture');
  assert.match(reasons[0].text, /ควีนที่ d5/u);
  assert.match(reasons[0].text, /ไม่มีใครคุ้มกัน/u);
});

test('a missed fork is reported when the better move forks and nothing else applies', () => {
  const reasons = explainMistake({
    fenBefore: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
    played: mv('e1', 'e2'),
    best: mv('b5', 'c7'),
  });
  assert.deepEqual(keys(reasons), ['missed-fork']);
  assert.match(reasons[0].text, /คิงที่ e8/u);
  assert.match(reasons[0].text, /เรือที่ a8/u);
});

test('grabbing a pawn with the queen and losing her is a bad capture', () => {
  const reasons = explainMistake({
    fenBefore: '3rk3/8/3p4/8/8/8/8/3QK3 w - - 0 1',
    played: mv('d1', 'd6'),
    reply: mv('d8', 'd6'),
  });
  assert.deepEqual(keys(reasons), ['bad-capture']);
  assert.match(reasons[0].text, /แลกไม่คุ้ม/u);
});

test('an equal exchange or a defended piece is NOT reported as a blunder', () => {
  // Nxd5 exd5: knight for knight — an ordinary trade.
  const g = new Chess('rnbqkb1r/ppp2ppp/5n2/3np3/8/2N2N2/PPPPPPPP/R1BQKB1R w KQkq - 0 1');
  const reasons = explainMistake({
    fenBefore: g.fen(),
    played: mv('c3', 'd5'),
    reply: mv('f6', 'd5'),
  });
  assert.deepEqual(reasons, []);
});

test('a fork whose knight can just be taken is not a fork', () => {
  // The knight on c7 forks the king and rook but the queen on d8... captures it for free.
  const game = new Chess('r2qk3/2N5/8/8/8/8/8/4K3 b - - 0 1');
  assert.deepEqual(forkTargets(game, 'c7'), []);
  const safe = new Chess('r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1');
  assert.deepEqual(forkTargets(safe, 'c7').map((t) => t.square).sort(), ['a8', 'e8']);
});

test('good moves: mate, forks and free material are worth mentioning; quiet moves are not', () => {
  const mate = explainGoodMove({ fenBefore: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', played: mv('e1', 'e8') });
  assert.deepEqual(keys(mate), ['mate']);
  assert.match(mate[0].text, /แถวหลัง/u);

  const fork = explainGoodMove({ fenBefore: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', played: mv('b5', 'c7') });
  assert.equal(fork[0].key, 'fork');

  const free = explainGoodMove({ fenBefore: '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1', played: mv('d1', 'd5') });
  assert.equal(free[0].key, 'free-piece');

  const quiet = explainGoodMove({
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', played: mv('e2', 'e4'),
  });
  assert.deepEqual(quiet, []);

  const promo = explainGoodMove({ fenBefore: '8/P7/8/8/8/8/k7/4K3 w - - 0 1', played: mv('a7', 'a8', 'q') });
  assert.equal(promo[0].key, 'promotion');
});

test('never throws: bad FEN, illegal move, missing data all give no reasons', () => {
  assert.deepEqual(explainMistake({ fenBefore: 'nonsense', played: mv('e2', 'e4') }), []);
  assert.deepEqual(explainMistake({
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', played: mv('e2', 'e5'),
  }), []);
  assert.deepEqual(explainGoodMove({ fenBefore: '', played: mv('a1', 'a2') }), []);
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.deepEqual(explainMistake({ fenBefore: start, played: mv('e2', 'e4'), best: mv('a1', 'a5'), reply: mv('z9', 'z9') }), []);
});

// ---- end to end: analysis data -> coach insight ---------------------------------

import { buildAnalysisResult, buildReplay } from '../src/analyzer.js';
import { CoachService } from '../src/review-ui.js';

test('the coach card gets the reasons, from the position before the move', () => {
  const record = {
    initialFen: null,
    moves: [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']]
      .map(([from, to]) => ({ from, to })),
    result: '1-0',
  };
  const replay = buildReplay(record);
  const evals = replay.fens.map((_, j) => {
    if (replay.terminal[j]) return { cp: null, mate: -1 };
    if (j === 6) return { cp: null, mate: 1 };           // white to move, mate in 1 after 3...Nf6??
    return { cp: 30, mate: null };
  });
  // black's better 3rd move was ...g6; white's best answer to ...Nf6 is Qxf7#
  const bests = replay.fens.map(() => null);
  bests[5] = { from: 'g7', to: 'g6' };
  bests[6] = { from: 'h5', to: 'f7' };
  const analysis = buildAnalysisResult(record, replay, evals, replay.fens.map(() => null), bests);
  const blunder = analysis.plies[5];
  assert.equal(blunder.san, 'Nf6');
  assert.equal(blunder.afterMate, -1);
  assert.equal(blunder.promotion, null);

  const coach = new CoachService();
  const insight = coach.generateInsight(blunder, { fenBefore: analysis.fens[5] });
  assert.equal(insight.reasons[0].key, 'allowed-mate');
  assert.match(insight.explanation, /เสียความได้เปรียบ/u, 'the generic text is kept');

  // no position given (old callers): no reasons, no crash
  assert.deepEqual(coach.generateInsight(blunder).reasons, []);
  // opening moves in book get none
  const quiet = coach.generateInsight(analysis.plies[0], { fenBefore: analysis.fens[0] });
  assert.deepEqual(quiet.reasons, []);
});

test('only real mistakes get an explanation; a "good" move and a king capture do not', () => {
  const coach = new CoachService();
  const fenBefore = '4k3/8/8/8/3q4/8/8/R3K3 w - - 0 1';
  const ply = {
    ply: 0, color: 'w', san: 'Ke2', from: 'e1', to: 'e2', promotion: null, tier: 'good', deltaW: 3,
    bestMove: null, bestSan: null, reply: { from: 'd4', to: 'a1' }, replySan: 'Qxa1', bestMate: null, afterMate: null, cpLoss: 30,
  };
  assert.deepEqual(coach.generateInsight(ply, { fenBefore }).reasons, [], 'a 3% slip is not worth a lecture');
  assert.equal(coach.generateInsight({ ...ply, tier: 'blunder', deltaW: 40 }, { fenBefore }).reasons[0].key, 'hanging');

  const kingTakesPawn = explainGoodMove({ fenBefore: '4k3/8/8/8/8/8/2p5/1K6 w - - 0 1', played: mv('b1', 'c2') });
  assert.deepEqual(kingTakesPawn, [], 'the king "winning material" would be nonsense');
});
