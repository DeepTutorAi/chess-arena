// Local player statistics + rating (roadmap A5 / C2).
//
// Games against the bots move a personal rating on the same scale the levels
// were calibrated on (src/level-ratings.js), so "you are ≈1150" means "about as
// strong as level 3". Everything stays in this browser's localStorage — there is
// no account — and a corrupt or missing store just starts fresh.

import { expectedScore, kFactor, updateRating } from './rating.js';

export const STATS_KEY = 'chess-arena-stats-v1';
export const INITIAL_RATING = 1000;
export const PROVISIONAL_GAMES = 10;
export const MAX_RESULTS = 300;
/** Games shorter than this many plies are not rated (an instant abandon teaches nothing). */
export const MIN_RATED_PLIES = 4;

const emptyState = () => ({ v: 1, rating: INITIAL_RATING, ratedGames: 0, results: [] });

const isResult = (r) => r && typeof r === 'object'
  && Number.isFinite(r.t) && Number.isInteger(r.level) && [0, 0.5, 1].includes(r.score);

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return emptyState();
  const results = Array.isArray(raw.results) ? raw.results.filter(isResult).slice(-MAX_RESULTS) : [];
  const rating = Number.isFinite(raw.rating) ? Math.max(100, Math.min(3500, raw.rating)) : INITIAL_RATING;
  const ratedGames = Number.isInteger(raw.ratedGames) && raw.ratedGames >= 0 ? raw.ratedGames : results.filter((r) => r.rated).length;
  return { v: 1, rating, ratedGames, results };
}

function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * The level to play next, judged from the player's rating: the level whose
 * strength is closest to it (ties go to the easier level).
 * @param {number} rating
 * @param {(level: number) => number} levelRating
 * @param {number} levelCount
 */
export function suggestLevel(rating, levelRating, levelCount) {
  let best = 1;
  for (let level = 2; level <= levelCount; level++) {
    if (Math.abs(levelRating(level) - rating) < Math.abs(levelRating(best) - rating)) best = level;
  }
  return best;
}

/**
 * @param {object} [opts]
 * @param {{getItem(k: string): string|null, setItem(k: string, v: string): void}|null} [opts.storage]
 * @param {() => number} [opts.now]
 * @param {(level: number) => number} opts.levelRating  rating of a bot level (1-based)
 * @param {number} opts.levelCount
 */
export function createStatsStore({ storage = browserStorage(), now = Date.now, levelRating, levelCount } = {}) {
  let state = emptyState();
  try {
    const text = storage?.getItem(STATS_KEY);
    if (text) state = sanitize(JSON.parse(text));
  } catch { /* unreadable store: start fresh */ }

  const save = () => {
    try { storage?.setItem(STATS_KEY, JSON.stringify(state)); } catch { /* private mode / quota */ }
  };
  const provisional = () => state.ratedGames < PROVISIONAL_GAMES;

  return {
    get rating() { return Math.round(state.rating); },
    get ratedGames() { return state.ratedGames; },
    get provisional() { return provisional(); },
    get results() { return state.results.slice(); },

    /**
     * Record a finished game against a bot.
     * @param {{level: number, score: 0|0.5|1, color: 'w'|'b', plies: number, reason?: string, assisted?: boolean}} game
     *        score is from the human's point of view
     * @returns {{rated: boolean, delta: number, rating: number, provisional: boolean, suggestedLevel: number, hint: 'up'|'down'|null}}
     */
    recordBotGame({ level, score, color, plies, reason = null, assisted = false }) {
      const rated = !assisted && plies >= MIN_RATED_PLIES;
      const before = state.rating;
      const opponent = levelRating(level);
      if (rated) {
        state.rating = updateRating(state.rating, opponent, score, kFactor(state.ratedGames));
        state.ratedGames += 1;
      }
      state.results.push({
        t: now(), level, score, color, plies, reason, rated, ratingAfter: Math.round(state.rating),
      });
      if (state.results.length > MAX_RESULTS) state.results.splice(0, state.results.length - MAX_RESULTS);
      save();

      // Expected score against the level just played tells whether it fits.
      const expected = expectedScore(state.rating, opponent);
      const hint = rated && !provisional() ? (expected >= 0.75 ? 'up' : expected <= 0.25 ? 'down' : null) : null;
      return {
        rated,
        delta: Math.round(state.rating) - Math.round(before),
        rating: Math.round(state.rating),
        provisional: provisional(),
        suggestedLevel: suggestLevel(state.rating, levelRating, levelCount),
        hint,
      };
    },

    /** Per-level record: { [level]: { games, wins, draws, losses } } over every stored game. */
    byLevel() {
      const table = {};
      for (const r of state.results) {
        const row = (table[r.level] ??= { games: 0, wins: 0, draws: 0, losses: 0 });
        row.games += 1;
        if (r.score === 1) row.wins += 1;
        else if (r.score === 0.5) row.draws += 1;
        else row.losses += 1;
      }
      return table;
    },

    suggestedLevel() { return suggestLevel(state.rating, levelRating, levelCount); },

    reset() {
      state = emptyState();
      save();
    },
  };
}
