// Mistake bank: what is kept, when it comes back, and that bad storage is harmless.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOX_DELAYS_MS, MAX_MISTAKES, MISTAKES_KEY, PRACTICE_BATCH, TOP_BOX,
  createMistakeBank, mistakesFromAnalysis, practiceAnalysis,
} from '../src/mistakes.js';

const DAY = 24 * 60 * 60 * 1000;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

const ply = (n, color, tier, extra = {}) => ({
  ply: n, color, tier, san: `m${n}`, deltaW: 25,
  bestMove: { from: 'd2', to: 'd4' }, bestSan: 'd4', acceptable: [{ from: 'd2', to: 'd4' }, { from: 'c2', to: 'c4' }], ...extra,
});
const analysis = (plies, fens = [START, AFTER_E4, START, AFTER_E4, START, AFTER_E4]) => ({ plies, fens });

/** N distinct one-pawn endgame positions (a white pawn walking along the 2nd rank plus a king on file N). */
function distinctPositions(count) {
  const positions = [];
  for (let king = 0; positions.length < count && king < 8; king++) {
    for (let pawn = 0; positions.length < count && pawn < 8; pawn++) {
      const rank2 = `${'1'.repeat(pawn)}P${'1'.repeat(7 - pawn)}`.replace(/1+/g, (m) => String(m.length));
      const rank1 = `${'1'.repeat(king)}K${'1'.repeat(7 - king)}`.replace(/1+/g, (m) => String(m.length));
      positions.push(`4k3/8/8/8/8/8/${rank2}/${rank1} w - - 0 1`);
    }
  }
  return positions;
}

// ---- what gets kept -----------------------------------------------------------------

test('only the player\'s own mistakes / blunders / misses become puzzles', () => {
  const found = mistakesFromAnalysis(analysis([
    ply(0, 'w', 'blunder'),
    ply(1, 'b', 'blunder'),   // the opponent's
    ply(2, 'w', 'inaccuracy'), // too small
    ply(3, 'b', 'best'),
    ply(4, 'w', 'miss'),
    ply(5, 'b', 'mistake'),
  ]), 'w');
  assert.deepEqual(found.map((m) => m.playedSan), ['m0', 'm4']);
  assert.equal(found[0].fen, START);
  assert.deepEqual(found[0].acceptable, [{ from: 'd2', to: 'd4' }, { from: 'c2', to: 'c4' }]);
  assert.equal(found[0].bestSan, 'd4');
});

test('a mistake without an engine move or a position is skipped; unknown colour keeps nothing', () => {
  const plies = [ply(0, 'w', 'blunder', { bestMove: null }), ply(2, 'w', 'blunder')];
  assert.deepEqual(mistakesFromAnalysis({ plies, fens: [START, AFTER_E4] }, 'w'), [], 'ply 2 has no fen, ply 0 no best move');
  assert.deepEqual(mistakesFromAnalysis(analysis([ply(0, 'w', 'blunder')]), null), []);
  assert.deepEqual(mistakesFromAnalysis(null, 'w'), []);
});

test('without an acceptable list the engine move alone is the solution', () => {
  const [item] = mistakesFromAnalysis(analysis([ply(0, 'w', 'blunder', { acceptable: undefined })]), 'w');
  assert.deepEqual(item.acceptable, [{ from: 'd2', to: 'd4' }]);
});

test('adding is idempotent per game and per position', () => {
  const bank = createMistakeBank({ storage: memoryStorage(), now: () => 1000 });
  const a = analysis([ply(0, 'w', 'blunder'), ply(4, 'w', 'mistake')]);
  assert.equal(bank.addFromAnalysis(a, 'w', 'game-1'), 1, 'both plies are the same position + best move: one puzzle');
  assert.equal(bank.addFromAnalysis(a, 'w', 'game-1'), 0, 'the same game again adds nothing');
  assert.equal(bank.addFromAnalysis(a, 'w', 'game-2'), 0, 'a different game with the same position adds nothing');
  assert.equal(bank.all.length, 1);
  const other = analysis([ply(1, 'w', 'blunder')], [START, AFTER_E4]);
  assert.equal(bank.addFromAnalysis(other, 'w', 'game-3'), 1, 'a new position is added');
});

