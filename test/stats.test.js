// Local rating + stats: rated games move the rating on the levels' own scale,
// assisted / abandoned games are recorded but not rated, and a bad store is ignored.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INITIAL_RATING, MAX_RESULTS, MIN_RATED_PLIES, PROVISIONAL_GAMES, STATS_KEY,
  createStatsStore, suggestLevel,
} from '../src/stats.js';

const levelRating = (level) => 600 + level * 200; // 800 … 2800
const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
};
const make = (storage = memoryStorage(), extra = {}) =>
  createStatsStore({ storage, levelRating, levelCount: 11, now: () => 1_000, ...extra });
const win = (level, extra = {}) => ({ level, score: 1, color: 'w', plies: 40, ...extra });
const loss = (level, extra = {}) => ({ level, score: 0, color: 'w', plies: 40, ...extra });

test('a new player starts at the initial rating, provisional', () => {
  const store = make();
  assert.equal(store.rating, INITIAL_RATING);
  assert.equal(store.provisional, true);
  assert.equal(store.ratedGames, 0);
});

test('a win against a stronger level moves the rating more than a win against a weaker one', () => {
  const a = make();
  const b = make();
  const strong = a.recordBotGame(win(6));
  const weak = b.recordBotGame(win(1));
  assert.ok(strong.delta > weak.delta && weak.delta > 0);
  assert.equal(strong.rated, true);
  assert.equal(a.rating, INITIAL_RATING + strong.delta);
});

test('a loss lowers the rating and results are kept per level', () => {
  const store = make();
  const result = store.recordBotGame(loss(2));
  assert.ok(result.delta < 0);
  store.recordBotGame({ level: 2, score: 0.5, color: 'b', plies: 60 });
  store.recordBotGame(win(3));
  assert.deepEqual(store.byLevel(), {
    2: { games: 2, wins: 0, draws: 1, losses: 1 },
    3: { games: 1, wins: 1, draws: 0, losses: 0 },
  });
});

test('assisted (undo / hint) and abandoned games are recorded but never rated', () => {
  const store = make();
  const assisted = store.recordBotGame(win(6, { assisted: true }));
  const abandoned = store.recordBotGame(win(6, { plies: MIN_RATED_PLIES - 1 }));
  for (const r of [assisted, abandoned]) {
    assert.equal(r.rated, false);
    assert.equal(r.delta, 0);
  }
  assert.equal(store.rating, INITIAL_RATING);
  assert.equal(store.ratedGames, 0);
  assert.equal(store.results.length, 2, 'they still show up in the history');
  assert.equal(store.results.every((r) => r.rated === false), true);
});

test('the rating stops being provisional after enough rated games, and K shrinks', () => {
  const store = make();
  for (let i = 0; i < PROVISIONAL_GAMES; i++) store.recordBotGame(win(2));
  assert.equal(store.provisional, false);

  const veteran = make();
  for (let i = 0; i < 40; i++) veteran.recordBotGame({ level: 6, score: 0.5, color: 'w', plies: 40 });
  const lateGain = veteran.recordBotGame({ level: 11, score: 0.5, color: 'w', plies: 40 }).delta;
  const earlyGain = make().recordBotGame({ level: 11, score: 0.5, color: 'w', plies: 40 }).delta;
  assert.ok(lateGain < earlyGain, 'K shrinks with experience, so the same result moves the rating less');
});

test('once established, a level that is far too easy or too hard is flagged', () => {
  const store = make();
  for (let i = 0; i < PROVISIONAL_GAMES; i++) store.recordBotGame(win(1)); // rating climbs
  assert.equal(store.recordBotGame(win(1)).hint, 'up', 'level 1 is far below the player now');

  const weak = make();
  for (let i = 0; i < PROVISIONAL_GAMES; i++) weak.recordBotGame(loss(6));
  assert.equal(weak.recordBotGame(loss(6)).hint, 'down');

  const provisional = make();
  assert.equal(provisional.recordBotGame(win(1)).hint, null, 'no advice from a handful of games');
});

test('suggestLevel picks the level closest to the rating (ties go to the easier one)', () => {
  assert.equal(suggestLevel(1000, levelRating, 11), 2);
  assert.equal(suggestLevel(1100, levelRating, 11), 2, 'exact tie between 1000 and 1200');
  assert.equal(suggestLevel(2790, levelRating, 11), 11);
  assert.equal(suggestLevel(100, levelRating, 11), 1);
});

test('state persists to storage and reloads', () => {
  const storage = memoryStorage();
  const first = make(storage);
  first.recordBotGame(win(4));
  const second = make(storage);
  assert.equal(second.rating, first.rating);
  assert.equal(second.ratedGames, 1);
  assert.equal(second.results.length, 1);
});

test('corrupt or foreign data in storage is ignored', () => {
  for (const garbage of ['{not json', '"text"', '{"v":2}', '{"v":1,"rating":"x","results":[{"junk":1},5,null]}']) {
    const store = make(memoryStorage({ [STATS_KEY]: garbage }));
    assert.equal(store.rating, INITIAL_RATING, garbage);
    assert.equal(store.results.length, 0);
  }
});

test('no storage at all (private mode) still works in memory', () => {
  const store = createStatsStore({ storage: null, levelRating, levelCount: 11 });
  store.recordBotGame(win(3));
  assert.ok(store.rating > INITIAL_RATING);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const other = createStatsStore({ storage: throwing, levelRating, levelCount: 11 });
  other.recordBotGame(win(3));
  assert.ok(other.rating > INITIAL_RATING);
});

test('only the most recent results are kept', () => {
  const store = make();
  for (let i = 0; i < MAX_RESULTS + 25; i++) store.recordBotGame({ level: 1, score: 0.5, color: 'w', plies: 40 });
  assert.equal(store.results.length, MAX_RESULTS);
});

test('reset wipes rating and history', () => {
  const store = make();
  store.recordBotGame(win(4));
  store.reset();
  assert.equal(store.rating, INITIAL_RATING);
  assert.equal(store.results.length, 0);
});
