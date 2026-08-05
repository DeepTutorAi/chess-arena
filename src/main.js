// Chess Arena — bootstrap: wires the board (chessground), UI, dialogs and the
// game controller together. All game logic lives in controller.js.

import { Chessground } from 'chessground';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './styles.css';

import { UI } from './ui.js';
import { Controller, MODES } from './controller.js';
import { LEVELS, TIME_CONTROLS, GITHUB_TOKEN_KEY, getRooms } from './config.js';
import { sounds } from './sounds.js';

const ui = new UI(document.getElementById('app'));

// ---- promotion picker -----------------------------------------------------

function openPromotion(orig, dest) {
  return new Promise((resolve) => {
    const overlay = ui.el('div', 'promo-overlay');
    const box = ui.el('div', 'promo-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'เลือกตัวหมากสำหรับโปรโมท');
    box.appendChild(ui.el('div', 'promo-title', '♟️ โปรโมทเบี้ย — เลือกตัวหมาก'));
    const piecesRow = ui.el('div', 'promo-pieces');
    const white = dest[1] === '8'; // promoting side's pieces are the mover's color
    // chess.js uses single letters; chessground CSS keys icons by full role names.
    const pieces = ['q', 'r', 'b', 'n'];
    const labels = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    const roles = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    for (const p of pieces) {
      const btn = ui.el('button', 'promo-btn');
      const wrap = document.createElement('div');
      wrap.className = 'cg-wrap';
      wrap.innerHTML = `<piece class="${white ? 'white' : 'black'} ${roles[p]}"></piece>`;
      btn.append(wrap, ui.el('span', 'promo-label', labels[p]));
      btn.onclick = () => {
        overlay.remove();
        resolve(p);
      };
      piecesRow.appendChild(btn);
    }
    box.appendChild(piecesRow);
    const cancel = ui.el('button', 'promo-cancel', 'ยกเลิก');
    cancel.onclick = () => {
      overlay.remove();
      resolve(null);
    };
    box.appendChild(cancel);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// ---- board -----------------------------------------------------------------

const ground = Chessground(ui.refs.board, {
  animation: { enabled: true, duration: 200 },
  draggable: { enabled: true, showGhost: true },
  selectable: { enabled: true },
  // visible (not enabled) so the hint button can draw arrows without letting
  // the user free-draw on the board. Custom brush: smaller + brighter than the
  // default paleBlue (lineWidth 15, opacity 0.4) so the hint arrow is clear.
  drawable: {
    enabled: false,
    visible: true,
    brushes: {
      hint: { key: 'h', color: '#f2b900', opacity: 0.95, lineWidth: 8 },
    },
  },
  movable: {
    free: false,
    color: false,
    showDests: true,
    dests: new Map(),
    events: {
      after: (orig, dest) => controller?.handleUserMove(orig, dest),
    },
  },
});

// Intercept square clicks for Sandbox Board Setup Mode (Replace Mode Only)
ui.refs.board.addEventListener('click', (e) => {
  if (!controller || !controller.sandboxSetup || controller.sandboxTool !== 'replace') return;
  const rect = ui.refs.board.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const fileIdx = Math.floor((x / rect.width) * 8);
  const rankIdx = 8 - Math.floor((y / rect.height) * 8);
  if (fileIdx >= 0 && fileIdx < 8 && rankIdx >= 1 && rankIdx <= 8) {
    const file = String.fromCharCode(97 + fileIdx);
    const square = `${file}${rankIdx}`;
    controller.handleSandboxSquareClick(square);
  }
});

const controller = new Controller({ ui, ground, onPromotion: openPromotion });

// ---- mode dialogs -----------------------------------------------------------

function colorRadios(name, { withRandom = true } = {}) {
  const wrap = ui.el('div', 'radio-row');
  const opts = withRandom
    ? [
        ['random', 'สุ่ม'],
        ['w', 'ขาว'],
        ['b', 'ดำ'],
      ]
    : [
        ['w', 'ขาว'],
        ['b', 'ดำ'],
      ];
  for (const [val, label] of opts) {
    const id = `${name}-${val}`;
    const lab = ui.el('label', 'pill');
    const inp = ui.el('input');
    inp.type = 'radio';
    inp.name = name;
    inp.value = val;
    inp.id = id;
    if (val === opts[0][0]) inp.checked = true;
    lab.append(inp, ui.el('span', null, label));
    wrap.appendChild(lab);
  }
  return wrap;
}

function timeControlRadios(name) {
  const wrap = ui.el('div', 'radio-row tc-radio-row');
  for (const tc of TIME_CONTROLS) {
    const lab = ui.el('label', `pill tc-pill tc-${tc.category}`);
    const inp = ui.el('input');
    inp.type = 'radio';
    inp.name = name;
    inp.value = tc.id;
    if (tc.id === 'unlimited') inp.checked = true;
    lab.append(inp, ui.el('span', null, tc.label));
    wrap.appendChild(lab);
  }
  return wrap;
}

function dlgButtons(...items) {
  const row = ui.el('div', 'dlg-actions');
  for (const [label, onClick, primary = false] of items) {
    const b = ui.el('button', `btn ${primary ? 'primary' : ''}`, label);
    b.onclick = onClick;
    row.appendChild(b);
  }
  return row;
}

// CLEAN LOBBY WITH BACK TO MENU BUTTON & DYNAMIC REAL ONLINE ROOMS
function openJoinDialog() {
  const overlay = ui.el('div', 'join-lobby-overlay');
  overlay.innerHTML = `
    <div class="lobby-topbar">
      <button class="lobby-back-btn" id="lobby-back-btn">
        <span>🏠</span> กลับหน้าเมนู
      </button>
      <div style="font-size:18px; font-weight:900; color:var(--accent);">Chess Arena Online Lobby</div>
    </div>

    <div style="margin-bottom:20px;">
      <h2 style="margin:0 0 6px; font-size:22px; font-weight:900;">ห้องประลองออนไลน์ (Live Online Rooms)</h2>
      <p style="margin:0; color:var(--muted); font-size:13px;">กดเลือกห้องด้านล่างเพื่อเข้าร่วมประลองทันที (1-Click Join):</p>
    </div>

    <div class="lobby-cards-grid" id="lobby-cards-container"></div>
  `;

  const container = overlay.querySelector('#lobby-cards-container');

  // Fetch real rooms from Room Store
  const storedRooms = getRooms();
  const activeGistUrl = controller.remoteGistUrl;
  const isHost = Boolean(activeGistUrl);

  const displayRooms = storedRooms.length > 0
    ? storedRooms
    : [
        {
          id: 'ankidun_room_1',
          gistId: 'ankidun_room_1',
          title: 'ANKIDUN Dares You: Respect the Gambit',
          hostName: 'ANKIDUN',
          status: 'WAITING',
        },
      ];

  for (const r of displayRooms) {
    const roomIsMine = isHost || r.hostName === 'คุณ';
    const card = ui.el('div', 'exact-room-card');
    card.innerHTML = `
      <div class="exact-card-header">
        <span>${r.title}</span>
        <span class="heart-icon">♡</span>
      </div>
      <div class="exact-card-body">
        <div class="exact-card-mini-board">
          <div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div>
          <div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div>
          <div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div>
          <div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div><div class="sq-b"></div><div class="sq-w"></div>
        </div>
        <div class="exact-card-match-details">
          <div class="exact-card-match-vs">
            <div class="exact-card-avatar" style="background:#4a2840;">🔥</div>
            <span class="exact-vs-text">vs</span>
            <div class="exact-card-avatar">👤</div>
          </div>
          <button class="exact-card-action-btn ${roomIsMine ? 'waiting' : 'join'}">
            ${roomIsMine ? 'WAITING' : 'JOIN'}
          </button>
        </div>
      </div>
    `;

    const joinBtn = card.querySelector('.exact-card-action-btn');
    joinBtn.onclick = () => {
      if (roomIsMine) {
        ui.log('คุณเป็นเจ้าของห้องนี้ — กำลังรอคู่แข่งเข้าร่วม', 'sys');
        return;
      }
      overlay.remove();
      controller.start(MODES.REMOTE, {
        action: 'join',
        gistId: r.gistId || r.id,
        token: localStorage.getItem(GITHUB_TOKEN_KEY) ?? '',
      });
    };

    container.appendChild(card);
  }

  // Back to menu handler
  overlay.querySelector('#lobby-back-btn').onclick = () => overlay.remove();

  document.body.appendChild(overlay);
}

// 2-STEP CREATE ROOM DIALOG FLOW (CHESS.COM PLAY CHESS STYLE)
function openModeDialog(targetMode = null) {
  const modal = ui.openModal('♟️ Play Chess (เล่น / เลือกโหมด)');
  const body = modal.body;

  const renderStep1 = () => {
    body.innerHTML = '';

    const cardsVertical = ui.el('div', 'modal-mode-cards-vertical');

    const options = [
      {
        mode: MODES.REMOTE,
        icon: '⚡',
        title: 'Play Online (ออนไลน์ / Remote)',
        desc: 'สร้างห้องประลองหรือต่อสู้กับ AI / ผู้เล่นอื่นออนไลน์',
      },
      {
        mode: MODES.HUMAN_VS_AI,
        icon: '🤖',
        title: 'Play Bots (เล่น vs Stockfish AI)',
        desc: 'สู้กับบอท Stockfish ปรับ Elo 800 - 2200+',
      },
      {
        mode: MODES.AI_VS_AI,
        icon: '⚔️',
        title: 'AI vs AI Arena',
        desc: 'เปิดชม Stockfish ปะทะ Stockfish เองแบบเต็มระบบ',
      },
      {
        mode: 'sandbox_direct',
        icon: '🛠️',
        title: 'Sandbox (กระดานทดลอง / ปรับแต่งสนาม)',
        desc: 'ปรับแต่งตัวหมาก รูปแบบกระดาน และเลือกโหมดเล่นอิสระ',
      },
    ];

    for (const opt of options) {
      const card = ui.el('div', 'chesscom-play-card');
      card.innerHTML = `
        <div class="c-icon">${opt.icon}</div>
        <div class="c-body">
          <div class="c-title">${opt.title}</div>
          <div class="c-desc">${opt.desc}</div>
        </div>
      `;
      card.onclick = () => {
        if (opt.mode === 'sandbox_direct') {
          modal.close();
          controller.startSandboxSetup();
        } else {
          renderStep2(opt.mode);
        }
      };
      cardsVertical.appendChild(card);
    }

    body.appendChild(cardsVertical);
  };

  const renderStep2 = (mode) => {
    body.innerHTML = '';

    const backBtn = ui.el('button', 'btn-back-link', '← ย้อนกลับไปเลือกโหมด');
    backBtn.onclick = () => renderStep1();
    body.appendChild(backBtn);

    if (mode === MODES.HUMAN_VS_AI) {
      body.append(ui.el('p', 'dlg-hint', 'ตั้งค่าการเล่นกับ Stockfish 18 AI'));

      body.append(ui.el('div', 'field-label', 'คุณเล่นเป็น'));
      body.appendChild(colorRadios('hva-color'));

      const levelWrap = ui.el('label', 'field');
      const levelLabel = ui.el('div', 'field-label');
      const initialCfg = LEVELS[3]; // default level 4 = Elo 1400
      levelLabel.innerHTML = `ระดับเอนจิน: <b id="hva-level-label">Elo ${initialCfg.label}</b>`;
      levelWrap.appendChild(levelLabel);

      const slider = ui.el('input');
      slider.type = 'range';
      slider.min = '1';
      slider.max = '11';
      slider.step = '1';
      slider.value = '4';
      slider.addEventListener('input', () => {
        const idx = Number(slider.value) - 1;
        const cfg = LEVELS[idx];
        const el = document.getElementById('hva-level-label');
        if (el && cfg) el.textContent = `Elo ${cfg.label}`;
      });

      levelWrap.appendChild(slider);
      body.appendChild(levelWrap);

      body.append(ui.el('div', 'field-label', 'ตั้งค่าเวลา (Time Control)'));
      body.appendChild(timeControlRadios('hva-tc'));

      body.appendChild(
        dlgButtons([
          'เริ่มเล่นเกม',
          () => {
            const color = body.querySelector('input[name="hva-color"]:checked').value;
            const tcId = body.querySelector('input[name="hva-tc"]:checked').value;
            controller.start(MODES.HUMAN_VS_AI, {
              color,
              level: Number(slider.value),
              timeControlId: tcId,
            });
            modal.close();
          },
          true,
        ])
      );
    } else if (mode === MODES.AI_VS_AI) {
      body.append(ui.el('p', 'dlg-hint', 'Stockfish ฝ่ายขาว vs Stockfish ฝ่ายดำ — ตั้งระดับ Elo ของแต่ละฝ่ายแล้วเปิดชม'));

      const levelSlider = (labelId, labelText, value) => {
        const wrap = ui.el('label', 'field');
        const lab = ui.el('div', 'field-label');
        lab.innerHTML = `${labelText}: <b id="${labelId}"></b>`;
        wrap.appendChild(lab);
        const slider = ui.el('input');
        slider.type = 'range';
        slider.min = '1';
        slider.max = '11';
        slider.step = '1';
        slider.value = String(value);
        wrap.appendChild(slider);
        return { wrap, slider, labelId };
      };
      const updLevelLabel = (slider, labelId) => {
        const cfg = LEVELS[Number(slider.value) - 1];
        const el = document.getElementById(labelId);
        if (el && cfg) el.textContent = `Elo ${cfg.elo}`;
      };

      const wLv = levelSlider('aiva-w-label', 'ระดับฝ่ายขาว (White)', 6);
      const bLv = levelSlider('aiva-b-label', 'ระดับฝ่ายดำ (Black)', 3);
      updLevelLabel(wLv.slider, wLv.labelId);
      updLevelLabel(bLv.slider, bLv.labelId);
      wLv.slider.addEventListener('input', () => updLevelLabel(wLv.slider, wLv.labelId));
      bLv.slider.addEventListener('input', () => updLevelLabel(bLv.slider, bLv.labelId));
      body.append(wLv.wrap, bLv.wrap);

      body.append(ui.el('div', 'field-label', 'ตั้งค่าเวลา (Time Control)'));
      body.appendChild(timeControlRadios('aiva-tc'));

      body.appendChild(
        dlgButtons([
          'เริ่มการประลอง AI',
          () => {
            const tcId = body.querySelector('input[name="aiva-tc"]:checked').value;
            controller.start(MODES.AI_VS_AI, {
              levelWhite: Number(wLv.slider.value),
              levelBlack: Number(bLv.slider.value),
              timeControlId: tcId,
            });
            modal.close();
          },
          true,
        ])
      );
    } else if (mode === MODES.REMOTE) {
      body.append(
        ui.el(
          'p',
          'dlg-hint',
          'สร้างห้องประลองออนไลน์เพื่อประลองกับผู้เล่นอื่นหรือ AI'
        )
      );

      body.append(ui.el('div', 'field-label', 'เอนจินสนามเล่นเป็น'));
      body.appendChild(colorRadios('rm-color'));

      const tokenField = ui.el('label', 'field');
      tokenField.append(
        ui.el(
          'span',
          'field-label',
          'GitHub Token (scope gist — เก็บเฉพาะในเบราว์เซอร์นี้)'
        )
      );
      const tokenInput = ui.el('input');
      tokenInput.type = 'password';
      tokenInput.placeholder = 'ghp_xxxxxxxxxxxx';
      tokenInput.autocomplete = 'off';
      tokenInput.value = localStorage.getItem(GITHUB_TOKEN_KEY) ?? '';
      tokenField.appendChild(tokenInput);
      body.appendChild(tokenField);

      const titleField = ui.el('label', 'field');
      titleField.append(ui.el('span', 'field-label', 'ชื่อการประลอง'));
      const titleInput = ui.el('input');
      titleInput.value = 'การประลอง AI Arena';
      titleField.appendChild(titleInput);
      body.appendChild(titleField);

      body.append(ui.el('div', 'field-label', 'ตั้งค่าเวลา (Time Control)'));
      body.appendChild(timeControlRadios('rm-tc'));

      body.appendChild(
        dlgButtons([
          'สร้างห้องประลอง',
          async () => {
            const color = body.querySelector('input[name="rm-color"]:checked').value;
            const tcId = body.querySelector('input[name="rm-tc"]:checked').value;
            const token = tokenInput.value.trim();
            if (token) localStorage.setItem(GITHUB_TOKEN_KEY, token);
            modal.close();
            try {
              await controller.start(MODES.REMOTE, {
                action: 'create',
                engineColor: color,
                timeControlId: tcId,
                token,
                title: titleInput.value.trim() || 'การประลอง AI Arena',
              });
              const url = controller.remoteGistUrl;
              if (url) navigator.clipboard?.writeText(url).catch(() => {});
              ui.log(`ห้องพร้อมประลองออนไลน์!`, 'sys');
            } catch (err) {
              ui.log(`สร้างห้องล้มเหลว: ${err.message}`, 'err');
            }
          },
          true,
        ])
      );
    }
  };

  if (targetMode) {
    renderStep2(targetMode);
  } else {
    renderStep1();
  }
}

// ---- Event Wiring -----------------------------------------------------------

ui.refs.brandHome.onclick = () => controller.goHome();
ui.refs.profileBtn.onclick = () => alert('ระบบสมาชิกและโปรไฟล์ผู้เล่นกำลังอยู่ในการพัฒนาค่ะ!');

ui.refs.heroCreateBtn.onclick = () => openModeDialog();
ui.refs.heroJoinBtn.onclick = () => openJoinDialog();

// Sidebar Tabs
ui.refs.tabMoves.onclick = () => ui.showTab('moves');
ui.refs.tabLog.onclick = () => ui.showTab('log');

// Action Strip Buttons (Chess.com controls)
ui.refs.btnUndo.onclick = () => controller.undo();
ui.refs.btnResign.onclick = () => {
  if (confirm('คุณแน่ใจหรือไม่ว่าต้องการยอมแพ้?')) {
    controller.resign();
  }
};
ui.refs.btnHome.onclick = () => controller.goHome();
ui.refs.btnFlip.onclick = () => controller.flip();
ui.refs.btnPause.onclick = () => controller.togglePause();
ui.refs.btnHint.onclick = () => controller.showHint();

// ---- SANDBOX BOARD EDITOR EVENTS -------------------------------------------

// Right Panel (Piece Palette & Tool Mode)
ui.refs.sbToolMove.onclick = () => {
  controller.setSandboxTool('move');
  ui.refs.sbToolMove.classList.add('active');
  ui.refs.sbToolReplace.classList.remove('active');
  ui.log('เปลี่ยนเป็นโหมด: 👆 ย้ายตำแหน่งหมาก', 'sys');
};

ui.refs.sbToolReplace.onclick = () => {
  controller.setSandboxTool('replace');
  ui.refs.sbToolReplace.classList.add('active');
  ui.refs.sbToolMove.classList.remove('active');
  ui.log('เปลี่ยนเป็นโหมด: 🎨 แทนที่ตัวหมาก (คลิกบนกระดานเพื่อเปลี่ยน)', 'sys');
};

ui.refs.sbPieceGrid.querySelectorAll('.piece-btn').forEach((btn) => {
  btn.onclick = () => {
    ui.refs.sbPieceGrid.querySelectorAll('.piece-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    controller.sandboxPiece = btn.dataset.piece;
    controller.setSandboxTool('replace');
    ui.refs.sbToolReplace.classList.add('active');
    ui.refs.sbToolMove.classList.remove('active');
    ui.log(`เลือกตัวหมาก: ${btn.dataset.piece.toUpperCase()}`, 'sys');
  };
});

ui.refs.sbStartGameBtn.onclick = () => {
  controller.startSandboxGame();
};

// Left Panel (Mode Toggles & Sub-settings)
function setupSandboxLeftPanel() {
  const modeBtns = [ui.refs.sbModeOnline, ui.refs.sbModeBot, ui.refs.sbModeAiva];

  // Render Time Control Radios inside Left Panel
  ui.refs.sbTcContainer.appendChild(timeControlRadios('sb-tc-left'));

  // Creator color picker (white / black / random) — same logic as the main dialogs
  ui.refs.sbColorContainer.appendChild(colorRadios('sb-color-left'));
  ui.refs.sbColorContainer.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'sb-color-left') {
      controller.sandboxSelectedColor = e.target.value;
    }
  });

  // Room token (needed to create / write battle rooms); kept in this browser
  ui.refs.sbTokenInput.value = localStorage.getItem(GITHUB_TOKEN_KEY) ?? '';
  ui.refs.sbTokenInput.addEventListener('input', () => {
    const token = ui.refs.sbTokenInput.value.trim();
    if (token) localStorage.setItem(GITHUB_TOKEN_KEY, token);
  });

  // Mode Toggle Logic
  modeBtns.forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.mode;
      const isAlreadyActive = btn.classList.contains('active');

      modeBtns.forEach((b) => b.classList.remove('active'));

      if (isAlreadyActive) {
        // Deselect mode -> return to Solo Analyze mode
        controller.sandboxTargetMode = null;
        ui.refs.sbSoloNotice.classList.remove('hidden');
        ui.refs.sbSubSettings.classList.add('hidden');
        ui.refs.sbSettingBot.classList.add('hidden');
        ui.refs.sbSettingColor.classList.add('hidden');
        ui.refs.sbSettingAiva.classList.add('hidden');
        ui.refs.sbSettingToken.classList.add('hidden');
        ui.log('เลือกโหมด: Solo ฝึกซ้อม (เดินได้ทั้ง 2 ฝ่าย)', 'sys');
      } else {
        // Select mode
        btn.classList.add('active');
        controller.sandboxTargetMode = mode;
        ui.refs.sbSoloNotice.classList.add('hidden');
        ui.refs.sbSubSettings.classList.remove('hidden');

        if (mode === 'hva') {
          ui.refs.sbSettingBot.classList.remove('hidden');
          ui.refs.sbColorLabel.textContent = 'คุณเล่นเป็นฝ่าย';
          ui.refs.sbSettingColor.classList.remove('hidden');
          ui.refs.sbSettingAiva.classList.add('hidden');
          ui.refs.sbSettingToken.classList.add('hidden');
          ui.log('เลือกโหมด: 🤖 เล่นกับบอท (Stockfish)', 'sys');
        } else if (mode === 'remote') {
          ui.refs.sbSettingBot.classList.add('hidden');
          ui.refs.sbColorLabel.textContent = 'เอนจินสนาม (คนสร้างห้อง) เล่นเป็นฝ่าย';
          ui.refs.sbSettingColor.classList.remove('hidden');
          ui.refs.sbSettingAiva.classList.add('hidden');
          ui.refs.sbSettingToken.classList.remove('hidden');
          ui.log('เลือกโหมด: ⚡ เล่นออนไลน์', 'sys');
        } else {
          ui.refs.sbSettingBot.classList.add('hidden');
          ui.refs.sbSettingColor.classList.add('hidden');
          ui.refs.sbSettingAiva.classList.remove('hidden');
          ui.refs.sbSettingToken.classList.add('hidden');
          ui.log('เลือกโหมด: ⚔️ AI vs AI Arena', 'sys');
        }
      }
    };
  });

  // Bot Elo Slider Event
  ui.refs.sbBotSlider.addEventListener('input', () => {
    const level = Number(ui.refs.sbBotSlider.value);
    controller.sandboxSelectedLevel = level;
    const cfg = LEVELS[level - 1];
    if (cfg) {
      ui.refs.sbBotLevelLabel.textContent = `Elo ${cfg.label}`;
    }
  });

  // AI vs AI level sliders (per side)
  const updAivaLevel = (slider, labelEl, prop) => {
    const level = Number(slider.value);
    controller[prop] = level;
    const cfg = LEVELS[level - 1];
    if (cfg) labelEl.textContent = `Elo ${cfg.elo}`;
  };
  ui.refs.sbAivaWSlider.addEventListener('input', () =>
    updAivaLevel(ui.refs.sbAivaWSlider, ui.refs.sbAivaWLabel, 'sandboxAivaLevelW')
  );
  ui.refs.sbAivaBSlider.addEventListener('input', () =>
    updAivaLevel(ui.refs.sbAivaBSlider, ui.refs.sbAivaBLabel, 'sandboxAivaLevelB')
  );

  // Time Control Event
  ui.refs.sbTcContainer.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'sb-tc-left') {
      controller.sandboxSelectedTc = e.target.value;
    }
  });

  // Action Buttons
  ui.refs.sbResetBoardBtn.onclick = () => {
    controller.startSandboxSetup();
    ui.log('รีเซ็ตกระดานเป็นตำแหน่งเริ่มต้นแล้ว', 'sys');
  };

  ui.refs.sbBackMenuBtn.onclick = () => {
    controller.goHome();
  };
}

setupSandboxLeftPanel();

// ---- AUTO JOIN VIA URL QUERY / HASH ----------------------------------------
const urlParams = new URLSearchParams(window.location.search);
const roomArg = urlParams.get('room') || window.location.hash.replace('#', '');
if (roomArg && roomArg.length > 5) {
  controller.start(MODES.REMOTE, { action: 'join', gistId: roomArg });
}

// ---- boot --------------------------------------------------------------------

ui.setPlayers(
  { name: 'Stockfish 18', avatar: '🤖' },
  { name: 'คุณ', avatar: '👤' }
);
ui.showHomeView();

// Click sound ONLY on actual buttons (not the board, not empty space).
// Piece moves already play their own move/capture sounds, so dragging stays
// quiet; the board itself has no buttons, so it is excluded automatically.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target.closest && e.target.closest('button')) sounds.play('click');
  },
  { capture: true }
);

// Debug/testing hook (dev aid; harmless in production).
window.__arena = { controller, ui, ground };