// ---- the schedule ---------------------------------------------------------------------

test('a new mistake is due at once; solving it pushes it out, missing it brings it straight back', () => {
  let now = 10_000;
  const bank = createMistakeBank({ storage: memoryStorage(), now: () => now });
  bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g');
  const [item] = bank.due();
  assert.equal(item.box, 0);

  let after = bank.record(item.id, true);
  assert.equal(after.box, 1);
  assert.equal(after.dueAt, now + BOX_DELAYS_MS[1]);
  assert.deepEqual(bank.due(), [], 'not due for a day');

  now += DAY;
  assert.equal(bank.due().length, 1);
  after = bank.record(item.id, true);
  assert.equal(after.box, 2);
  assert.equal(after.dueAt, now + 3 * DAY);

  after = bank.record(item.id, false);
  assert.equal(after.box, 0, 'a miss drops to the bottom');
  assert.equal(after.dueAt, now, 'and is due again immediately');
  assert.equal(after.missed, 1);
  assert.equal(after.solved, 2);
});

test('the ladder tops out and counts as mastered', () => {
  let now = 0;
  const bank = createMistakeBank({ storage: memoryStorage(), now: () => now });
  bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g');
  const [{ id }] = bank.all;
  for (let i = 0; i < 8; i++) { bank.record(id, true); now += 30 * DAY; }
  const [item] = bank.all;
  assert.equal(item.box, TOP_BOX);
  assert.equal(bank.stats(now).mastered, 1);
  assert.equal(bank.ahead().length, 0, 'nothing left to practise ahead');
});

test('a practice batch is capped, the most overdue comes first, and extra practice serves the weakest', () => {
  let now = 50 * DAY;
  const bank = createMistakeBank({ storage: memoryStorage(), now: () => now });
  const fens = distinctPositions(PRACTICE_BATCH + 3);
  assert.equal(new Set(fens).size, PRACTICE_BATCH + 3);
  assert.equal(bank.addFromAnalysis({ plies: fens.map((_, i) => ply(i, 'w', 'blunder')), fens }, 'w', 'g'), PRACTICE_BATCH + 3);
  assert.equal(bank.due().length, PRACTICE_BATCH, 'a session is one batch');
  assert.equal(bank.due(3).length, 3);

  const first = bank.all[0].id;
  bank.record(first, true); // now scheduled for tomorrow
  assert.ok(!bank.due(50).some((m) => m.id === first));

  now += 60 * DAY;
  for (const m of bank.all) bank.record(m.id, true); // everything solved once: nothing due
  assert.equal(bank.due().length, 0);
  assert.equal(bank.ahead().length, PRACTICE_BATCH, 'extra practice: a batch of the weakest');
});

test('the most overdue mistake comes first', () => {
  let now = 0;
  const bank = createMistakeBank({ storage: memoryStorage(), now: () => now });
  const [a, b] = distinctPositions(2);
  bank.addFromAnalysis({ plies: [ply(0, 'w', 'blunder'), ply(1, 'w', 'blunder')], fens: [a, b] }, 'w', 'g');
  const [x, y] = bank.all.map((m) => m.id);
  bank.record(x, true); // due in a day
  bank.record(y, false); // due now
  now = 5 * DAY;
  assert.deepEqual(bank.due().map((m) => m.id), [y, x].sort((p, q) => bank.all.find((m) => m.id === p).dueAt - bank.all.find((m) => m.id === q).dueAt));
});

test('recording an unknown id changes nothing', () => {
  const bank = createMistakeBank({ storage: memoryStorage() });
  assert.equal(bank.record('nope', true), null);
});

test('stats count boxes, due and mastered', () => {
  const now = 0;
  const bank = createMistakeBank({ storage: memoryStorage(), now: () => now });
  const fens = distinctPositions(3);
  bank.addFromAnalysis({ plies: fens.map((_, i) => ply(i, 'w', 'blunder')), fens }, 'w', 'g');
  bank.record(bank.all[0].id, true);
  const s = bank.stats(now);
  assert.equal(s.total, 3);
  assert.equal(s.due, 2);
  assert.deepEqual(s.byBox.slice(0, 2), [2, 1]);
});

