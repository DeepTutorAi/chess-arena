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
 *  from the perspective of the side to move at the evaluated position. */

// plan.md §3.1 — logistic win probability in [0, 100] for the mover.
export function convertCentipawnsToWinProbability(cp, mate = null) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  const p = 2 / (1 + Math.exp(-LOGISTIC_K * cp)) - 1;
  return 50 + 50 * p;
}

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
// moveContext: { ply, secondDelta, isSacrifice, winProbAfter, missedMate,
//                opponentPrevTier, endsGame } — everything beyond deltaW is
// optional and degrades gracefully when missing.
export function classifyMove(deltaW, moveContext = {}) {
  const {
    ply = Infinity,
    secondDelta = null,
    isSacrifice = false,
    winProbAfter = 50,
    missedMate = false,
    opponentPrevTier = null,
    endsGame = false,
  } = moveContext;

  if (ply < BOOK_PLIES && deltaW <= BOOK_MAX_LOSS && !endsGame) return 'book';
  if (deltaW <= 0.1) {
    if (isSacrifice && winProbAfter >= 60) return 'brilliant';
    if (secondDelta !== null && secondDelta >= 15) return 'great';
    return 'best';
  }
  // Missed a forced mate the engine had, or failed to punish the opponent's
  // fresh mistake/ blunder.
  if (missedMate && deltaW > 10) return 'miss';
  if (
    (opponentPrevTier === 'mistake' || opponentPrevTier === 'blunder') && deltaW > 5
  ) {
    return 'miss';
  }
  if (deltaW > 20) return 'blunder';
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
  return {
    depth: Number(depth[1]),
    multipv: multipv ? Number(multipv[1]) : 1,
    eval: score[1] === 'mate'
      ? { cp: null, mate: Number(score[2]) }
      : { cp: Number(score[2]), mate: null },
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
 * Analyzes a completed game ply-by-ply at ANALYSIS_DEPTH with MultiPV 2.
 * The second line powers the plan's "Great" rule (sole good move among
 * alternatives). Terminal positions (checkmate/ draw) are scored without the
 * engine. onProgress streams { currentPly, totalPlies, percentage }.
 * openingBook (src/openings.js) is optional: when set, the "Book" tier follows
 * the matched theory line instead of the early-ply heuristic.
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

export class GameReviewAnalyzer {
  constructor({
    workerUrl = ENGINE_WORKER_URL,
    depth = ANALYSIS_DEPTH,
    openingBook = null,
    idleTimeoutMs = SEARCH_IDLE_TIMEOUT_MS,
    firstIdleTimeoutMs = FIRST_SEARCH_IDLE_TIMEOUT_MS,
  } = {}) {
    this.workerUrl = workerUrl;
    this.depth = depth;
    this.openingBook = openingBook;
    this.idleTimeoutMs = idleTimeoutMs;
    this.firstIdleTimeoutMs = firstIdleTimeoutMs;
    this.worker = null;
    this._pending = null;
    this._info = null;
    this._cancelled = false; // set only by abort(): the user (or dispose) gave up.
                             // An aborted analyzer is spent — create a new one.
    this._fatal = null;      // engine failure that ended the current run
    this._watchdog = null;
    this._heardFromEngine = false; // has the current worker said anything yet?
  }

  async analyzeGame(record, onProgress = () => {}) {
    const replay = buildReplay(record);
    const total = replay.fens.length;
    const evals = new Array(total).fill(null);
    const secondEvals = new Array(total).fill(null);
    const bests = new Array(total).fill(null);
    const bestPvs = new Array(total).fill(null);
    const opening = this.openingBook?.lookup(replay.moves.map((m) => m.san)) ?? null;

    // A cancel that landed before we got here (e.g. while the opening book was
    // still loading) must stick — never resurrect a cancelled analyzer.
    if (this._cancelled) throw new Error('review_aborted');
    this._fatal = null;
    this._spawn();
    try {
      for (let j = 0; j < total; j++) {
        if (this._cancelled) throw new Error('review_aborted');
        if (this._fatal) throw this._fatal;
        if (replay.terminal[j]) {
          // Side to move is mated (W=0 for them) or the game is drawn.
          evals[j] = replay.terminal[j] === 'checkmate' ? { cp: null, mate: -1 } : { cp: 0, mate: null };
        } else {
          const result = await this._search(replay.fens[j]);
          evals[j] = result.eval1;
          secondEvals[j] = result.eval2;
          bests[j] = result.best;
          bestPvs[j] = result.pv;
        }
        onProgress({
          currentPly: j + 1,
          totalPlies: total,
          percentage: Math.round(((j + 1) / total) * 100),
        });
      }
    } finally {
      this._teardown();
    }
    return buildAnalysisResult(record, replay, evals, secondEvals, bests, bestPvs, opening);
  }

  /** Terminate the worker immediately — safe to call any time, any number of
   *  times (plan Hole 3). An in-flight search rejects with 'review_aborted'. */
  abort() {
    this._cancelled = true;
    this._teardown();
    this._rejectPending(new Error('review_aborted'));
  }

  /** The engine itself failed (worker error / silent engine). Distinct from
   *  abort(): the caller must tell the user, not treat it as a cancel. */
  _fail(code) {
    const error = new Error(code);
    this._fatal = error;
    this._teardown();
    this._rejectPending(error);
  }

  _teardown() {
    this._clearWatchdog();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  _rejectPending(error) {
    if (!this._pending) return;
    const { reject } = this._pending;
    this._pending = null;
    reject(error);
  }

  _clearWatchdog() {
    if (this._watchdog !== null) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
  }

  /** (Re)arm the idle timer — every engine line proves it is alive. */
  _armWatchdog() {
    this._clearWatchdog();
    if (!this._pending) return;
    const ms = this._heardFromEngine ? this.idleTimeoutMs : this.firstIdleTimeoutMs;
    this._watchdog = setTimeout(() => {
      this._watchdog = null;
      if (this._pending) this._fail('engine_timeout');
    }, ms);
  }

  _spawn() {
    this._heardFromEngine = false;
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (e) => this._handleLine(e.data);
    worker.onerror = () => this._fail('engine_error');
    this.worker = worker;
    this._send('uci');
    this._send('isready');
    this._send('setoption name MultiPV value 2');
    this._send('setoption name Hash value 64');
  }

  _send(cmd) {
    this.worker?.postMessage(cmd);
  }

  _search(fen) {
    this._info = { depth: -1, eval1: null, eval2: null };
    const promise = new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
    });
    this._armWatchdog();
    this._send(`position fen ${fen}`);
    this._send(`go depth ${this.depth}`);
    return promise;
  }

  _handleLine(line) {
    if (typeof line !== 'string') return;
    this._heardFromEngine = true;
    if (this._pending) this._armWatchdog();
    if (!this._info) return; // stray line after a finished/aborted search
    if (line.startsWith('info ')) {
      const parsed = parseInfoEval(line);
      if (!parsed || parsed.depth < this._info.depth) return;
      this._info.depth = parsed.depth;
      if (parsed.multipv >= 2) this._info.eval2 = parsed.eval;
      else {
        this._info.eval1 = parsed.eval;
        if (parsed.pv.length) this._info.pv1 = parsed.pv;
      }
    } else if (line.startsWith('bestmove ')) {
      const uci = line.split(' ')[1];
      const payload = {
        best: uci && uci !== '(none)' ? uciToMove(uci) : null,
        eval1: this._info.eval1 ?? { cp: 0, mate: null },
        eval2: this._info.eval2,
        pv: this._info.pv1 ?? [],
      };
      this._info = null;
      this._clearWatchdog();
      const { resolve } = this._pending ?? {};
      this._pending = null;
      resolve?.(payload);
    }
  }
}

