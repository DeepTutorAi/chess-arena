// Controller layer — single state machine managing game modes, clock, engine
// worker, and board sync.

import { Chess } from 'chess.js';
import { Stockfish } from './engine.js';
import { GameReviewAnalyzer } from './analyzer.js';
import { ReviewUI } from './review-ui.js';
import { getOpeningBook } from './openings.js';
import { SpectatorEval as SpectatorAnalysisEngine } from './spectator-eval.js';
import { AVATAR_GLYPHS, OnlineRoomClient } from './online.js';
import { ChessClock } from './clock.js';
import { planThinkTime } from './thinktime.js';
import { createTurnAlert } from './turnalert.js';
import { sounds } from './sounds.js';
import {
  ENGINE_NAME,
  HUMAN_NAME,
  LEVELS,
  TIME_CONTROLS,
  DEFAULT_TIME_CONTROL,
  ENGINE_HINT_URL,
  ENGINE_MULTI_URL,
  resolveEngineWorkerUrl,
  getStrongEnginePreference,
  isCrossOriginIsolated,
} from './config.js';

export const MODES = {
  HUMAN_VS_AI: 'hva',
  AI_VS_AI: 'aiva',
  ONLINE: 'online',
  ANALYZE: 'analyze',
};

export class Controller {
  constructor({
    ui,
    ground,
    onPromotion,
    onlineClientFactory = (options) => new OnlineRoomClient(options),
    gameOverDelayMs = 3000,
    turnAlert = createTurnAlert(),
  }) {
    this.ui = ui;
    this.ground = ground;
    this.onPromotion = onPromotion;
    this._gameOverDelayMs = gameOverDelayMs;
    this.turnAlert = turnAlert; // blinks the tab title when it is our turn in a hidden tab

    this.game = new Chess();
    this.mode = null;
    this.engine = null;
    this.engineBlack = null;
    this.online = null;
    this.onlineClientFactory = onlineClientFactory;
    this.onlineState = null;
    this.onlineRoomId = null;
    this.onlineInviteToken = null;
    this.onlineSide = null;
    this.onlineRole = null;
    this.onlineWatchInviteToken = null;
    this.onlineConnectionState = 'disconnected';
    this.ui.setShareVisible?.(false);
    this._onlineClockTimer = null;
    this._onlineAfkTimer = null;
    this._onlinePlyCount = null; // plies in the last accepted snapshot (null = none yet)
    this.clock = null;

    this.engineReady = false;
    this.engineBusy = false;
    this.viewerMode = false;
    this.paused = false;
    this.hintEngine = null;   // GM-level engine for the hint button (hva only)
    this.hintBusy = false;
    this._hintTimer = null;
    this.orientation = 'white';
    this._playersByColor = null; // { w, b } name/avatar entries behind the two player bars
    this.levelIndex = 3; // level 4
    this.humanSide = 'w';
    this.engineSide = 'b';
    this.timeControlId = DEFAULT_TIME_CONTROL;

    this._isTimeout = false;
    this._timeoutLoser = null;
    this._aiTimer = null;
    this._lastOpts = null;
    this._overPopupShown = false;

    // Game Review System state (plan.md §Step 4)
    this._gameInitialFen = null;
    this._lastGameRecord = null;
    this._lastGameOver = null;
    this._gameOverOverlay = null;
    this._reviewActive = false;
    this._analysis = null;
    this._activeAnalyzer = null;
    // Finished analysis of the last game — re-entering review reuses it instead
    // of re-running the engine over every ply.
    this._lastAnalysis = null;
    this._lastAnalysisRecord = null;
    // Bumped whenever a review session ends; a stale analyzer's late progress /
    // result / error checks its token and is ignored.
    this._reviewRun = 0;
    this.reviewUI = null;
    this._reviewDisconnectNotified = false;
    this._gameOverDelayTimer = null;

    // Per-ply clock snapshots for the review replay (remaining {w,b} ms after
    // each move, keyed by history length).
    this._clockSnapshots = [];

    // Interactive Sandbox Board Setup State
    this.sandboxSetup = false;
    this.sandboxTool = 'move';       // 'move' | 'replace'
    this.sandboxPiece = 'q';         // 'q' | 'r' | 'b' | 'n' | 'p' | 'delete'
    this.sandboxTargetMode = null;   // null (Solo) | 'hva' | 'aiva' | 'online'
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
    this._lowTimePlayed = false; // low-time warning fires once per game
    this._timeoutLoser = null;

    const initialFen = opts.initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    try {
      this.game = new Chess(initialFen);
    } catch {
      this.game = new Chess(); // fallback to standard
    }
    this._gameInitialFen = initialFen;
    this._lastGameRecord = null;
    this._lastGameOver = null;
    this._gameOverOverlay = null;
    this._analysis = null;
    this._lastAnalysis = null;
    this._lastAnalysisRecord = null;
    this._activeAnalyzer = null;
    this._clockSnapshots = [];

    this.ui.clearLog();
    this.ui.resetMoves();
    this.ui.setEngineInfo('top', '');
    this.ui.setEngineInfo('bottom', '');

    this.timeControlId = opts.timeControlId ?? DEFAULT_TIME_CONTROL;
    if (mode === MODES.ONLINE) {
      this.ui.showClocks(false);
    } else {
      const tcConfig = TIME_CONTROLS.find((t) => t.id === this.timeControlId) ?? TIME_CONTROLS[0];
      this._initClock(tcConfig);
      // The clock was never started anywhere, so time controls never ticked.
      this.clock?.start(this.game.turn());
    }

    if (mode === MODES.HUMAN_VS_AI) {
      this.ui.showGameView();
      this._startHumanVsAi(opts);
    } else if (mode === MODES.AI_VS_AI) {
      this.ui.showGameView();
      this._startAiVsAi(opts);
    } else if (mode === MODES.ONLINE) {
      await this._startOnline(opts);
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
    // Leave any previous game fully behind (engines, online socket, clock,
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
    this.ui.showClocks?.(false); // the editor has no clocks — don't show "--:--" or the last game's times

    const fen = initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    try {
      this.game = new Chess(fen);
    } catch {
      this.game = new Chess();
    }

    this.orientation = 'white'; // the editor's rank rules assume White at the bottom
    this._setPlayersByColor(
      { name: 'ฝ่ายขาว (ปรับแต่งสนาม)', icon: 'user' },
      { name: 'ฝ่ายดำ (ปรับแต่งสนาม)', icon: 'user' },
    );
    this.ui.setStatus('Sandbox Setup — จัดแต่งหมากและเลือกโหมดการเล่น', '');
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
      } else if (targetMode === MODES.ONLINE) {
        await this.start(MODES.ONLINE, {
          action: 'create',
          playerName: HUMAN_NAME,
          title: 'Sandbox Custom Battle',
          color: this.sandboxSelectedColor ?? 'random',
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
      incrementMs: tcConfig.incMs,
      onTick: (times, currentTurn) => this._onClockTick(times, currentTurn),
      onTimeout: (loser) => this._onClockTimeout(loser),
    });
  }

  _onClockTick(times, currentTurn) {
    this._renderClockTimes(times, currentTurn);

    // Low-time warning — once per game, when the clock first turns red (≤20s).
    if ((times.w <= 20000 || times.b <= 20000) && !this._lowTimePlayed) {
      this._lowTimePlayed = true;
      sounds.playLowTime();
    }
  }

  /** Paint both clock badges for the current orientation. `activeTurn` is the
   *  colour whose clock is running (null when stopped). */
  _renderClockTimes(times, activeTurn) {
    const topColor = this.orientation === 'white' ? 'b' : 'w';
    const bottomColor = topColor === 'w' ? 'b' : 'w';
    this.ui.setClock('top', ChessClock.formatTime(times[topColor]), activeTurn === topColor, times[topColor] <= 20000);
    this.ui.setClock('bottom', ChessClock.formatTime(times[bottomColor]), activeTurn === bottomColor, times[bottomColor] <= 20000);
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
    if (this.clock) {
      this.clock.stop();
      this._restoreClockDisplay();
    }
    this.ui.setBusy?.(false);
    // Lock the board: without a re-sync the flagged side keeps the pre-timeout
    // movable config and could keep dragging pieces after the flag.
    this._syncBoard();

    this.ui.setStatus(`จบเกม · ${text}`, 'done');
    this.ui.setPlayerDone(loser === 'w' ? 'bottom' : 'top');
    this.ui.log(`จบเกม: ${text} (${detail})`, 'sys');

    if (!this._overPopupShown) {
      this._overPopupShown = true;
      this._pushClockSnapshot(); // flag time (loser at 0:00) for the replay
      this._captureGameRecord({ result: winnerCode, reason: 'timeout' });
      this._showGameOverSoon(text, detail);
    }

    this._playGameOverSound();
  }

  resign() {
    if (this.mode === MODES.ONLINE) {
      if (this.onlineRole === 'spectator') return;
      if (!this.online || this.onlineState?.status !== 'active') return;
      try {
        this.online.resign(this.onlineState.revision);
        this.ui.log('ส่งคำขอยอมแพ้แล้ว — รอเซิร์ฟเวอร์ยืนยัน', 'sys');
      } catch (err) {
        this.ui.log(`ยอมแพ้ไม่สำเร็จ: ${err.message}`, 'err');
      }
      return;
    }
    if (this._isOver() || this._overPopupShown) return;
    // In analyze both sides are human — the resigning side is the one to move.
    const loser = this.mode === MODES.ANALYZE ? this.game.turn() : this.humanSide;
    const winnerColor = loser === 'w' ? 'ดำ' : 'ขาว';
    const winnerCode = loser === 'w' ? '0-1' : '1-0';
    const text = `ยอมแพ้! ฝ่าย${winnerColor}ชนะ`;
    const detail = `ฝ่าย${loser === 'w' ? 'ขาว' : 'ดำ'}ยอมแพ้ (${winnerCode})`;

    if (this.engine) this.engine.stop();
    if (this.engineBlack) this.engineBlack.stop();
    if (this.clock) {
      this.clock.stop();
      this._restoreClockDisplay();
    }
    this.ui.setBusy?.(false);

    this.ui.setStatus(`จบเกม · ${text}`, 'done');
    this.ui.log(`จบเกม: ${text} (${detail})`, 'sys');

    if (!this._overPopupShown) {
      this._overPopupShown = true;
      this._pushClockSnapshot(); // freeze the times the resignation happened at
      this._captureGameRecord({ result: winnerCode, reason: 'resign' });
      this._showGameOverSoon(text, detail);
    }

    // The human always loses when resigning.
    sounds.play('lose');
  }

  /** User dragged a piece in game mode. */

  async handleUserMove(orig, dest) {
    if (this.engineBusy || this.viewerMode || this._isOver()) return;
    if (this.mode === MODES.ONLINE && !this._onlineHumanTurn()) return;

    const legal = this.game.moves({ square: orig, verbose: true }).some((m) => m.to === dest);
    if (!legal) return;

    let promotion = null;
    const piece = this.game.get(orig);
    const toRow = dest.charCodeAt(1) - 48; // 1..8
    if (piece && piece.type === 'p' && (toRow === 8 || toRow === 1)) {
      promotion = await this.onPromotion(orig, dest);
      if (!promotion) {
        // Nothing was played — snap the animated drag back to canonical state.
        this._syncBoard();
        return;
      }
      // The clock can flag while the promotion picker is open — re-validate
      // so a decided game never accepts the queued move.
      if (this._isOver()) return;
    }

    if (this.mode === MODES.ONLINE) {
      try {
        this.online.sendMove(orig, dest, promotion, this.onlineState.revision);
        this.ui.log(`ส่งตาเดิน ${orig}${dest}${promotion ?? ''} — รอเซิร์ฟเวอร์ยืนยัน`, 'sys');
      } catch (err) {
        this.ui.log(`ส่งตาเดินไม่สำเร็จ: ${err.message}`, 'err');
      }
      // Chessground already animated the drop. Snap it back to the last
      // canonical snapshot until the server accepts and broadcasts the move.
      this._syncBoard();
      return;
    }

    const move = this.game.move({ from: orig, to: dest, promotion });
    if (!move) return;

    this.ui.log(`${move.color === 'w' ? 'ขาว' : 'ดำ'} เดิน ${move.san}`, 'move');
    this._afterMove(move);
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

      this.ground.cancelPremove?.();
      // Reset game over locks so checkmate/loss popup re-triggers properly on next end
      this._overPopupShown = false;
      this._isTimeout = false;
      this._timeoutLoser = null;

      this._syncBoard();
      this.ui.log('ย้อนการเดินแล้ว', 'sys');
      this._renderMoves();
      sounds.play('move'); // undo uses the move sound, as requested
      if (this._isOver()) return;
      // A previous timeout/pause left the clock stopped and pointed at the
      // wrong turn — restart it on the restored turn so time drains the
      // correct side and the game can still end by flag.
      this.clock?.start(this.game.turn());
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
    // Everything that lives in the top/bottom player bars is keyed by colour,
    // so it has to follow the board or a name ends up next to the wrong clock.
    this._renderPlayers();
    this._renderMaterial();
    if (this._reviewActive) {
      this.reviewUI?.rerender(); // badges + replayed clocks follow the flip
    } else {
      this._renderTurnIndicators();
      this._refreshClockDisplay();
    }
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
      this.ui.setBusy?.(false);
      this.ui.setStatus('หยุดชั่วคราว — กดปุ่ม "ต่อ" เพื่อเล่นต่อ', '');
      this.ui.setPauseState(true);
    } else {
      if (!this._isOver()) this.clock?.start(this.game.turn());
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
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
    if (this.spectatorEval) { this.spectatorEval.destroy(); this.spectatorEval = null; }
    if (this.online) { this.online.stop(); this.online = null; }
    if (this._onlineClockTimer) { clearInterval(this._onlineClockTimer); this._onlineClockTimer = null; }
    if (this._onlineAfkTimer) { clearInterval(this._onlineAfkTimer); this._onlineAfkTimer = null; }
    this.ui.setAfkWarning?.({ visible: false });
    this.onlineState = null;
    this.onlineRoomId = null;
    this.onlineInviteToken = null;
    this.onlineSide = null;
    this.onlineRole = null;
    this.onlineWatchInviteToken = null;
    this.onlineConnectionState = 'disconnected';
    this._onlinePlyCount = null;
    this.engineReady = false;
    this.engineBusy = false;
    this.hintBusy = false;
    // Viewer lock must not leak between modes (aiva -> hva silently blocked
    // every human move otherwise).
    this.viewerMode = false;
    this.paused = false;
    this.sandboxSetup = false;
    this.ground.setShapes([]);
    this.ground.setAutoShapes?.([]);
    this.ground.cancelPremove?.();
    this.turnAlert?.clear();
    if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = null; }

    // Review teardown — a running analysis must not outlive its game.
    if (this._activeAnalyzer) { this._activeAnalyzer.abort(); this._activeAnalyzer = null; }
    if (this._gameOverDelayTimer) { clearTimeout(this._gameOverDelayTimer); this._gameOverDelayTimer = null; }
    if (this._reviewActive) {
      this.reviewUI?.exitStepperMode();
      this.reviewUI?.closeSummaryModal();
      this.reviewUI?.closeProgressModal();
      this.reviewUI?.hideEvalBar();
      this._reviewActive = false;
    }
    this._analysis = null;
    this._lastAnalysis = null;
    this._lastAnalysisRecord = null;
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

    const engineEntry = { name: `${ENGINE_NAME} Elo ${cfg.elo} (ฝ่าย${engineSide === 'w' ? 'ขาว' : 'ดำ'})`, icon: 'robot' };
    const humanEntry = { name: `${HUMAN_NAME} (ฝ่าย${this.humanSide === 'w' ? 'ขาว' : 'ดำ'})`, icon: 'user' };
    this._setPlayersByColor(
      this.humanSide === 'w' ? humanEntry : engineEntry,
      this.humanSide === 'w' ? engineEntry : humanEntry,
    );
    // The WASM download is several MB on first load — say so instead of a
    // silent gap between the dialog closing and the engine's first move.
    this.ui.setStatus(`กำลังโหลดเอนจิน ${ENGINE_NAME}…`, 'busy');
    this.ui.setActionStrip({ undo: true, resign: false, flip: true, pause: false, hint: true, liveAnalysis: false, options: true });

    this.engine = new Stockfish({
      workerUrl: this._engineUrl(),
      onReady: () => {
        this.engineReady = true;
        if (this.engine) {
          this.engine.setOption('Skill Level', cfg.skill);
          this.engine.setOption('Hash', 16);
          this.engine.setPosition(this.game.fen());
        }
        this.ui.log(`เอนจินพร้อม (${ENGINE_NAME})`, 'sys');
        this.ui.setStatus(`Stockfish Elo ${cfg.elo} · เริ่มเกม`, '');
        if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
          this._engineTurn();
        }
      },
      onBestMove: (uci) => this._onEngineBestMove(uci),
      onError: (msg) => {
        this.ui.log(`เอนจินผิดพลาด: ${msg}`, 'err');
        if (!this.engineReady) {
          this.ui.setStatus('โหลดเอนจินไม่สำเร็จ — กลับหน้าแรกแล้วเริ่มเกมใหม่อีกครั้ง', 'err');
        }
      },
    });
    this._syncBoard();
    this._renderMoves();
  }

  _startAiVsAi({ levelWhite = 6, levelBlack = 3, initialFen } = {}) {
    this.viewerMode = true;
    this.orientation = 'white'; // don't inherit a flipped board from the previous game
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

    this._setPlayersByColor(
      { name: `${ENGINE_NAME} · Elo ${cfgW.elo} (ฝ่ายขาว)`, icon: 'robot' },
      { name: `${ENGINE_NAME} · Elo ${cfgB.elo} (ฝ่ายดำ)`, icon: 'robot' },
    );
    this.ui.setStatus(`AI vs AI · ขาว Elo ${cfgW.elo} ปะทะ ดำ Elo ${cfgB.elo}`, '');
    this.paused = false;
    this.ui.setPauseState(false);
    // AI vs AI: flip to watch the other side + pause/resume; options menu for audio.
    this.ui.setActionStrip({ undo: false, resign: false, flip: true, pause: true, liveAnalysis: true, options: true });
    this._ensureSpectatorAnalysis();

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
      workerUrl: this._engineUrl(),
      onReady: () => onWorkerReady('w'),
      onBestMove: (uci) => this._onAiLoopMove('w', uci),
      onError: (msg) => {
        this.ui.log(`เอนจินขาวผิดพลาด: ${msg}`, 'err');
        this.ui.setStatus('เอนจินฝ่ายขาวล้มเหลว — การประลองเริ่มไม่ได้ ลองเริ่มเกมใหม่', 'err');
      },
    });

    this.engineBlack = new Stockfish({
      workerUrl: this._engineUrl(),
      onReady: () => onWorkerReady('b'),
      onBestMove: (uci) => this._onAiLoopMove('b', uci),
      onError: (msg) => {
        this.ui.log(`เอนจินดำผิดพลาด: ${msg}`, 'err');
        this.ui.setStatus('เอนจินฝ่ายดำล้มเหลว — การประลองเริ่มไม่ได้ ลองเริ่มเกมใหม่', 'err');
      },
    });

    this._syncBoard();
    this._renderMoves();
  }

  _startAnalyze() {
    this.orientation = 'white';
    this._setPlayersByColor(
      { name: 'ฝ่ายขาว (มือคุณ)', icon: 'user' },
      { name: 'ฝ่ายดำ (มือคุณ)', icon: 'user' },
    );
    this.ui.setStatus('โหมด Sandbox — เล่นได้ทั้งสองสี', '');
    this.ui.setActionStrip({ undo: true, resign: false, flip: true, pause: false, liveAnalysis: false, options: true });
    this._syncBoard();
    this._renderMoves();
  }

  async _startOnline({
    action = 'create',
    roomId = '',
    inviteToken = '',
    playerName = HUMAN_NAME,
    title = 'ห้องประลองออนไลน์',
    color = 'random',
    timeControlId = DEFAULT_TIME_CONTROL,
    initialFen,
    visibility = 'public',
    allowSpectators = true,
    avatar = 'knight',
    watchInviteToken,
  } = {}) {
    this.online = this.onlineClientFactory({
      onState: (state) => this._onOnlineState(state),
      onError: (message, detail) => {
        this.ui.log(`Online: ${message}`, 'err');
        if (detail?.code === 'stale_revision') this.online?.sync();
      },
      onConnectionState: (state) => {
        this.onlineConnectionState = state;
        if (state === 'connected') {
          this.ui.setStatus('เชื่อมต่อห้องออนไลน์แล้ว', '');
          if (this.onlineState) this._syncBoard();
        }
        else if (state === 'reconnecting') this.ui.setStatus('การเชื่อมต่อขาดหาย — กำลังเชื่อมต่อใหม่…', 'busy');
        else if (state === 'failed') this.ui.setStatus('เชื่อมต่อห้องไม่ได้ — กลับมาที่แท็บนี้เมื่อเน็ตกลับมาเพื่อลองใหม่อัตโนมัติ', 'err');
        else if (state === 'replaced') this.ui.setStatus('ห้องนี้ถูกเปิดจากแท็บอื่น — การเชื่อมต่อแท็บนี้ถูกแทนที่', '');
        else if (state === 'unauthorized') this.ui.setStatus('session หมดอายุหรือไม่ถูกต้อง — กลับเข้าห้องจาก Lobby หรือลิงก์เชิญอีกครั้ง', 'err');
        else if (state === 'expired') this.ui.setStatus('ห้องนี้หมดอายุแล้ว', '');
      },
    });

    let result;
    if (action === 'create') {
      result = await this.online.create({
        playerName, title, color, timeControlId, initialFen, visibility, allowSpectators, avatar,
      });
      this.onlineRoomId = result.roomId;
      this.onlineInviteToken = result.inviteToken;
      this.onlineWatchInviteToken = result.watchInviteToken;
    } else if (action === 'join') {
      result = await this.online.join(roomId, { playerName, inviteToken });
      this.onlineRoomId = roomId;
    } else if (action === 'joinPublic') {
      result = await this.online.joinPublic(roomId, { playerName, avatar });
      this.onlineRoomId = roomId;
    } else if (action === 'watch') {
      result = await this.online.watch(roomId, {
        playerName, avatar, ...(watchInviteToken ? { watchInviteToken } : {}),
      });
      this.onlineRoomId = roomId;
    } else if (action === 'resume') {
      if (!this.online.restoreSession(roomId)) throw new Error('ไม่พบ session ของห้องนี้ในเบราว์เซอร์');
      this.onlineRoomId = roomId;
      result = { state: this.online.state };
    } else {
      throw new Error('คำสั่งเปิดห้องออนไลน์ไม่ถูกต้อง');
    }

    this.onlineRole = this.online.session.role;
    this.onlineSide = this.online.session.color;
    this.viewerMode = this.onlineRole === 'spectator';
    this.orientation = this.onlineSide === 'b' ? 'black' : 'white';
    if (result.state) this._onOnlineState(result.state);
    this.ui.setActionStrip({ undo: false, resign: false, flip: true, pause: false, liveAnalysis: this.onlineRole === 'spectator', options: true });
    if (this.onlineRole === 'spectator') this._ensureSpectatorAnalysis();
    this.ui.setOnlineRole?.(this.onlineRole);
    this.ui.setShareVisible?.(this.onlineRole === 'host');
    this.online.connect();
  }

  _onlineHumanTurn() {
    return Boolean(
      this.online
      && this.onlineState?.status === 'active'
      && this.onlineConnectionState === 'connected'
      && this.onlineSide === this.game.turn(),
    );
  }

  _onOnlineState(state) {
    if (!state || (this.onlineRoomId && state.roomId !== this.onlineRoomId)) return;
    if (this.onlineState && state.revision < this.onlineState.revision) return;

    try {
      const game = new Chess(state.initialFen);
      for (const uci of state.moves) {
        const move = game.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        if (!move) throw new Error('ประวัติการเดินไม่ถูกต้อง');
      }
      if (game.fen() !== state.fen) throw new Error('FEN ไม่ตรงกับประวัติการเดิน');
      this.game = game;
    } catch (err) {
      this.ui.log(`Online snapshot ถูกปฏิเสธ: ${err.message}`, 'err');
      return;
    }

    const wasFinished = this.onlineState?.status === 'finished';

    this.onlineState = state;
    this._playOnlineMoveSound(state);
    // Rematch handshake (roadmap B): remember the live offer for the game-over
    // card, even while review owns the screen.
    this._onlineRematch = state.rematch ?? null;
    if (state.hostColor && this.onlineRole !== 'spectator') {
      const expectedSide = this.onlineRole === 'host'
        ? state.hostColor
        : (state.hostColor === 'w' ? 'b' : 'w');
      if (expectedSide !== this.onlineSide) {
        this.onlineSide = expectedSide;
        // chessground wants 'white'/'black', not 'w'/'b'.
        this.orientation = expectedSide === 'b' ? 'black' : 'white';
      }
    }
    // A rematch flips the finished room back to an empty active game — clear
    // every local "game over" remnant so the new game starts clean.
    if (wasFinished && state.status === 'active' && state.moves.length === 0) {
      this._overPopupShown = false;
      this._gameOverOverlay?.close();
      this._gameOverOverlay = null;
      this._lastGameOver = null;
      this._clockSnapshots.length = 0;
      if (this._reviewActive) {
        // The summary modal/ progress modal would float dead over the new game.
        this.reviewUI?.closeSummaryModal();
        this.reviewUI?.closeProgressModal();
        this.reviewUI?.exitStepperMode();
        this.reviewUI?.hideEvalBar();
        this._finishReviewSession();
      }
      this.ui.log('รีเมตช์ได้รับการยอมรับ — เริ่มเกมใหม่แล้ว (สลับฝั่งกัน)', 'sys');
    }
    // Server clock truth at this revision — the review replay replays these.
    if (state.clock) {
      const snap = { ply: state.moves.length, w: state.clock.whiteMs, b: state.clock.blackMs };
      const last = this._clockSnapshots[this._clockSnapshots.length - 1];
      if (last && last.ply === snap.ply) this._clockSnapshots[this._clockSnapshots.length - 1] = snap;
      else this._clockSnapshots.push(snap);
    }
    if (this._reviewActive) {
      // Live data keeps flowing while reviewing, but review owns the screen —
      // no board/ clock re-renders, only non-blocking toasts.
      this._maybeNotifyReviewDisconnect(state);
      this._maybeNotifyReviewRematch(state);
      return;
    }
    // A rematch offer/decision that lands while the game-over card is open
    // changes which buttons the card must show — re-render it from the LIVE
    // state instead of letting stale buttons sit there.
    const rematchKey = this._rematchStateKey();
    if (
      this._lastGameOver
      && this._gameOverOverlay?.body?.isConnected
      && rematchKey !== null
      && rematchKey !== this._rematchCardKey
    ) {
      this._rematchCardKey = rematchKey;
      this._gameOverOverlay.close();
      this._gameOverOverlay = null;
      this._reshowGameOver();
    }
    this.ui.setSpectators?.({ visible: state.allowSpectators, spectators: state.spectators ?? [] });
    const onlinePlayer = (color) => ({
      name: state.players[color].name || 'กำลังรอผู้เล่น',
      avatar: AVATAR_GLYPHS[state.players[color].avatar] ?? '♟',
    });
    this._setPlayersByColor(onlinePlayer('w'), onlinePlayer('b'));
    this._syncBoard();
    this._renderMoves();
    this._renderOnlineClock(state);
    this._renderOnlineAfk(state);

    if (state.status === 'waiting') {
      this.ui.setStatus(this.onlineRole === 'spectator' ? 'กำลังชมโต๊ะที่รอผู้เล่น' : 'ห้องพร้อมแล้ว — รอผู้เล่นจาก Lobby', 'busy');
    } else if (state.status === 'active') {
      if (this.onlineRole === 'spectator') this.ui.setStatus('กำลังรับชมการแข่งขันแบบสด', 'busy');
      else this.ui.setStatus(
          state.turn === this.onlineSide ? 'ถึงตาของคุณ' : 'รอคู่แข่งเดิน…',
          state.turn === this.onlineSide ? '' : 'busy',
        );
    } else {
      this._announceOnlineResult(state);
    }
  }

  /** Move / capture / check feedback for online games — the bot modes get it
   *  from _afterMove, which online never runs. Only a NEW ply in a live game
   *  makes noise: not the first snapshot (join / resume), not a rematch reset,
   *  not a game-ending move (the result sound covers that) and not while the
   *  review owns the screen. */
  _playOnlineMoveSound(state) {
    const previous = this._onlinePlyCount;
    this._onlinePlyCount = state.moves.length;
    if (previous === null || state.moves.length <= previous) return;
    if (state.status !== 'active' || this._reviewActive) return;
    const last = this.game.history({ verbose: true }).at(-1);
    if (!last) return;
    sounds.play(last.captured ? 'capture' : 'move');
    if (this.game.inCheck()) sounds.play('check');
    // A new ply that hands US the move while the tab is hidden: get attention.
    if (this.onlineRole !== 'spectator' && state.turn === this.onlineSide) {
      this.turnAlert?.notify('ถึงตาคุณ');
    }
  }

  /** Server-aligned now() — clock/AFK deadlines are server epochs and must
   *  not be extrapolated with the browser's possibly-skewed Date.now(). */
  _onlineNow() {
    return this.online?.now?.() ?? Date.now();
  }

  /** Rematch actions for the game-over card (roadmap B) — null for spectators,
   *  unfinished games, or non-online modes. */
  _onlineRematchActions() {
    if (this.mode !== MODES.ONLINE || this.onlineRole === 'spectator') return null;
    if (this.onlineState?.status !== 'finished') return null;
    const revision = this.onlineState.revision;
    const offer = this.onlineState.rematch;
    if (offer && offer.requestedBy !== this.onlineSide) {
      return {
        mode: 'accept',
        onAccept: () => this.online?.acceptRematch(revision),
        onDecline: () => this.online?.declineRematch(revision),
      };
    }
    if (offer) return { mode: 'waiting' };
    return { mode: 'request', onRequest: () => this.online?.requestRematch(revision) };
  }

  /** Non-blocking toast while review owns the screen (roadmap B). */
  _maybeNotifyReviewRematch(state) {
    if (!state.rematch || state.rematch.requestedBy === this.onlineSide) return;
    if (this._reviewRematchNotifiedFor === state.revision) return;
    this._reviewRematchNotifiedFor = state.revision;
    this.ui.showFloatingToast?.({
      title: 'คำขอรีเมตช์',
      detail: 'ฝ่ายตรงข้ามขอรีเมตช์ — ออกจากรีวิวเพื่อยอมรับหรือปฏิเสธ',
    });
  }

  _renderOnlineClock(state) {
    if (this._onlineClockTimer) clearInterval(this._onlineClockTimer);
    this._onlineClockTimer = null;
    if (!state.clock) {
      this.ui.showClocks(false);
      return;
    }
    this.ui.showClocks(true);
    const render = () => {
      const clock = state.clock;
      let whiteMs = clock.whiteMs;
      let blackMs = clock.blackMs;
      if (state.status === 'active' && clock.activeSince !== null) {
        const elapsed = Math.max(0, this._onlineNow() - clock.activeSince);
        if (state.turn === 'w') whiteMs = Math.max(0, whiteMs - elapsed);
        else blackMs = Math.max(0, blackMs - elapsed);
      }
      const topColor = this.orientation === 'white' ? 'b' : 'w';
      const topMs = topColor === 'w' ? whiteMs : blackMs;
      const bottomMs = topColor === 'w' ? blackMs : whiteMs;
      const isOnlineActive = state.status === 'active';
      this.ui.setClock('top', ChessClock.formatTime(topMs), isOnlineActive && state.turn === topColor, topMs <= 20_000);
      this.ui.setClock('bottom', ChessClock.formatTime(bottomMs), isOnlineActive && state.turn !== topColor, bottomMs <= 20_000);
    };
    render();
    if (state.status === 'active') this._onlineClockTimer = setInterval(render, 250);
  }

  _renderOnlineAfk(state) {
    if (this._onlineAfkTimer) clearInterval(this._onlineAfkTimer);
    this._onlineAfkTimer = null;
    const countdown = state.afk?.countdown;
    if (!countdown || state.status !== 'active') {
      this.ui.setAfkWarning?.({ visible: false });
      return;
    }
    const affectedName = state.players[countdown.color]?.name || (countdown.color === 'w' ? 'ฝ่ายขาว' : 'ฝ่ายดำ');
    const isSelf = countdown.color === this.onlineSide;
    const causes = {
      opening: 'ยังไม่เดินหมากในช่วงเปิดเกม',
      hidden: 'ออกจากแท็บระหว่างตาของตนเอง',
      heartbeat: 'ขาดการเชื่อมต่อกับห้อง',
      inactivity: 'ยังไม่เดินหมากเกิน 4 นาที',
    };
    const strikes = state.afk.strikes[countdown.color];
    const detail = countdown.cause === 'opening'
      ? causes.opening
      : `${causes[countdown.cause]} · คำเตือน ${strikes}/2`;
    const render = () => {
      const remainingSeconds = Math.max(0, Math.ceil((countdown.deadlineAt - this._onlineNow()) / 1_000));
      this.ui.setAfkWarning?.({
        visible: true,
        title: isSelf ? 'คุณกำลังถูกนับ AFK' : `${affectedName} กำลังถูกนับ AFK`,
        detail,
        remainingSeconds,
        danger: remainingSeconds <= 10,
      });
    };
    render();
    this._onlineAfkTimer = setInterval(render, 250);
  }

  _announceOnlineResult(state) {
    if (this._onlineClockTimer) {
      clearInterval(this._onlineClockTimer);
      this._onlineClockTimer = null;
    }
    if (this._overPopupShown) return;
    this._overPopupShown = true;
    const draw = state.result === '1/2-1/2';
    const won = !draw && ((state.result === '1-0' && this.onlineSide === 'w') || (state.result === '0-1' && this.onlineSide === 'b'));
    const title = this.onlineRole === 'spectator' ? 'เกมจบแล้ว' : draw ? 'เสมอกัน' : won ? 'คุณชนะ' : 'คุณแพ้';
    const reasons = {
      checkmate: 'รุกฆาต',
      draw: 'เสมอตามกติกา',
      resignation: 'มีผู้เล่นยอมแพ้',
      timeout: 'หมดเวลา',
      opening_afk_timeout: 'ไม่เดินหมากทันเวลาในช่วงเปิดเกม',
      unlimited_afk_timeout: 'หมดเวลานับถอยหลัง AFK',
      unlimited_afk_strikes: 'AFK ครบ 3 ครั้ง',
    };
    const detail = `${reasons[state.reason] ?? 'เกมจบแล้ว'} (${state.result})`;
    this.ui.setStatus(`จบเกม · ${title}`, 'done');
    this.ui.log(`จบเกมออนไลน์: ${title} — ${detail}`, 'sys');
    this.turnAlert?.notify(`จบเกม · ${title}`);

    // Cache the full game locally the moment it ends — the review must keep
    // working even if the opponent rage-quits right away (plan.md §5.2B).
    this._captureGameRecord({
      result: state.result,
      reason: state.reason,
      fromState: state,
    });
    this._showGameOverSoon(title, detail);
    const afkResult = ['opening_afk_timeout', 'unlimited_afk_timeout', 'unlimited_afk_strikes'].includes(state.reason);
    sounds.play(afkResult ? 'afk' : draw ? 'draw' : won ? 'victory' : 'lose');
  }

  // ------------------------------------------------------------------ game review

  /** Snapshot remaining clock time for the review replay — keyed by history
   *  length so undo() naturally invalidates later snapshots. */
  _pushClockSnapshot() {
    if (!this.clock || this.clock.unlimited) return;
    const ply = this.game.history().length;
    while (this._clockSnapshots.length && this._clockSnapshots[this._clockSnapshots.length - 1].ply >= ply) {
      this._clockSnapshots.pop();
    }
    this._clockSnapshots.push({ ply, w: this.clock.times.w, b: this.clock.times.b });
  }

  /** Snapshot the finished game into the mode-agnostic GameHistoryRecord
   *  (plan.md §5.1). Online games rebuild from the server state's UCI list. */
  _captureGameRecord({ result, reason, fromState = null } = {}) {
    try {
      let initialFen = this._gameInitialFen ?? null;
      let moves;
      let players;
      if (fromState) {
        initialFen = fromState.initialFen ?? initialFen;
        moves = fromState.moves.map((uci) => ({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        }));
        players = {
          white: { name: fromState.players.w.name },
          black: { name: fromState.players.b.name },
        };
      } else {
        const history = this.game.history({ verbose: true });
        if (!history.length) return;
        moves = history.map((m) => ({
          san: m.san,
          from: m.from,
          to: m.to,
          promotion: m.promotion || undefined,
        }));
        players = this._recordPlayers();
      }
      this._lastGameRecord = {
        initialFen,
        moves,
        result,
        reason,
        players,
        gamemode: this.mode === MODES.ANALYZE ? 'sandbox' : this.mode,
        times: this._clockSnapshots.map((s) => ({ ply: s.ply, w: s.w, b: s.b })),
        initial: this._recordInitialTimes(),
      };
    } catch (err) {
      // A broken record must never break the game-over flow — review is
      // simply unavailable for that game.
      this.ui.log(`บันทึกไว้รีวิวไม่สำเร็จ: ${err.message}`, 'warn');
    }
  }

  /** Starting clock times for the replay (null when the game had no clock). */
  _recordInitialTimes() {
    if (this.mode === MODES.ONLINE) {
      const clock = this.onlineState?.clock;
      return clock ? { w: clock.initialMs, b: clock.initialMs } : null;
    }
    if (this.clock && !this.clock.unlimited) {
      return { w: this.clock.initialMs, b: this.clock.initialMs };
    }
    return null;
  }

  _recordPlayers() {
    if (this.mode === MODES.ONLINE && this.onlineState?.players) {
      const p = this.onlineState.players;
      return { white: { name: p.w.name }, black: { name: p.b.name } };
    }
    if (this.mode === MODES.HUMAN_VS_AI) {
      const cfg = LEVELS[this.levelIndex];
      const engineName = `${ENGINE_NAME} Elo ${cfg?.elo ?? '?'}`;
      return this.humanSide === 'w'
        ? { white: { name: HUMAN_NAME }, black: { name: engineName } }
        : { white: { name: engineName }, black: { name: HUMAN_NAME } };
    }
    if (this.mode === MODES.AI_VS_AI) {
      const w = LEVELS[this.aivaLevelW];
      const b = LEVELS[this.aivaLevelB];
      return {
        white: { name: `${ENGINE_NAME} Elo ${w?.elo ?? '?'}` },
        black: { name: `${ENGINE_NAME} Elo ${b?.elo ?? '?'}` },
      };
    }
    return { white: { name: 'ฝ่ายขาว' }, black: { name: 'ฝ่ายดำ' } };
  }

  startReview() {
    if (this._reviewActive) return;
    if (!this._lastGameRecord?.moves?.length) {
      this.ui.log('ยังไม่มีประวัติเกมให้รีวิว', 'warn');
      this._reshowGameOver();
      return;
    }
    this._gameOverOverlay?.close();
    this._gameOverOverlay = null;
    this._reviewDisconnectNotified = false;
    // Spectator live analysis must not fight the review for the eval bar and
    // board arrows — pause it and resume when the review session ends.
    if (this.spectatorEval?.enabled) {
      this._spectatorAnalysisResume = true;
      this.spectatorEval.setEnabled(false);
      this.ui.refs.btnAnalysis?.setAttribute('aria-pressed', 'false');
    }

    // Hole 2 — clocks, AFK timers and engines stop the moment review begins.
    this.clock?.stop();
    if (this._onlineClockTimer) { clearInterval(this._onlineClockTimer); this._onlineClockTimer = null; }
    if (this._onlineAfkTimer) { clearInterval(this._onlineAfkTimer); this._onlineAfkTimer = null; }
    this.ui.setAfkWarning?.({ visible: false });
    this.engine?.stop();
    this.engineBlack?.stop();
    this.ui.setBusy?.(false);

    this._reviewActive = true;
    this.ground.cancelPremove?.();
    this.reviewUI = this.reviewUI ?? new ReviewUI();
    const run = ++this._reviewRun;
    const record = this._lastGameRecord;

    // Same finished game as last time: show the stored result straight away.
    if (this._lastAnalysis && this._lastAnalysisRecord === record) {
      this._analysis = this._lastAnalysis;
      this._showReviewSummary(this._lastAnalysis);
      return;
    }

    const analyzer = new GameReviewAnalyzer();
    this._activeAnalyzer = analyzer;
    // A cancelled/finished/superseded run must never touch the UI again.
    const isCurrent = () => run === this._reviewRun && this._reviewActive;
    this.reviewUI.showProgressModal(() => {
      analyzer.abort();
      this.reviewUI.closeProgressModal();
      this._finishReviewSession();
      this._reshowGameOver();
    });
    // Opening book (roadmap A2) loads lazily and never blocks/ breaks review —
    // a failed fetch resolves null and grading falls back to the old heuristic.
    getOpeningBook()
      .then((book) => {
        if (!isCurrent()) throw new Error('review_aborted'); // cancelled while the book loaded
        analyzer.openingBook = book;
        return analyzer.analyzeGame(record, (p) => {
          if (isCurrent()) this.reviewUI.updateProgress(p.percentage, p.currentPly, p.totalPlies);
        });
      })
      .then((analysis) => {
        if (this._activeAnalyzer === analyzer) this._activeAnalyzer = null;
        if (!isCurrent()) return; // cancelled while the tail ran
        this._analysis = analysis;
        this._lastAnalysis = analysis;
        this._lastAnalysisRecord = record;
        this.reviewUI.closeProgressModal();
        this._showReviewSummary(analysis);
      })
      .catch((err) => {
        if (this._activeAnalyzer === analyzer) this._activeAnalyzer = null;
        if (!isCurrent()) return; // cancel / superseded — already handled
        this.reviewUI?.closeProgressModal();
        if (err?.message === 'review_aborted') return;
        this._finishReviewSession();
        this._reportReviewFailure(err);
      });
  }

  _showReviewSummary(analysis) {
    this.reviewUI.showReviewSummaryModal(
      analysis,
      (ply) => this.enterBoardStepper(ply),
      () => { this._finishReviewSession(); this.newGame(); },
      () => { this._finishReviewSession(); this._reshowGameOver(); },
      () => { this.enterBoardStepper(0); this.reviewUI.startPuzzleRun(); },
    );
  }

  /** Analysis died (engine failed / went silent): say so and offer a retry —
   *  never leave the player on a bare board with no way back. */
  _reportReviewFailure(err) {
    const known = {
      engine_error: 'โหลดเอนจินวิเคราะห์ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
      engine_timeout: 'เอนจินวิเคราะห์ไม่ตอบสนอง — ลองใหม่อีกครั้ง',
    };
    const detail = known[err?.message] ?? `เกิดข้อผิดพลาดระหว่างวิเคราะห์: ${err?.message ?? 'ไม่ทราบสาเหตุ'}`;
    this.ui.log(`รีวิวล้มเหลว: ${detail}`, 'err');
    this._reshowGameOver();
    this.ui.showFloatingToast?.({
      title: 'รีวิวเกมไม่สำเร็จ',
      detail,
      actions: [['ลองใหม่', () => this.startReview(), true], ['ปิด']],
    });
  }

  enterBoardStepper(ply = 0) {
    if (!this._reviewActive || !this._analysis) return;
    this.reviewUI.enterStepperMode(this, this._analysis, ply);
  }

  exitReview() {
    if (!this._reviewActive) return;
    this.reviewUI?.exitStepperMode();
    this.reviewUI?.hideEvalBar();
    this._finishReviewSession();
    this._syncBoard();
    this._restoreClockDisplay();
    this._reshowGameOver();
  }

  /** Put the clock badges back to the game's final frozen times — the review
   *  stepper rewrote them with per-ply replay values. */
  _restoreClockDisplay() {
    if (this.mode === MODES.ONLINE) {
      if (this.onlineState) this._renderOnlineClock(this.onlineState);
      return;
    }
    if (!this.clock) return;
    this._renderClockTimes(this.clock.times, null);
  }

  _finishReviewSession() {
    this._reviewActive = false;
    this._reviewRun += 1; // invalidate any analyzer still running for this session
    this._analysis = null;
    // Resume the spectator live analysis it was paused for (roadmap C1).
    if (this._spectatorAnalysisResume) {
      this._spectatorAnalysisResume = false;
      if (this._spectatorAnalysisAllowed() && this.spectatorEval) {
        this.spectatorEval.setEnabled(true);
        this.spectatorEval.notifyPosition();
        this.ui.refs.btnAnalysis?.setAttribute('aria-pressed', 'true');
      }
    }
  }

  /** Pop the game-over card after a short beat so players can take in the
   *  final position first — game-over sounds already played immediately. */
  _showGameOverSoon(title, detail, delayMs = this._gameOverDelayMs) {
    this._lastGameOver = { title, detail };
    const open = () => {
      if (this._gameOverOverlay?.body?.isConnected) return;
      this._gameOverOverlay = this.ui.showGameOver(
        title,
        detail,
        () => this.newGame(),
        () => this.goHome(),
        () => this.startReview(),
        this._onlineRematchActions(),
        () => this._reshowGameOver(),
      );
      this._rematchCardKey = this._rematchStateKey();
    };
    if (!delayMs) {
      open();
      return;
    }
    if (this._gameOverDelayTimer) clearTimeout(this._gameOverDelayTimer);
    this._gameOverDelayTimer = setTimeout(() => {
      this._gameOverDelayTimer = null;
      open();
    }, delayMs);
  }

  _reshowGameOver() {
    if (!this._lastGameOver || this._gameOverOverlay?.body?.isConnected) return;
    this._gameOverOverlay = this.ui.showGameOver(
      this._lastGameOver.title,
      this._lastGameOver.detail,
      () => this.newGame(),
      () => this.goHome(),
      () => this.startReview(),
      this._onlineRematchActions(),
      () => this._reshowGameOver(),
    );
    this._rematchCardKey = this._rematchStateKey();
  }

  /** Identity of the rematch state the open card was rendered from — a change
   *  means the card's rematch buttons are stale and must be re-rendered. */
  _rematchStateKey() {
    if (this.onlineState?.status !== 'finished') return null;
    return `${this.onlineState.revision}:${this.onlineState.rematch ? this.onlineState.rematch.requestedBy : '-'}`;
  }

  /** Real online events during review surface as non-blocking corner toasts. */
  _maybeNotifyReviewDisconnect(state) {
    if (this._reviewDisconnectNotified || state.status !== 'finished') return;
    const disconnected = ['w', 'b'].filter((c) => state.players[c]?.connected === false);
    if (!disconnected.length) return;
    this._reviewDisconnectNotified = true;
    const name = state.players[disconnected[0]]?.name || 'คู่แข่ง';
    this.ui.showFloatingToast({
      title: `${name} ออกจากห้องแล้ว`,
      detail: 'คุณรีวิวเกมต่อได้ตามปกติ — ประวัติการเดินถูกเก็บไว้ในเครื่องแล้ว',
      actions: [['รู้แล้ว', () => {}]],
    });
  }

  // ------------------------------------------------------------------ internal flow

  /** Engine worker URL for GAME engines (roadmap D2) — honours the strong
   *  multi-thread preference, but only when the host supports it. Spectator
   *  analysis/ review/ forecast stay on the single build to save resources. */
  _engineUrl() {
    return resolveEngineWorkerUrl({ strong: getStrongEnginePreference() && isCrossOriginIsolated() });
  }

  /** Spectator live analysis (roadmap C1) — available only while WATCHING (AI
   *  vs AI arena or an online room as spectator), never while playing. */
  _spectatorAnalysisAllowed() {
    return this.mode === MODES.AI_VS_AI
      || (this.mode === MODES.ONLINE && this.onlineRole === 'spectator');
  }

  _ensureSpectatorAnalysis() {
    if (!this.spectatorEval) {
      this.spectatorEval = new SpectatorAnalysisEngine({
        fenProvider: () => this.game?.fen() ?? null,
      });
      this.spectatorEval.setHandler((result) => this._renderSpectatorAnalysis(result));
    }
    return this.spectatorEval;
  }

  /** Action-strip toggle — returns the new enabled state (or null if N/A). */
  toggleSpectatorAnalysis(force) {
    if (!this._spectatorAnalysisAllowed()) return null;
    const session = this._ensureSpectatorAnalysis();
    const next = session.setEnabled(typeof force === 'boolean' ? force : !session.enabled);
    this.ui.refs.btnAnalysis?.setAttribute('aria-pressed', String(next));
    if (!next) this._clearSpectatorAnalysisDisplay();
    else session.notifyPosition();
    return next;
  }

  _renderSpectatorAnalysis(result) {
    if (typeof document === 'undefined') return;
    if (this._reviewActive) return; // review owns the eval bar and arrows
    const bar = document.getElementById('eval-bar');
    if (!bar) return;
    if (!result) {
      bar.classList.add('hidden');
      this.ground?.setAutoShapes?.([]);
      return;
    }
    bar.classList.remove('hidden');
    const whitePct = Math.max(0, Math.min(100, result.whiteWinProb));
    bar.querySelector('[data-eval-fill]').style.height = `${whitePct}%`;
    const cp = result.whiteCp;
    const evalText = Math.abs(cp) >= 10000
      ? (cp > 0 ? 'M' : '-M')
      : (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
    bar.querySelector('[data-eval-label]').textContent = `${evalText} · d${result.depth}`;
    if (result.best && this.ground?.setAutoShapes) {
      this.ground.setAutoShapes([{ orig: result.best.from, dest: result.best.to, brush: 'green' }]);
    }
  }

  _clearSpectatorAnalysisDisplay() {
    if (typeof document === 'undefined') return;
    const bar = document.getElementById('eval-bar');
    bar?.classList.add('hidden');
    this.ground?.setAutoShapes?.([]);
  }

  _syncBoard() {
    // Review mode owns the board — game-driven syncs must not unlock it or
    // wipe the review arrows/ badges.
    if (this._reviewActive) return;
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
        premovable: { enabled: false },
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
      !this._isOver() &&
      (this.mode === MODES.ANALYZE ||
      (this.mode === MODES.HUMAN_VS_AI && this.game.turn() === this.humanSide) ||
      (this.mode === MODES.ONLINE && this._onlineHumanTurn()));

    // Highlight the REAL last move from chess.js history (from+to) so the
    // opponent's move is highlighted too — without this, chessground kept the
    // stale square pair from the human's drag after the bot moved.
    const lastVerbose = this.game.history({ verbose: true });
    const last = lastVerbose[lastVerbose.length - 1];

    // Premove: while it is the opponent's turn our side may still queue a move
    // (chessground allows it when movable.color is ours and it is not our turn).
    // The queued move is validated against our real dests once the turn comes.
    const premoveColor = this._premoveColor();
    this.ground.set({
      fen: this.game.fen(),
      orientation: this.orientation,
      turnColor: this.game.turn() === 'w' ? 'white' : 'black',
      check: this.game.inCheck(),
      lastMove: last ? [last.from, last.to] : undefined,
      selectable: { enabled: true },
      premovable: { enabled: Boolean(premoveColor) },
      movable: {
        free: false,
        color: isHumanTurn ? (this.game.turn() === 'w' ? 'white' : 'black') : (premoveColor ?? false),
        dests: isHumanTurn ? this._getDests() : new Map(),
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

    this._renderTurnIndicators();

    // Play a queued premove now that the turn is ours (chessground re-validates
    // it against our real dests and drops it if it became illegal); drop any
    // queued premove when premove is off (game over, spectator, review…).
    if (!premoveColor) this.ground.cancelPremove?.();
    else if (isHumanTurn) this.ground.playPremove?.();

    // Spectator live eval (roadmap C1) follows every displayed position change.
    this.spectatorEval?.notifyPosition();
  }

  /** The side that may queue a premove right now ('white' | 'black'), or null.
   *  Only real players in a live game: vs the bot, or a seated online player. */
  _premoveColor() {
    if (this._isOver() || this._reviewActive || this.viewerMode) return null;
    if (this.mode === MODES.HUMAN_VS_AI) return this.humanSide === 'w' ? 'white' : 'black';
    if (
      this.mode === MODES.ONLINE
      && this.onlineRole !== 'spectator'
      && this.onlineSide
      && this.onlineState?.status === 'active'
      && this.onlineConnectionState === 'connected'
    ) {
      return this.onlineSide === 'w' ? 'white' : 'black';
    }
    return null;
  }

  /** Highlight the player bar whose turn it is (follows the orientation). */
  _renderTurnIndicators() {
    const over = this._isOver();
    const topTurn = this.orientation === 'white' ? this.game.turn() === 'b' : this.game.turn() === 'w';
    this.ui.setPlayerActive('top', topTurn && !over);
    this.ui.setPlayerActive('bottom', !topTurn && !over);
  }

  /** Remember who plays which colour and paint the two bars for the current
   *  orientation. Modes call this instead of ui.setPlayers so a later flip can
   *  re-render the bars from the same source of truth. */
  _setPlayersByColor(white, black) {
    this._playersByColor = { w: white, b: black };
    this._renderPlayers();
  }

  _renderPlayers() {
    if (!this._playersByColor) return;
    const topColor = this.orientation === 'white' ? 'b' : 'w';
    const bottomColor = topColor === 'w' ? 'b' : 'w';
    this.ui.setPlayers(this._playersByColor[topColor], this._playersByColor[bottomColor]);
  }

  /** Repaint the clock badges after an orientation change. */
  _refreshClockDisplay() {
    if (this.mode === MODES.ONLINE) {
      if (this.onlineState) this._renderOnlineClock(this.onlineState);
      return;
    }
    if (!this.clock || this.clock.unlimited) return;
    this._renderClockTimes(this.clock.times, this.clock.active ? this.clock.turn : null);
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

  _afterMove(move) {
    this._renderMoves();
    this._syncBoard();

    const over = this._isOver();
    if (this.clock) {
      if (over) {
        this.clock.stop();
      } else {
        this.clock.switchTurn(this.game.turn());
      }
      this._pushClockSnapshot();
    }

    if (over) {
      if (this.clock) {
        this.clock.stop();
        this._restoreClockDisplay();
      }
      this._announceGameOver();
      return;
    } else if (this.mode !== MODES.ANALYZE) {
      // move / capture / check feedback (human or bot) — silent in
      // sandbox / custom (analyze) mode.
      if (move.captured) sounds.play('capture');
      else sounds.play('move');
      if (this.game.inCheck()) sounds.play('check');
    }

    if (this.mode === MODES.HUMAN_VS_AI && this.game.turn() !== this.humanSide) {
      this._engineTurn();
    } else if (this.mode === MODES.HUMAN_VS_AI) {
      // The engine's "thinking…" status must not outlive its move.
      this.ui.setStatus('ถึงตาของคุณ', '');
      this.turnAlert?.notify('ถึงตาคุณ');
    } else if (this.mode === MODES.AI_VS_AI) {
      this._maybeStartAiLoop();
    }
  }

  /**
   * Humanized engine thinking (see src/thinktime.js): a time-control scaled,
   * position-aware pause, capped by what the moving side's own clock can afford
   * so the bot never flags itself. Returns { delay, search }: delay = thinking
   * pause, search = UCI movetime for the timed modes.
   */
  _thinkTime() {
    const tc = TIME_CONTROLS.find((t) => t.id === this.timeControlId);
    const side = this.game.turn();
    const timed = this.clock && !this.clock.unlimited;
    let legalMoves = 25;
    let pieceCount = 32;
    let lastWasCaptureOrCheck = false;
    try {
      legalMoves = this.game.moves().length;
      pieceCount = this.game.board().flat().filter(Boolean).length;
      const history = this.game.history({ verbose: true });
      const last = history[history.length - 1];
      lastWasCaptureOrCheck = Boolean(last && (last.captured || last.san.includes('+')));
    } catch { /* custom boards without moves are handled elsewhere */ }
    const plan = planThinkTime({
      tcId: this.timeControlId,
      initialMs: tc?.initialMs ?? 0,
      level: this._activeEngineLevel(),
      historyLength: this.game.history().length,
      legalMoves,
      pieceCount,
      inCheck: this.game.inCheck(),
      lastWasCaptureOrCheck,
      remainingMs: timed ? this.clock.times[side] : null,
      incrementMs: timed ? this.clock.incrementMs : 0,
    });
    return { delay: plan.delay, search: plan.search };
  }

  /** 1-based level of the engine whose turn it is (drives thinking pace). */
  _activeEngineLevel() {
    if (this.mode === MODES.AI_VS_AI) {
      return (this.game.turn() === 'w' ? this.aivaLevelW : this.aivaLevelB) + 1;
    }
    return this.levelIndex + 1;
  }

  _engineTurn() {
    if (!this.engine || !this.engineReady || this.engineBusy || this._isOver()) return;
    this.engineBusy = true;
    this.ui.setBusy?.(true);
    this.ui.setStatus('เอนจินกำลังคิด…', 'busy');
    const cfg = LEVELS[this.levelIndex];
    const { delay, search } = this._thinkTime();
    const fen = this.game.fen();
    this._aiTimer = setTimeout(() => {
      if (this._isOver() || !this.engine || !this.engineReady) return;
      this.engine.setPosition(fen);
      // Timed games search for the clock-governed time (never more than the
      // level's own movetime); untimed games use the level's full movetime.
      const timed = this.clock && !this.clock.unlimited;
      const movetime = timed ? Math.min(cfg.movetime, search ?? 500) : cfg.movetime;
      this.engine.go({ movetime, depth: cfg.depth });
    }, delay);
  }

  _onEngineBestMove(uci) {
    this.engineBusy = false;
    this.ui.setBusy?.(false);
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
    this.ui.setBusy?.(false);
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
    this.ui.setBusy?.(true);
    this.ui.setStatus('บอท GM กำลังคิดคำใบ้…', 'busy');
    if (!this.hintEngine) {
      this.hintEngine = new Stockfish({
        workerUrl: getStrongEnginePreference() && isCrossOriginIsolated() ? ENGINE_MULTI_URL : ENGINE_HINT_URL,
        onReady: () => {
          if (!this.hintEngine) return;
          this.hintEngine.setOption('Skill Level', 20);
          this.hintEngine.setOption('Hash', 64);
          this._hintGo();
        },
        onBestMove: (uci) => this._applyHint(uci),
        onError: (msg) => {
          this._failHint(`เอนจินคำใบ้ผิดพลาด: ${msg}`);
        },
      });
    } else {
      this._hintGo();
    }
  }

  /** Reset hint state and drop a dead/ wedged hint worker so the next click
   *  recreates it — without this the button bricks after one worker error. */
  _failHint(logMessage) {
    this.hintBusy = false;
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
    if (this.hintEngine) { this.hintEngine.quit(); this.hintEngine = null; }
    this.ui.setBusy?.(false);
    this.ui.log(logMessage, 'err');
    this.ui.setStatus('คำใบ้ใช้ไม่ได้ตอนนี้ — ลองอีกครั้ง', '');
  }

  _hintGo() {
    if (!this.hintEngine || !this.hintEngine.ready || !this.hintBusy) return;
    this.hintEngine.setPosition(this.game.fen());
    this.hintEngine.go({ movetime: 3500, depth: 20 });
    // Watchdog: a hung worker must not leave the button stuck at "thinking".
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this._hintTimer = null;
      if (this.hintBusy) this._failHint('หมดเวลารอคำใบ้จากเอนจิน');
    }, 8000);
  }

  _applyHint(uci) {
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
    this.hintBusy = false;
    this.ui.setBusy?.(false);
    if (!uci || uci === '(none)') {
      this.ui.log('ไม่มีคำใบ้สำหรับตำแหน่งนี้', 'warn');
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
    this.ui.log(`คำใบ้: เดิน ${pieceLabel} ${orig} → ${dest}`, 'hint');
    this.ui.setStatus('คำใบ้แสดงบนกระดานแล้ว', '');
  }

  _maybeStartAiLoop() {
    if (this.engineBusy || this._isOver() || this.paused) return;
    const turn = this.game.turn();
    const activeEngine = turn === 'w' ? this.engine : this.engineBlack;
    if (!activeEngine || !this.engineReady) return;

    this.engineBusy = true;
    this.ui.setBusy?.(true);
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

  _isOver() {
    return this.game.isGameOver() || this._isTimeout;
  }

  _announceGameOver() {
    if (this.clock) {
      this.clock.stop();
      this._restoreClockDisplay();
    }
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

    this.turnAlert?.notify(`จบเกม · ${title}`);
    this._captureGameRecord({
      result: this.game.isCheckmate() ? (this.game.turn() === 'w' ? '0-1' : '1-0') : '1/2-1/2',
      reason: this.game.isCheckmate()
        ? 'checkmate'
        : this.game.isStalemate() ? 'stalemate' : 'draw',
    });

    this.ui.setStatus(`จบเกม · ${title}`, 'done');
    this.ui.log(`จบเกม: ${title} (${detail})`, 'sys');

    if (!this._overPopupShown) {
      this._overPopupShown = true;
      this._showGameOverSoon(title, detail);
    }

    this._playGameOverSound();
  }

  /** Win (victory1+victory2 together) / lose / draw sounds — only when a
   *  human is playing. AI vs AI / analyze stay silent. */
  _playGameOverSound() {
    let humanSide = null;
    if (this.mode === MODES.HUMAN_VS_AI) humanSide = this.humanSide;
    else if (this.mode === MODES.ONLINE) humanSide = this.onlineSide;
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