// ---- storage -----------------------------------------------------------------------------

test('the bank survives a reload and ignores corrupt data', () => {
  const storage = memoryStorage();
  const first = createMistakeBank({ storage, now: () => 5 });
  first.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g');
  first.record(first.all[0].id, true);
  const again = createMistakeBank({ storage, now: () => 5 });
  assert.equal(again.all.length, 1);
  assert.equal(again.all[0].box, 1);
  assert.equal(again.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g'), 0, 'the game is remembered as done');

  for (const garbage of ['{nope', '"x"', '{"v":2}', '{"v":1,"items":[{"id":1},null,{"id":"a","fen":"x"}]}']) {
    const bank = createMistakeBank({ storage: memoryStorage({ [MISTAKES_KEY]: garbage }) });
    assert.equal(bank.all.length, 0, garbage);
  }
});

test('an item with a hostile FEN or moves is dropped on load', () => {
  const bad = { v: 1, items: [
    { id: 'a', fen: '<img src=x onerror=alert(1)>', acceptable: [{ from: 'a2', to: 'a3' }] },
    { id: 'b', fen: START, acceptable: [{ from: 'zz', to: 'a3' }] },
    { id: 'c', fen: START, acceptable: [] },
    { id: 'd', fen: START, acceptable: [{ from: 'a2', to: 'a3' }], box: 99, bestSan: 'x'.repeat(50) },
  ] };
  const bank = createMistakeBank({ storage: memoryStorage({ [MISTAKES_KEY]: JSON.stringify(bad) }) });
  assert.deepEqual(bank.all.map((i) => i.id), ['d']);
  assert.equal(bank.all[0].box, TOP_BOX, 'box is clamped');
  assert.equal(bank.all[0].bestSan.length, 12);
});

test('broken or missing storage never throws', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  for (const storage of [null, throwing]) {
    const bank = createMistakeBank({ storage });
    assert.equal(bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g'), 1);
    assert.equal(bank.due().length, 1);
  }
});

test('two tabs do not overwrite each other\'s mistakes', () => {
  const storage = memoryStorage();
  const a = createMistakeBank({ storage });
  const b = createMistakeBank({ storage });
  a.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g1');
  b.addFromAnalysis(analysis([ply(1, 'w', 'blunder')], [START, AFTER_E4]), 'w', 'g2');
  assert.equal(createMistakeBank({ storage }).all.length, 2);
});

test('remove and clear work, and clear also forgets which games were read', () => {
  const bank = createMistakeBank({ storage: memoryStorage() });
  bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g');
  bank.remove(bank.all[0].id);
  assert.equal(bank.all.length, 0);
  bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g2');
  bank.clear();
  assert.equal(bank.all.length, 0);
  assert.equal(bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')]), 'w', 'g'), 1);
  assert.equal(MAX_MISTAKES, 400);
});

// ---- the practice session ---------------------------------------------------------------------

test('practiceAnalysis gives the puzzle machinery everything it reads', () => {
  const bank = createMistakeBank({ storage: memoryStorage() });
  bank.addFromAnalysis(analysis([ply(0, 'w', 'blunder')], [START, AFTER_E4]), 'w', 'g');
  bank.addFromAnalysis(analysis([ply(1, 'b', 'blunder', { bestMove: { from: 'd7', to: 'd5' }, acceptable: [{ from: 'd7', to: 'd5' }] })], [START, AFTER_E4]), 'b', 'g2');
  const a = practiceAnalysis(bank.all);
  assert.equal(a.plies.length, 2);
  assert.deepEqual(a.fens, [START, AFTER_E4]);
  assert.equal(a.plies[0].color, 'w');
  assert.equal(a.plies[1].color, 'b', 'the side to move in the position is the one who must find the move');
  assert.equal(a.positions.length, 3, 'one position per ply plus the final');
  assert.deepEqual(a.plies[0].bestMove, { from: 'd2', to: 'd4' });
  assert.equal(a.plies[0].tier, 'blunder');
  assert.equal(a.practice, true);
  assert.equal(practiceAnalysis([]).plies.length, 0);
});
