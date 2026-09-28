// Game Review System — analysis engine (plan.md §3, §7 Step 1).
// Pure math + classification helpers are exported for unit tests; the
// GameReviewAnalyzer class drives a dedicated Stockfish web worker entirely
// client-side (zero server compute) and never touches the live game session.

import { Chess } from 'chess.js';
import { ENGINE_WORKER_URL } from './config.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LOGISTIC_K = 0.00368208;
export const ANALYSIS_DEPTH = 12;
// Opening-theory proxy: plan.md has no book database available client-side,
// so "Book" is granted to negligible-loss plies inside the first 10.
const BOOK_PLIES = 10;
const BOOK_MAX_LOSS = 2;
// Two independent depth-limited searches routinely disagree by a few percent.
// A move that IS the engine's first choice is treated as loss-free below this.
const SEARCH_NOISE_PCT = 5;

// plan.md §3.3 — canonical tiers, badges and colors (UI renders from this).
export const TIERS = [
  { key: 'brilliant', symbol: '!!', color: '#26c2a3', label: 'Brilliant' },
  { key: 'great', symbol: '!', color: '#3b82f6', label: 'Great' },
  { key: 'best', symbol: '★', color: '#22c55e', label: 'Best' },
  { key: 'excellent', symbol: '✓', color: '#10b981', label: 'Excellent' },
  { key: 'good', symbol: '·', color: '#84cc16', label: 'Good' },
  { key: 'book', symbol: '📖', color: '#d97706', label: 'Book' },
  { key: 'inaccuracy', symbol: '?!', color: '#eab308', label: 'Inaccuracy' },
  { key: 'mistake', symbol: '?', color: '#f97316', label: 'Mistake' },
  { key: 'blunder', symbol: '??', color: '#ef4444', label: 'Blunder' },
  { key: 'miss', symbol: '✗', color: '#a855f7', label: 'Miss' },
];

export const TIER_BY_KEY = Object.fromEntries(TIERS.map((t) => [t.key, t]));

/** Eval object: { cp: number, mate: null } or { cp: null, mate: ±N } — always
 *  from the perspective of the side to move at the evaluated position. When the
 *  engine reports it (UCI_ShowWDL) it also carries wdl: [win, draw, loss] in
 *  per-mille for that same side. */

// plan.md §3.1 — logistic win probability in [0, 100] for the mover. Blind to
// the phase of the game: +150 cp reads the same in a rook ending as in a
// middlegame. This is the curve every grade is computed on.
export function convertCentipawnsToWinProbability(cp, mate = null) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  const p = 2 / (1 + Math.exp(-LOGISTIC_K * cp)) - 1;
  return 50 + 50 * p;
}

/** A usable WDL triple: three non-negative per-mille numbers. */
export function isWdl(wdl) {
  return Array.isArray(wdl) && wdl.length === 3 && wdl.every((n) => Number.isFinite(n) && n >= 0)
    && wdl[0] + wdl[1] + wdl[2] > 0;
}

// Grading deliberately stays on the logistic above: it is fitted to how HUMAN
// games end, which is what "how much did this move cost" should mean here. The
// engine's WDL comes from engine-vs-engine play (an equal middlegame reads ≈91%
// draw and a 100 cp swing looks ~1.4× bigger), so it is shown to the player as
// extra information (draw chances, decisive positions) rather than used to grade.
export function winProbFromEval(evalObj) {
  if (!evalObj) return 50;
  return convertCentipawnsToWinProbability(evalObj.cp ?? 0, evalObj.mate);
}

/** Mate scores are unbounded — clamp to a large cp for centipawn-loss display. */
export function evalToCentipawns(evalObj) {
  if (!evalObj) return 0;
  if (evalObj.mate !== null && evalObj.mate !== undefined) {
    return evalObj.mate > 0 ? 10000 : -10000;
  }
  return evalObj.cp ?? 0;
}

/** Flip a side-to-move-perspective eval to the opponent's perspective. */
export function negateEval(evalObj) {
  if (!evalObj) return { cp: 0, mate: null };
  if (evalObj.mate !== null && evalObj.mate !== undefined) {
    return { cp: null, mate: -evalObj.mate };
  }
  return { cp: -(evalObj.cp ?? 0), mate: null };
}

