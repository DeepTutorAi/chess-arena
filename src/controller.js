// Controller layer — single state machine managing game modes, clock, engine
// worker, and board sync.

import { Chess } from 'chess.js';
import { Stockfish } from './engine.js';
import { createRoom, RemoteChannel } from './remote.js';
import { ChessClock } from './clock.js';
import { sounds } from './sounds.js';
import {
  ENGINE_NAME,
  HUMAN_NAME,
  GUEST_NAME,
  LEVELS,
  REMOTE_POLL_MS,
  TIME_CONTROLS,
  DEFAULT_TIME_CONTROL,
  GITHUB_TOKEN_KEY,
  ENGINE_HINT_URL,
  saveRoom,
} from './config.js';

export const MODES = {
  HUMAN_VS_AI: 'hva',
  AI_VS_AI: 'aiva',
  REMOTE: 'remote',
  ANALYZE: 'analyze',
};

export class Controller {
  constructor({ ui, ground, onPromotion }) {
    this.ui = ui;
    this.ground = ground;
    this.onPromotion = onPromotion;

    this.game = new Chess();
    this.mode = null;
    this.engine = null;
    this.engineBlack = null;
    this.remote = null;
    this.clock = null;

    this.engineReady = false;
    this.engineBusy = false;
    this.viewerMode = false;
    this.paused = false;
    this.hintEngine = null;   // GM-level engine for the hint button (hva only)
    this.hintBusy = false;
    this.orientation = 'white';
    this.levelIndex = 3; // level 4
    this.humanSide = 'w';
    this.engineSide = 'b';
    this.remoteGistUrl = null;
    this.timeControlId = DEFAULT_TIME_CONTROL;

    this._isTimeout = false;
    this._timeoutLoser = null;
    this._aiTimer = null;
    this._lastOpts = null;
    this._overPopupShown = false;

    // Interactive Sandbox Board Setup State
    this.sandboxSetup = false;
    this.sandboxTool = 'move';       // 'move' | 'replace'
    this.sandboxPiece = 'q';         // 'q' | 'r' | 'b' | 'n' | 'p' | 'delete'
    this.sandboxTargetMode = null;   // null (Solo) | 'hva' | 'aiva' | 'remote'
    this.sandboxSelectedLevel = 4;   // default Elo 1400
    this.sandboxSelectedTc = DEFAULT_TIME_CONTROL;
    this.sandboxSelectedColor = 'random'; // creator side: 'random' | 'w' | 'b'
    this.sandboxAivaLevelW = 6;      // AI vs AI: white engine level (Elo 1800)
    this.sandboxAivaLevelB = 3;      // AI vs AI: black engine level (Elo 1200)
  }

  // ------------------------------------------------------------------ start & reset

  async start(mode, opts = {}) {
    this.dispose();
    this.mode = mode;
    this._lastOpts = { ...opts };
    this._overPopupShown = false;
    this._isTimeout = false;
    this._timeoutLoser = null;

    const initialFen = opts.initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    try {
      this.game = new Chess(initialFen);
    } catch {
      this.game = new Chess(); // fallback to standard
    }

    this.ui.clearLog();
    this.ui.resetMoves();
    this.ui.setEngineInfo('top', '');
    this.ui.setEngineInfo('bottom', '');

    this.timeControlId = opts.timeControlId ?? DEFAULT_TIME_CONTROL;
    const tcConfig = TIME_CONTROLS.find((t) => t.id === this.timeControlId) ?? TIME_CONTROLS[0];
    this._initClock(tcConfig);
    // The clock was never started anywhere, so time controls never ticked.
    this.clock?.start(this.game.turn());

    if (mode === MODES.HUMAN_VS_AI) {
      this.ui.showGameView();
      this._startHumanVsAi(opts);
    } else if (mode === MODES.AI_VS_AI) {
      this.ui.showGameView();
      this._startAiVsAi(opts);
    } else if (mode === MODES.REMOTE) {
      await this._startRemote(opts);
      this.ui.showGameView();
    } else {
      if (opts.sandboxSetup) {
        this.startSandboxSetup(opts);
      } else {
        this.ui.showGameView();
        this._startAnalyze();
      }
    }

    // A custom board may already be checkmate/stalemate before the first move
    // — announce it instead of freezing with no moves.
    if (this._isOver()) this._announceGameOver();
  }

  // ---- Interactive Sandbox Board Setup -----------------------------------

  startSandboxSetup({ initialFen } = {}) {
    // Leave any previous game fully behind (engines, remote polling, clock,
    // viewer lock, game-over flags) so stale state can't corrupt the editor.
    this.dispose();
    this._overPopupShown = false;
    this._isTimeout = false;
    this._timeoutLoser = null;
    this.ui.clearLog();
    this.ui.resetMoves();
    this.ui.setEngineInfo('top', '');
    this.ui.setEngineInfo('bottom', '');

    this.sandboxSetup = true;
    this.sandboxTool = 'move';
    this.sandboxPiece = 'q';
    this.sandboxTargetMode = null; // Default: Solo Play
    this.viewerMode = false;
    this.paused = false;
    this.ui.resetSandboxPanel?.();
    this.ui.setActionStrip?.({ undo: false, resign: false, flip: false, pause: false });

    const fen = initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    try {
      this.game = new Chess(fen);
    } catch {
      this.game = new Chess();
    }

    this.ui.setPlayers(
      { name: 'ฝ่ายดำ (ปรับแต่งสนาม)' },
      { name: 'ฝ่ายขาว (ปรับแต่งสนาม)' }
    );
    this.ui.setStatus('🛠️ Sandbox Setup — จัดแต่งหมากและเลือกโหมดการเล่น', '');
    this.ui.log('เข้าสู่โหมด Sandbox Setup — เลือกโหมดแถบซ้ายมือ และเลือกหมากแถบขวามือ', 'sys');

    // Show the view first so the board is laid out before the first sync —
    // syncing while hidden leaves chessground with 0x0 bounds cached.
    this.ui.showGameView({ sandboxMode: true });
    this._syncBoard();
  }

