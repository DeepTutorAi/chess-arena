// UI layer — pure DOM helpers. The controller drives the game and calls into
// this module; nothing here knows about chess rules or the engine.

import { AVATAR_GLYPHS } from './online.js';
import {
  iconUndo,
  iconHint,
  iconFlag,
  iconFlip,
  iconPause,
  iconPlay,
  iconSound,
  iconHome,
  iconShare,
  iconRefresh,
  iconSwords,
  iconLink,
  iconBolt,
  iconBot,
  iconArena,
  iconWrench,
  iconUser,
  iconRobot,
  iconRating,
  iconMove,
  iconPalette,
  iconTrash,
  iconList,
  iconTerminal,
} from './icons.js';

const $ = (sel) => document.querySelector(sel);

export class UI {
  constructor(root) {
    this._activeModalClose = null;
    root.innerHTML = `
      <header class="topbar">
        <button class="brand" id="brand-home" type="button">
          <span class="brand-mark">♞</span> Chess Arena
        </button>

        <!-- PROFILE PLACEHOLDER (RIGHT TOPBAR) -->
        <button class="profile-badge-placeholder" id="profile-btn" type="button" title="โปรไฟล์ผู้เล่น (ระบบสมาชิกเร็วๆ นี้)">
          <span class="user-avatar">${iconUser({ size: 16 })}</span>
          <span class="user-info">
            <span class="user-name">Guest Player</span>
            <span class="user-rating">${iconRating({ size: 12 })} 1500</span>
          </span>
        </button>
      </header>

      <main class="app-viewport">
        <!-- HOME SCREEN (IMAGE 2 CHESS IN THE PARK STYLE) -->
        <section id="home-view" class="home-view">
          <div class="park-hero-container">
            <div class="park-logo-wrap">
              <img src="./assets/chess_arena_3d_logo.jpg" alt="Chess Arena 3D" class="park-logo-3d-img" />
              <p class="park-logo-sub">BROWSER CHESS ARENA 2026</p>
            </div>
            
            <div class="park-hero-cards">
              <button id="hero-create-btn" class="park-action-card create-card">
                <div class="card-icon-3d-wrap">
                  <img src="./assets/icons/btn_create_3d.jpg" alt="Create Game" class="card-icon-3d-img" />
                </div>
                <div class="card-text">CREATE GAME</div>
                <div class="card-sub">สร้างห้อง / เลือกโหมด</div>
              </button>

              <button id="hero-join-btn" class="park-action-card join-card">
                <div class="card-icon-3d-wrap">
                  <img src="./assets/icons/btn_join_3d.jpg" alt="Join Game" class="card-icon-3d-img" />
                </div>
                <div class="card-text">JOIN GAME</div>
                <div class="card-sub">เข้าร่วมห้องประลอง</div>
              </button>
            </div>
          </div>
        </section>

        <!-- GAME PLAY VIEW (CHESS.COM STYLE — 100VH FIT) -->
        <section id="game-view" class="game-view hidden">
          <div class="chesscom-layout" id="game-layout">
            
            <!-- LEFT PANEL FOR SANDBOX MODE (MODE SELECTOR & SETTINGS) -->
            <aside class="sidebar sandbox-left-panel hidden" id="sandbox-left-panel">
              <h3 class="sandbox-tool-title">${iconWrench({ size: 18 })} เลือกโหมด & ตั้งค่า</h3>

              <div style="font-size:11px; color:var(--muted);">เลือกโหมดเกม (หากไม่เลือก = โหมด Solo ฝึกซ้อมเดินหมากทั้ง 2 ฝ่าย):</div>

              <div style="display:flex; flex-direction:column; gap:8px;">
                <button class="sandbox-mode-opt-btn" id="sb-mode-online" data-mode="online">
                  <span class="m-icon">${iconBolt({ size: 16 })}</span>
                  <span>เล่นออนไลน์ (Online)</span>
                </button>
                <button class="sandbox-mode-opt-btn" id="sb-mode-bot" data-mode="hva">
                  <span class="m-icon">${iconBot({ size: 16 })}</span>
                  <span>เล่นกับบอท (Stockfish)</span>
                </button>
                <button class="sandbox-mode-opt-btn" id="sb-mode-aiva" data-mode="aiva">
                  <span class="m-icon">${iconArena({ size: 16 })}</span>
                  <span>AI vs AI Arena</span>
                </button>
              </div>

              <div id="sb-solo-notice" class="sandbox-solo-notice">
                <span class="solo-notice-icon">${iconHint({ size: 14 })}</span> <b>โหมด Solo ฝึกซ้อม:</b> ขยับเดินหมากได้ทั้งขาวและดำแบบอิสระ
              </div>

              <!-- SUB SETTINGS CONTAINER -->
              <div id="sb-sub-settings" class="sandbox-sub-settings hidden">
                <div id="sb-setting-bot" class="field hidden">
                  <span class="field-label">ระดับบอท AI: <b id="sb-bot-level-label">Elo 1400</b></span>
                  <input type="range" id="sb-bot-slider" min="1" max="11" value="4" step="1" />
                </div>

                <div id="sb-setting-color" class="field hidden">
                  <span class="field-label" id="sb-color-label">คุณเล่นเป็นฝ่าย</span>
                  <div class="radio-row" id="sb-color-container"></div>
                </div>

                <div id="sb-setting-aiva" class="field hidden">
                  <span class="field-label">ระดับเอนจินฝ่ายขาว: <b id="sb-aiva-w-label">Elo 1800</b></span>
                  <input type="range" id="sb-aiva-w-slider" min="1" max="11" value="6" step="1" />
                  <span class="field-label" style="margin-top:4px;">ระดับเอนจินฝ่ายดำ: <b id="sb-aiva-b-label">Elo 1200</b></span>
                  <input type="range" id="sb-aiva-b-slider" min="1" max="11" value="3" step="1" />
                </div>

                <div id="sb-setting-tc" class="field">
                  <span class="field-label">ตั้งค่าเวลา (Time Control)</span>
                  <div class="radio-row tc-radio-row" id="sb-tc-container"></div>
                </div>
              </div>

              <!-- ACTION BUTTONS ROW -->
              <div class="sandbox-action-row">
                <button id="sb-reset-board-btn" class="sandbox-action-btn" title="รีเซ็ตตำแหน่งกระดาน">
                  <span class="btn-svg">${iconRefresh({ size: 15 })}</span> รีเซ็ตกระดาน
                </button>
                <button id="sb-back-menu-btn" class="sandbox-action-btn" title="กลับหน้าแรก">
                  <span class="btn-svg">${iconHome({ size: 15 })}</span> กลับหน้า Menu
                </button>
              </div>
            </aside>

            <!-- CENTER: CHESS BOARD & PLAYER BARS -->
            <div class="board-container">
              <!-- TOP PLAYER -->
              <div class="player-bar top-player" id="player-bar-top">
                <div class="player-profile">
                  <div class="avatar" id="avatar-top">${iconRobot({ size: 22 })}</div>
                  <div class="player-meta">
                    <span class="pname" id="name-top">Stockfish 18</span>
                    <div class="player-subrow">
                      <span class="pinfo" id="info-top"></span>
                      <span class="score-badge" id="score-top"></span>
                    </div>
                    <div class="captured-row" id="captured-top"></div>
                  </div>
                </div>
                <div class="clock-badge" id="clock-top">--:--</div>
              </div>

              <!-- BOARD WRAPPER -->
              <div id="board" class="board-wrap"></div>

              <!-- BOTTOM PLAYER -->
              <div class="player-bar bottom-player" id="player-bar-bottom">
                <div class="player-profile">
                  <div class="avatar" id="avatar-bottom">${iconUser({ size: 22 })}</div>
                  <div class="player-meta">
                    <span class="pname" id="name-bottom">คุณ</span>
                    <div class="player-subrow">
                      <span class="pinfo" id="info-bottom"></span>
                      <span class="score-badge" id="score-bottom"></span>
                    </div>
                    <div class="captured-row" id="captured-bottom"></div>
                  </div>
                </div>
                <div class="clock-badge" id="clock-bottom">--:--</div>
              </div>

              <div id="status" class="status-bar">กำลังเตรียมพร้อม…</div>
            </div>

            <!-- RIGHT SIDEBAR (CHESS.COM MOVES & CONTROLS) -->
            <aside class="sidebar" id="game-sidebar">
              <div class="sidebar-header">
                <button class="tab-btn active" id="tab-moves" type="button">${iconList({ size: 15 })} รายการเดิน</button>
                <button class="tab-btn" id="tab-log" type="button">${iconTerminal({ size: 15 })} สัญญาณ / Log</button>
              </div>

              <div class="spectator-control hidden" id="spectator-control">
                <button id="spectator-btn" class="spectator-eye-btn" type="button" aria-haspopup="dialog" aria-expanded="false">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                  <span id="spectator-count">0</span>
                </button>
                <div id="spectator-panel" class="spectator-panel" role="dialog" aria-modal="false" aria-label="รายชื่อผู้ชม" hidden>
                  <div class="spectator-panel-head">
                    <strong>ผู้ชมการแข่งขัน</strong>
                    <button id="spectator-close" type="button" aria-label="ปิดรายชื่อผู้ชม">✕</button>
                  </div>
                  <div id="spectator-list" class="spectator-list"></div>
                </div>
              </div>

              <div id="afk-warning" class="afk-warning hidden" role="status" aria-live="polite" aria-atomic="true">
                <div class="afk-warning-copy">
                  <strong id="afk-warning-title"></strong>
                  <span id="afk-warning-detail"></span>
                </div>
                <span id="afk-warning-countdown" class="afk-warning-countdown"></span>
              </div>

              <div class="sidebar-content">
                <div id="moves-container" class="moves-container">
                  <div id="moves" class="moves-list"></div>
                </div>
                <div id="log-container" class="log-container hidden">
                  <div id="log" class="log-list"></div>
                </div>
              </div>

              <!-- CHESS.COM ACTION STRIP BUTTONS -->
              <div class="action-strip">
                <button id="btn-undo" class="action-btn" title="ย้อนเดิน (Undo)">
                  <span class="icon">${iconUndo({ size: 18 })}</span>
                  <span class="label">ย้อน</span>
                </button>
                <button id="btn-hint" class="action-btn hidden" title="คำใบ้จากบอทระดับ GM (Hint)">
                  <span class="icon">${iconHint({ size: 18 })}</span>
                  <span class="label">คำใบ้</span>
                </button>
                <button id="btn-resign" class="action-btn danger" title="ยอมแพ้ (Resign)">
                  <span class="icon">${iconFlag({ size: 18 })}</span>
                  <span class="label">ยอมแพ้</span>
                </button>
                <button id="btn-share" class="action-btn hidden" title="แชร์ห้อง (Share Room)">
                  <span class="icon">${iconShare({ size: 18 })}</span>
                  <span class="label">แชร์</span>
                </button>
                <button id="btn-flip" class="action-btn hidden" title="กลับกระดาน (Flip Board)">
                  <span class="icon">${iconFlip({ size: 18 })}</span>
                  <span class="label">กลับกระดาน</span>
                </button>
                <button id="btn-pause" class="action-btn hidden" title="หยุด/เล่นต่อ (Pause/Resume)">
                  <span class="icon">${iconPause({ size: 18 })}</span>
                  <span class="label">หยุด</span>
                </button>
                <button id="btn-sound" class="action-btn" type="button" title="เปิด/ปิดเสียง" aria-pressed="false">
                  <span class="icon">${iconSound({ size: 18 })}</span>
                  <span class="label">เสียง</span>
                </button>
                <button id="btn-home" class="action-btn" title="กลับหน้าแรก (Home)">
                  <span class="icon">${iconHome({ size: 18 })}</span>
                  <span class="label">หน้าแรก</span>
                </button>
              </div>
            </aside>

            <!-- SANDBOX BOARD EDITOR RIGHT PANEL (PIECE PALETTE) -->
            <aside class="sidebar sandbox-editor-panel hidden" id="sandbox-tools">
              <h3 class="sandbox-tool-title">${iconWrench({ size: 18 })} จัดแต่งกระดาน (Sandbox)</h3>
              
              <div class="sandbox-mode-selector">
                <button class="sandbox-mode-btn active" id="sb-tool-move"><span class="btn-svg">${iconMove({ size: 16 })}</span> ย้ายตำแหน่ง</button>
                <button class="sandbox-mode-btn" id="sb-tool-replace"><span class="btn-svg">${iconPalette({ size: 16 })}</span> แทนที่ตัวหมาก</button>
              </div>

              <div class="sandbox-palette-label">เลือกตัวหมากมาวางแทนที่:</div>
              <div class="sandbox-piece-grid" id="sandbox-piece-grid">
                <button class="piece-btn active" data-piece="q"><span class="p-icon">♛</span><span class="p-name">Queen</span></button>
                <button class="piece-btn" data-piece="r"><span class="p-icon">♜</span><span class="p-name">Rook</span></button>
                <button class="piece-btn" data-piece="b"><span class="p-icon">♝</span><span class="p-name">Bishop</span></button>
                <button class="piece-btn" data-piece="n"><span class="p-icon">♞</span><span class="p-name">Knight</span></button>
                <button class="piece-btn" data-piece="p"><span class="p-icon">♟</span><span class="p-name">Pawn</span></button>
                <button class="piece-btn delete-btn" data-piece="delete"><span class="p-icon">${iconTrash({ size: 18 })}</span><span class="p-name">ลบหมาก</span></button>
              </div>

              <div class="sandbox-rule-notice">
                📌 <b>กฎการจัดกระดาน:</b><br/>
                • King สามารถย้ายตำแหน่งได้เฉพาะใน 2 แถวแรก<br/>
                • การเพิ่ม/แทนที่หมากทำได้เฉพาะใน 2 แถวแรกของแต่ละฝั่ง
              </div>

              <button id="sb-start-game-btn" class="sandbox-start-btn"><span class="btn-svg">${iconSwords({ size: 18 })}</span> เริ่มเล่นเกมตามที่จัด</button>
            </aside>
          </div>
        </section>
      </main>

      <div id="modal-root"></div>
    `;

    this.refs = {
      topbar: $('.topbar'),
      homeView: $('#home-view'),
      gameView: $('#game-view'),
      gameLayout: $('#game-layout'),
      gameSidebar: $('#game-sidebar'),
      sandboxTools: $('#sandbox-tools'),
      sandboxLeftPanel: $('#sandbox-left-panel'),

      brandHome: $('#brand-home'),
      profileBtn: $('#profile-btn'),
      heroCreateBtn: $('#hero-create-btn'),
      heroJoinBtn: $('#hero-join-btn'),

      status: $('#status'),
      board: $('#board'),
      moves: $('#moves'),
      log: $('#log'),
      movesContainer: $('#moves-container'),
      logContainer: $('#log-container'),
      sidebarContent: $('.sidebar-content'),
      tabMoves: $('#tab-moves'),
      tabLog: $('#tab-log'),

      playerBarTop: $('#player-bar-top'),
      playerBarBottom: $('#player-bar-bottom'),
      nameTop: $('#name-top'),
      nameBottom: $('#name-bottom'),
      infoTop: $('#info-top'),
      infoBottom: $('#info-bottom'),
      scoreTop: $('#score-top'),
      scoreBottom: $('#score-bottom'),
      capturedTop: $('#captured-top'),
      capturedBottom: $('#captured-bottom'),
      avatarTop: $('#avatar-top'),
      avatarBottom: $('#avatar-bottom'),
      clockTop: $('#clock-top'),
      clockBottom: $('#clock-bottom'),

      btnUndo: $('#btn-undo'),
      btnHint: $('#btn-hint'),
      btnResign: $('#btn-resign'),
      btnShare: $('#btn-share'),
      btnFlip: $('#btn-flip'),
      btnPause: $('#btn-pause'),
      btnSound: $('#btn-sound'),
      btnHome: $('#btn-home'),
      spectatorControl: $('#spectator-control'),
      spectatorButton: $('#spectator-btn'),
      spectatorCount: $('#spectator-count'),
      spectatorPanel: $('#spectator-panel'),
      spectatorClose: $('#spectator-close'),
      spectatorList: $('#spectator-list'),
      afkWarning: $('#afk-warning'),
      afkWarningTitle: $('#afk-warning-title'),
      afkWarningDetail: $('#afk-warning-detail'),
      afkWarningCountdown: $('#afk-warning-countdown'),
      modalRoot: $('#modal-root'),

      // Sandbox Editor refs (Right panel)
      sbToolMove: $('#sb-tool-move'),
      sbToolReplace: $('#sb-tool-replace'),
      sbPieceGrid: $('#sandbox-piece-grid'),
      sbStartGameBtn: $('#sb-start-game-btn'),

      // Sandbox Left Panel refs
      sbModeOnline: $('#sb-mode-online'),
      sbModeBot: $('#sb-mode-bot'),
      sbModeAiva: $('#sb-mode-aiva'),
      sbSoloNotice: $('#sb-solo-notice'),
      sbSubSettings: $('#sb-sub-settings'),
      sbSettingBot: $('#sb-setting-bot'),
      sbBotSlider: $('#sb-bot-slider'),
      sbBotLevelLabel: $('#sb-bot-level-label'),
      sbSettingColor: $('#sb-setting-color'),
      sbColorLabel: $('#sb-color-label'),
      sbColorContainer: $('#sb-color-container'),
      sbSettingAiva: $('#sb-setting-aiva'),
      sbAivaWSlider: $('#sb-aiva-w-slider'),
      sbAivaWLabel: $('#sb-aiva-w-label'),
      sbAivaBSlider: $('#sb-aiva-b-slider'),
      sbAivaBLabel: $('#sb-aiva-b-label'),
      sbTcContainer: $('#sb-tc-container'),
      sbResetBoardBtn: $('#sb-reset-board-btn'),
      sbBackMenuBtn: $('#sb-back-menu-btn'),
    };

    this.refs.spectatorButton.onclick = () => this._setSpectatorPanel(this.refs.spectatorPanel.hidden);
    this.refs.spectatorClose.onclick = () => this._setSpectatorPanel(false);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.refs.spectatorPanel.hidden) this._setSpectatorPanel(false);
    });
  }

  // ---- Navigation Views ----------------------------------------------------
  showHomeView() {
    this.refs.topbar.classList.remove('hidden');
    this.refs.homeView.classList.remove('hidden');
    this.refs.gameView.classList.add('hidden');
    document.body.style.overflow = 'auto';
  }

  /** Clear sandbox mode-panel state (mode buttons, sub-settings). */
  resetSandboxPanel() {
    for (const b of [this.refs.sbModeOnline, this.refs.sbModeBot, this.refs.sbModeAiva]) {
      b.classList.remove('active');
    }
    this.refs.sbSoloNotice.classList.remove('hidden');
    this.refs.sbSubSettings.classList.add('hidden');
    this.refs.sbSettingBot.classList.add('hidden');
    this.refs.sbSettingColor.classList.add('hidden');
    this.refs.sbSettingAiva.classList.add('hidden');
  }

  showGameView({ sandboxMode = false } = {}) {
    this.refs.topbar.classList.add('hidden');
    this.refs.homeView.classList.add('hidden');
    this.refs.gameView.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    if (sandboxMode) {
      this.refs.gameLayout.classList.add('sandbox-layout');
      this.refs.gameSidebar.classList.add('hidden');
      this.refs.sandboxLeftPanel.classList.remove('hidden');
      this.refs.sandboxTools.classList.remove('hidden');
    } else {
      this.refs.gameLayout.classList.remove('sandbox-layout');
      this.refs.sandboxLeftPanel.classList.add('hidden');
      this.refs.sandboxTools.classList.add('hidden');
      this.refs.gameSidebar.classList.remove('hidden');
    }
  }

  // ---- action strip (per-mode buttons) -------------------------------------
  setActionStrip({ undo = true, resign = true, flip = false, pause = false, hint = false } = {}) {
    this.refs.btnUndo.classList.toggle('hidden', !undo);
    this.refs.btnResign.classList.toggle('hidden', !resign);
    this.refs.btnFlip.classList.toggle('hidden', !flip);
    this.refs.btnPause.classList.toggle('hidden', !pause);
    this.refs.btnHint.classList.toggle('hidden', !hint);
  }

  setOnlineRole(role) {
    if (role === 'spectator') {
      this.refs.btnResign.classList.add('hidden');
      this.refs.btnUndo.classList.add('hidden');
    }
  }

  setShareVisible(visible) {
    this.refs.btnShare.classList.toggle('hidden', !visible);
  }

  setSpectators({ visible = false, spectators = [] } = {}) {
    this.refs.spectatorControl.classList.toggle('hidden', !visible);
    if (!visible) this._setSpectatorPanel(false, { restoreFocus: false });
    this.refs.spectatorCount.textContent = String(spectators.length);
    this.refs.spectatorButton.setAttribute('aria-label', `ผู้ชม ${spectators.length} คน`);
    this.refs.spectatorList.innerHTML = '';
    if (!spectators.length) {
      this.refs.spectatorList.appendChild(this.el('p', 'spectator-empty', 'ยังไม่มีผู้ชม'));
      return;
    }
    const glyphs = AVATAR_GLYPHS;
    for (const profile of spectators) {
      const item = this.el('div', 'spectator-profile');
      item.append(
        this.el('span', `spectator-avatar avatar-${profile.avatar}`, glyphs[profile.avatar] ?? '♞'),
        this.el('span', 'spectator-name', profile.name),
        this.el('span', 'spectator-state', 'Watching'),
      );
      this.refs.spectatorList.appendChild(item);
    }
  }

  setAfkWarning({ visible = false, title = '', detail = '', remainingSeconds = 0, danger = false } = {}) {
    this.refs.afkWarning.classList.toggle('hidden', !visible);
    this.refs.afkWarning.classList.toggle('danger', visible && danger);
    if (!visible) {
      this.refs.afkWarningTitle.textContent = '';
      this.refs.afkWarningDetail.textContent = '';
      this.refs.afkWarningCountdown.textContent = '';
      return;
    }
    this.refs.afkWarningTitle.textContent = title;
    this.refs.afkWarningDetail.textContent = detail;
    this.refs.afkWarningCountdown.textContent = String(Math.max(0, remainingSeconds));
  }

  _setSpectatorPanel(open, { restoreFocus = true } = {}) {
    this.refs.spectatorPanel.hidden = !open;
    this.refs.spectatorButton.setAttribute('aria-expanded', String(open));
    if (open) this.refs.spectatorClose.focus();
    else if (restoreFocus) this.refs.spectatorButton.focus();
  }

  setPauseState(paused) {
    this.refs.btnPause.querySelector('.icon').innerHTML = paused ? iconPlay({ size: 18 }) : iconPause({ size: 18 });
    this.refs.btnPause.querySelector('.label').textContent = paused ? 'ต่อ' : 'หยุด';
  }

  // ---- material score + captured pieces ------------------------------------
  setScore(side, text) {
    const el = side === 'top' ? this.refs.scoreTop : this.refs.scoreBottom;
    if (el) el.textContent = text;
  }

  setCaptured(side, roles, iconColor) {
    const el = side === 'top' ? this.refs.capturedTop : this.refs.capturedBottom;
    if (!el) return;
    el.innerHTML = '';
    const roleNames = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
    for (const r of roles) {
      const wrap = document.createElement('span');
      wrap.className = 'cg-wrap captured-mini';
      wrap.innerHTML = `<piece class="${iconColor} ${roleNames[r] ?? r}"></piece>`;
      el.appendChild(wrap);
    }
  }

  // ---- Sidebar Tabs --------------------------------------------------------
  showTab(tabName) {
    if (tabName === 'moves') {
      this.refs.tabMoves.classList.add('active');
      this.refs.tabLog.classList.remove('active');
      this.refs.movesContainer.classList.remove('hidden');
      this.refs.logContainer.classList.add('hidden');
    } else {
      this.refs.tabLog.classList.add('active');
      this.refs.tabMoves.classList.remove('active');
      this.refs.logContainer.classList.remove('hidden');
      this.refs.movesContainer.classList.add('hidden');
    }
  }

  // ---- Clocks --------------------------------------------------------------
  setClock(side, text, active = false, lowTime = false) {
    const el = side === 'top' ? this.refs.clockTop : this.refs.clockBottom;
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('active', active);
    el.classList.toggle('low-time', lowTime);
  }

  showClocks(visible = true) {
    this.refs.clockTop.style.display = visible ? 'flex' : 'none';
    this.refs.clockBottom.style.display = visible ? 'flex' : 'none';
  }

  // ---- status pill -------------------------------------------------------
  setStatus(text, cls = '') {
    this.refs.status.className = `status-bar ${cls}`;
    this.refs.status.textContent = text;
    this.refs.status.setAttribute('role', 'status');
  }

  /** Dim board-blocking actions while the engine (or hint search) is busy. */
  setBusy(busy) {
    this.refs.btnUndo.disabled = Boolean(busy);
    this.refs.btnHint.disabled = Boolean(busy);
  }

  // ---- players -----------------------------------------------------------
  setPlayers(top, bottom) {
    this.refs.nameTop.textContent = top.name ?? '—';
    this.refs.nameBottom.textContent = bottom.name ?? '—';
    if (top.avatar) this.refs.avatarTop.textContent = top.avatar;
    if (bottom.avatar) this.refs.avatarBottom.textContent = bottom.avatar;
  }

  setPlayerActive(side, active) {
    const bar = side === 'top' ? this.refs.playerBarTop : this.refs.playerBarBottom;
    bar.classList.toggle('turn-active', active);
  }

  setPlayerDone(side) {
    const bar = side === 'top' ? this.refs.playerBarTop : this.refs.playerBarBottom;
    bar.classList.remove('turn-active');
  }

  setEngineInfo(side, text) {
    const el = side === 'top' ? this.refs.infoTop : this.refs.infoBottom;
    el.textContent = text;
  }

  // ---- move list ---------------------------------------------------------
  resetMoves() {
    this.refs.moves.innerHTML = '';
  }

  renderMoves(moves) {
    this.refs.moves.innerHTML = '';
    for (let i = 0; i < moves.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'move-row';
      const num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = `${Math.floor(i / 2) + 1}.`;
      const w = document.createElement('span');
      w.className = 'move-san';
      w.textContent = moves[i];
      const b = document.createElement('span');
      b.className = 'move-san';
      b.textContent = moves[i + 1] ?? '';
      row.append(num, w, b);
      this.refs.moves.appendChild(row);
    }
    // The scroll container is .sidebar-content; the inner containers have no
    // overflow of their own, so scrolling them is a no-op.
    this.refs.sidebarContent.scrollTop = this.refs.sidebarContent.scrollHeight;
  }

  // ---- event log ---------------------------------------------------------
  clearLog() {
    this.refs.log.innerHTML = '';
  }

  log(text, cls = '') {
    const line = document.createElement('div');
    line.className = `log-line ${cls}`;
    line.textContent = text;
    this.refs.log.appendChild(line);
    while (this.refs.log.childElementCount > 200) {
      this.refs.log.removeChild(this.refs.log.firstElementChild);
    }
    this.refs.sidebarContent.scrollTop = this.refs.sidebarContent.scrollHeight;
  }

  // ---- modals ------------------------------------------------------------
  openModal(title, bodyEl) {
    // One modal at a time: a new open tears the previous one down through its
    // own close path so listeners and focus never leak.
    this._activeModalClose?.();
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = `
      <div class="modal" tabindex="-1">
        <div class="modal-head"><h2></h2><button class="modal-close" type="button" aria-label="ปิด">✕</button></div>
        <div class="modal-body"></div>
      </div>
    `;
    overlay.querySelector('h2').textContent = title;
    const body = overlay.querySelector('.modal-body');
    if (bodyEl) body.appendChild(bodyEl);
    const dialog = overlay.querySelector('.modal');
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };
    const close = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
      if (this._activeModalClose === close) this._activeModalClose = null;
    };
    overlay.querySelector('.modal-close').onclick = close;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeyDown);
    this.refs.modalRoot.appendChild(overlay);
    dialog.focus();
    this._activeModalClose = close;
    return {
      close,
      body,
    };
  }

  // ---- game over popup ---------------------------------------------------
  showGameOver(title, detail = '', onNewGame, onHome) {
    const body = this.el('div', 'gameover');
    const big = this.el('div', 'gameover-title', title);
    const sub = this.el('div', 'gameover-detail', detail);
    body.append(big, sub);
    const row = this.el('div', 'dlg-actions');

    const again = this.el('button', 'btn primary');
    again.innerHTML = `<span class="btn-svg">${iconRefresh({ size: 16 })}</span> <span>เริ่มเกมใหม่</span>`;
    again.onclick = () => {
      overlay.close();
      onNewGame?.();
    };

    const home = this.el('button', 'btn');
    home.innerHTML = `<span class="btn-svg">${iconHome({ size: 16 })}</span> <span>กลับหน้าเมนู</span>`;
    home.onclick = () => {
      overlay.close();
      onHome?.();
    };

    row.append(again, home);
    body.appendChild(row);
    const overlay = this.openModal('จบเกม', body);
    overlay.body.querySelector('.btn.primary').focus();
    return overlay;
  }

  el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
}
