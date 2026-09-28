// Spectator live evaluation (roadmap.md C1) — one depth-capped engine per
// spectator that always searches the CURRENT displayed position: a position
// change mid-search stops the stale search and the completion handler re-
// requests, so it can never fall more than one search behind. The tab-visibility
// listener pauses the search while hidden and resumes on return.

import { Stockfish } from './engine.js';
import { convertCentipawnsToWinProbability } from './analyzer.js';

export const SPECTATOR_EVAL_DEPTH = 10;

export class SpectatorEval {
  /** fenProvider: () => current FEN string. handler: (result|null) => void. */
  constructor({ fenProvider, depth = SPECTATOR_EVAL_DEPTH } = {}) {
    if (typeof fenProvider !== 'function') throw new Error('fenProvider is required');
    this.fenProvider = fenProvider;
    this.depth = depth;
    this.enabled = false;
    this.engine = null;
    this.searching = false;
    this.searchedFen = null;
    this.handler = null;
    this._onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) this._pause();
      else this._requestCurrent();
    };
  }

  setHandler(fn) {
    this.handler = fn;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    const doc = typeof document !== 'undefined' && document ? document : null;
    if (this.enabled) {
      doc?.addEventListener('visibilitychange', this._onVisibility);
      this._ensureEngine();
    } else {
      doc?.removeEventListener('visibilitychange', this._onVisibility);
      this._pause();
      this.handler?.(null);
    }
    return this.enabled;
  }

  /** The controller calls this whenever the displayed position changes. A dead
   *  worker (past onError) is respawned here so one glitch never silences the
   *  feature until a manual toggle. */
  notifyPosition() {
    if (!this.enabled) return;
    if (this.searching) {
      this.engine?.stop();
      return;
    }
    this._ensureEngine();
  }

  destroy() {
    this.setEnabled(false);
    if (this.engine) {
      this.engine.quit();
      this.engine = null;
    }
    this.handler = null;
    this.searching = false;
  }

  _ensureEngine() {
    if (this.engine) {
      this._requestCurrent();
      return;
    }
    let engine;
    engine = new Stockfish({
      // A stubbed worker can answer synchronously INSIDE the constructor —
      // before `this.engine = engine` runs — so onReady re-binds the instance.
      onReady: () => {
        if (!this.engine) this.engine = engine;
        this.searching = false;
        this._requestCurrent();
      },
      onInfo: (info) => this._emit(info),
      onBestMove: () => {
        this.searching = false;
        this._requestCurrent();
      },
      onError: () => {
        if (this.engine === engine) {
          engine.quit();
          this.engine = null;
          this.searching = false;
          // The aborted search never produced a result — allow a re-search.
          this.searchedFen = null;
        }
      },
    });
    if (!this.engine) this.engine = engine;
    this._requestCurrent();
  }

  _pause() {
    if (this.searching && this.engine) this.engine.stop();
    this.searching = false;
    // The stopped search never completed — the fen must be searchable again.
    this.searchedFen = null;
  }

  _requestCurrent() {
    if (!this.enabled || !this.engine?.ready || this.searching) return;
    const fen = this.fenProvider();
    if (!fen || fen === this.searchedFen) return;
    this.searchedFen = fen;
    this.searching = true;
    this.engine.setPosition(fen);
    this.engine.go({ depth: this.depth });
  }

  /** Engine scores are side-to-move — convert to white perspective for the bar. */
  _emit(info) {
    if (!this.handler || !info) return;
    const turn = (this.searchedFen ?? '').split(' ')[1] === 'b' ? 'b' : 'w';
    let whiteCp;
    let whiteProb;
    if (typeof info.score === 'number') {
      whiteCp = Math.round((turn === 'w' ? 1 : -1) * info.score * 100);
      const probStm = convertCentipawnsToWinProbability(Math.round(info.score * 100));
      whiteProb = Math.round(turn === 'w' ? probStm : 100 - probStm);
    } else if (typeof info.score === 'string' && /^-?M\d+$/.test(info.score)) {
      whiteCp = info.score.startsWith('-') ? -10000 : 10000;
      const probStm = whiteCp > 0 ? 100 : 0;
      whiteProb = turn === 'w' ? probStm : 100 - probStm;
    } else {
      return;
    }
    const pv = Array.isArray(info.pv) && info.pv[0]
      ? { from: info.pv[0].slice(0, 2), to: info.pv[0].slice(2, 4) }
      : null;
    this.handler?.({
      whiteCp,
      whiteWinProb: whiteProb,
      depth: info.depth,
      best: pv,
      fen: this.searchedFen,
    });
  }
}
