// UI layer — pure DOM helpers. The controller drives the game and calls into
// this module; nothing here knows about chess rules or the engine.

const $ = (sel) => document.querySelector(sel);

export class UI {
  constructor(root) {
    root.innerHTML = `
      <header class="topbar">
        <div class="brand" id="brand-home">
          <span class="brand-mark">♞</span> Chess Arena
        </div>
        
        <!-- PROFILE PLACEHOLDER (RIGHT TOPBAR) -->
        <div class="profile-badge-placeholder" id="profile-btn" title="โปรไฟล์ผู้เล่น (ระบบสมาชิกเร็วๆ นี้)">
          <div class="user-avatar">👤</div>
          <div class="user-info">
            <span class="user-name">Guest Player</span>
            <span class="user-rating">⚡ 1500</span>
          </div>
        </div>
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
                <div class="card-icon">⚔️</div>
                <div class="card-text">CREATE GAME</div>
                <div class="card-sub">สร้างห้อง / เลือกโหมด</div>
              </button>

              <button id="hero-join-btn" class="park-action-card join-card">
                <div class="card-icon">🔗</div>
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
              <h3 class="sandbox-tool-title">🎯 เลือกโหมด & ตั้งค่า</h3>

              <div style="font-size:11px; color:var(--muted);">เลือกโหมดเกม (หากไม่เลือก = โหมด Solo ฝึกซ้อมเดินหมากทั้ง 2 ฝ่าย):</div>

              <div style="display:flex; flex-direction:column; gap:8px;">
                <button class="sandbox-mode-opt-btn" id="sb-mode-online" data-mode="remote">
                  <span class="m-icon">⚡</span>
                  <span>เล่นออนไลน์ (Online)</span>
                </button>
                <button class="sandbox-mode-opt-btn" id="sb-mode-bot" data-mode="hva">
                  <span class="m-icon">🤖</span>
                  <span>เล่นกับบอท (Stockfish)</span>
                </button>
                <button class="sandbox-mode-opt-btn" id="sb-mode-aiva" data-mode="aiva">
                  <span class="m-icon">⚔️</span>
                  <span>AI vs AI Arena</span>
                </button>
              </div>

              <div id="sb-solo-notice" class="sandbox-solo-notice">
                💡 <b>โหมด Solo ฝึกซ้อม:</b> ขยับเดินหมากได้ทั้งขาวและดำแบบอิสระ
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

                <div id="sb-setting-token" class="field hidden">
                  <span class="field-label">GitHub Token (scope gist — เก็บเฉพาะในเบราว์เซอร์นี้)</span>
                  <input type="password" id="sb-token-input" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off" />
                </div>

                <div id="sb-setting-tc" class="field">
                  <span class="field-label">ตั้งค่าเวลา (Time Control)</span>
                  <div class="radio-row tc-radio-row" id="sb-tc-container"></div>
                </div>
              </div>

              <!-- ACTION BUTTONS ROW -->
              <div class="sandbox-action-row">
                <button id="sb-reset-board-btn" class="sandbox-action-btn" title="รีเซ็ตตำแหน่งกระดาน">
                  <span>🔄</span> รีเซ็ตกระดาน
                </button>
                <button id="sb-back-menu-btn" class="sandbox-action-btn" title="กลับหน้าแรก">
                  <span>🏠</span> กลับหน้า Menu
                </button>
              </div>
            </aside>

            <!-- CENTER: CHESS BOARD & PLAYER BARS -->
            <div class="board-container">
              <!-- TOP PLAYER -->
              <div class="player-bar top-player" id="player-bar-top">
                <div class="player-profile">
                  <div class="avatar" id="avatar-top">🤖</div>
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
                  <div class="avatar" id="avatar-bottom">👤</div>
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
                <div class="tab-btn active" id="tab-moves">📜 รายการเดิน</div>
                <div class="tab-btn" id="tab-log">⚙️ สัญญาณ / Log</div>
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
                  <span class="icon">↩️</span>
                  <span class="label">ย้อน</span>
                </button>
                <button id="btn-hint" class="action-btn hidden" title="คำใบ้จากบอทระดับ GM (Hint)">
                  <span class="icon">💡</span>
                  <span class="label">คำใบ้</span>
                </button>
                <button id="btn-resign" class="action-btn danger" title="ยอมแพ้ (Resign)">
                  <span class="icon">🚩</span>
                  <span class="label">ยอมแพ้</span>
                </button>
                <button id="btn-flip" class="action-btn hidden" title="กลับกระดาน (Flip Board)">
                  <span class="icon">🔄</span>
                  <span class="label">กลับกระดาน</span>
                </button>
                <button id="btn-pause" class="action-btn hidden" title="หยุด/เล่นต่อ (Pause/Resume)">
                  <span class="icon">⏸️</span>
                  <span class="label">หยุด</span>
                </button>
                <button id="btn-home" class="action-btn" title="กลับหน้าแรก (Home)">
                  <span class="icon">🏠</span>
                  <span class="label">หน้าแรก</span>
                </button>
              </div>
            </aside>

            <!-- SANDBOX BOARD EDITOR RIGHT PANEL (PIECE PALETTE) -->
            <aside class="sidebar sandbox-editor-panel hidden" id="sandbox-tools">
              <h3 class="sandbox-tool-title">🛠️ จัดแต่งกระดาน (Sandbox)</h3>
              
              <div class="sandbox-mode-selector">
                <button class="sandbox-mode-btn active" id="sb-tool-move">👆 ย้ายตำแหน่ง</button>
                <button class="sandbox-mode-btn" id="sb-tool-replace">🎨 แทนที่ตัวหมาก</button>
              </div>

              <div class="sandbox-palette-label">เลือกตัวหมากมาวางแทนที่:</div>
              <div class="sandbox-piece-grid" id="sandbox-piece-grid">
                <button class="piece-btn active" data-piece="q"><span class="p-icon">♛</span><span class="p-name">Queen</span></button>
                <button class="piece-btn" data-piece="r"><span class="p-icon">♜</span><span class="p-name">Rook</span></button>
                <button class="piece-btn" data-piece="b"><span class="p-icon">♝</span><span class="p-name">Bishop</span></button>
                <button class="piece-btn" data-piece="n"><span class="p-icon">♞</span><span class="p-name">Knight</span></button>
                <button class="piece-btn" data-piece="p"><span class="p-icon">♟</span><span class="p-name">Pawn</span></button>
                <button class="piece-btn delete-btn" data-piece="delete"><span class="p-icon">🗑️</span><span class="p-name">ลบหมาก</span></button>
              </div>

              <div class="sandbox-rule-notice">
                📌 <b>กฎการจัดกระดาน:</b><br/>
                • King สามารถย้ายตำแหน่งได้เฉพาะใน 2 แถวแรก<br/>
                • การเพิ่ม/แทนที่หมากทำได้เฉพาะใน 2 แถวแรกของแต่ละฝั่ง
              </div>

              <button id="sb-start-game-btn" class="sandbox-start-btn">⚔️ เริ่มเล่นเกมตามที่จัด</button>
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
      btnFlip: $('#btn-flip'),
      btnPause: $('#btn-pause'),
      btnHome: $('#btn-home'),
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
      sbSettingToken: $('#sb-setting-token'),
      sbTokenInput: $('#sb-token-input'),
      sbTcContainer: $('#sb-tc-container'),
      sbResetBoardBtn: $('#sb-reset-board-btn'),
      sbBackMenuBtn: $('#sb-back-menu-btn'),
    };
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
    this.refs.sbSettingToken.classList.add('hidden');
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

  setPauseState(paused) {
    this.refs.btnPause.querySelector('.icon').textContent = paused ? '▶️' : '⏸️';
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
    this.refs.movesContainer.scrollTop = this.refs.movesContainer.scrollHeight;
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
    this.refs.logContainer.scrollTop = this.refs.logContainer.scrollHeight;
  }

  // ---- modals ------------------------------------------------------------
  openModal(title, bodyEl) {
    this.refs.modalRoot.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h2></h2><button class="modal-close" aria-label="ปิด">✕</button></div>
        <div class="modal-body"></div>
      </div>
    `;
    overlay.querySelector('h2').textContent = title;
    const body = overlay.querySelector('.modal-body');
    if (bodyEl) body.appendChild(bodyEl);
    overlay.querySelector('.modal-close').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    this.refs.modalRoot.appendChild(overlay);
    return {
      close: () => overlay.remove(),
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

    const again = this.el('button', 'btn primary', '🔄 เริ่มเกมใหม่');
    again.onclick = () => {
      overlay.close();
      onNewGame?.();
    };

    const home = this.el('button', 'btn', '🏠 กลับหน้าเมนู');
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