// plan.md §3.2 — loss in win probability. Evals must already be converted to
// the mover's perspective by the caller (that is the "turn" handling).
export function calculateDeltaWinProbability(bestEval, actualEval) {
  return Math.max(0, winProbFromEval(bestEval) - winProbFromEval(actualEval));
}

// plan.md §3.3 — canonical tier classification.
// moveContext: { ply, secondDelta, isSacrifice, winProbAfter, winProbBefore,
//                missedMate, opponentPrevTier, endsGame, inBookLine } —
// everything beyond deltaW is optional and degrades gracefully when missing.
// inBookLine: true/false when a real opening line was matched (or ruled out);
// null falls back to the early-ply heuristic.
export function classifyMove(deltaW, moveContext = {}) {
  const {
    ply = Infinity,
    secondDelta = null,
    isSacrifice = false,
    winProbAfter = 50,
    winProbBefore = 50,
    missedMate = false,
    opponentPrevTier = null,
    endsGame = false,
    inBookLine = null,
  } = moveContext;

  const inBook = inBookLine === null ? ply < BOOK_PLIES : inBookLine;
  if (inBook && deltaW <= BOOK_MAX_LOSS && !endsGame) return 'book';
  if (deltaW <= 0.1) {
    // Brilliant = a real sacrifice that works, in a position that was NOT
    // already crushing, and that clearly beats the alternatives.
    if (
      isSacrifice && winProbAfter >= 60 && winProbBefore < 90
      && (secondDelta === null || secondDelta >= 5)
    ) return 'brilliant';
    if (secondDelta !== null && secondDelta >= 15) return 'great';
    return 'best';
  }
  // Missed a forced mate the engine had.
  if (missedMate && deltaW > 10) return 'miss';
  // A move that throws away >20% is a blunder whatever came before it; "Miss"
  // (failing to punish the opponent's fresh mistake) is for the smaller lapses.
  if (deltaW > 20) return 'blunder';
  if (
    (opponentPrevTier === 'mistake' || opponentPrevTier === 'blunder') && deltaW > 5
  ) {
    return 'miss';
  }
  if (deltaW > 10) return 'mistake';
  if (deltaW > 5) return 'inaccuracy';
  if (deltaW > 2) return 'good';
  return 'excellent';
}

// plan.md §3.4 — per-move accuracy curve + harmonic-mean aggregation.
// The curve constants are 4-decimal approximations (A(0) is meant to be 100
// but 103.1668 - 3.1669 lands at 99.9999), so results are rounded to the
// one-decimal precision the UI displays.
export function moveAccuracy(deltaW) {
  const a = 103.1668 * Math.exp(-0.04354 * deltaW) - 3.1669;
  return Math.max(0, Math.min(100, Math.round(a * 10) / 10));
}

export function calculatePlayerAccuracy(deltaWList) {
  if (!deltaWList.length) return null; // side never moved — no score to show
  let sum = 0;
  for (const deltaW of deltaWList) {
    sum += 1 / Math.max(1, moveAccuracy(deltaW));
  }
  return deltaWList.length / sum;
}

/**
 * Lichess-style volatility weights: a move made while the evaluation is swinging
 * matters more than one made in a static position. Weight of move i = standard
 * deviation of the white win% over a short window starting at that move,
 * clamped to [0.5, 12]. `winPcts` has one entry per position (plies + 1).
 */
export function volatilityWeights(winPcts) {
  const plies = Math.max(0, winPcts.length - 1);
  const window = Math.min(8, Math.max(2, Math.floor(plies / 10)));
  const weights = [];
  for (let i = 0; i < plies; i++) {
    const slice = winPcts.slice(i, Math.min(winPcts.length, i + window + 1));
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    weights.push(Math.min(12, Math.max(0.5, Math.sqrt(variance))));
  }
  return weights;
}

/**
 * Player accuracy = average of the harmonic mean (punishes every bad move) and
 * the volatility-weighted mean (punishes bad moves in critical moments). The
 * harmonic mean alone turns one catastrophic move in a 40-move game into ~29%.
 */
