// A bot that plays like a person (roadmap A4): most of the time the best move, now
// and then a second- or third-best one, more often the weaker it is — instead of
// the engine's own weakening, which produces the same kind of slip every time.
//
// The engine searches a few lines (MultiPV); this picks among them with weights
// exp(-loss / T): T is large for a beginner (many inaccuracies) and tiny for a
// master (almost always the best move). The style nudges the choice by a few
// centipawns toward captures and checks (aggressive) or quiet, safe moves (solid).
// Pure functions — no engine, no DOM — so behaviour is testable.

export const HUMAN_STYLES = Object.freeze(['balanced', 'aggressive', 'solid']);
/** How many engine lines (MultiPV) the picker chooses among. */
export const HUMAN_LINES = 4;
/** The most a style may tilt a choice, in centipawns. */
export const STYLE_BONUS_CP = 30;
const MATE_CP = 1000;

/**
 * Softmax temperature in centipawns for a level (1..11): 240 for a beginner down
 * to ~4 for the strongest (a 20 cp difference is then all but decisive), shrinking
 * 34% per level.
 */
export function temperatureFor(level) {
  const clamped = Math.max(1, Math.min(11, level));
  return 240 * 0.66 ** (clamped - 1);
}

/** Centipawns from an engine line; a mate is worth ±MATE_CP so it sorts beyond any normal score. */
export function lineScore(line) {
  if (line.mate !== null && line.mate !== undefined) return Math.sign(line.mate) * MATE_CP;
  return line.cp ?? 0;
}

/**
 * How much a move fits a style, in centipawns of preference (never more than
 * STYLE_BONUS_CP either way, so style cannot turn a good bot into a bad one).
 * @param {{capture?: boolean, check?: boolean, castle?: boolean, promotion?: boolean}} features
 */
export function styleBonus(style, features = {}) {
  const forcing = Boolean(features.capture || features.check || features.promotion);
  if (style === 'aggressive') return forcing ? STYLE_BONUS_CP : 0;
  if (style === 'solid') return forcing ? 0 : (features.castle ? STYLE_BONUS_CP : STYLE_BONUS_CP * 0.6);
  return 0;
}

/**
 * Choose a move from the engine's lines.
 * @param {Array<{uci: string, cp?: number|null, mate?: number|null, capture?: boolean, check?: boolean, castle?: boolean, promotion?: boolean}>} candidates
 *        engine lines, best first (index 0 is the engine's choice)
 * @param {object} opts
 * @param {number} opts.level  1..11
 * @param {'balanced'|'aggressive'|'solid'} [opts.style]
 * @param {() => number} [opts.rng]
 * @returns {string|null} the UCI move, or null with no candidates
 */
export function pickHumanMove(candidates, { level, style = 'balanced', rng = Math.random }) {
  const lines = candidates.filter((c) => c && c.uci);
  if (!lines.length) return null;
  if (lines.length === 1) return lines[0].uci;

  const scores = lines.map(lineScore);
  const best = Math.max(...scores);
  const temperature = temperatureFor(level);

  // A forced mate is played: nobody who sees mate in 2 drops it for a "human" move.
  const hasMate = best >= MATE_CP;
  // ...and no level plays a line further behind than it plausibly would: about a
  // piece for a beginner, well under a pawn and a half for a strong player.
  const floor = hasMate ? MATE_CP : best - Math.min(450, Math.max(150, temperature * 1.6));

  const weights = lines.map((line, i) => {
    if (scores[i] < floor) return 0;
    const loss = best - scores[i];
    return Math.exp(-(loss - styleBonus(style, line)) / temperature);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return lines[0].uci;
  let roll = rng() * total;
  for (let i = 0; i < lines.length; i++) {
    roll -= weights[i];
    if (roll < 0) return lines[i].uci;
  }
  return lines[0].uci;
}

/**
 * The engine's lines annotated with what the style cares about, from the position
 * they were searched in.
 * @param {(fen: string) => object} makeGame  a chess.js constructor wrapper: fen -> game
 * @param {string} fen
 * @param {Array<{pv: string[], cp: number|null, mate: number|null}>} lines
 */
export function annotateLines(makeGame, fen, lines) {
  const out = [];
  for (const line of lines.slice(0, HUMAN_LINES)) {
    const uci = line.pv?.[0];
    if (!uci) continue;
    let move = null;
    try {
      move = makeGame(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch { move = null; }
    if (!move) continue; // an unplayable line is dropped, never guessed at
    out.push({
      uci,
      cp: line.cp,
      mate: line.mate,
      capture: Boolean(move.captured),
      check: move.san.includes('+') || move.san.includes('#'),
      castle: move.san.startsWith('O-O'),
      promotion: Boolean(move.promotion),
    });
  }
  return out;
}
