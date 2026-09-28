import test from 'node:test';
import assert from 'node:assert/strict';

import { enforceIncreasing, expectedScore, fitRatings, kFactor, pairSchedule, updateRating } from '../src/rating.js';

test('expected score follows the Elo curve', () => {
  assert.equal(expectedScore(1500, 1500), 0.5);
  assert.ok(Math.abs(expectedScore(1500, 1100) - 0.909) < 0.001);
  assert.ok(Math.abs(expectedScore(1100, 1500) - 0.091) < 0.001);
  assert.ok(Math.abs(expectedScore(1800, 1400) + expectedScore(1400, 1800) - 1) < 1e-12);
});

test('rating moves toward the result and is zero-sum for equal K', () => {
  assert.equal(updateRating(1500, 1500, 1, 32), 1516);
  assert.equal(updateRating(1500, 1500, 0, 32), 1484);
  assert.equal(updateRating(1500, 1500, 0.5, 32), 1500);
  assert.ok(updateRating(1500, 1900, 1) - 1500 > 16, 'beating a much stronger opponent is worth more');
  assert.ok(updateRating(1500, 1100, 1) - 1500 < 16, 'and beating a weaker one is worth less');
});

test('K-factor shrinks with experience', () => {
  assert.ok(kFactor(0) > kFactor(15) && kFactor(15) > kFactor(100));
});

test('pairSchedule pairs each level with the next two', () => {
  assert.deepEqual(pairSchedule([1, 2, 3, 4], 2), [[1, 2], [1, 3], [2, 3], [2, 4], [3, 4]]);
  assert.equal(pairSchedule(Array.from({ length: 11 }, (_, i) => i + 1), 2).length, 19);
  assert.deepEqual(pairSchedule([1], 2), []);
});

test('fitRatings recovers known rating gaps from expected-score data', () => {
  const truth = { 1: 800, 2: 1000, 3: 1150, 4: 1400, 5: 1500 };
  const results = [];
  for (const [a, b] of pairSchedule([1, 2, 3, 4, 5], 2)) {
    // 200 games per pair, scored at exactly the expected fraction
    for (let i = 0; i < 200; i++) results.push({ a, b, score: expectedScore(truth[a], truth[b]) });
  }
  const fit = fitRatings(results, { levels: [1, 2, 3, 4, 5], anchorMean: 1170, priorDraws: 1 });
  for (const level of [1, 2, 3, 4, 5]) {
    assert.ok(Math.abs(fit[level] - truth[level]) <= 12, `level ${level}: fit ${fit[level]} vs ${truth[level]}`);
  }
  const mean = Object.values(fit).reduce((s, v) => s + v, 0) / 5;
  assert.ok(Math.abs(mean - 1170) <= 1, 'anchored to the requested mean');
});

test('a sweep (4-0) still yields a finite, ordered rating thanks to the prior', () => {
  const results = [];
  for (let i = 0; i < 4; i++) results.push({ a: 2, b: 1, score: 1 });
  const fit = fitRatings(results, { levels: [1, 2], anchorMean: 1000 });
  assert.ok(fit[2] > fit[1] && fit[2] - fit[1] < 1200, JSON.stringify(fit));
});

test('enforceIncreasing leaves an ordered list alone and repairs an inversion', () => {
  assert.deepEqual(enforceIncreasing([800, 1000, 1200, 1400]), [800, 1000, 1200, 1400]);
  // 1770 / 1710 are the wrong way round: pooled around their mean, spread 20 apart.
  const fixed = enforceIncreasing([1380, 1770, 1710, 1920]);
  assert.deepEqual(fixed, [1380, 1730, 1750, 1920]);
  for (let i = 1; i < fixed.length; i++) assert.ok(fixed[i] - fixed[i - 1] >= 20);
});

test('enforceIncreasing cascades through a run of inversions and keeps the mean', () => {
  const input = [900, 1500, 1400, 1300, 2000];
  const fixed = enforceIncreasing(input);
  for (let i = 1; i < fixed.length; i++) assert.ok(fixed[i] - fixed[i - 1] >= 20, fixed.join());
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(Math.abs(mean(fixed) - mean(input)) < 2);
  assert.equal(fixed[0], 900);
  assert.equal(fixed[4], 2000);
  assert.deepEqual(enforceIncreasing([]), []);
  assert.deepEqual(enforceIncreasing([1234]), [1234]);
});

test('enforceIncreasing pools neighbours that are closer than the minimum gap', () => {
  const fixed = enforceIncreasing([1000, 1005, 1010]);
  assert.deepEqual(fixed, [985, 1005, 1025]);
});