export function calculateBlendedAccuracy(deltaWList, weights = null) {
  const harmonic = calculatePlayerAccuracy(deltaWList);
  if (harmonic === null) return null;
  if (!weights || weights.length !== deltaWList.length) return harmonic;
  let num = 0;
  let den = 0;
  deltaWList.forEach((deltaW, i) => {
    num += moveAccuracy(deltaW) * weights[i];
    den += weights[i];
  });
  const weighted = den > 0 ? num / den : harmonic;
  return (harmonic + weighted) / 2;
}

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Lightweight sacrifice heuristic for the "Brilliant" tier: the move gives
 *  up material to a strictly cheaper attacker. Soundness is filtered
 *  separately by winProbAfter >= 60. */
export function detectSacrifice(fen, move) {
  if (move.promotion) return false;
  const pieceValue = PIECE_VALUES[move.piece] ?? 0;
  const capturedValue = move.captured ? PIECE_VALUES[move.captured] : 0;
  if (pieceValue <= capturedValue) return false;

  let game;
  try {
    game = new Chess(fen);
    game.move({ from: move.from, to: move.to, promotion: move.promotion || undefined });
  } catch {
    return false;
  }
  // Any enemy recapture by a strictly cheaper piece means material was truly
  // offered; equal-value recaptures are trades and safe squares are nothing.
  for (const reply of game.moves({ verbose: true })) {
    if (reply.to === move.to && (PIECE_VALUES[reply.piece] ?? 0) < pieceValue) {
      return true;
    }
  }
  return false;
}

/** True when the position (placement, side to move, castling, en passant) is
 *  the standard chess start — theory/"Book" only makes sense from there. */
export function isStandardStart(fen) {
  const key = (f) => String(f).split(' ').slice(0, 4).join(' ');
  return key(fen) === key(START_FEN);
}

/** Rebuild the full game from a GameHistoryRecord — throws on an illegal move
 *  so callers can surface the real problem instead of analyzing garbage. */
export function buildReplay(record) {
  const startFen = record.initialFen || START_FEN;
  const game = new Chess(startFen);
  const fens = [game.fen()];
  const turns = [game.turn()];
  const terminal = [positionTerminal(game)];
  const moves = [];
  for (const mv of record.moves) {
    const move = game.move({ from: mv.from, to: mv.to, promotion: mv.promotion || undefined });
    if (!move) throw new Error(`ประวัติการเดินไม่ถูกต้อง: ${mv.from}${mv.to}${mv.promotion ?? ''}`);
    moves.push(move);
    fens.push(game.fen());
    turns.push(game.turn());
    terminal.push(positionTerminal(game));
  }
  return { startFen, fens, turns, terminal, moves };
}

function positionTerminal(game) {
  if (!game.isGameOver()) return null;
  return game.isCheckmate() ? 'checkmate' : 'draw';
}

function parseInfoEval(line) {
  const depth = line.match(/\bdepth (\d+)/);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  if (!depth || !score) return null;
  const multipv = line.match(/\bmultipv (\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  const wdl = wdlMatch ? [Number(wdlMatch[1]), Number(wdlMatch[2]), Number(wdlMatch[3])] : null;
  return {
    depth: Number(depth[1]),
    multipv: multipv ? Number(multipv[1]) : 1,
    eval: score[1] === 'mate'
      ? { cp: null, mate: Number(score[2]), wdl }
      : { cp: Number(score[2]), mate: null, wdl },
    pv: pv ? pv[1].trim().split(/\s+/) : [],
  };
}

/** Convert an engine PV (UCI list) into SAN moves playable from `fen`.
 *  Stops at the first non-legal move (truncated/ speculative tails). */
export function pvToSan(fen, uciMoves, maxPlies = 6) {
  const sans = [];
  try {
    const game = new Chess(fen);
    for (const uci of uciMoves.slice(0, maxPlies)) {
      const move = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!move) break;
      sans.push(move.san);
    }
  } catch {
    return sans;
  }
  return sans;
}

/** Critical moments (roadmap.md A1): the plies with the biggest win-probability
 *  swings from the MOVER's perspective. Adjacent heavy swings collapse into one
 *  moment (the strongest of the cluster); at most `maxMoments` survive, sorted
 *  chronologically. swingPct is rounded; lost=true means the mover lost that
 *  much win probability with the move. */
export function findCriticalMoments(positions, plies, { threshold = 15, maxMoments = 3 } = {}) {
  const candidates = [];
  for (let j = 0; j < plies.length; j++) {
    const before = positions[j]?.whiteWinProb;
    const after = positions[j + 1]?.whiteWinProb;
    if (before === undefined || after === undefined) continue;
    const mover = plies[j].color === 'w' ? before : 100 - before;
    const moverAfter = plies[j].color === 'w' ? after : 100 - after;
    const swing = mover - moverAfter;
    if (Math.abs(swing) >= threshold) candidates.push({ ply: j, swing });
  }
  const clusters = [];
  for (const c of candidates) {
    const last = clusters[clusters.length - 1];
    if (last && c.ply === last[last.length - 1].ply + 1) last.push(c);
    else clusters.push([c]);
  }
  return clusters
    .map((cluster) =>
      cluster.reduce((best, c) => (Math.abs(c.swing) > Math.abs(best.swing) ? c : best)))
    .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing))
    .slice(0, maxMoments)
    .sort((a, b) => a.ply - b.ply)
    .map(({ ply, swing }) => ({
      ply,
      san: plies[ply].san,
      lost: swing > 0,
      swingPct: Math.round(Math.abs(swing)),
    }));
}

