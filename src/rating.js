// Elo maths shared by the level calibration tool (scripts/calibrate-levels.mjs)
// and the player's local rating. Pure functions — no DOM, no storage.

const ELO_SCALE = 400 / Math.LN10; // Elo points per natural-log unit of odds

/** Expected score (0..1) of a player rated `ra` against one rated `rb`. */
export function expectedScore(ra, rb) {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** New rating after one game. score: 1 win, 0.5 draw, 0 loss. */
export function updateRating(rating, opponentRating, score, k = 32) {
  return Math.round(rating + k * (score - expectedScore(rating, opponentRating)));
}

/** K-factor that shrinks as the player accumulates rated games. */
export function kFactor(gamesPlayed) {
  if (gamesPlayed < 10) return 40;
  if (gamesPlayed < 30) return 32;
  return 24;
}

/**
 * Which level pairs to play: every level against the next `span` levels above it.
 * Neighbours pin the local gap, the skip-one pairs tie the scale together.
 * @param {number[]} levelNumbers
 * @returns {Array<[number, number]>}
 */
export function pairSchedule(levelNumbers, span = 2) {
  const pairs = [];
  for (let i = 0; i < levelNumbers.length; i++) {
    for (let step = 1; step <= span; step++) {
      if (i + step < levelNumbers.length) pairs.push([levelNumbers[i], levelNumbers[i + step]]);
    }
  }
  return pairs;
}

/**
 * Maximum-likelihood Elo ratings from game results (Newton iterations).
 * A lopsided sample (4-0) would otherwise give an infinite gap, so every pair
 * that appears gets `priorDraws` virtual drawn games.
 *
 * @param {Array<{a: number, b: number, score: number}>} results  score = a's score
 * @param {object} opts
 * @param {number[]} opts.levels                 ids to rate
 * @param {number} opts.anchorMean               the fitted mean is shifted to this
 * @param {number} [opts.priorDraws]
 * @returns {Record<number, number>}
 */
export function fitRatings(results, { levels, anchorMean, priorDraws = 1, iterations = 300 }) {
  const games = results.map((r) => ({ ...r }));
  const seen = new Set();
  for (const r of results) {
    const key = r.a < r.b ? `${r.a}-${r.b}` : `${r.b}-${r.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let i = 0; i < priorDraws; i++) games.push({ a: r.a, b: r.b, score: 0.5 });
  }
  const rating = Object.fromEntries(levels.map((l) => [l, 0]));
  for (let iter = 0; iter < iterations; iter++) {
    const grad = Object.fromEntries(levels.map((l) => [l, 0]));
    const curv = Object.fromEntries(levels.map((l) => [l, 0]));
    for (const g of games) {
      const e = expectedScore(rating[g.a], rating[g.b]);
      grad[g.a] += g.score - e;
      grad[g.b] -= g.score - e;
      curv[g.a] += e * (1 - e);
      curv[g.b] += e * (1 - e);
    }
    for (const l of levels) {
      if (curv[l] > 0) rating[l] += 0.7 * ELO_SCALE * (grad[l] / curv[l]);
    }
  }
  const mean = levels.reduce((s, l) => s + rating[l], 0) / levels.length;
  return Object.fromEntries(levels.map((l) => [l, Math.round(rating[l] - mean + anchorMean)]));
}

/**
 * The levels are designed to get stronger, but a small sample can leave two
 * neighbours in the wrong order. Pool adjacent violators (isotonic regression):
 * out-of-order runs are replaced by their mean, then spread `minGap` apart so no
 * two levels display the same rating.
 * @param {number[]} values  ratings in level order
 * @param {number} [minGap]
 * @returns {number[]}
 */
export function enforceIncreasing(values, minGap = 20) {
  const pools = []; // { sum, count }
  for (const value of values) {
    pools.push({ sum: value, count: 1 });
    while (pools.length > 1) {
      const last = pools[pools.length - 1];
      const prev = pools[pools.length - 2];
      // Pools are ordered by mean once their members are spread minGap apart.
      const prevTop = prev.sum / prev.count + ((prev.count - 1) / 2) * minGap;
      const lastBottom = last.sum / last.count - ((last.count - 1) / 2) * minGap;
      if (lastBottom - prevTop >= minGap) break;
      pools.pop();
      prev.sum += last.sum;
      prev.count += last.count;
    }
  }
  return pools.flatMap(({ sum, count }) => {
    const mean = sum / count;
    return Array.from({ length: count }, (_, i) => Math.round(mean + (i - (count - 1) / 2) * minGap));
  });
}
