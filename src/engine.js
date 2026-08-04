// Thin UCI client wrapping the Stockfish.js worker.
// The engine is a classic (non-module) worker script served from public/engine,
// so it works on static hosts without cross-origin isolation headers.

import { ENGINE_WORKER_URL } from './config.js';

const infoRe =
  /^info .*?depth (\d+).*?score (cp|mate) (-?\d+).*?(?:nps (\d+))?.*?time (\d+).*?(?:pv (.+))?$/;

export class Stockfish {
  /**
   * @param {object} opts
   * @param {Function} [opts.onReady]
   * @param {Function} [opts.onInfo] (info) => void — periodic search info
   * @param {Function} opts.onBestMove (uci, info) => void
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
      if (m) {
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
      this._searchInfo = null;
      this.onBestMove(this._bestmove, info);
    }
  }

  setOption(name, value) {
    this._send(`setoption name ${name} value ${value}`);
  }

  setPosition(fen) {
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