/**
 * Analyzes a completed game ply-by-ply at ANALYSIS_DEPTH with MultiPV 3.
 * The second line powers the plan's "Great" rule (sole good move among
 * alternatives); all three lines give same-search grades for moves near the top
 * and the alternatives a puzzle may accept. Terminal positions (checkmate/ draw)
 * are scored without the engine. onProgress streams
 * { currentPly, totalPlies, percentage, etaMs }.
 * openingBook (src/openings.js) is optional: when set, the "Book" tier follows
 * the matched theory line instead of the early-ply heuristic.
 *
 * Positions are independent searches spread over several workers. The hash is
 * cleared before every position, so a position's result does not depend on which
 * worker took it or what that worker searched before — the review of a game is
 * the same on a 2-core phone and an 8-core desktop.
 */
// Watchdogs. Every engine line proves the engine is alive and re-arms the timer:
// - until the FIRST line arrives the worker may still be downloading/compiling
//   the ~7MB wasm, so it gets a long leash;
// - afterwards silence for SEARCH_IDLE_TIMEOUT_MS means the engine is wedged.
// Deliberately no `movetime` cap: depth alone decides when a search ends, so an
// analysis (and the tiers/accuracy derived from it) never depends on how fast
// the device is.
export const SEARCH_IDLE_TIMEOUT_MS = 20_000;
export const FIRST_SEARCH_IDLE_TIMEOUT_MS = 120_000;
export const ANALYSIS_MULTIPV = 3;

/** Workers for a review: leave one core for the page, never more than 4 (each
 *  holds a copy of the engine), 2 when the browser will not say. */
export function defaultWorkerCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency) {
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency < 1) return 2;
  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency) - 1));
}

/** One engine worker that runs one search at a time and watches its own health. */
class EngineSearcher {
  constructor({ workerUrl, multiPv, hashMb, idleTimeoutMs, firstIdleTimeoutMs, depth, onFail }) {
    this.workerUrl = workerUrl;
    this.multiPv = multiPv;
    this.hashMb = hashMb;
    this.idleTimeoutMs = idleTimeoutMs;
    this.firstIdleTimeoutMs = firstIdleTimeoutMs;
    this.depth = depth;
    this.onFail = onFail;
    this.worker = null;
    this.pending = null;
    this.info = null;
    this.watchdog = null;
    this.heard = false; // has this worker said anything yet?
  }

  get hasTimer() { return this.watchdog !== null; }

  spawn() {
    this.heard = false;
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (e) => this._handleLine(e.data);
    worker.onerror = () => this.onFail('engine_error');
    this.worker = worker;
    this._send('uci');
    this._send('isready');
    this._send(`setoption name MultiPV value ${this.multiPv}`);
    this._send('setoption name UCI_ShowWDL value true'); // win/draw/loss chances shown in the review
    this._send(`setoption name Hash value ${this.hashMb}`);
  }

  _send(cmd) {
    this.worker?.postMessage(cmd);
  }