  setSandboxTool(tool) {
    this.sandboxTool = tool;
    this._syncBoard();
  }

  async handleSandboxMove(orig, dest) {
    if (!this.sandboxSetup || this.sandboxTool !== 'move') return;

    const targetPiece = this.game.get(orig);
    if (!targetPiece) return;
    const destPiece = this.game.get(dest);

    // Rule: only the King is restricted to its 2 starting ranks (1-2 for
    // White, 7-8 for Black). Other pieces may be rearranged anywhere.
    // Kings are also never removed or replaced: landing on a King is blocked.
    const movingKing = targetPiece.type === 'k';
    const landingOnKing = destPiece && destPiece.type === 'k';
    if (movingKing || landingOnKing) {
      const kingColor = movingKing ? targetPiece.color : destPiece.color;
      const destRank = parseInt(dest[1], 10);
      const validRank =
        kingColor === 'w' ? destRank === 1 || destRank === 2 : destRank === 7 || destRank === 8;
      if (landingOnKing || !validRank) {
        // Pawn onto a King on the last rank: point the user to the real cause.
        const destRank = parseInt(dest[1], 10);
        const pawnToLastRank = targetPiece.type === 'p' && (destRank === 8 || destRank === 1);
        this.ui.log(
          landingOnKing && pawnToLastRank
            ? `ช่อง ${dest} มี King อยู่ — ย้าย King ออกก่อน เพื่อโปรโมทเบี้ยที่ช่องนี้`
            : landingOnKing
              ? 'ไม่สามารถวางหมากทับตัว King ได้'
              : `King ฝ่าย${kingColor === 'w' ? 'ขาว' : 'ดำ'} ย้ายได้เฉพาะแถว ${kingColor === 'w' ? '1-2' : '7-8'} เท่านั้น`,
          'warn'
        );
        this._syncBoard();
        return;
      }
    }

    let pieceType = targetPiece.type;

    // Pawn reaching the opponent's last rank -> choose the promotion piece
    // (same picker as normal games). Cancelling keeps the board unchanged.
    const destRank = parseInt(dest[1], 10);
    if (targetPiece.type === 'p' && (destRank === 8 || destRank === 1)) {
      this.ui.log('โปรโมทเบี้ย — เลือกตัวหมากที่จะแปลงเป็น', 'sys');
      const promotion = await this.onPromotion(orig, dest);
      if (!promotion) return;
      pieceType = promotion;
    }

    // Apply board change cleanly in chess.js
    this.game.remove(orig);
    this.game.put({ type: pieceType, color: targetPiece.color }, dest);
    this._syncBoard();
    this.ui.log(
      pieceType === targetPiece.type
        ? `ย้ายหมาก ${targetPiece.type.toUpperCase()} (${targetPiece.color === 'w' ? 'ขาว' : 'ดำ'}) ไปที่ ${dest}`
        : `โปรโมทเบี้ยเป็น ${pieceType.toUpperCase()} (${targetPiece.color === 'w' ? 'ขาว' : 'ดำ'}) ที่ ${dest}`,
      'sys'
    );
  }

  handleSandboxSquareClick(square) {
    if (!this.sandboxSetup || this.sandboxTool !== 'replace') return;

    const current = this.game.get(square);
    const rank = parseInt(square[1], 10);

    // Rule: King Protection (King cannot be deleted or replaced by other piece types)
    if (current && current.type === 'k') {
      this.ui.log('ไม่สามารถลบหรือเอาหมากชนิดอื่นมาแทนตัว King ได้', 'warn');
      return;
    }

    if (this.sandboxPiece === 'delete') {
      if (!current) return;
      this.game.remove(square);
      this._syncBoard();
      this.ui.log(`ลบหมากที่ ${square}`, 'sys');
      return;
    }

    // Determine color based on rank (1-2 White, 7-8 Black)
    const color = rank >= 7 ? 'b' : 'w';
    const isValidRank = color === 'w' ? (rank === 1 || rank === 2) : (rank === 7 || rank === 8);

    if (!isValidRank) {
      this.ui.log(`วางหมากฝ่าย${color === 'w' ? 'ขาว' : 'ดำ'} ได้เฉพาะแถว ${color === 'w' ? '1-2' : '7-8'} เท่านั้น`, 'warn');
      return;
    }

    // Pawns cannot sit on the edge rows (would make the board invalid) —
    // use the move tool to promote instead.
    if (this.sandboxPiece === 'p' && (rank === 1 || rank === 8)) {
      this.ui.log('วางเบี้ยบนแถว 1/8 ไม่ได้ — ใช้โหมด "ย้ายตำแหน่ง" เพื่อโปรโมทเบี้ย', 'warn');
      return;
    }

    this.game.put({ type: this.sandboxPiece, color }, square);
    this._syncBoard();
    this.ui.log(`วาง ${this.sandboxPiece.toUpperCase()} (${color === 'w' ? 'ขาว' : 'ดำ'}) ที่ ${square}`, 'sys');
  }

