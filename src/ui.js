// UI layer — pure DOM helpers. The controller drives the game and calls into
// this module; nothing here knows about chess rules or the engine.

const $ = (sel) => document.querySelector(sel);

export class UI {
  constructor(root) {
    root.innerHTML = `
      <header class="topbar">
        <div class="brand"><span class="brand-mark">♞</span> Chess Arena</div>
        <nav class="mode-tabs" id="mode-tabs">
          <button data-mode="human-vs-ai" class="tab active">เล่น vs AI</button>
          <button data-mode="ai-vs-ai" class="tab">AI vs AI</button>
          <button data-mode="remote" class="tab">ต่อสู้ Remote</button>
          <button data-mode="analyze" class="tab">วิเคราะห์</button>
        </nav>
      </header>
      <main class="layout">
        <section class="board-panel">
          <div class="player-bar">
            <div class="player" id="player-top">
              <span class="dot"></span><span class="pname"></span>
              <span class="pinfo" id="info-top"></span>
            </div>
          </div>
          <div id="board" class="board-wrap"></div>
          <div class="player-bar">
            <div class="player" id="player-bottom">
              <span class="dot"></span><span class="pname"></span>
              <span class="pinfo" id="info-bottom"></span>
            </div>
          </div>
          <div id="status" class="status">กำลังโหลด…</div>
          <div class="controls">
            <button id="btn-config" class="btn primary">ตั้งค่าโหมด</button>
            <button id="btn-undo" class="btn">ย้อนเดิน</button>
            <button id="btn-flip" class="btn">กลับกระดาน</button>
            <button id="btn-new" class="btn">เกมใหม่</button>
          </div>
        </section>
        <aside class="side-panel">
          <div class="card">
            <h3>รายการเดิน</h3>
            <div id="moves" class="moves"></div>
          </div>
          <div class="card">
            <h3>สัญญาณ / ข้อมูลเอนจิน</h3>
            <div id="log" class="log"></div>
          </div>
        </aside>
      </main>
      <div id="modal-root"></div>
    `;

    this.refs = {
      tabs: $('#mode-tabs'),
      status: $('#status'),
      board: $('#board'),
      moves: $('#moves'),
      log: $('#log'),
      playerTop: $('#player-top'),
      playerBottom: $('#player-bottom'),
      infoTop: $('#info-top'),
      infoBottom: $('#info-bottom'),
      btnConfig: $('#btn-config'),
      btnUndo: $('#btn-undo'),
      btnFlip: $('#btn-flip'),
      btnNew: $('#btn-new'),
      modalRoot: $('#modal-root'),
    };
    this._logLines = 0;
  }

  // ---- status pill -------------------------------------------------------
  setStatus(text, cls = '') {
    this.refs.status.className = `status ${cls}`;
    this.refs.status.textContent = text;
  }

  // ---- players -----------------------------------------------------------
  setPlayers(top, bottom) {
    this._setPlayer(this.refs.playerTop, top);
    this._setPlayer(this.refs.playerBottom, bottom);
  }

  _setPlayer(el, { name, active = false, done = false } = {}) {
    el.querySelector('.pname').textContent = name ?? '—';
    el.querySelector('.dot').className = `dot ${active ? 'on' : ''} ${done ? 'done' : ''}`;
  }

  setPlayerActive(side, active) {
    const el = side === 'top' ? this.refs.playerTop : this.refs.playerBottom;
    const dot = el.querySelector('.dot');
    dot.classList.toggle('on', active);
    dot.classList.remove('done');
  }

  setPlayerDone(side) {
    const el = side === 'top' ? this.refs.playerTop : this.refs.playerBottom;
    const dot = el.querySelector('.dot');
    dot.classList.remove('on');
    dot.classList.add('done');
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
    // moves: array of SAN strings
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
    this.refs.moves.scrollTop = this.refs.moves.scrollHeight;
  }

  // ---- event log ---------------------------------------------------------
  clearLog() {
    this.refs.log.innerHTML = '';
    this._logLines = 0;
  }

  log(text, cls = '') {
    const line = document.createElement('div');
    line.className = `log-line ${cls}`;
    line.textContent = text;
    this.refs.log.appendChild(line);
    while (this.refs.log.childElementCount > 200) {
      this.refs.log.removeChild(this.refs.log.firstElementChild);
    }
    this.refs.log.scrollTop = this.refs.log.scrollHeight;
    this._logLines++;
  }

  // ---- modals ------------------------------------------------------------
  /**
   * Open a modal dialog. Callers may pass a body element up front, or build
   * into the returned `modal.body` afterwards.
   */
  openModal(title, bodyEl) {
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

  el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
}