  search(fen) {
    this.info = { lines: [] };
    const promise = new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    this._armWatchdog();
    this._send('ucinewgame'); // fresh hash: the result must not depend on what came before
    this._send(`position fen ${fen}`);
    this._send(`go depth ${this.depth}`);
    return promise;
  }

  rejectPending(error) {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    reject(error);
  }

  teardown() {
    this._clearWatchdog();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  _clearWatchdog() {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** (Re)arm the idle timer — every engine line proves it is alive. */
  _armWatchdog() {
    this._clearWatchdog();
    if (!this.pending) return;
    const ms = this.heard ? this.idleTimeoutMs : this.firstIdleTimeoutMs;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.pending) this.onFail('engine_timeout');
    }, ms);
  }

  _handleLine(line) {
    if (typeof line !== 'string') return;
    this.heard = true;
    if (this.pending) this._armWatchdog();
    if (!this.info) return; // stray line after a finished/aborted search
    if (line.startsWith('info ')) {
      const parsed = parseInfoEval(line);
      if (!parsed) return;
      const slot = this.info.lines[parsed.multipv - 1];
      if (slot && parsed.depth < slot.depth) return;
      this.info.lines[parsed.multipv - 1] = {
        depth: parsed.depth,
        eval: parsed.eval,
        pv: parsed.pv.length ? parsed.pv : (slot?.pv ?? []),
      };
    } else if (line.startsWith('bestmove ')) {
      const uci = line.split(' ')[1];
      const lines = this.info.lines.filter(Boolean).map((l) => ({
        eval: l.eval,
        pv: l.pv,
        move: l.pv.length ? uciToMove(l.pv[0]) : null,
      }));
      const payload = {
        best: uci && uci !== '(none)' ? uciToMove(uci) : null,
        eval1: lines[0]?.eval ?? { cp: 0, mate: null },
        eval2: lines[1]?.eval ?? null,
        pv: lines[0]?.pv ?? [],
        lines,
      };
      this.info = null;
      this._clearWatchdog();
      const { resolve } = this.pending ?? {};
      this.pending = null;
      resolve?.(payload);
    }
  }
}

export class GameReviewAnalyzer {
  constructor({
    workerUrl = ENGINE_WORKER_URL,
    depth = ANALYSIS_DEPTH,
    openingBook = null,
    idleTimeoutMs = SEARCH_IDLE_TIMEOUT_MS,
    firstIdleTimeoutMs = FIRST_SEARCH_IDLE_TIMEOUT_MS,
    workers = defaultWorkerCount(),
    multiPv = ANALYSIS_MULTIPV,
    now = () => Date.now(),
  } = {}) {
    this.workerUrl = workerUrl;
    this.depth = depth;
    this.openingBook = openingBook;
    this.idleTimeoutMs = idleTimeoutMs;
    this.firstIdleTimeoutMs = firstIdleTimeoutMs;
    this.workerCount = Math.max(1, Math.floor(workers));
    this.multiPv = multiPv;
    this._now = now;
    this._searchers = [];
    this._cancelled = false; // set only by abort(): the user (or dispose) gave up.
                             // An aborted analyzer is spent — create a new one.
    this._fatal = null;      // engine failure that ended the current run
  }

  /** True while any worker's watchdog is armed (tests check nothing leaks). */
  hasPendingTimers() {
    return this._searchers.some((s) => s.hasTimer);
  }

