// Game controller — the single state machine for every mode:
//   human-vs-ai  : you vs Stockfish
//   ai-vs-ai     : Stockfish vs Stockfish (watch the fight)
//   remote       : battle against an external AI agent over a GitHub gist
//   analyze      : free play / analysis board (no engine)
//
// The controller knows chess rules (chess.js), talks UCI to Stockfish and
// speaks the gist protocol via RemoteChannel. UI stays dumb.

import { Chess } from 'chess.js';
import { Stockfish } from './engine.js';
import { RemoteChannel, createRoom, sanitizeName } from './remote.js';
import { LEVELS, SPEEDS, DEFAULT_SPEED, ENGINE_NAME, HUMAN_NAME, GUEST_NAME } from './config.js';

export const MODES = {
  HUMAN_VS_AI: 'human-vs-ai',
  AI_VS_AI: 'ai-vs-ai',
  REMOTE: 'remote',
  ANALYZE: 'analyze',
};

const RESULT_TEXT = {
  '1-0': 'ฝ่ายขาวชนะ',
  '0-1': 'ฝ่ายดำชนะ',
  '1/2-1/2': 'ผลเสมอ',
};

export class Controller {
  /**
   * @param {object} deps
   * @param {UI} deps.ui
   * @param {object} deps.ground — chessground instance
   * @param {(orig, dest) => Promise<string|null>} deps.onPromotion — returns promotion piece or null
   */
  constructor({ ui, ground, onPromotion }) {
    this.ui = ui;
    this.ground = ground;
    this.onPromotion = onPromotion;

    this.game = new Chess();
    this.mode = null;

    this.engine = null; // Stockfish — opponent (human-vs-ai) or white (ai-vs-ai)
    this.engineBlack = null; // Stockfish — black (ai-vs-ai only)
    this.engineReady = false;
    this.engineBusy = false;

    this.remote = null;
    this.remoteGistUrl = null;
    this.remoteState = null;
    this.remoteBusy = false;
    this.claimedSide = null; // remote guest: side this user claims ('w'|'b'|null)
    this.engineSide = null; // remote: side this arena's engine plays ('w'|'b'|null)
    this.humanSide = null; // human-vs-ai: side the user plays
    this.orientation = 'white';
    this.levelIndex = 3; // default level 4
    this.speed = DEFAULT_SPEED;
    this.viewerMode = false; // ai-vs-ai / remote spectator: nobody drags

    this._aiTimer = null;
    this._lastGameHash = '';
  }

  // ------------------------------------------------------------------ public

  start(mode, opts = {}) {
    this.dispose();
    this.mode = mode;
    this._lastOpts = opts;
    this.game = new Chess();
    this.orientation = 'white';
    this.viewerMode = false;
    this.engineBusy = false;

    this.ui.resetMoves();
    this.ui.clearLog();
    this.ui.setEngineInfo('top', '');
    this.ui.setEngineInfo('bottom', '');
    this.ui.setStatus('เตรียมพร้อม…', '');

    switch (mode) {
      case MODES.HUMAN_VS_AI:
        this._startHumanVsAi(opts);
        break;
      case MODES.AI_VS_AI:
        this._startAiVsAi(opts);
        break;
      case MODES.REMOTE:
        this._startRemote(opts);
        break;
      case MODES.ANALYZE:
        this._startAnalyze();
        break;
    }
  }

  /** User dragged a piece. */
  async handleUserMove(orig, dest) {
    if (this.engineBusy || this.viewerMode) return;
    if (this.remote && !this._remoteHumanTurn()) return;

    const legal = this.game.moves({ square: orig, verbose: true }).some((m) => m.to === dest);
    if (!legal) return;

    let promotion = null;
    const piece = this.game.get(orig);
    const toRow = dest.charCodeAt(1) - 48; // 1..8
    if (piece && piece.type === 'p' && (toRow === 8 || toRow === 1)) {
      promotion = await this.onPromotion(orig, dest);
      if (!promotion) return; // cancelled
    }

    const move = this.game.move({ from: orig, to: dest, promotion });
    if (!move) return;

    this.ui.log(`${move.color === 'w' ? 'ขาว' : 'ดำ'} เดิน ${move.san}`, 'move');
    this._afterMove(move, { publish: this.mode === MODES.REMOTE });
  }

