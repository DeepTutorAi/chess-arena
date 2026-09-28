// Bot pacing: how long the engine "thinks" before answering, and how long it
// actually searches. Pure functions so the behaviour is unit-testable.
//
// Two layers:
//  1. A human-like model (time-control scaled, Elo paced, complexity aware,
//     skewed jitter) — how a person would spend time.
//  2. A clock governor — the bot must never flag itself. The human-like number
//     is capped by what the bot's own clock can afford; short of time it plays
//     fast, and in the last seconds it moves almost instantly.

/** Human-like base pause + search time (ms) for a time control. */
function baseTimes(tcId, initialMs) {
  if (tcId === 'blitz_5_0' || initialMs === 5 * 60000) return { base: 1400, search: 400 };
  if (tcId === 'rapid_10_0' || initialMs === 10 * 60000) return { base: 2000, search: 500 };
  if (initialMs <= 0 || initialMs >= 12 * 60000) return { base: 7000, search: 1500 }; // unlimited / 15-30min
  if (initialMs >= 4 * 60000) return { base: 5000, search: 800 };                      // 4-7min
  if (initialMs >= 60000) return { base: 2000, search: 450 };                          // 1-3min: snappy
  return { base: 1200, search: 250 };                                                  // <1min: fastest
}

/**
 * What the bot's own clock can afford for ONE move right now.
 * Assumes the game lasts at least ~22 more moves (so it paces itself for a long
 * game instead of spending like a sprint), keeps a safety reserve, and adds most
 * of the increment back.
 */
export function clockBudgetMs({ remainingMs, incrementMs = 0, historyLength = 0 }) {
  const moveNo = Math.floor(historyLength / 2) + 1;
  const movesLeft = Math.max(22, 45 - moveNo);
  const reserve = Math.min(remainingMs * 0.12, 4000);
  const spendable = Math.max(0, remainingMs - reserve);
  let perMove = spendable / movesLeft + incrementMs * 0.75;
  if (remainingMs < 8000) perMove = Math.min(perMove, remainingMs * 0.06); // time trouble
  if (remainingMs < 2000) perMove = Math.min(perMove, 120);                // last seconds: premove-fast
  return Math.max(30, perMove);
}

/**
 * @param {object} ctx
 * @param {string|null} ctx.tcId            time control id
 * @param {number} ctx.initialMs            time control base time (0 = unlimited)
 * @param {number} ctx.level                1-based engine level (drives pace)
 * @param {number} ctx.historyLength        plies played so far
 * @param {number} [ctx.legalMoves]         legal move count (complexity)
 * @param {number} [ctx.pieceCount]         pieces on the board (endgame)
 * @param {boolean} [ctx.inCheck]
 * @param {boolean} [ctx.lastWasCaptureOrCheck]
 * @param {number|null} [ctx.remainingMs]   the bot side's clock now; null = no clock
 * @param {number} [ctx.incrementMs]
 * @param {() => number} [ctx.rng]
 * @returns {{ delay: number, search: number, total: number }}
 */
export function planThinkTime({
  tcId = null,
  initialMs = 0,
  level = 4,
  historyLength = 0,
  legalMoves = 25,
  pieceCount = 32,
  inCheck = false,
  lastWasCaptureOrCheck = false,
  remainingMs = null,
  incrementMs = 0,
  rng = Math.random,
} = {}) {
  const { base: rawBase, search } = baseTimes(tcId, initialMs);
  // Pace by the moving engine's strength: level 1 ×1.3 … level 11 ×0.3.
  const base = rawBase * (1.3 - 0.1 * (level - 1));

  let delay;
  if (historyLength < 3) {
    // Opening: the first plies come quick whatever the control.
    delay = 600 + Math.floor(rng() * 1001);
  } else {
    let factor = 1;
    if (legalMoves > 30) factor *= 1.2;      // rich position -> more candidates
    else if (legalMoves < 10) factor *= 0.8; // few options -> quicker
    if (pieceCount <= 8) factor *= 1.15;     // endgame -> precise calculation
    if (inCheck) factor *= 1.4;              // must find the escape
    else if (lastWasCaptureOrCheck) factor *= 1.25; // recapture / check follow-up
    // Skewed human-like distribution: ~12% quick, 76% normal, 12% deep.
    const u = rng();
    const skew = u < 0.12 ? 0.55 : u < 0.88 ? 1 : 1.55;
    const minDelay = tcId === 'blitz_5_0' ? 600 : tcId === 'rapid_10_0' ? 700 : 800;
    delay = Math.min(12000, Math.max(minDelay, Math.round(base * factor * skew + (rng() - 0.5) * base * 0.3)));
  }

  if (remainingMs === null || remainingMs === undefined) {
    return { delay, search, total: delay + search };
  }

  // Clock governor: never spend more than the clock can afford.
  const budget = clockBudgetMs({ remainingMs, incrementMs, historyLength });
  const wanted = delay + search;
  const total = Math.max(30, Math.min(wanted, budget));
  const cappedSearch = Math.max(20, Math.min(search, Math.round(total * 0.4)));
  return { delay: Math.max(0, Math.round(total - cappedSearch)), search: cappedSearch, total: Math.round(total) };
}