  async analyzeGame(record, onProgress = () => {}) {
    const replay = buildReplay(record);
    const total = replay.fens.length;
    const evals = new Array(total).fill(null);
    const secondEvals = new Array(total).fill(null);
    const bests = new Array(total).fill(null);
    const bestPvs = new Array(total).fill(null);
    const lines = new Array(total).fill(null);
    const opening = isStandardStart(replay.startFen)
      ? (this.openingBook?.lookup(replay.moves.map((m) => m.san)) ?? null)
      : null;

    // A cancel that landed before we got here (e.g. while the opening book was
    // still loading) must stick — never resurrect a cancelled analyzer.
    if (this._cancelled) throw new Error('review_aborted');
    this._fatal = null;

    // Terminal positions (mate / draw) are scored without the engine.
    let done = 0;
    const todo = [];
    replay.fens.forEach((_, j) => {
      if (replay.terminal[j]) {
        // Side to move is mated (W=0 for them) or the game is drawn.
        evals[j] = replay.terminal[j] === 'checkmate'
          ? { cp: null, mate: -1, wdl: [0, 0, 1000] }
          : { cp: 0, mate: null, wdl: [0, 1000, 0] };
        done += 1;
      } else {
        todo.push(j);
      }
    });

    const startedAt = this._now();
    let searched = 0;
    const report = () => {
      const remaining = todo.length - searched;
      // Average time per position so far, scaled to what is left. Held back until
      // a few positions have finished (the first ones include engine start-up).
      const etaMs = searched >= 3 && remaining > 0
        ? Math.round(((this._now() - startedAt) / searched) * remaining)
        : null;
      onProgress({
        currentPly: done,
        totalPlies: total,
        percentage: Math.round((done / total) * 100),
        etaMs,
      });
    };
    report();

    if (todo.length) {
      const count = Math.min(this.workerCount, todo.length);
      this._searchers = Array.from({ length: count }, () => new EngineSearcher({
        workerUrl: this.workerUrl,
        multiPv: this.multiPv,
        hashMb: count > 1 ? 32 : 64,
        idleTimeoutMs: this.idleTimeoutMs,
        firstIdleTimeoutMs: this.firstIdleTimeoutMs,
        depth: this.depth,
        onFail: (code) => this._fail(code),
      }));
      let next = 0;
      const drain = async (searcher) => {
        while (next < todo.length) {
          if (this._cancelled) throw new Error('review_aborted');
          if (this._fatal) throw this._fatal;
          const j = todo[next++];
          const result = await searcher.search(replay.fens[j]);
          evals[j] = result.eval1;
          secondEvals[j] = result.eval2;
          bests[j] = result.best;
          bestPvs[j] = result.pv;
          lines[j] = result.lines;
          done += 1;
          searched += 1;
          report();
        }
      };
      try {
        for (const searcher of this._searchers) searcher.spawn();
        await Promise.all(this._searchers.map(drain));
      } finally {
        this._teardown();
      }
    }
    if (this._cancelled) throw new Error('review_aborted');
    return buildAnalysisResult(record, replay, evals, secondEvals, bests, bestPvs, opening, lines);
  }

  /** Terminate every worker immediately — safe to call any time, any number of
   *  times (plan Hole 3). In-flight searches reject with 'review_aborted'. */
  abort() {
    this._cancelled = true;
    this._teardown();
    this._rejectPending(new Error('review_aborted'));
  }

  /** The engine itself failed (worker error / silent engine). Distinct from
   *  abort(): the caller must tell the user, not treat it as a cancel. */
  _fail(code) {
    if (this._fatal) return; // the first failure is the one reported
    const error = new Error(code);
    this._fatal = error;
    this._teardown();
    this._rejectPending(error);
  }

  _teardown() {
    for (const searcher of this._searchers) searcher.teardown();
  }

  _rejectPending(error) {
    for (const searcher of this._searchers) searcher.rejectPending(error);
  }
}

export function uciToMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

/** Two moves are the same when squares and promotion agree (queen is the default). */
export function sameMove(a, b) {
  return Boolean(a && b && a.from === b.from && a.to === b.to
    && (a.promotion || undefined) === (b.promotion || undefined));
}

/** An alternative within this many win-% points of the engine's first choice
 *  (in the same search) is as good a solution as the first choice itself. */
export const EQUAL_ALTERNATIVE_DELTA = 3;

/** Is (from, to, promotion) a solution to the position this ply started from —
 *  the engine's move, or an alternative it rates as good? Falls back to the
 *  engine's move alone for analyses that predate the alternatives list. */
export function isAcceptableMove(ply, from, to, promotion) {
  const accepted = ply.acceptable?.length ? ply.acceptable : (ply.bestMove ? [ply.bestMove] : []);
  return accepted.some((m) => m.from === from && m.to === to && (m.promotion ?? 'q') === (promotion ?? 'q'));
}

/** Assemble the full review payload consumed by review-ui.js. opening (from
 *  OpeningBook.lookup) is optional — null keeps the early-ply Book fallback.
 *  lines (optional): per position, the engine's top lines [{move, eval}] from
 *  the same search; enables same-search grades and the acceptable-alternatives
 *  list. */