  async startSandboxGame() {
    // Generate valid FEN string for chess.js game loop
    const rawFenParts = this.game.fen().split(' ');
    // Ensure valid turn ('w') and reset invalid castling flags if pieces were rearranged
    const cleanFen = `${rawFenParts[0]} w - - 0 1`;
    const targetMode = this.sandboxTargetMode;
    const timeControlId = this.sandboxSelectedTc;

    // Guard: chess.js rejects FENs without both kings (and pawns on edge rows);
    // start() would silently fall back to the standard board — wiping the
    // custom setup. Surface the real reason instead.
    try {
      new Chess(cleanFen);
    } catch (err) {
      const msg = err.message ?? '';
      const hint = /king/i.test(msg) ? ' — ต้องมี King ครบทั้งสองฝ่าย' : ' — กระดานนี้ไม่ถูกต้องตามกฎหมากรุก';
      this.ui.log(`กระดานยังไม่ถูกต้อง: ${msg}${hint}`, 'err');
      return;
    }

    // chess.js also accepts illegal positions where the side NOT to move is in
    // check; Stockfish then refuses to move (bestmove (none)) and every AI mode
    // stalls. Reject those up front with a clear message.
    const fenParts = cleanFen.split(' ');
    const otherTurn = fenParts[1] === 'w' ? 'b' : 'w';
    try {
      const other = new Chess(`${fenParts[0]} ${otherTurn} ${fenParts[2]} ${fenParts[3]} ${fenParts[4]} ${fenParts[5]}`);
      if (other.inCheck()) {
        this.ui.log(
          'กระดานยังไม่ถูกต้อง: ฝ่ายที่ยังไม่ได้เดินกำลังถูก Check — สลับฝ่ายที่เดินหรือแก้กระดานก่อนเริ่มเกม',
          'err'
        );
        return;
      }
    } catch {
      // king-less FEN already caught above; ignore
    }

    // Remote rooms need a room token — fail early and stay in the editor.
    if (targetMode === MODES.REMOTE && !(localStorage.getItem(GITHUB_TOKEN_KEY) ?? '')) {
      this.ui.log('สร้างห้องออนไลน์ต้องใส่ GitHub Token (scope gist) ในช่อง Token ด้านซ้ายก่อน', 'err');
      return;
    }

    this.sandboxSetup = false;
    this.ui.showGameView({ sandboxMode: false });

    try {
      if (targetMode === MODES.HUMAN_VS_AI) {
        await this.start(MODES.HUMAN_VS_AI, {
          color: this.sandboxSelectedColor ?? 'w',
          level: this.sandboxSelectedLevel,
          timeControlId,
          initialFen: cleanFen,
        });
      } else if (targetMode === MODES.AI_VS_AI) {
        await this.start(MODES.AI_VS_AI, {
          levelWhite: this.sandboxAivaLevelW,
          levelBlack: this.sandboxAivaLevelB,
          timeControlId,
          initialFen: cleanFen,
        });
      } else if (targetMode === MODES.REMOTE) {
        await this.start(MODES.REMOTE, {
          action: 'create',
          title: 'Sandbox Custom Battle',
          engineColor: this.sandboxSelectedColor ?? 'random',
          timeControlId,
          initialFen: cleanFen,
        });
      } else {
        // Default: Solo Analyze mode with custom FEN
        await this.start(MODES.ANALYZE, {
          timeControlId,
          initialFen: cleanFen,
        });
      }
    } catch (err) {
      // Game failed to start (e.g. network) — return to the editor with the
      // custom board intact so the user can retry.
      this.ui.log(`เริ่มเกมล้มเหลว: ${err.message}`, 'err');
      this.startSandboxSetup({ initialFen: cleanFen });
    }
  }

  // ---- Clock Integration ---------------------------------------------------

  _initClock(tcConfig) {
    if (this.clock) {
      this.clock.stop();
      this.clock = null;
    }
    if (tcConfig.category === 'unlimited') {
      this.ui.showClocks(false);
      return;
    }
    this.ui.showClocks(true);
    this.clock = new ChessClock({
      initialMs: tcConfig.initialMs,
      incMs: tcConfig.incMs,
      onTick: (times, currentTurn) => this._onClockTick(times, currentTurn),
      onTimeout: (loser) => this._onClockTimeout(loser),
    });
  }

  _onClockTick(times, currentTurn) {
    const topColor = this.orientation === 'white' ? 'b' : 'w';
    const bottomColor = this.orientation === 'white' ? 'w' : 'b';

    const topMs = times[topColor];
    const bottomMs = times[bottomColor];

    this.ui.setClock('top', ChessClock.formatTime(topMs), currentTurn === topColor, topMs <= 20000);
    this.ui.setClock('bottom', ChessClock.formatTime(bottomMs), currentTurn === bottomColor, bottomMs <= 20000);

    // Low-time warning (cooldown inside the sound manager so it doesn't rattle).
    if (topMs <= 20000 || bottomMs <= 20000) sounds.playLowTime();
  }

  _onClockTimeout(loser) {
    this._isTimeout = true;
    this._timeoutLoser = loser;
    const winnerColor = loser === 'w' ? 'ดำ' : 'ขาว';
    const winnerCode = loser === 'w' ? '0-1' : '1-0';
    const text = `หมดเวลา! ฝ่าย${winnerColor}ชนะ`;
    const detail = `ฝ่าย${loser === 'w' ? 'ขาว' : 'ดำ'}เวลาหมด (${winnerCode})`;

    if (this.engine) this.engine.stop();
    if (this.engineBlack) this.engineBlack.stop();

    this.ui.setStatus(`จบเกม · ${text}`, 'done');
    this.ui.setPlayerDone(loser === 'w' ? 'bottom' : 'top');
    this.ui.log(`จบเกม: ${text} (${detail})`, 'sys');

    if (!this._overPopupShown) {
      this._overPopupShown = true;
      this.ui.showGameOver(
        text,
        detail,
        () => this.newGame(),
        () => this.goHome()
      );
    }

    this._playGameOverSound();
  }