export function uciToMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

/** Assemble the full review payload consumed by review-ui.js. opening (from
 *  OpeningBook.lookup) is optional — null keeps the early-ply Book fallback. */
export function buildAnalysisResult(record, replay, evals, secondEvals, bests, bestPvs = null, opening = null) {
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
    const deltaW = Math.max(0, bestW - actualW);
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
    const bookEligible = opening ? i < opening.plies : true;
    const tier = classifyMove(deltaW, {
      ply: bookEligible ? i : Infinity,
      secondDelta,
      isSacrifice: detectSacrifice(replay.fens[i], move),
      winProbAfter: actualW,
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
      captured: move.captured ?? null,
      fenAfter: replay.fens[i + 1],
      turnAfter: replay.turns[i + 1],
      bestMove,
      bestSan,
      reply: replyMove,
      replySan,
      tier,
      deltaW: round2(deltaW),
      cpLoss: Math.max(0, Math.round(evalToCentipawns(bestEval) - evalToCentipawns(afterEval))),
      bestEvalCp: Math.round(evalToCentipawns(bestEval)),
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
      clock: clockFor(j),
      // Engine's predicted continuation from this position (SAN, ≤6 plies).
      pvSan: bestPvs?.[j]?.length ? pvToSan(fen, bestPvs[j]) : [],
    };
  });

  const accuracy = { w: null, b: null };
  const counts = { w: emptyCounts(), b: emptyCounts() };
  for (const color of ['w', 'b']) {
    const deltas = plies.filter((p) => p.color === color).map((p) => p.deltaW);
    accuracy[color] = calculatePlayerAccuracy(deltas);
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

function emptyCounts() {
  return Object.fromEntries(TIERS.map((t) => [t.key, 0]));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