  async undo() {
    if (this.engineBusy) return;
    if (this.mode === MODES.HUMAN_VS_AI || this.mode === MODES.ANALYZE) {
      if (this.game.history().length === 0) {
        this.ui.log('ยังไม่มีการเดิน', 'warn');
        return;
      }
      this.game.undo();
      if (this.mode === MODES.HUMAN_VS_AI) this.game.undo(); // take back engine reply too
      if (this.engine) this.engine.setPosition(this.game.fen());
      this._syncBoard();
      this.ui.log('ย้อนการเดินแล้ว', 'sys');
      this._renderMoves();
      if (this._isOver()) return;
      if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
        this._engineTurn();
      }
    } else {
      this.ui.log('โหมดนี้ไม่รองรับการย้อนเดิน', 'warn');
    }
  }

  newGame() {
    const mode = this.mode;
    const opts = this._lastOpts ?? {};
    this.start(mode, opts);
  }

  flip() {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.ground.set({ orientation: this.orientation });
    this.ui.log(`กลับกระดาน — ${this.orientation === 'white' ? 'ขาว' : 'ดำ'} อยู่ด้านล่าง`, 'sys');
  }

  setLevel(level) {
    this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, level - 1));
  }

  setSpeed(speed) {
    if (SPEEDS[speed]) this.speed = speed;
  }

  dispose() {
    if (this.engine) { this.engine.quit(); this.engine = null; }
    if (this.engineBlack) { this.engineBlack.quit(); this.engineBlack = null; }
    if (this.remote) { this.remote.stop(); this.remote = null; }
    this.engineReady = false;
    this.engineBusy = false;
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
  }

  // ------------------------------------------------------------------ modes

  _startHumanVsAi({ color = 'random', level = 4 } = {}) {
    this.setLevel(level);
    this.humanSide = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    this.orientation = this.humanSide === 'w' ? 'white' : 'black';
    const engineSide = this.humanSide === 'w' ? 'b' : 'w';
    const cfg = LEVELS[this.levelIndex];

    this.ui.setPlayers(
      { name: `${ENGINE_NAME} (ฝ่าย${engineSide === 'w' ? 'ขาว' : 'ดำ'})` },
      { name: `${HUMAN_NAME} (ฝ่าย${this.humanSide === 'w' ? 'ขาว' : 'ดำ'})` }
    );
    this.ui.setStatus(`ระดับ ${cfg.level}/8 · เริ่มเกม`, '');

    this.engine = new Stockfish({
      onReady: () => {
        this.engineReady = true;
        this.engine.setOption('Skill Level', cfg.skill);
        this.engine.setOption('Hash', 16);
        this.engine.setPosition(this.game.fen());
        this.ui.log(`เอนจินพร้อม (${ENGINE_NAME})`, 'sys');
        if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
          this._engineTurn();
        }
      },
      onInfo: (info) => this._engineInfo(info),
      onBestMove: (uci) => this._onEngineBestMove(uci),
      onError: (msg) => this.ui.log(`เอนจินผิดพลาด: ${msg}`, 'err'),
    });
    this._syncBoard();
    this._renderMoves();
  }

  _startAiVsAi({ speed = DEFAULT_SPEED } = {}) {
    this.setSpeed(speed);
    this.viewerMode = true;
    this.ui.setPlayers(
      { name: `${ENGINE_NAME} (ฝ่ายดำ)` },
      { name: `${ENGINE_NAME} (ฝ่ายขาว)` }
    );
    this.ui.setStatus(`AI vs AI · ความเร็ว: ${SPEEDS[speed].label}`, '');

    const mk = (color) =>
      new Stockfish({
        onReady: () => {
          this.engineReady = true;
          this.engine.setOption('Skill Level', 20);
          this.engine.setOption('Hash', 16);
          if (color === 'b' && this.engineBlack) {
            this.engineBlack.setOption('Skill Level', 20);
            this.engineBlack.setOption('Hash', 16);
          }
          this._maybeStartAiLoop();
        },
        onInfo: (info) => {
          if (color === 'w') this._engineInfo(info, 'bottom');
          else this._engineInfo(info, 'top');
        },
        onBestMove: (uci) => this._onAiLoopMove(color, uci),
        onError: (msg) => this.ui.log(`เอนจิน${color === 'w' ? 'ขาว' : 'ดำ'}ผิดพลาด: ${msg}`, 'err'),
      });

    this.engine = mk('w');
    this.engineBlack = mk('b');
    this._syncBoard();
    this._renderMoves();
  }

  _startAnalyze() {
    this.ui.setPlayers(
      { name: 'ฝ่ายดำ (มือคุณ)' },
      { name: 'ฝ่ายขาว (มือคุณ)' }
    );
    this.ui.setStatus('โหมดวิเคราะห์ — เล่นได้ทั้งสองสี', '');
    this._syncBoard();
    this._renderMoves();
  }

  async _startRemote({ action = 'create', gistId = '', token = '', engineColor = 'random', title = 'การประลอง AI' } = {}) {
    if (action === 'create') {
      this.engineSide = engineColor === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : engineColor;
      const { gistId: id, url } = await createRoom({
        token,
        title,
        white: {
          name: ENGINE_NAME,
          kind: 'engine',
          source: `stockfish 18 lite single (chess arena)`,
        },
        black: {
          name: GUEST_NAME,
          kind: 'agent',
          source: 'external ai agent',
        },
      });
      gistId = id;
      this.remoteGistUrl = url;
      this.ui.log(`สร้างห้องแล้ว: ${url}`, 'sys');
    } else {
      this.engineSide = null; // guest/spectator: engine stays idle unless side claimed
    }

    this.viewerMode = true;
    const state = await this._openRemote(token, gistId);
    this.ui.setPlayers(
      { name: `${state.black?.name ?? 'ฝ่ายดำ'}` },
      { name: `${state.white?.name ?? 'ฝ่ายขาว'}` }
    );
    this.ui.setStatus(
      this.engineSide
        ? `เอนจินสนามเล่นฝ่าย${this.engineSide === 'w' ? 'ขาว' : 'ดำ'} · รอคู่แข่ง AI เข้ามา…`
        : 'โหมดผู้ชม/ร่วมเล่น · กำลังซิงก์…',
      ''
    );
    this.ui.log(
      this.engineSide
        ? `รอการเดินจากฝ่าย${this.engineSide === 'w' ? 'ดำ' : 'ขาว'} (คู่แข่ง AI)…`
        : 'รอ state จากห้อง…',
      'sys'
    );
    if (this.engineSide) {
      this.engine = new Stockfish({
        onReady: () => {
          this.engineReady = true;
          this.engine.setOption('Skill Level', 20);
          this.engine.setOption('Hash', 16);
          this.engine.setPosition(this.game.fen());
          this.ui.log('เอนจินสนามพร้อม', 'sys');
          this._remoteMaybeEngineTurn();
        },
        onInfo: (info) => this._engineInfo(info, this.engineSide === 'w' ? 'bottom' : 'top'),
        onBestMove: (uci) => this._onRemoteEngineMove(uci),
        onError: (msg) => this.ui.log(`เอนจินผิดพลาด: ${msg}`, 'err'),
      });
    }
    this._syncBoard();
    this._renderMoves();
  }

  // ------------------------------------------------------------------ helpers

  _engineInfo(info, side) {
    const score = info.score !== undefined ? (typeof info.score === 'string' ? info.score : info.score.toFixed(2)) : '?';
    const pv = info.pv?.slice(0, 3).join(' ') ?? '';
    this.ui.setEngineInfo(side ?? (this.mode === MODES.HUMAN_VS_AI ? 'top' : 'bottom'), `depth ${info.depth ?? '?'} · ${score} ${pv}`);
  }

  _renderMoves() {
    this.ui.renderMoves(this.game.history());
  }

  _syncBoard() {
    const turn = this.game.turn();
    // chess.js uses 'w'/'b'; chessground expects 'white'/'black'.
    const cgTurn = turn === 'w' ? 'white' : 'black';
    const inCheck = this.game.inCheck();
    let checkSq = null;
    if (inCheck) {
      outer: for (const row of this.game.board()) {
        for (const sq of row) {
          if (sq && sq.type === 'k' && sq.color === turn) {
            checkSq = sq.square;
            break outer;
          }
        }
      }
    }
    const hist = this.game.history({ verbose: true });
    const last = hist.length ? hist[hist.length - 1] : null;

    const humanCanMove =
      !this.viewerMode &&
      this.mode !== MODES.AI_VS_AI &&
      (this.mode === MODES.ANALYZE ||
        (this.mode === MODES.HUMAN_VS_AI && turn === this.humanSide) ||
        (this.mode === MODES.REMOTE && this._remoteHumanTurn()));

    this.ground.set({
      fen: this.game.fen(),
      orientation: this.orientation,
      turnColor: cgTurn,
      check: checkSq,
      lastMove: last ? [last.from, last.to] : undefined,
      movable: {
        color: humanCanMove ? cgTurn : false,
        dests: humanCanMove ? this._dests() : new Map(),
      },
      viewOnly: !humanCanMove && !(this.mode === MODES.ANALYZE && !this._isOver()),
    });
    this._updateStatus();
  }

  _dests() {
    const dests = new Map();
    for (const m of this.game.moves({ verbose: true })) {
      const list = dests.get(m.from);
      if (list) {
        if (!list.includes(m.to)) list.push(m.to);
      } else {
        dests.set(m.from, [m.to]);
      }
    }
    return dests;
  }

  _isOver() {
    return this.game.isGameOver();
  }

  _resultCode() {
    if (this.game.isCheckmate()) return this.game.turn() === 'w' ? '0-1' : '1-0';
    return '1/2-1/2';
  }

  _updateStatus() {
    if (this._isOver()) {
      const code = this._resultCode();
      const text = this.game.isCheckmate()
        ? `หมากรุก! ${RESULT_TEXT[code]}`
        : this.game.isStalemate()
          ? 'ผลเสมอ — ทางตัน (stalemate)'
          : this.game.isInsufficientMaterial()
            ? 'ผลเสมอ — หมากไม่พอชนะ'
            : this.game.isThreefoldRepetition()
              ? 'ผลเสมอ — เดินซ้ำสามครั้ง'
              : this.game.isDraw()
                ? 'ผลเสมอ — ตามกติกา'
                : RESULT_TEXT[code];
      this.ui.setStatus(`จบเกม · ${text} (${code})`, 'done');
      this.ui.setPlayerDone(this.game.turn() === 'w' ? 'top' : 'bottom');
      this.ui.setPlayerActive(this.game.turn() === 'w' ? 'top' : 'bottom', false);
      this.ui.log(`จบเกม: ${text}`, 'sys');
      if (this.mode === MODES.AI_VS_AI) {
        this._stopAiLoop();
      }
      return;
    }
    const turn = this.game.turn();
    const who = turn === 'w' ? 'ขาว' : 'ดำ';
    const side = turn === 'w' ? 'bottom' : 'top';
    this.ui.setPlayerActive(side, true);
    this.ui.setPlayerActive(side === 'top' ? 'bottom' : 'top', false);
    if (this.engineBusy && this.mode !== MODES.REMOTE) {
      this.ui.setStatus(`ฝ่าย${who}กำลังคิด…`, 'think');
    } else if (this.mode === MODES.REMOTE && this.remoteBusy) {
      this.ui.setStatus('กำลังรอการเดินจากคู่แข่ง…', 'wait');
    } else {
      const hint =
        this.mode === MODES.AI_VS_AI
          ? ''
          : this.mode === MODES.REMOTE && !this._remoteHumanTurn()
            ? 'รอคู่แข่ง'
            : 'ถึงตาฝ่าย' + who;
      this.ui.setStatus(`${this.mode === MODES.ANALYZE ? 'วิเคราะห์' : 'กำลังเล่น'} · ${hint || 'ถึงตาฝ่าย' + who}`, 'turn');
    }
  }

  // ------------------------------------------------------------------ after move

  _afterMove(move, { publish = false } = {}) {
    this._renderMoves();
    this._syncBoard();
    if (this._isOver()) {
      if (this.mode === MODES.AI_VS_AI) this._stopAiLoop();
      return;
    }
    if (publish && this.mode === MODES.REMOTE && this.remote) {
      this._remotePublishMove(move);
    }
    // Hand off to the engine when it is its turn.
    if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
      this._engineTurn();
    }
  }

  // ------------------------------------------------------------------ engine (human-vs-ai)

  _engineTurn() {
    if (!this.engineReady || this.engineBusy || this._isOver()) return;
    const cfg = LEVELS[this.levelIndex];
    this.engineBusy = true;
    this.ui.setStatus('เอนจินกำลังคิด…', 'think');
    this.ui.log(`เอนจินกำลังคิด (ระดับ ${cfg.level}/8)…`, 'sys');
    this.engine.setPosition(this.game.fen());
    this.engine.go({ depth: cfg.depth, movetime: cfg.movetime });
  }

  _onEngineBestMove(uci) {
    if (this.mode !== MODES.HUMAN_VS_AI || this.engineBusy === false) return;
    this.engineBusy = false;
    if (!uci) {
      this.ui.setStatus('เอนจินไม่มีการเดิน — จบ', 'done');
      return;
    }
    const move = this._applyUci(uci);
    if (!move) {
      this.ui.log(`เอนจินส่งการเดินไม่ถูกต้อง: ${uci}`, 'err');
      return;
    }
    this.ui.log(`เอนจินตอบ: ${move.san}`, 'engine');
    this._afterMove(move);
  }

  // ------------------------------------------------------------------ engine (ai-vs-ai)

  _maybeStartAiLoop() {
    if (!this.engineReady || this.mode !== MODES.AI_VS_AI) return;
    if (this.engineBusy) return;
    const side = this.game.turn();
    const eng = side === 'w' ? this.engine : this.engineBlack;
    if (!eng) return;
    this.engineBusy = true;
    const mv = SPEEDS[this.speed].movetime;
    this.ui.setStatus(`AI ${side === 'w' ? 'ขาว' : 'ดำ'} กำลังคิด…`, 'think');
    eng.setPosition(this.game.fen());
    eng.go({ movetime: mv });
  }

  _onAiLoopMove(color, uci) {
    if (this.mode !== MODES.AI_VS_AI) return;
    if (this.game.turn() !== color) {
      // stale bestmove from a previous position — ignore
      return;
    }
    this.engineBusy = false;
    if (!uci) {
      this._stopAiLoop();
      return;
    }
    const move = this._applyUci(uci);
    if (!move) {
      this.ui.log(`AI ${color === 'w' ? 'ขาว' : 'ดำ'} เดินไม่ถูกต้อง: ${uci}`, 'err');
      this._stopAiLoop();
      return;
    }
    this.ui.log(`AI ${color === 'w' ? 'ขาว' : 'ดำ'}: ${move.san}`, 'engine');
    this._afterMove(move);
    if (this._isOver()) return;
    this._aiTimer = setTimeout(() => this._maybeStartAiLoop(), 350);
  }

  _stopAiLoop() {
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
    this.engineBusy = false;
  }

  // ------------------------------------------------------------------ shared engine move application

  _applyUci(uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    try {
      return this.game.move({ from, to, promotion });
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ remote

  _remoteHumanTurn() {
    if (!this.remote) return false;
    const state = this.remoteState;
    if (!state || state.status !== 'active') return false;
    // Human plays a side only if the arena engine is not on that side.
    const side = this.game.turn();
    if (this.engineSide === side) return false;
    if (this.claimedSide && this.claimedSide !== side) return false;
    return true;
  }

  async _openRemote(token, gistId) {
    this.remote = new RemoteChannel({
      token,
      gistId,
      onState: (state) => this._remoteOnState(state),
      onError: (msg) => {
        this.ui.log(`Remote: ${msg}`, 'err');
        this.ui.setStatus('Remote: สัญญาณผิดพลาด', 'err');
      },
    });
    const state = await this.remote.fetchState();
    this._remoteApplyState(state);
    this.remote.start();
    return state;
  }

  _remoteApplyState(state) {
    if (!state || state.protocol !== 'chess-arena-battle') {
      this.ui.log('ห้องนี้ไม่ใช่ห้องประลองของ Chess Arena', 'err');
      return;
    }
    this.remoteState = state;
    const fen = state.fen;
    const localFen = this.game.fen();
    if (fen !== localFen) {
      // Rebuild from recorded move list to keep SAN history consistent.
      try {
        const fresh = new Chess();
        for (const uci of state.moves ?? []) {
          const m = fresh.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
          if (!m) throw new Error(`bad move ${uci}`);
        }
        this.game = fresh;
      } catch {
        this.game = new Chess(fen);
      }
      this.ui.setPlayers(
        { name: state.black?.name ?? 'ฝ่ายดำ' },
        { name: state.white?.name ?? 'ฝ่ายขาว' }
      );
      this._renderMoves();
      this._syncBoard();
      this.ui.log(
        `ซิงก์จากห้อง: ${state.moves?.length ?? 0} ท่า · ${state.turn === 'w' ? 'ขาว' : 'ดำ'}รอเดิน`,
        'sys'
      );
    }
  }

  _remoteOnState(state) {
    if (!this.remote || this.remoteBusy) return;
    const before = `${this.remoteState?.fen}|${this.remoteState?.updatedAt}`;
    this._remoteApplyState(state);
    const after = `${this.remoteState?.fen}|${this.remoteState?.updatedAt}`;
    if (before !== after) {
      this.ui.setStatus(this.remoteState.status === 'finished' ? 'จบเกมแล้วในห้อง' : 'คู่แข่งเดินแล้ว — อัปเดต', 'wait');
    }
    this._remoteMaybeEngineTurn();
  }

  _remoteMaybeEngineTurn() {
    if (!this.engineReady || !this.remote || this.engineBusy || this.remoteBusy) return;
    const state = this.remoteState;
    if (!state || state.status !== 'active') return;
    if (this.engineSide && state.turn === this.engineSide) {
      this.remoteBusy = true;
      this.ui.setStatus('เอนจินสนามกำลังคิด…', 'think');
      this.engine.setPosition(this.game.fen());
      this.engine.go({ movetime: 900 });
    }
  }

  async _onRemoteEngineMove(uci) {
    if (this.mode !== MODES.REMOTE || !this.remote) return;
    this.remoteBusy = false;
    if (!uci) {
      this.ui.log('เอนจินไม่มีการเดิน', 'err');
      return;
    }
    const move = this._applyUci(uci);
    if (!move) {
      this.ui.log(`เอนจินสนามเดินไม่ถูกต้อง: ${uci}`, 'err');
      return;
    }
    this.ui.log(`เอนจินสนาม: ${move.san}`, 'engine');
    this._afterMove(move, { publish: true });
  }

  async _remotePublishMove(move) {
    if (!this.remote) return;
    const uci = move.from + move.to + (move.promotion ?? '');
    try {
      const over = this._isOver();
      await this.remote.updateState((s) => {
        const next = {
          ...s,
          fen: this.game.fen(),
          turn: this.game.turn(),
          lastMove: uci,
          lastMoveSan: move.san,
          moves: [...(s.moves ?? []), uci],
          status: over ? 'finished' : 'active',
          result: over ? this._resultCode() : s.result,
        };
        return next;
      });
      this.ui.log(`ส่งการเดิน ${move.san} ไปยังห้องแล้ว`, 'sys');
    } catch (err) {
      this.ui.log(`ส่งการเดินล้มเหลว: ${err.message}`, 'err');
    }
  }
}
