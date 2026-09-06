// Chess Arena — bootstrap: wires the board (chessground), UI, dialogs and the
// game controller together. All game logic lives in controller.js.

import { Chessground } from 'chessground';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './styles.css';

import { UI } from './ui.js';
import { Controller, MODES } from './controller.js';
import { LEVELS, TIME_CONTROLS, HUMAN_NAME, getRooms, saveRoom } from './config.js';
import {
  buildInviteUrl,
  buildWatchInviteUrl,
  getOnlineApiUrl,
  OnlineRoomClient,
  parseInviteLocation,
  parseWatchInviteLocation,
} from './online.js';
import { createLobbyView } from './lobby.js';
import { sounds } from './sounds.js';

const ui = new UI(document.getElementById('app'));
const PLAYER_NAME_KEY = 'chess-arena-player-name';
const SOUND_MUTED_KEY = 'chess-arena-sound-muted';

// localStorage may be blocked (private mode, quota) — persistence is a
// convenience and must never break the flow that triggered it.
function storeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

// ---- promotion picker -----------------------------------------------------

function openPromotion(orig, dest) {
  // A second drag while the picker is open must not stack a second overlay;
  // it resolves as cancelled and the board snaps back.
  if (document.querySelector('.promo-overlay')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const overlay = ui.el('div', 'promo-overlay');
    const box = ui.el('div', 'promo-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'เลือกตัวหมากสำหรับโปรโมท');
    box.appendChild(ui.el('div', 'promo-title', '♟️ โปรโมทเบี้ย — เลือกตัวหมาก'));
    const piecesRow = ui.el('div', 'promo-pieces');
    const white = dest[1] === '8'; // promoting side's pieces are the mover's color
    // chess.js uses single letters; chessground CSS keys icons by full role names.
    const pieces = ['q', 'r', 'b', 'n'];
    const labels = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    const roles = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    const finish = (value) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') finish(null);
    };
    for (const p of pieces) {
      const btn = ui.el('button', 'promo-btn');
      btn.type = 'button';
      const wrap = document.createElement('div');
      wrap.className = 'cg-wrap';
      wrap.innerHTML = `<piece class="${white ? 'white' : 'black'} ${roles[p]}"></piece>`;
      btn.append(wrap, ui.el('span', 'promo-label', labels[p]));
      btn.onclick = () => finish(p);
      piecesRow.appendChild(btn);
    }
    box.appendChild(piecesRow);
    const cancel = ui.el('button', 'promo-cancel', 'ยกเลิก');
    cancel.type = 'button';
    cancel.onclick = () => finish(null);
    box.appendChild(cancel);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    piecesRow.querySelector('button')?.focus();
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

// ROOM LOBBY WITH BACK TO MENU BUTTON
function openLiveLobby() {
  const overlay = ui.el('div', 'live-lobby-host');
  const browseClient = new OnlineRoomClient();
  const storedRooms = getRooms();
  const recentRooms = Array.isArray(storedRooms)
    ? storedRooms.filter((room) => room.kind === 'online' && room.roomId)
    : [];
  let lobbyView;
  const close = () => {
    lobbyView?.destroy();
    overlay.remove();
  };
  const remember = (room, profile, status) => {
    storeLocal(PLAYER_NAME_KEY, profile.name);
    saveRoom({
      id: room.roomId,
      roomId: room.roomId,
      kind: 'online',
      title: room.title,
      hostName: room.host?.name || 'ผู้เล่นออนไลน์',
      status,
      createdAt: Date.now(),
    });
  };
  lobbyView = createLobbyView({
    root: overlay,
    client: browseClient,
    profile: {
      name: localStorage.getItem(PLAYER_NAME_KEY) || '',
      avatar: localStorage.getItem('chess-arena-player-avatar') || 'knight',
    },
    recentRooms,
    onClose: close,
    onCreate: () => { close(); openModeDialog(MODES.ONLINE); },
    onJoin: async (room, profile) => {
      storeLocal('chess-arena-player-avatar', profile.avatar);
      try {
        await controller.start(MODES.ONLINE, {
          action: 'joinPublic', roomId: room.roomId, playerName: profile.name, avatar: profile.avatar,
        });
        remember(room, profile, 'ACTIVE');
        close();
      } catch (error) {
        ui.log(`เข้าห้องไม่สำเร็จ: ${error.message}`, 'err');
        try { await lobbyView.refresh(); } catch { /* keep the list we have */ }
        lobbyView?.showError?.(`เข้าห้องไม่สำเร็จ: ${error.message}`);
      }
    },
    onWatch: async (room, profile) => {
      storeLocal('chess-arena-player-avatar', profile.avatar);
      try {
        await controller.start(MODES.ONLINE, {
          action: 'watch', roomId: room.roomId, playerName: profile.name, avatar: profile.avatar,
        });
        remember(room, profile, 'WATCHING');
        close();
      } catch (error) {
        ui.log(`เข้าชมไม่สำเร็จ: ${error.message}`, 'err');
        try { await lobbyView.refresh(); } catch { /* keep the list we have */ }
        lobbyView?.showError?.(`เข้าชมไม่สำเร็จ: ${error.message}`);
      }
    },
    onReconnect: async (room) => {
      try {
        await controller.start(MODES.ONLINE, { action: 'resume', roomId: room.roomId });
        close();
      } catch (error) {
        lobbyView?.showError?.(`กลับเข้าห้องไม่สำเร็จ: ${error.message}`);
      }
    },
  });
  document.body.appendChild(overlay);
}

function openJoinDialog(prefillInvite = null) {
  if (!prefillInvite) {
    openLiveLobby();
    return;
  }
  const spectatorInvite = Boolean(prefillInvite.watchInviteToken);
  const overlay = ui.el('div', 'join-lobby-overlay');
  overlay.innerHTML = `
    <div class="lobby-topbar">
      <button class="lobby-back-btn" id="lobby-back-btn">
        <span>🏠</span> กลับหน้าเมนู
      </button>
      <div style="font-size:18px; font-weight:900; color:var(--accent);">Chess Arena Online</div>
    </div>

    <div class="online-join-panel">
      <h2>${spectatorInvite ? 'ชมการแข่งขันสด' : 'เข้าร่วมโต๊ะส่วนตัว'}</h2>
      <p>${spectatorInvite ? 'ลิงก์นี้ให้สิทธิ์รับชมเท่านั้น คุณจะเดินหมากหรือรับที่นั่งผู้เล่นไม่ได้' : 'ลิงก์เชิญพร้อมแล้ว ใส่ชื่อแล้วเข้าร่วมได้ทันทีโดยไม่ต้องใช้ GitHub Token'}</p>
      <label class="field">
        <span class="field-label">ชื่อที่แสดง</span>
        <input id="online-join-name" maxlength="40" autocomplete="nickname" />
      </label>
      <label class="field">
        <span class="field-label">ตราประจำตัว</span>
        <select id="online-join-avatar">
          <option value="knight">♞ Knight</option><option value="king">♚ King</option>
          <option value="rook">♜ Rook</option><option value="bishop">♝ Bishop</option>
          <option value="pawns">♟ Pawns</option><option value="shield">♛ Shield</option>
        </select>
      </label>
      <div class="online-join-actions">
        <button class="btn primary" id="online-join-btn">${spectatorInvite ? 'WATCH LIVE' : 'เข้าร่วมโต๊ะ'}</button>
        <span id="online-join-status" role="status"></span>
      </div>
    </div>

    <div class="lobby-saved-heading">
      <h2>ห้องที่เคยเปิดในเบราว์เซอร์นี้</h2>
      <p>รายการนี้เป็นทางลัดในเครื่องเท่านั้น สถานะสดจะอ่านจากเซิร์ฟเวอร์เมื่อเชื่อมต่อ</p>
    </div>

    <div class="lobby-cards-grid" id="lobby-cards-container"></div>
  `;

  const container = overlay.querySelector('#lobby-cards-container');
  const nameInput = overlay.querySelector('#online-join-name');
  const avatarInput = overlay.querySelector('#online-join-avatar');
  const joinButton = overlay.querySelector('#online-join-btn');
  const joinStatus = overlay.querySelector('#online-join-status');
  const apiReady = Boolean(getOnlineApiUrl());

  nameInput.value = localStorage.getItem(PLAYER_NAME_KEY) || '';
  avatarInput.value = localStorage.getItem('chess-arena-player-avatar') || 'knight';
  if (!apiReady) {
    joinButton.disabled = true;
    joinStatus.textContent = 'ยังไม่ได้ตั้งค่า VITE_ONLINE_API_URL';
  }

  joinButton.onclick = async () => {
    const playerName = nameInput.value.trim();
    if (!playerName) {
      joinStatus.textContent = 'กรุณาใส่ชื่อที่แสดง';
      nameInput.focus();
      return;
    }
    const invite = prefillInvite;
    joinButton.disabled = true;
    joinStatus.textContent = 'กำลังเข้าร่วมห้อง…';
    try {
      storeLocal(PLAYER_NAME_KEY, playerName);
      storeLocal('chess-arena-player-avatar', avatarInput.value);
      await controller.start(MODES.ONLINE, {
        action: spectatorInvite ? 'watch' : 'join', playerName, avatar: avatarInput.value, ...invite,
      });
      saveRoom({
        id: invite.roomId,
        roomId: invite.roomId,
        kind: 'online',
        title: controller.onlineState?.title || 'ห้องออนไลน์',
        hostName: controller.onlineState?.players?.w?.name || 'ผู้เล่นออนไลน์',
        status: spectatorInvite ? 'WATCHING' : (controller.onlineState?.status || 'ACTIVE'),
        createdAt: Date.now(),
      });
      const cleanUrl = new URL(window.location.href);
      cleanUrl.hash = '';
      history.replaceState(null, '', cleanUrl);
      overlay.remove();
    } catch (err) {
      joinButton.disabled = false;
      joinStatus.textContent = err.message;
    }
  };

  // Room Store is local-only; never invent a room when it is empty.
  const storedRooms = getRooms();
  const displayRooms = Array.isArray(storedRooms)
    ? storedRooms.filter((room) => room.kind === 'online' && room.roomId)
    : [];

  if (displayRooms.length === 0) {
    const emptyState = ui.el('div', 'lobby-empty-state');
    emptyState.append(
      ui.el('div', 'lobby-empty-icon', '♞'),
      ui.el('h3', null, 'ยังไม่มีประวัติห้องออนไลน์'),
      ui.el('p', null, 'สร้างห้องใหม่ หรือวางลิงก์เชิญด้านบน')
    );
    container.appendChild(emptyState);
  }

  for (const r of displayRooms) {
    const title = String(r.title ?? '').trim() || 'ห้องไม่มีชื่อ';
    const hostName = String(r.hostName ?? '').trim() || 'ไม่ทราบชื่อ';
    const status = String(r.status ?? '').trim().toUpperCase();
    const card = ui.el('div', 'exact-room-card');
    card.innerHTML = `
      <div class="exact-card-header">
        <span class="room-card-title"></span>
        <span class="room-status-badge"></span>
      </div>
      <div class="exact-card-body">
        <div class="room-card-details">
          <div class="room-card-host"></div>
          <div class="room-card-source">ทางลัดในเบราว์เซอร์นี้ · ตรวจสถานะเมื่อเชื่อมต่อ</div>
          <button class="exact-card-action-btn join"></button>
        </div>
      </div>
    `;

    card.querySelector('.room-card-title').textContent = title;
    card.querySelector('.room-status-badge').textContent = status ? `SAVED · ${status}` : 'SAVED ROOM';
    card.querySelector('.room-card-host').textContent = `เจ้าของห้อง: ${hostName}`;

    const joinBtn = card.querySelector('.exact-card-action-btn');
    joinBtn.textContent = 'กลับเข้าห้อง';
    joinBtn.onclick = async () => {
      joinBtn.disabled = true;
      try {
        await controller.start(MODES.ONLINE, { action: 'resume', roomId: r.roomId });
        overlay.remove();
      } catch (err) {
        joinBtn.disabled = false;
        ui.log(`กลับเข้าห้องล้มเหลว: ${err.message}`, 'err');
      }
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
        mode: MODES.ONLINE,
        icon: '⚡',
        title: 'Play Online (ผู้เล่นสองคน)',
        desc: 'สร้างห้อง ส่งลิงก์เชิญ และเล่นผ่านเซิร์ฟเวอร์โดยไม่ใช้ GitHub Token',
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
    } else if (mode === MODES.ONLINE) {
      body.append(
        ui.el(
          'p',
          'dlg-hint',
          getOnlineApiUrl()
            ? 'สร้างห้องแล้วส่งลิงก์เชิญให้คู่แข่ง เซิร์ฟเวอร์จะตรวจตาเดินทุกครั้ง'
            : 'ยังไม่ได้ตั้งค่า VITE_ONLINE_API_URL — ต้องรันหรือ deploy Worker ก่อนสร้างห้อง'
        )
      );

      const nameField = ui.el('label', 'field');
      nameField.append(ui.el('span', 'field-label', 'ชื่อที่แสดง'));
      const nameInput = ui.el('input');
      nameInput.maxLength = 40;
      nameInput.autocomplete = 'nickname';
      nameInput.value = localStorage.getItem(PLAYER_NAME_KEY) || '';
      nameField.appendChild(nameInput);
      body.appendChild(nameField);

      const avatarField = ui.el('label', 'field');
      avatarField.append(ui.el('span', 'field-label', 'ตราประจำตัว'));
      const avatarSelect = ui.el('select');
      avatarSelect.innerHTML = `
        <option value="knight">♞ Knight</option>
        <option value="king">♚ King</option>
        <option value="rook">♜ Rook</option>
        <option value="bishop">♝ Bishop</option>
        <option value="pawns">♟ Pawns</option>
        <option value="shield">♛ Royal Shield</option>
      `;
      avatarSelect.value = localStorage.getItem('chess-arena-player-avatar') || 'knight';
      avatarField.appendChild(avatarSelect);
      body.appendChild(avatarField);

      body.append(ui.el('div', 'field-label', 'คุณต้องการเล่นเป็น'));
      body.appendChild(colorRadios('online-color'));

      const titleField = ui.el('label', 'field');
      titleField.append(ui.el('span', 'field-label', 'ชื่อห้อง'));
      const titleInput = ui.el('input');
      titleInput.maxLength = 80;
      titleInput.value = 'ห้องประลอง Chess Arena';
      titleField.appendChild(titleInput);
      body.appendChild(titleField);

      body.append(ui.el('div', 'field-label', 'การมองเห็นห้อง'));
      const visibilityRow = ui.el('div', 'radio-row');
      for (const [value, label, checked] of [['public', 'Public · แสดงใน Lobby', true], ['private', 'Private · ลิงก์เท่านั้น', false]]) {
        const option = ui.el('label', 'pill');
        const input = ui.el('input');
        input.type = 'radio';
        input.name = 'online-visibility';
        input.value = value;
        input.checked = checked;
        option.append(input, ui.el('span', null, label));
        visibilityRow.appendChild(option);
      }
      body.appendChild(visibilityRow);

      const spectatorOption = ui.el('label', 'online-spectator-option');
      const spectatorInput = ui.el('input');
      spectatorInput.type = 'checkbox';
      spectatorInput.checked = true;
      spectatorOption.append(spectatorInput, ui.el('span', null, 'อนุญาตผู้ชมการแข่งขัน (สูงสุด 50 คน)'));
      body.appendChild(spectatorOption);

      body.append(ui.el('div', 'field-label', 'ตั้งค่าเวลา (Time Control)'));
      body.appendChild(timeControlRadios('online-tc'));

      const createButton = ui.el('button', 'btn primary', 'สร้างห้องออนไลน์');
      const createStatus = ui.el('span', 'online-create-status');
      createStatus.setAttribute('role', 'status');
      createButton.disabled = !getOnlineApiUrl();
      if (createButton.disabled) createStatus.textContent = 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ห้องออนไลน์';
      createButton.onclick = async () => {
        const playerName = nameInput.value.trim();
        if (!playerName) {
          ui.log('กรุณาใส่ชื่อที่แสดงก่อนสร้างห้อง', 'err');
          nameInput.focus();
          return;
        }
        createButton.disabled = true;
        createStatus.textContent = 'กำลังสร้างห้อง…';
        try {
          const color = body.querySelector('input[name="online-color"]:checked').value;
          const tcId = body.querySelector('input[name="online-tc"]:checked').value;
          const visibility = body.querySelector('input[name="online-visibility"]:checked').value;
          const roomTitle = titleInput.value.trim() || 'ห้องประลอง Chess Arena';
          storeLocal(PLAYER_NAME_KEY, playerName);
          storeLocal('chess-arena-player-avatar', avatarSelect.value);
          await controller.start(MODES.ONLINE, {
            action: 'create', playerName, color, timeControlId: tcId, title: roomTitle,
            visibility, allowSpectators: spectatorInput.checked, avatar: avatarSelect.value,
          });
          saveRoom({
            id: controller.onlineRoomId,
            roomId: controller.onlineRoomId,
            kind: 'online',
            title: roomTitle,
            hostName: playerName,
            createdAt: Date.now(),
            status: 'WAITING',
          });
          modal.close();
          ui.log(visibility === 'public'
            ? 'สร้างห้องแล้ว — ห้องกำลังแสดงใน Live Lobby'
            : 'สร้างห้อง Private แล้ว — ใช้ปุ่ม Share ในหน้าเกมเพื่อส่งลิงก์', 'sys');
        } catch (err) {
          createButton.disabled = false;
          createStatus.textContent = err.message;
          ui.log(`สร้างห้องล้มเหลว: ${err.message}`, 'err');
        }
      };
      const createActions = ui.el('div', 'dlg-actions');
      createActions.append(createButton, createStatus);
      body.appendChild(createActions);
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
ui.refs.profileBtn.onclick = () => {
  const body = ui.el('p', 'dlg-hint', 'ระบบสมาชิกและโปรไฟล์ผู้เล่นกำลังอยู่ในการพัฒนาค่ะ!');
  ui.openModal('โปรไฟล์ผู้เล่น', body);
};

ui.refs.heroCreateBtn.onclick = () => openModeDialog();
ui.refs.heroJoinBtn.onclick = () => openJoinDialog();

// Sidebar Tabs
ui.refs.tabMoves.onclick = () => ui.showTab('moves');
ui.refs.tabLog.onclick = () => ui.showTab('log');

// Action Strip Buttons (Chess.com controls)
ui.refs.btnUndo.onclick = () => controller.undo();
ui.refs.btnResign.onclick = () => {
  const body = ui.el('p', 'dlg-hint', 'คุณแน่ใจหรือไม่ว่าต้องการยอมแพ้?');
  const row = ui.el('div', 'dlg-actions');
  const keepPlaying = ui.el('button', 'btn', 'เล่นต่อ');
  const confirmResign = ui.el('button', 'btn primary', 'ยอมแพ้');
  const modal = ui.openModal('ยืนยันการยอมแพ้', body);
  keepPlaying.onclick = () => modal.close();
  confirmResign.onclick = () => {
    modal.close();
    controller.resign();
  };
  row.append(keepPlaying, confirmResign);
  body.appendChild(row);
  confirmResign.focus();
};
ui.refs.btnShare.onclick = () => {
  if (!controller.onlineRoomId || !controller.onlineInviteToken) return;
  const body = ui.el('div', 'share-room-dialog');
  body.appendChild(ui.el('p', 'dlg-hint', 'เลือกสิทธิ์ของลิงก์ที่ต้องการส่ง ลิงก์ผู้ชมไม่สามารถรับที่นั่งผู้เล่นได้'));
  const links = [
    ['ลิงก์สำหรับผู้เล่น', buildInviteUrl(window.location, controller.onlineRoomId, controller.onlineInviteToken)],
  ];
  if (controller.onlineWatchInviteToken) {
    links.push(['ลิงก์สำหรับผู้ชม', buildWatchInviteUrl(window.location, controller.onlineRoomId, controller.onlineWatchInviteToken)]);
  }
  for (const [label, value] of links) {
    const row = ui.el('div', 'share-link-row');
    const copy = ui.el('div', 'share-link-copy');
    copy.append(ui.el('strong', null, label), ui.el('span', null, 'Capability link · ส่งให้คนที่คุณไว้ใจ'));
    const button = ui.el('button', 'btn primary', 'คัดลอก');
    button.onclick = async () => {
      await navigator.clipboard.writeText(value);
      button.textContent = 'คัดลอกแล้ว';
    };
    row.append(copy, button);
    body.appendChild(row);
  }
  ui.openModal('แชร์ห้องออนไลน์', body);
};
ui.refs.btnHome.onclick = () => controller.goHome();
ui.refs.btnFlip.onclick = () => controller.flip();
ui.refs.btnPause.onclick = () => controller.togglePause();
ui.refs.btnHint.onclick = () => controller.showHint();
ui.refs.btnSound.onclick = () => setSoundMuted(!sounds.muted);

function setSoundMuted(muted) {
  sounds.muted = muted;
  storeLocal(SOUND_MUTED_KEY, muted ? '1' : '0');
  ui.refs.btnSound.querySelector('.icon').textContent = muted ? '🔇' : '🔊';
  ui.refs.btnSound.setAttribute('aria-pressed', String(muted));
}
setSoundMuted(localStorage.getItem(SOUND_MUTED_KEY) === '1');

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
          ui.log('เลือกโหมด: 🤖 เล่นกับบอท (Stockfish)', 'sys');
        } else if (mode === 'online') {
          ui.refs.sbSettingBot.classList.add('hidden');
          ui.refs.sbColorLabel.textContent = 'คุณเล่นเป็นฝ่าย';
          ui.refs.sbSettingColor.classList.remove('hidden');
          ui.refs.sbSettingAiva.classList.add('hidden');
          ui.log('เลือกโหมด: ⚡ เล่นออนไลน์', 'sys');
        } else {
          ui.refs.sbSettingBot.classList.add('hidden');
          ui.refs.sbSettingColor.classList.add('hidden');
          ui.refs.sbSettingAiva.classList.remove('hidden');
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

// ---- ONLINE INVITE / RECONNECT FROM URL -----------------------------------
const pendingInvite = parseInviteLocation(window.location) ?? parseWatchInviteLocation(window.location);
const resumeRoomArg = new URLSearchParams(window.location.search).get('room');

// ---- boot --------------------------------------------------------------------

ui.setPlayers(
  { name: 'Stockfish 18', avatar: '🤖' },
  { name: 'คุณ', avatar: '👤' }
);
ui.showHomeView();

if (pendingInvite) {
  queueMicrotask(() => openJoinDialog(pendingInvite));
} else if (resumeRoomArg) {
  queueMicrotask(() => {
    controller.start(MODES.ONLINE, { action: 'resume', roomId: resumeRoomArg })
      .catch(() => openJoinDialog());
  });
}

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

// Debug/testing hook — dev builds only, never shipped to production.
if (import.meta.env?.DEV) {
  window.__arena = { controller, ui, ground };
}
