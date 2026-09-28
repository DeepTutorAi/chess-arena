// A bot that plays like a person (roadmap A4): most of the time the best move, now
// and then a second- or third-best one, more often the weaker it is — instead of
// the engine's own weakening, which produces the same kind of slip every time.
//
// The engine searches a few lines (MultiPV); this picks among them with weights
// exp(-loss / T): T is large for a beginner (many inaccuracies) and tiny for a
// master (almost always the best move). The style makes captures and checks
// (aggressive) or quiet, safe moves (solid) about 1.5x as likely at any level.
// Pure functions — no engine, no DOM — so behaviour is testable.

export const HUMAN_STYLES = Object.freeze(['balanced', 'aggressive', 'solid']);
/** How many engine lines (MultiPV) the picker chooses among. */
export const HUMAN_LINES = 4;
/** The scale of a style's preference: a move that fully fits gets this many points (see STYLE_TILT). */
export const STYLE_BONUS_CP = 30;
/** A style's full preference, in temperatures (a weight factor of e^0.4 ≈ 1.5). */
const STYLE_TILT = 0.4;
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

/**
 * Centipawns from an engine line. A mate sorts beyond any normal score, and a nearer
 * mate beats a farther one (for the side delivering it) — so being mated in 9 is a
 * better line than being mated in 2.
 */
export function lineScore(line) {
  if (line.mate !== null && line.mate !== undefined && line.mate !== 0) {
    return Math.sign(line.mate) * (MATE_CP - Math.min(Math.abs(line.mate), 99));
  }
  return line.cp ?? 0;
}

/**
 * How well a move fits a style, on a scale where STYLE_BONUS_CP is a full fit.
 * pickHumanMove scales it with the level's temperature, so style stays a lean and
 * never turns a good bot into a bad one.
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

  // A forced mate is played, the quickest one: nobody who sees mate in 2 drops it
  // for a "human" move.
  const mating = lines.filter((c) => c.mate > 0).sort((a, b) => a.mate - b.mate);
  if (mating.length) return mating[0].uci;

  const scores = lines.map(lineScore);
  const best = Math.max(...scores);
  const temperature = temperatureFor(level);
  // No level plays a line further behind than it plausibly would: about a piece for
  // a beginner, well under a pawn and a half for a strong player.
  const floor = best - Math.min(450, Math.max(150, temperature * 1.6));
  // The style makes a matching move about 1.5x as likely at every level (a tilt of
  // 0.4 temperatures): a wide lean for a beginner, and for a master a few centipawns —
  // far too little to prefer a worse move.
  const tilt = (temperature * STYLE_TILT) / STYLE_BONUS_CP;

  const weights = lines.map((line, i) => {
    if (scores[i] < floor) return 0;
    const loss = best - scores[i];
    return Math.exp(-(loss - styleBonus(style, line) * tilt) / temperature);
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