export function buildAnalysisResult(record, replay, evals, secondEvals, bests, bestPvs = null, opening = null, lines = null) {
  const plyCount = replay.moves.length;
  const scratch = new Chess();

  const plies = [];
  const tiers = [];
  for (let i = 0; i < plyCount; i++) {
    const move = replay.moves[i];
    const bestEval = evals[i];
    const afterEval = negateEval(evals[i + 1]);
    const bestW = winProbFromEval(bestEval);
    const actualW = winProbFromEval(afterEval);
    // deltaW compares two INDEPENDENT searches (before / after), so the engine's
    // own top move can come out a couple of % "worse" from search noise alone.
    // Playing the engine's choice is by definition a zero-loss move.
    const engineChoice = bests[i];
    const playedIsBest = sameMove(engineChoice, move);
    const alternatives = lines?.[i] ?? null;
    // A move that is one of the engine's top lines has its own evaluation from
    // the SAME search as the best move — a like-for-like comparison, free of the
    // cross-search noise. (The top line itself has zero loss by definition.)
    const playedLine = alternatives ? alternatives.find((l) => sameMove(l.move, move)) : null;
    const lineDelta = playedLine ? Math.max(0, bestW - winProbFromEval(playedLine.eval)) : (playedIsBest ? 0 : null);
    // ...but only up to the noise level: if the deeper "after" search shows a
    // large drop the tactic is real and the move is graded by it.
    const rawDelta = Math.max(0, bestW - actualW);
    const deltaW = lineDelta !== null && rawDelta - lineDelta <= SEARCH_NOISE_PCT
      ? Math.min(rawDelta, lineDelta)
      : rawDelta;
    const secondW = secondEvals[i] ? winProbFromEval(secondEvals[i]) : null;
    const secondDelta = secondW === null ? null : Math.max(0, bestW - secondW);

    // SAN of the engine's recommendation for the coach card (null if the
    // position was terminal or the engine returned nothing).
    let bestSan = null;
    let bestMove = bests[i];
    if (bestMove) {
      try {
        scratch.load(replay.fens[i]);
        bestSan = scratch.move({ from: bestMove.from, to: bestMove.to, promotion: bestMove.promotion || undefined })?.san ?? null;
      } catch {
        bestSan = null;
      }
    }

    // Opponent's strongest answer to the played move — the dashed "threat"
    // arrow source in replay mode (plan.md §4.1 item 4).
    let replySan = null;
    const replyMove = bests[i + 1] ?? null;
    if (replyMove && !replay.terminal[i + 1]) {
      try {
        scratch.load(replay.fens[i + 1]);
        replySan = scratch.move({ from: replyMove.from, to: replyMove.to, promotion: replyMove.promotion || undefined })?.san ?? null;
      } catch {
        replySan = null;
      }
    }

    // Real theory (roadmap A2): a matched opening line grades "book" only while
    // the game stays inside it; no match keeps the early-ply heuristic fallback.
    // Book: a matched line grades "book" for its full length (theory runs up to
    // 14 plies); no match keeps the early-ply heuristic — but never from a custom
    // start position, where "theory" means nothing.
    let inBookLine = null;
    if (opening) inBookLine = i < opening.plies;
    else if (!isStandardStart(replay.startFen)) inBookLine = false;
    const tier = classifyMove(deltaW, {
      ply: i,
      inBookLine,
      secondDelta,
      isSacrifice: detectSacrifice(replay.fens[i], move),
      winProbAfter: actualW,
      winProbBefore: bestW,
      missedMate: (bestEval?.mate ?? 0) > 0 && deltaW > 10,
      opponentPrevTier: i > 0 ? tiers[i - 1] : null,
      endsGame: replay.terminal[i + 1] !== null,
    });
    tiers.push(tier);

    plies.push({
      ply: i,
      color: move.color,
      san: move.san,
      from: move.from,
      to: move.to,
      promotion: move.promotion ?? null,
      captured: move.captured ?? null,
      fenAfter: replay.fens[i + 1],
      turnAfter: replay.turns[i + 1],
      bestMove,
      bestSan,
      acceptable: acceptableMoves(bestMove, bestEval, alternatives, bestW),
      reply: replyMove,
      replySan,
      tier,
      deltaW: round2(deltaW),
      cpLoss: deltaW === 0 && playedIsBest ? 0 : Math.max(0, Math.round(evalToCentipawns(bestEval) - evalToCentipawns(afterEval))),
      bestEvalCp: Math.round(evalToCentipawns(bestEval)),
      // Forced mates from the mover's side (for the coach): >0 the mover had one
      // before the move, <0 the mover gets mated after it.
      bestMate: bestEval?.mate ?? null,
      afterMate: afterEval?.mate ?? null,
    });
  }

  // Advantage timeline for the graph — white win probability per position,
  // plus the replay clock (remaining ms per side at that position) when the
  // game recorded time data.
  const times = record.times ?? [];
  const initialTimes = record.initial ?? null;
  const clockFor = (j) => {
    if (!times.length) return null;
    for (let t = times.length - 1; t >= 0; t--) {
      if (times[t].ply <= j) return { w: times[t].w, b: times[t].b };
    }
    return initialTimes ? { ...initialTimes } : null;
  };

  const positions = replay.fens.map((fen, j) => {
    const w = winProbFromEval(evals[j]);
    const whiteSign = replay.turns[j] === 'w' ? 1 : -1;
    return {
      ply: j,
      fen,
      turn: replay.turns[j],
      whiteWinProb: round2(replay.turns[j] === 'w' ? w : 100 - w),
      whiteEvalCp: Math.round(evalToCentipawns(evals[j]) * whiteSign),
      // white / draw / black chances in percent, when the engine reported them
      wdl: whiteWdlPercent(evals[j], replay.turns[j]),
      clock: clockFor(j),
      // Engine's predicted continuation from this position (SAN, ≤6 plies).
      pvSan: bestPvs?.[j]?.length ? pvToSan(fen, bestPvs[j]) : [],
    };
  });

  const accuracy = { w: null, b: null };
  const counts = { w: emptyCounts(), b: emptyCounts() };
  const weights = volatilityWeights(positions.map((p) => p.whiteWinProb));
  for (const color of ['w', 'b']) {
    const mine = plies.filter((p) => p.color === color);
    accuracy[color] = calculateBlendedAccuracy(mine.map((p) => p.deltaW), mine.map((p) => weights[p.ply]));
    accuracy[color] = accuracy[color] === null ? null : round1(accuracy[color]);
    for (const p of plies) {
      if (p.color === color) counts[color][p.tier] += 1;
    }
  }

  return {
    initialFen: replay.startFen,
    fens: replay.fens,
    plies,
    positions,
    criticalMoments: findCriticalMoments(positions, plies),
    opening: opening ? { eco: opening.eco, name: opening.name } : null,
    accuracy,
    counts,
    result: record.result ?? '*',
    reason: record.reason ?? '',
    players: record.players ?? { white: {}, black: {} },
    gamemode: record.gamemode ?? null,
  };
}

