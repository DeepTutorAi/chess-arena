// Thin UCI client wrapping the Stockfish.js worker.
// The engine is a classic (non-module) worker script served from public/engine,
// so it works on static hosts without cross-origin isolation headers.

import { ENGINE_WORKER_URL } from './config.js';

const infoRe =
  /^info .*?depth (\d+).*?score (cp|mate) (-?\d+).*?(?:nps (\d+))?.*?time (\d+).*?(?:pv (.+))?$/;
const multipvRe = /\bmultipv (\d+)/;

/**
 * Collects the MultiPV lines of one search and reports the final set.
 *
 * A search cut off mid-iteration leaves the later slots holding lines from the
 * iteration before: a move that has since climbed to the top then appears twice (the
 * fresher, lower-numbered copy wins), and the move it displaced from the top slot
 * would otherwise be lost — so displaced moves from the previous iteration fill any
 * slots left short, after the fresh lines. Older ones are never used: a score from
 * far shallower search is no basis to choose by.
 */
export class LineCollector {
  constructor() { this.reset(); }

  reset() {
    this.slots = new Map(); // multipv index -> latest line
    this.displaced = []; // older lines another move has since pushed out of their slot
  }

  /** @param {{multipv: number, depth: number, cp: number|null, mate: number|null, pv: string[]}} line */
  add(line) {
    const previous = this.slots.get(line.multipv);
    if (previous && line.depth < previous.depth) return;
    if (previous && previous.pv[0] !== line.pv[0]) {
      this.displaced.push(previous);
      if (this.displaced.length > 16) this.displaced.shift();
    }
    this.slots.set(line.multipv, line);
  }

  /** Every line of the search, best first. */
  result() {
    const lines = uniqueLines([...this.slots.values()].sort((a, b) => a.multipv - b.multipv));
    const deepest = Math.max(0, ...lines.map((l) => l.depth));
    const have = new Set(lines.map((l) => l.pv[0]));
    for (const old of this.displaced.slice().reverse()) {
      if (lines.length >= this.slots.size) break;
      if (!old.pv[0] || have.has(old.pv[0]) || old.depth < deepest - 1) continue;
      have.add(old.pv[0]);
      lines.push(old);
    }
    return lines;
  }
}

/** Drop later copies of a move, keeping lines without a move as they are. */
export function uniqueLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const first = line.pv?.[0];
    if (!first) return true;
    if (seen.has(first)) return false;
    seen.add(first);
    return true;
  });
}

export class Stockfish {
  /**
   * @param {object} opts
   * @param {Function} [opts.onReady]
   * @param {Function} [opts.onInfo] (info) => void — periodic search info
   * @param {Function} opts.onBestMove (uci, info, lines, fen) => void — `lines` is the final
   *        result of every MultiPV line, best first: [{ multipv, depth, cp, mate, pv }];
   *        `fen` is the position the search was started on (null if none was set), which
   *        stays right even when a stopped search answers after a new one has begun
   * @param {Function} [opts.onError] (msg) => void
   * @param {string} [opts.workerUrl]
   */
  constructor({ onReady, onInfo, onBestMove, onError, workerUrl = ENGINE_WORKER_URL } = {}) {
    this.worker = new Worker(workerUrl);
    this.onReady = onReady ?? (() => {});
    this.onInfo = onInfo ?? (() => {});
    this.onBestMove = onBestMove;
    this.onError = onError ?? (() => {});
    this.ready = false;
    this._searchInfo = null;
    this._lines = new LineCollector(); // the MultiPV lines of the current search
    this._fen = null; // the last position sent
    this._searches = []; // one entry per `go` not yet answered; the engine answers in order
    this._bestmove = null;
    this._pendingReady = null;

    this.worker.onmessage = (e) => this._handle(e.data);
    this.worker.onerror = (e) => this.onError(e.message || 'Engine worker error');

    this._send('uci');
    this._send('isready');
  }

  _send(cmd) {
    this.worker.postMessage(cmd);
  }

  _handle(line) {
    if (typeof line !== 'string') return;
    if (line === 'uciok' || line === 'readyok') {
      if (!this.ready) {
        this.ready = true;
        this.onReady();
      }
    } else if (line.startsWith('info ')) {
      const m = line.match(infoRe);
      const multipv = Number(line.match(multipvRe)?.[1] ?? 1);
      // Bound lines (aspiration-window fail highs / lows) are not real scores.
      if (m && !/\b(?:lowerbound|upperbound)\b/.test(line)) {
        this._lines.add({
          multipv,
          depth: Number(m[1]),
          cp: m[2] === 'cp' ? Number(m[3]) : null,
          mate: m[2] === 'mate' ? Number(m[3]) : null,
          pv: m[6] ? m[6].split(' ') : [],
        });
      }
      // The headline info stays that of the BEST line even when several are searched.
      if (m && multipv === 1) {
        this._searchInfo = {
          depth: Number(m[1]),
          score: m[2] === 'mate' ? (Number(m[3]) > 0 ? 'M' + m[3] : '-M' + Math.abs(Number(m[3]))) : Number(m[3]) / 100,
          nps: m[4] ? Number(m[4]) : null,
          timeMs: Number(m[5]),
          pv: m[6] ? m[6].split(' ').slice(0, 8) : [],
        };
        this.onInfo(this._searchInfo);
      }
    } else if (line.startsWith('bestmove ')) {
      const parts = line.split(' ');
      const uci = parts[1];
      if (uci === '(none)') {
        this._bestmove = null;
      } else {
        this._bestmove = uci;
      }
      const info = this._searchInfo;
      const lines = this._lines.result();
      const fen = this._searches.shift() ?? null;
      this._searchInfo = null;
      this._lines.reset();
      this.onBestMove(this._bestmove, info, lines, fen);
    }
  }

  setOption(name, value) {
    this._send(`setoption name ${name} value ${value}`);
  }

  setPosition(fen) {
    this._fen = fen;
    this._send(`position fen ${fen}`);
  }

  /**
   * Start a search.
   * @param {object} opts — depth, movetime (ms), or infinite
   */
  go(opts = {}) {
    const parts = ['go'];
    if (opts.depth) parts.push('depth', String(opts.depth));
    if (opts.movetime) parts.push('movetime', String(opts.movetime));
    if (opts.infinite) parts.push('infinite');
    this._searchInfo = null;
    this._lines.reset();
    this._searches.push(this._fen);
    this._send(parts.join(' '));
  }

  stop() {
    this._send('stop');
  }

  quit() {
    this._send('quit');
    this.worker.terminate();
  }
}