  resign() {
    if (this._isOver() || this._overPopupShown) return;
    const loser = this.humanSide ?? this.game.turn();
    const winnerColor = loser === 'w' ? 'ดำ' : 'ขาว';
    const winnerCode = loser === 'w' ? '0-1' : '1-0';
    const text = `ยอมแพ้! ฝ่าย${winnerColor}ชนะ`;
    const detail = `ฝ่าย${loser === 'w' ? 'ขาว' : 'ดำ'}ยอมแพ้ (${winnerCode})`;

    if (this.engine) this.engine.stop();
    if (this.engineBlack) this.engineBlack.stop();
    this.clock?.stop();

    this.ui.setStatus(`จบเกม · ${text}`, 'done');
    this.ui.log(`จบเกม: ${text} (${detail})`, 'sys');

    if (!this._overPopupShown) {
      this._overPopupShown = true;
      this.ui.showGameOver(
        text,
        detail,
        () => this.newGame(),
        () => this.goHome()
      );
    }

    // The human always loses when resigning.
    sounds.play('lose');
  }

  /** User dragged a piece in game mode. */

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

      // Reset game over locks so checkmate/loss popup re-triggers properly on next end
      this._overPopupShown = false;
      this._isTimeout = false;
      this._timeoutLoser = null;

      this._syncBoard();
      this.ui.log('ย้อนการเดินแล้ว', 'sys');
      this._renderMoves();
      sounds.play('move'); // undo uses the move sound, as requested
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