/** The engine's move plus its alternatives that score within EQUAL_ALTERNATIVE_DELTA
 *  of it (and still mate when the best move mates). Never contains duplicates. */
function acceptableMoves(bestMove, bestEval, alternatives, bestW) {
  if (!bestMove) return [];
  const accepted = [bestMove];
  const mates = (bestEval?.mate ?? 0) > 0;
  for (const line of alternatives ?? []) {
    if (!line.move || accepted.some((m) => sameMove(m, line.move))) continue;
    if (mates && !((line.eval?.mate ?? 0) > 0)) continue;
    if (bestW - winProbFromEval(line.eval) <= EQUAL_ALTERNATIVE_DELTA) accepted.push(line.move);
  }
  return accepted;
}

/** {w, d, b} percentages from white's point of view, or null without engine WDL. */
export function whiteWdlPercent(evalObj, turn) {
  if (!evalObj || !isWdl(evalObj.wdl)) return null;
  const total = evalObj.wdl[0] + evalObj.wdl[1] + evalObj.wdl[2];
  const [win, draw, loss] = evalObj.wdl.map((n) => (100 * n) / total);
  const [w, b] = turn === 'w' ? [win, loss] : [loss, win];
  return { w: round1(w), d: round1(draw), b: round1(b) };
}

function emptyCounts() {
  return Object.fromEntries(TIERS.map((t) => [t.key, 0]));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
