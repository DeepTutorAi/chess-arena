// The bot's opening book: sound-only theory, keyed by position, weighted random
// picks, and the controller playing from it instead of calling the engine.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { BotBook, bookPlies, positionKey } from '../src/botbook.js';
import { collectEdges, filterEdges } from '../scripts/build-botbook.mjs';
import { Controller, MODES } from '../src/controller.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('positionKey ignores move counters but not side, castling or en passant', () => {
  const a = positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  assert.equal(a, positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 5 9'));
  assert.notEqual(a, positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e3 0 1'));
  assert.notEqual(a, positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b Kkq e3 0 1'));
  assert.notEqual(a, positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'));
});

test('a stronger level may use more theory, capped by what the book holds', () => {
  let last = 0;
  for (let level = 1; level <= 11; level++) {
    assert.ok(bookPlies(level) >= last);
    assert.ok(bookPlies(level) <= 12);
    last = bookPlies(level);
  }
  assert.ok(bookPlies(1) < bookPlies(11));
});

test('pick draws by sqrt(count) weight, skips illegal entries, and is null out of book', () => {
  const book = new BotBook({ positions: { [positionKey(START)]: [['e2e4', 100], ['d2d4', 25], ['a2a3', 1]] } });
  assert.equal(book.pick('8/8/8/8/8/8/8/K6k w - - 0 1'), null, 'unknown position');
  assert.deepEqual(book.candidates(START).map((c) => c.weight), [10, 5, 1]);

  // rng at the very start / end of the range lands on the first / last entry.
  assert.equal(book.pick(START, { rng: () => 0 }), 'e2e4');
  assert.equal(book.pick(START, { rng: () => 0.999999 }), 'a2a3');
  // 10 of 16 weight units belong to e4: a roll of 0.6 (9.6) is still e4, 0.65 (10.4) is d4.
  assert.equal(book.pick(START, { rng: () => 0.6 }), 'e2e4');
  assert.equal(book.pick(START, { rng: () => 0.65 }), 'd2d4');

  assert.equal(book.pick(START, { isLegal: (uci) => uci === 'd2d4' }), 'd2d4');
  assert.equal(book.pick(START, { isLegal: () => false }), null, 'a hash collision can never produce an illegal move');
  assert.equal(book.pick(START, { prefer: ['a2a3'] }), 'a2a3', 'a preferred move wins when the book has it');
  assert.ok(['e2e4', 'd2d4', 'a2a3'].includes(book.pick(START, { prefer: ['h2h4'] })), 'an unavailable preference is ignored');
});

test('collectEdges merges transpositions and counts how many lines use a move', () => {
  const nodes = collectEdges([
    { moves: 'e4 e5 Nf3' },
    { moves: 'e4 c5' },
    { moves: 'Nf3 e5 e4' }, // transposes into 1.e4 e5 2.Nf3? no — different move order, same position after 3 plies
  ], 12);
  const root = nodes.get(positionKey(START));
  assert.deepEqual([...root.moves].map(([uci, edge]) => [uci, edge.count]).sort(), [['e2e4', 2], ['g1f3', 1]]);
  const afterE4 = new Chess();
  afterE4.move('e4');
  assert.deepEqual([...nodes.get(positionKey(afterE4.fen())).moves.keys()].sort(), ['c7c5', 'e7e5']);
  // 1.e4 e5 2.Nf3 and 1.Nf3 e5 2.e4 reach the same position: it is one node.
  const transposed = new Chess();
  for (const san of ['e4', 'e5', 'Nf3']) transposed.move(san);
  const other = new Chess();
  for (const san of ['Nf3', 'e5', 'e4']) other.move(san);
  assert.equal(positionKey(transposed.fen()), positionKey(other.fen()));
});

test('collectEdges cuts lines at maxPlies', () => {
  const nodes = collectEdges([{ moves: 'e4 e5 Nf3 Nc6 Bb5 a6' }], 3);
  assert.equal(nodes.size, 3, 'only the first three plies are book positions');
});

test('filterEdges drops moves the engine scores clearly worse than the best', () => {
  const nodes = collectEdges([{ moves: 'e4' }, { moves: 'Na3' }, { moves: 'd4' }], 12);
  // Evaluations from the side to move: start position +30 for white; after each
  // white move black is to move and sees the reverse.
  const after = (san) => { const g = new Chess(); g.move(san); return g.fen(); };
  const scores = new Map([
    [positionKey(START), 30],
    [positionKey(after('e4')), -30],   // white keeps +30
    [positionKey(after('d4')), -20],   // white +20: within 50 of the best
    [positionKey(after('Na3')), 10],   // white -10: 40 below the best, still inside
  ]);
  const evalOf = (fen) => scores.get(positionKey(fen));
  let positions = filterEdges(nodes, evalOf, 50);
  assert.deepEqual(positions[positionKey(START)].map(([uci]) => uci).sort(), ['b1a3', 'd2d4', 'e2e4']);

  scores.set(positionKey(after('Na3')), 120); // white -120: junk
  positions = filterEdges(nodes, evalOf, 50);
  assert.deepEqual(positions[positionKey(START)].map(([uci]) => uci).sort(), ['d2d4', 'e2e4']);
  assert.equal(positions[positionKey(START)][0][1], 1);
});

test('the shipped book only offers legal moves and starts every line from the initial position', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const path = new URL('../public/assets/botbook.json', import.meta.url);
  if (!existsSync(path)) return; // generated by `node scripts/build-botbook.mjs`
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(data.positions[positionKey(START)], 'the initial position is in the book');
  const rootMoves = data.positions[positionKey(START)].map(([uci]) => uci);
  assert.ok(rootMoves.includes('e2e4') && rootMoves.includes('d2d4'));
  assert.ok(!rootMoves.includes('b1a3'), 'junk first moves are filtered out');
  // Every reply of every position reachable in <=4 plies is a legal move there.
  const seen = new Set();
  const walk = (game, depth) => {
    if (depth === 0) return;
    const key = positionKey(game.fen());
    if (seen.has(key)) return;
    seen.add(key);
    const legal = new Set(game.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')));
    for (const [uci] of data.positions[key] ?? []) {
      assert.ok(legal.has(uci), `${uci} is legal in ${game.fen()}`);
      const next = new Chess(game.fen());
      next.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      walk(next, depth - 1);
    }
  };
  walk(new Chess(), 4);
  assert.ok(seen.size > 10);
});

// ---- controller ---------------------------------------------------------------

function makeBotController(book) {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const ground = {
    state: { dom: { bounds: { clear() {} } } },
    set() {}, setShapes() {}, playPremove() {}, cancelPremove() {},
  };
  const ui = new Proxy({}, { get: () => () => {} });
  const controller = new Controller({ ui, ground, onPromotion: async () => 'q', loadBotBook: async () => book });
  const engineCalls = [];
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'w';
  controller.engineSide = 'b';
  controller.levelIndex = 3;
  controller.engineReady = true;
  controller.engine = { setPosition: (fen) => engineCalls.push(['position', fen]), go: (opts) => engineCalls.push(['go', opts]), quit() {} };
  controller.botBook = book;
  return { controller, engineCalls };
}

test('vs bot: the bot plays a book reply without touching the engine', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const afterE4 = new Chess();
    afterE4.move('e4');
    const book = new BotBook({ positions: { [positionKey(afterE4.fen())]: [['c7c5', 1]] } });
    const { controller, engineCalls } = makeBotController(book);
    controller.game = afterE4;
    controller._engineTurn();
    assert.equal(controller.engineBusy, true);
    mock.timers.tick(30000);
    assert.deepEqual(controller.game.history(), ['e4', 'c5']);
    assert.equal(engineCalls.length, 0, 'no search for a book move');
    assert.equal(controller.engineBusy, false);
    controller.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('vs bot: out of book, past the level\'s theory depth, or with no book loaded the engine plays', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const afterE4 = new Chess();
    afterE4.move('e4');
    const book = new BotBook({ positions: { [positionKey(afterE4.fen())]: [['c7c5', 1]] } });

    // No book yet (still downloading).
    let { controller, engineCalls } = makeBotController(book);
    controller.botBook = null;
    controller.game = new Chess(afterE4.fen());
    controller._engineTurn();
    mock.timers.tick(30000);
    assert.equal(engineCalls.at(-1)[0], 'go');
    controller.dispose();

    // Position not in the book.
    ({ controller, engineCalls } = makeBotController(book));
    const other = new Chess();
    other.move('d4');
    controller.game = other;
    controller._engineTurn();
    mock.timers.tick(30000);
    assert.equal(engineCalls.at(-1)[0], 'go');
    controller.dispose();

    // A weak level stops using theory after bookPlies(level) plies even if the book goes on.
    ({ controller, engineCalls } = makeBotController(book));
    controller.levelIndex = 0; // level 1 -> 5 plies
    const deep = new Chess();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) deep.move(san);
    controller.game = deep;
    controller.botBook = new BotBook({ positions: { [positionKey(deep.fen())]: [['a7a6', 1]] } });
    controller._engineTurn();
    mock.timers.tick(30000);
    assert.equal(engineCalls.at(-1)[0], 'go', 'level 1 is out of theory at ply 5');
    controller.dispose();
  } finally {
    mock.timers.reset();
  }
});
