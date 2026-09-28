// OpeningBook lookup (roadmap.md A2): longest prefix of the game's SAN moves
// that matches a known opening line. Entries come from the trimmed lichess
// chess-openings dataset (CC0) built by scripts/build-openings.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { OpeningBook, getOpeningBook } from '../src/openings.js';

const book = new OpeningBook([
  { moves: 'e4 e5 Nf3', eco: 'C40', name: "King's Knight Opening" },
  { moves: 'e4 c5', eco: 'B20', name: 'Sicilian Defense' },
  { moves: 'e4 c5 Nf3 d6', eco: 'B50', name: 'Modern Variations' },
  { moves: 'd4 d5 c4', eco: 'D06', name: 'Queen\'s Gambit' },
]);

test('lookup returns the LONGEST matching prefix of the game moves', () => {
  assert.deepEqual(book.lookup(['e4', 'c5', 'Nf3', 'd6', 'Bg5']), {
    eco: 'B50',
    name: 'Modern Variations',
    plies: 4,
  });
});

test('lookup matches short lines and unknown moves', () => {
  assert.deepEqual(book.lookup(['e4', 'c5']), { eco: 'B20', name: 'Sicilian Defense', plies: 2 });
  assert.equal(book.lookup(['d4']), null);
  assert.equal(book.lookup([]), null);
});

test('lookup still matches when the played line exhausts a known opening exactly', () => {
  assert.deepEqual(book.lookup(['d4', 'd5', 'c4']), { eco: 'D06', name: "Queen's Gambit", plies: 3 });
});

test('lookup normalizes check/mate suffixes on both sides', () => {
  const annotated = new OpeningBook([
    { moves: 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7', eco: 'C57', name: 'Italian Checkline' },
  ]);
  // chess.js SAN for the mating move is "Qxf7#"; the dataset may store "Qxf7".
  assert.deepEqual(
    annotated.lookup(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']),
    { eco: 'C57', name: 'Italian Checkline', plies: 7 },
  );
});

test('an empty book never matches', () => {
  assert.equal(new OpeningBook([]).lookup(['e4']), null);
});

test('getOpeningBook retries after a failed fetch (no permanent null cache)', async () => {
  const previousFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async () => (fail
    ? { ok: false }
    : { ok: true, json: async () => [{ moves: 'e4', eco: 'B00', name: "King's Pawn" }] });
  try {
    const failed = await getOpeningBook();
    assert.equal(failed, null, 'a failed fetch resolves null');
    fail = false;
    const retried = await getOpeningBook();
    assert.ok(retried instanceof OpeningBook, 'the next review retries the fetch');
    assert.deepEqual(retried.lookup(['e4']), { eco: 'B00', name: "King's Pawn", plies: 1 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