  setLevel(level) {
    this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, level - 1));
  }

  flip() {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.ground.set({ orientation: this.orientation });
    this.ui.log(`กลับกระดาน — ${this.orientation === 'white' ? 'ขาว' : 'ดำ'} อยู่ด้านล่าง`, 'sys');
  }

  /** Pause / resume an AI vs AI match (stop & continue). */
  togglePause() {
    if (this.mode !== MODES.AI_VS_AI || this._isOver()) return;
    this.paused = !this.paused;
    if (this.paused) {
      // Cancel a pending think and stop any running search; a late bestmove
      // is discarded by _onAiLoopMove while paused.
      if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
      if (this.engine) this.engine.stop();
      if (this.engineBlack) this.engineBlack.stop();
      this.engineBusy = false;
      this.clock?.stop();
      this.ui.setStatus('⏸ หยุดชั่วคราว — กด ▶️ ต่อเพื่อเล่นต่อ', '');
      this.ui.setPauseState(true);
    } else {
      this.clock?.start(this.game.turn());
      this.ui.setPauseState(false);
      this.ui.setStatus(`AI (${this.game.turn() === 'w' ? 'ขาว' : 'ดำ'}) กำลังคิด…`, 'busy');
      this._maybeStartAiLoop();
    }
  }

  dispose() {
    if (this.clock) { this.clock.stop(); this.clock = null; }
    if (this.engine) { this.engine.quit(); this.engine = null; }
    if (this.engineBlack) { this.engineBlack.quit(); this.engineBlack = null; }
    if (this.hintEngine) { this.hintEngine.quit(); this.hintEngine = null; }
    if (this.remote) { this.remote.stop(); this.remote = null; }
    this.engineReady = false;
    this.engineBusy = false;
    this.hintBusy = false;
    // Viewer lock must not leak between modes (aiva -> hva silently blocked
    // every human move otherwise).
    this.viewerMode = false;
    this.paused = false;
    this.sandboxSetup = false;
    this.remoteGistUrl = null;
    this.ground.setShapes([]);
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }
  }

  // ------------------------------------------------------------------ modes

  _startHumanVsAi({ color = 'random', level = 4, initialFen } = {}) {
    this.setLevel(level);
    this.humanSide = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    this.orientation = this.humanSide === 'w' ? 'white' : 'black';
    const engineSide = this.humanSide === 'w' ? 'b' : 'w';
    const cfg = LEVELS[this.levelIndex];

    if (initialFen) {
      try {
        this.game = new Chess(initialFen);
      } catch {
        this.game = new Chess();
      }
    }

    this.ui.setPlayers(
      { name: `${ENGINE_NAME} Elo ${cfg.elo} (ฝ่าย${engineSide === 'w' ? 'ขาว' : 'ดำ'})` },
      { name: `${HUMAN_NAME} (ฝ่าย${this.humanSide === 'w' ? 'ขาว' : 'ดำ'})` }
    );
    this.ui.setStatus(`Stockfish Elo ${cfg.elo} · เริ่มเกม`, '');
    this.ui.setActionStrip({ undo: true, resign: true, flip: false, pause: false, hint: true });

    this.engine = new Stockfish({
      onReady: () => {
        this.engineReady = true;
        if (this.engine) {
          this.engine.setOption('Skill Level', cfg.skill);
          this.engine.setOption('Hash', 16);
          this.engine.setPosition(this.game.fen());
        }
        this.ui.log(`เอนจินพร้อม (${ENGINE_NAME})`, 'sys');
        if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
          this._engineTurn();
        }
      },
      onBestMove: (uci) => this._onEngineBestMove(uci),
      onError: (msg) => this.ui.log(`เอนจินผิดพลาด: ${msg}`, 'err'),
    });
    this._syncBoard();
    this._renderMoves();
  }

  _startAiVsAi({ levelWhite = 6, levelBlack = 3, initialFen } = {}) {
    this.viewerMode = true;
    this.aivaLevelW = Math.max(0, Math.min(LEVELS.length - 1, (levelWhite ?? 6) - 1));
    this.aivaLevelB = Math.max(0, Math.min(LEVELS.length - 1, (levelBlack ?? 3) - 1));
    const cfgW = LEVELS[this.aivaLevelW];
    const cfgB = LEVELS[this.aivaLevelB];

    if (initialFen) {
      try {
        this.game = new Chess(initialFen);
      } catch {
        this.game = new Chess();
      }
    }

    this.ui.setPlayers(
      { name: `${ENGINE_NAME} · Elo ${cfgB.elo} (ฝ่ายดำ)` },
      { name: `${ENGINE_NAME} · Elo ${cfgW.elo} (ฝ่ายขาว)` }
    );
    this.ui.setStatus(`AI vs AI · ขาว Elo ${cfgW.elo} ปะทะ ดำ Elo ${cfgB.elo}`, '');
    this.paused = false;
    this.ui.setPauseState(false);
    // AI vs AI: flip to watch the other side + pause/resume; no resign/undo.
    this.ui.setActionStrip({ undo: false, resign: false, flip: true, pause: true });

    let readyCount = 0;

    const onWorkerReady = (color) => {
      readyCount++;
      if (color === 'w' && this.engine) {
        this.engine.setOption('Skill Level', cfgW.skill);
        this.engine.setOption('Hash', 16);
      }
      if (color === 'b' && this.engineBlack) {
        this.engineBlack.setOption('Skill Level', cfgB.skill);
        this.engineBlack.setOption('Hash', 16);
      }
      if (readyCount >= 2) {
        this.engineReady = true;
        this._maybeStartAiLoop();
      }
    };

    this.engine = new Stockfish({
      onReady: () => onWorkerReady('w'),
      onBestMove: (uci) => this._onAiLoopMove('w', uci),
      onError: (msg) => this.ui.log(`เอนจินขาวผิดพลาด: ${msg}`, 'err'),
    });

    this.engineBlack = new Stockfish({
      onReady: () => onWorkerReady('b'),
      onBestMove: (uci) => this._onAiLoopMove('b', uci),
      onError: (msg) => this.ui.log(`เอนจินดำผิดพลาด: ${msg}`, 'err'),
    });

    this._syncBoard();
    this._renderMoves();
  }

  _startAnalyze() {
    this.ui.setPlayers(
      { name: 'ฝ่ายดำ (มือคุณ)' },
      { name: 'ฝ่ายขาว (มือคุณ)' }
    );
    this.ui.setStatus('โหมด Sandbox — เล่นได้ทั้งสองสี', '');
    this.ui.setActionStrip({ undo: true, resign: true, flip: false, pause: false });
    this._syncBoard();
    this._renderMoves();
  }

  async _startRemote({ action = 'create', gistId = '', token, engineColor = 'random', title = 'การประลอง AI', initialFen } = {}) {
    if (initialFen) {
      try {
        this.game = new Chess(initialFen);
      } catch {
        this.game = new Chess();
      }
    }

    // Token lives in localStorage (entered once in the UI); falls back for
    // URL auto-joins and sandbox mode.
    const githubToken = token ?? localStorage.getItem(GITHUB_TOKEN_KEY) ?? '';

    if (action === 'create' && !githubToken) {
      this.mode = null;
      this.engineSide = null;
      throw new Error('กรุณาใส่ GitHub Token (scope gist) ก่อนสร้างห้อง — ดูช่อง Token ในหน้าต่างสร้างห้อง');
    }

    if (action === 'create') {
      this.engineSide = engineColor === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : engineColor;
      const engineWhite = this.engineSide !== 'b';
      let created;
      try {
        created = await createRoom({
          token: githubToken,
          title,
          arenaSide: this.engineSide,
          initialFen,
          white: engineWhite
            ? { name: ENGINE_NAME, kind: 'engine', source: 'stockfish 18 lite single (chess arena)' }
            : { name: GUEST_NAME, kind: 'agent' },
          black: engineWhite
            ? { name: GUEST_NAME, kind: 'agent' }
            : { name: ENGINE_NAME, kind: 'engine', source: 'stockfish 18 lite single (chess arena)' },
        });
      } catch (err) {
        // Leave no half-started remote state behind on failure.
        this.remoteGistUrl = null;
        this.mode = null;
        this.engineSide = null;
        throw err;
      }
      this.remoteGistUrl = created.url;
      gistId = created.gistId;

      saveRoom({
        id: gistId,
        gistId,
        title,
        hostName: HUMAN_NAME,
        createdAt: Date.now(),
        status: 'WAITING',
      });
    } else {
      // Joining: the engine side comes from the room state (arenaSide).
      this.engineSide = null;
    }

    this.remote = new RemoteChannel({
      gistId,
      token: githubToken,
      pollMs: REMOTE_POLL_MS,
      onState: (state) => this._onRemoteState(state),
      onError: (msg) => this.ui.log(`Remote: ${msg}`, 'err'),
    });

    this.ui.setStatus('กำลังเชื่อมต่อห้อง Remote…', '');
    this.ui.setActionStrip({ undo: false, resign: true, flip: false, pause: false });
    this.remote.start();
  }

  // ------------------------------------------------------------------ internal flow

  _syncBoard() {
    // The board can move between layouts (sandbox panels hide/show) without a
    // resize or scroll, so chessground's cached bounds go stale and every drag
    // maps to a shifted square. Force a re-measure before syncing, and again
    // on the next frame once the layout has settled after a mode change.
    this.ground.state.dom?.bounds.clear();
    requestAnimationFrame(() => this.ground.state?.dom?.bounds.clear());

    if (this.sandboxSetup) {
      const isMoveTool = this.sandboxTool === 'move';
      this.ground.set({
        fen: this.game.fen(),
        orientation: this.orientation,
        selectable: { enabled: isMoveTool },
        movable: {
          free: isMoveTool,
          color: isMoveTool ? 'both' : false,
          events: {
            after: (orig, dest) => this.handleSandboxMove(orig, dest),
          },
        },
      });
      return;
    }

    const isHumanTurn =
      this.mode === MODES.ANALYZE ||
      (this.mode === MODES.HUMAN_VS_AI && this.game.turn() === this.humanSide) ||
      (this.mode === MODES.REMOTE && this._remoteHumanTurn());

    // Highlight the REAL last move from chess.js history (from+to) so the
    // opponent's move is highlighted too — without this, chessground kept the
    // stale square pair from the human's drag after the bot moved.
    const lastVerbose = this.game.history({ verbose: true });
    const last = lastVerbose[lastVerbose.length - 1];

    this.ground.set({
      fen: this.game.fen(),
      orientation: this.orientation,
      turnColor: this.game.turn() === 'w' ? 'white' : 'black',
      check: this.game.inCheck(),
      lastMove: last ? [last.from, last.to] : undefined,
      selectable: { enabled: true },
      movable: {
        free: false,
        color: isHumanTurn ? (this.game.turn() === 'w' ? 'white' : 'black') : false,
        dests: this._getDests(),
        // Always rebind the game-move handler: chessground merges config, so
        // without this the sandbox setup handler would stick around and
        // silently swallow every move after leaving sandbox mode.
        events: {
          after: (orig, dest) => this.handleUserMove(orig, dest),
        },
      },
      // Clear any hint highlight from the previous position.
      highlight: { custom: new Map() },
    });

    this._renderMaterial();

    const topTurn = this.orientation === 'white' ? this.game.turn() === 'b' : this.game.turn() === 'w';
    const botTurn = this.orientation === 'white' ? this.game.turn() === 'w' : this.game.turn() === 'b';
    this.ui.setPlayerActive('top', topTurn && !this._isOver());
    this.ui.setPlayerActive('bottom', botTurn && !this._isOver());
  }

  /**
   * Material score + captured pieces shown under each player name.
   * Score: the leading side shows e.g. "1+" (pawns ahead); equal -> nothing.
   * Captured: icons of the pieces that side took (highest value first).
   */
  _renderMaterial() {
    const vals = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    let w = 0;
    let b = 0;
    for (const row of this.game.board()) {
      for (const sq of row) {
        if (!sq) continue;
        if (sq.color === 'w') w += vals[sq.type] ?? 0;
        else b += vals[sq.type] ?? 0;
      }
    }
    const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const topIsBlack = this.orientation === 'white';
    const topDiff = topIsBlack ? b - w : w - b;
    const botDiff = -topDiff;
    this.ui.setScore('top', topDiff > 0 ? `${fmt(topDiff)}+` : '');
    this.ui.setScore('bottom', botDiff > 0 ? `${fmt(botDiff)}+` : '');

    // Captured pieces: keyed by the capturing side, icons colored as opponent.
    const cap = { w: [], b: [] };
    const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
    for (const m of this.game.history({ verbose: true })) {
      if (m.captured) cap[m.color].push(m.captured);
    }
    for (const side of ['w', 'b']) cap[side].sort((a, z) => order[a] - order[z]);
    const topSide = topIsBlack ? 'b' : 'w';
    const bottomSide = topIsBlack ? 'w' : 'b';
    this.ui.setCaptured('top', cap[topSide], topSide === 'w' ? 'black' : 'white');
    this.ui.setCaptured('bottom', cap[bottomSide], bottomSide === 'w' ? 'black' : 'white');
  }

  _getDests() {
    const dests = new Map();
    try {
      for (const move of this.game.moves({ verbose: true })) {
        if (!dests.has(move.from)) dests.set(move.from, []);
        dests.get(move.from).push(move.to);
      }
    } catch {
      // If custom position has no moves, return empty map safely
    }
    return dests;
  }

  _afterMove(move, { publish = false } = {}) {
    this._renderMoves();
    this._syncBoard();

    if (this.clock) {
      this.clock.switchTurn(this.game.turn());
    }

    const over = this._isOver();
    if (over) {
      this._announceGameOver();
    } else {
      // move / capture / check feedback for every move (human, bot, remote)
      if (move.captured) sounds.play('capture');
      else sounds.play('move');
      if (this.game.inCheck()) sounds.play('check');
    }

    if (publish && this.remote) {
      // Publish UCI + SAN + resulting FEN to the battle room (docs/agent-battle.md).
      const uci = move.from + move.to + (move.promotion ?? '');
      this.remote
        .appendMove(uci, move.san, this.game.fen(), this._gameResult())
        .catch((err) => this.ui.log(`Remote: ${err.message}`, 'err'));
    }

    if (over) return;

    if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
      this._engineTurn();
    } else if (this.mode === MODES.AI_VS_AI) {
      this._maybeStartAiLoop();
    }
  }

  _gameResult() {
    if (!this.game.isGameOver()) return null;
    if (this.game.isCheckmate()) return this.game.turn() === 'w' ? '0-1' : '1-0';
    return '1/2-1/2';
  }

  /**
   * Humanized engine thinking: the bot pauses before moving with a
   * time-control-scaled, position-aware delay — not just a random number.
   *  - longer time controls get a longer base pause (unlimited/8-30min longest)
   *  - complex positions (many legal moves) / endgames (little material)
   *    make the engine "calculate" longer
   *  - being in check or replying to a capture/check makes it think longer
   *  - skewed distribution: mostly mid-range, occasionally a quick "obvious"
   *    move, occasionally a deep "calculation" pause — human-like rhythm
   * Returns { delay, search }: delay = thinking pause, search = UCI movetime.
   */
  _thinkTime() {
    const tc = TIME_CONTROLS.find((t) => t.id === this.timeControlId);
    const ms = tc?.initialMs ?? 0;
    let base;
    let search;
    if (ms <= 0 || ms >= 8 * 60000) { base = 7000; search = 1500; }
    else if (ms >= 4 * 60000) { base = 5000; search = 800; }
    else { base = 2800; search = 450; }

    // Opening: the first 3 plies come quick (~1-3s) whatever the time control.
    if (this.game.history().length < 3) {
      return { delay: 1000 + Math.floor(Math.random() * 2001), search };
    }

    let factor = 1;
    try {
      const legal = this.game.moves().length;
      if (legal > 30) factor *= 1.2;      // rich position -> more candidates to check
      else if (legal < 10) factor *= 0.8; // few options -> quicker
      const material = this.game.board().flat().filter(Boolean).length;
      if (material <= 8) factor *= 1.15;  // endgame -> precise calculation
    } catch { /* custom boards without moves are handled elsewhere */ }

    const history = this.game.history({ verbose: true });
    const last = history[history.length - 1];
    if (this.game.inCheck()) factor *= 1.4; // must find the escape
    else if (last && (last.captured || last.san.includes('+'))) factor *= 1.25; // recapture/check follow-up

    // Skewed human-like distribution: ~12% quick ("obvious"), 76% normal, 12% deep.
    const u = Math.random();
    const skew = u < 0.12 ? 0.55 : u < 0.88 ? 1 : 1.55;
    const delay = Math.max(800, Math.round(base * factor * skew + (Math.random() - 0.5) * base * 0.3));
    return { delay, search };
  }

  _engineTurn() {
    if (!this.engine || !this.engineReady || this.engineBusy || this._isOver()) return;
    this.engineBusy = true;
    this.ui.setStatus('เอนจินกำลังคิด…', 'busy');
    const cfg = LEVELS[this.levelIndex];
    const { delay } = this._thinkTime();
    const fen = this.game.fen();
    this._aiTimer = setTimeout(() => {
      if (this._isOver() || !this.engine || !this.engineReady) return;
      this.engine.setPosition(fen);
      this.engine.go({ movetime: cfg.movetime, depth: cfg.depth });
    }, delay);
  }

  _onEngineBestMove(uci) {
    this.engineBusy = false;
    if (!uci || this._isOver()) return;
    const orig = uci.slice(0, 2);
    const dest = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = this.game.move({ from: orig, to: dest, promotion });
    if (!move) {
      this.ui.log(`เอนจินส่งการเดินผิดกฎ: ${uci}`, 'err');
      return;
    }
    this.ui.log(`Stockfish เดิน ${move.san}`, 'engine');
    this._afterMove(move);
  }

  /** AI vs AI — apply the bestmove of the engine for `side` and hand off. */
  _onAiLoopMove(side, uci) {
    this.engineBusy = false;
    if (this.paused) return; // paused — discard the computed move
    if (!uci) {
      // Stockfish answers (none) for illegal/custom positions — don't stall silently.
      if (!this._isOver()) {
        this.ui.log(`AI (${side === 'w' ? 'ขาว' : 'ดำ'}): กระดานไม่ถูกต้อง — เอนจินไม่มีหมากให้เดิน`, 'err');
      }
      return;
    }
    if (this._isOver()) return;
    const orig = uci.slice(0, 2);
    const dest = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = this.game.move({ from: orig, to: dest, promotion });
    if (!move) {
      this.ui.log(`AI (${side === 'w' ? 'ขาว' : 'ดำ'}) ส่งการเดินผิดกฎ: ${uci}`, 'err');
      return;
    }
    this.ui.log(`AI (${side === 'w' ? 'ขาว' : 'ดำ'}) เดิน ${move.san}`, 'engine');
    this._afterMove(move);
  }

  /** GM hint (human vs bot only): strongest available search suggests a move.
   *  Draws an arrow + square highlights; the human decides whether to follow. */
  showHint() {
    if (this.mode !== MODES.HUMAN_VS_AI || this.engineBusy || this.hintBusy || this._isOver()) return;
    if (this.game.turn() !== this.humanSide) {
      this.ui.log('คำใบ้ใช้ได้เฉพาะตอนถึงตาเรา', 'warn');
      return;
    }
    this.hintBusy = true;
    this.ui.setStatus('💡 บอท GM กำลังคิดคำใบ้…', 'busy');
    if (!this.hintEngine) {
      this.hintEngine = new Stockfish({
        workerUrl: ENGINE_HINT_URL,
        onReady: () => {
          if (!this.hintEngine) return;
          this.hintEngine.setOption('Skill Level', 20);
          this.hintEngine.setOption('Hash', 64);
          this._hintGo();
        },
        onBestMove: (uci) => this._applyHint(uci),
        onError: (msg) => {
          this.hintBusy = false;
          this.ui.log(`เอนจินคำใบ้ผิดพลาด: ${msg}`, 'err');
        },
      });
    } else {
      this._hintGo();
    }
  }

  _hintGo() {
    if (!this.hintEngine || !this.hintEngine.ready || !this.hintBusy) return;
    this.hintEngine.setPosition(this.game.fen());
    this.hintEngine.go({ movetime: 3500, depth: 20 });
  }

  _applyHint(uci) {
    this.hintBusy = false;
    if (!uci || uci === '(none)') {
      this.ui.log('💡 ไม่มีคำใบ้สำหรับตำแหน่งนี้', 'warn');
      return;
    }
    const orig = uci.slice(0, 2);
    const dest = uci.slice(2, 4);
    const piece = this.game.get(orig);
    const roleNames = { p: 'เบี้ย', n: 'ม้า', b: 'หมาก', r: 'เรือ', q: 'เม็ด', k: 'คิง' };
    const pieceLabel = piece ? (roleNames[piece.type] ?? piece.type) : 'หมาก';
    // Arrow (small, bright custom 'hint' brush) + square highlights in the
    // same color as the normal last-move highlight (cleared on next sync).
    this.ground.setShapes([{ orig, dest, brush: 'hint' }]);
    this.ground.set({
      highlight: { custom: new Map([[orig, 'hint-from'], [dest, 'hint-dest']]) },
    });
    this.ui.log(`💡 คำใบ้: เดิน ${pieceLabel} ${orig} → ${dest}`, 'hint');
    this.ui.setStatus('💡 คำใบ้แสดงบนกระดานแล้ว', '');
  }

  _maybeStartAiLoop() {
    if (this.engineBusy || this._isOver() || this.paused) return;
    const turn = this.game.turn();
    const activeEngine = turn === 'w' ? this.engine : this.engineBlack;
    if (!activeEngine || !this.engineReady) return;

    this.engineBusy = true;
    const { delay, search } = this._thinkTime();
    const cfg = turn === 'w' ? LEVELS[this.aivaLevelW] : LEVELS[this.aivaLevelB];
    this.ui.setStatus(`AI (${turn === 'w' ? 'ขาว' : 'ดำ'}) กำลังคิด…`, 'busy');
    const fen = this.game.fen();
    this._aiTimer = setTimeout(() => {
      if (this._isOver() || !activeEngine || !this.engineReady) return;
      activeEngine.setPosition(fen);
      activeEngine.go({ movetime: search, depth: cfg.depth });
    }, delay);
  }

  _remoteHumanTurn() {
    if (!this.remote || !this.remote.state) return false;
    if (!this.remote.token) return false; // spectators only watch
    const turn = this.game.turn();
    return this.engineSide !== turn;
  }

  _onRemoteState(state) {
    // Joiners learn the engine side from the room itself.
    if (!this.engineSide && state.arenaSide) this.engineSide = state.arenaSide;

    if (state.fen && state.fen !== this.game.fen()) {
      try {
        this.game.load(state.fen);
        this.ui.log(`ซิงค์กระดาน Remote (${state.moves?.length ?? 0} ตา)`, 'sys');
        this._syncBoard();
        this._renderMoves();
      } catch (err) {
        this.ui.log(`โหลด FEN Remote ล้มเหลว: ${err.message}`, 'err');
      }
    }

    if (this._isOver()) {
      this._announceGameOver();
      return;
    }

    // Only the room creator auto-plays the arena side locally (remoteGistUrl is
    // set on create); joiners/spectators must never spawn a second engine.
    if (this.remoteGistUrl && this.remote.token && this.game.turn() === this.engineSide && !this.engineBusy) {
      if (!this.engine) {
        this.engine = new Stockfish({
          onReady: () => {
            if (!this.engine) return;
            this.engineReady = true;
            this.engine.setOption('Skill Level', 20);
            this.engine.setOption('Hash', 16);
            this._remoteEngineTurn();
          },
          onBestMove: (uci) => {
            this.engineBusy = false;
            if (!uci) return;
            const orig = uci.slice(0, 2);
            const dest = uci.slice(2, 4);
            const promotion = uci.length > 4 ? uci[4] : undefined;
            const move = this.game.move({ from: orig, to: dest, promotion });
            if (move) {
              this.ui.log(`เอนจินสนามเดินแทน ${move.san}`, 'engine');
              this._afterMove(move, { publish: true });
            }
          },
        });
      } else {
        this._remoteEngineTurn();
      }
    }
  }

  _remoteEngineTurn() {
    if (this.engineBusy || this._isOver()) return;
    this.engineBusy = true;
    const { delay } = this._thinkTime();
    const fen = this.game.fen();
    this._aiTimer = setTimeout(() => {
      if (this._isOver() || !this.engine) return;
      this.engine.setPosition(fen);
      this.engine.go({ movetime: 600, depth: 10 });
    }, delay);
  }

  _isOver() {
    return this.game.isGameOver() || this._isTimeout;
  }

  _announceGameOver() {
    let title = 'จบเกม';
    let detail = '';

    if (this._isTimeout) {
      const winner = this._timeoutLoser === 'w' ? 'ดำ' : 'ขาว';
      title = `หมดเวลา! ฝ่าย${winner}ชนะ`;
      detail = `ฝ่าย${this._timeoutLoser === 'w' ? 'ขาว' : 'ดำ'}เวลาหมด`;
    } else if (this.game.isCheckmate()) {
      const winner = this.game.turn() === 'w' ? 'ดำ' : 'ขาว';
      title = `รุกฆาต! ฝ่าย${winner}ชนะ`;
      detail = `ฝ่าย${this.game.turn() === 'w' ? 'ขาว' : 'ดำ'}ถูกรุกฆาต`;
    } else if (this.game.isDraw()) {
      title = 'เสมอกัน';
      if (this.game.isStalemate()) detail = 'อับอั้น (Stalemate)';
      else if (this.game.isThreefoldRepetition()) detail = 'ซ้ำ 3 ครั้ง';
      else if (this.game.isInsufficientMaterial()) detail = 'หมากไม่พอรุกฆาต';
      else detail = 'กฎ 50 ตา';
    }

    this.ui.setStatus(`จบเกม · ${title}`, 'done');
    this.ui.log(`จบเกม: ${title} (${detail})`, 'sys');

    if (!this._overPopupShown) {
      this._overPopupShown = true;
      this.ui.showGameOver(
        title,
        detail,
        () => this.newGame(),
        () => this.goHome()
      );
    }

    this._playGameOverSound();
  }

  /** Win (victory1+victory2 together) / lose / draw sounds — only when a
   *  human is playing (hva, or remote host). AI vs AI / analyze stay silent. */
  _playGameOverSound() {
    let humanSide = null;
    if (this.mode === MODES.HUMAN_VS_AI) humanSide = this.humanSide;
    else if (this.mode === MODES.REMOTE && this.remoteGistUrl) humanSide = this.engineSide === 'w' ? 'b' : 'w';
    if (!humanSide) return;

    if (this.game.isDraw()) {
      sounds.play('draw');
      return;
    }
    let winner;
    if (this._isTimeout) winner = this._timeoutLoser === 'w' ? 'b' : 'w';
    else winner = this.game.turn() === 'w' ? 'b' : 'w';
    if (winner === humanSide) sounds.play('victory');
    else sounds.play('lose');
  }

  _renderMoves() {
    const history = this.game.history();
    this.ui.renderMoves(history);
  }

  goHome() {
    this.dispose();
    this.ui.showHomeView();
  }
}
