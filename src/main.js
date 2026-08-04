// Chess Arena — bootstrap: wires the board (chessground), UI, dialogs and the
// game controller together. All game logic lives in controller.js.

import { Chessground } from 'chessground';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './styles.css';

import { UI } from './ui.js';
import { Controller, MODES } from './controller.js';
import { LEVELS, SPEEDS } from './config.js';

const ui = new UI(document.getElementById('app'));

// ---- promotion picker -----------------------------------------------------

function openPromotion(orig, dest) {
  return new Promise((resolve) => {
    const overlay = ui.el('div', 'promo-overlay');
    const box = ui.el('div', 'promo-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'เลือกตัวหมากสำหรับโปรโมท');
    const white = dest[1] === '8'; // promoting side's pieces are the mover's color
    const pieces = ['q', 'r', 'b', 'n'];
    const labels = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    for (const p of pieces) {
      const btn = ui.el('button', 'promo-btn');
      const wrap = document.createElement('div');
      wrap.className = 'cg-wrap';
      wrap.innerHTML = `<piece class="${p} ${white ? 'white' : 'black'}"></piece>`;
      btn.append(wrap, ui.el('span', 'promo-label', labels[p]));
      btn.onclick = () => {
        overlay.remove();
        resolve(p);
      };
      box.appendChild(btn);
    }
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
  drawable: { enabled: false },
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

const controller = new Controller({ ui, ground, onPromotion: openPromotion });

// ---- mode dialogs -----------------------------------------------------------

const TOKEN_KEY = 'chess-arena-github-token';

function tokenField(label) {
  const wrap = ui.el('label', 'field');
  wrap.append(ui.el('span', 'field-label', label));
  const input = ui.el('input');
  input.type = 'password';
  input.placeholder = 'ghp_…';
  input.value = localStorage.getItem(TOKEN_KEY) ?? '';
  input.addEventListener('change', () => localStorage.setItem(TOKEN_KEY, input.value.trim()));
  wrap.appendChild(input);
  return { wrap, input };
}

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

function dlgButtons(...items) {
  const row = ui.el('div', 'dlg-actions');
  for (const [label, onClick, primary = false] of items) {
    const b = ui.el('button', `btn ${primary ? 'primary' : ''}`, label);
    b.onclick = onClick;
    row.appendChild(b);
  }
  return row;
}

function openModeDialog(mode) {
  const modal = ui.openModal('ตั้งค่าโหมด');
  const body = modal.body;

  if (mode === MODES.HUMAN_VS_AI) {
    body.append(ui.el('p', 'dlg-hint', 'คุณเล่นกับเอนจิน Stockfish 18 (ระดับปรับได้ 1–8)'));
    body.append(ui.el('div', 'field-label', 'คุณเล่นเป็น'));
    body.appendChild(colorRadios('hva-color'));
    const levelWrap = ui.el('label', 'field');
    levelWrap.append(ui.el('span', 'field-label', `ระดับเอนจิน: <b id="hva-level-label">4/8</b>`));
    const slider = ui.el('input');
    slider.type = 'range';
    slider.min = '1';
    slider.max = '8';
    slider.step = '1';
    slider.value = '4';
    slider.addEventListener('input', () => {
      document.getElementById('hva-level-label').textContent = `${slider.value}/8`;
    });
    levelWrap.appendChild(slider);
    body.appendChild(levelWrap);
    body.appendChild(
      dlgButtons([
        'เริ่มเกม',
        () => {
          const color = body.querySelector('input[name="hva-color"]:checked').value;
          controller.start(MODES.HUMAN_VS_AI, { color, level: Number(slider.value) });
          modal.close();
        },
        true,
      ])
    );
  } else if (mode === MODES.AI_VS_AI) {
    body.append(ui.el('p', 'dlg-hint', 'Stockfish ฝ่ายขาว vs Stockfish ฝ่ายดำ — เปิดชมได้เลย'));
    body.append(ui.el('div', 'field-label', 'ความเร็ว'));
    const speedWrap = ui.el('div', 'radio-row');
    for (const [key, cfg] of Object.entries(SPEEDS)) {
      const lab = ui.el('label', 'pill');
      const inp = ui.el('input');
      inp.type = 'radio';
      inp.name = 'aiva-speed';
      inp.value = key;
      if (key === 'normal') inp.checked = true;
      lab.append(inp, ui.el('span', null, cfg.label));
      speedWrap.appendChild(lab);
    }
    body.appendChild(speedWrap);
    body.appendChild(
      dlgButtons([
        'เริ่มการประลอง',
        () => {
          controller.start(MODES.AI_VS_AI, {
            speed: body.querySelector('input[name="aiva-speed"]:checked').value,
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
        'สร้างห้องประลอง แล้วส่ง URL ห้องให้ AI คู่แข่งมาเล่นผ่าน Gist (ดู docs/agent-battle.md) — หรือเข้าร่วมห้องที่มีอยู่'
      )
    );

    const createWrap = ui.el('div', 'dlg-section');
    createWrap.append(ui.el('div', 'dlg-section-title', 'สร้างห้อง'));
    createWrap.append(ui.el('div', 'field-label', 'เอนจินของสนามเล่นเป็น'));
    createWrap.appendChild(colorRadios('rm-color'));
    const titleField = ui.el('label', 'field');
    titleField.append(ui.el('span', 'field-label', 'ชื่อการประลอง'));
    const titleInput = ui.el('input');
    titleInput.value = 'การประลอง AI';
    titleField.appendChild(titleInput);
    createWrap.appendChild(titleField);
    const tokCreate = tokenField('GitHub Token (สิทธิ์ gist)');
    createWrap.appendChild(tokCreate.wrap);
    createWrap.appendChild(
      dlgButtons([
        'สร้างห้องและเริ่ม',
        async () => {
          const color = createWrap.querySelector('input[name="rm-color"]:checked').value;
          const token = tokCreate.input.value.trim();
          if (!token) {
            ui.log('กรุณาใส่ GitHub Token เพื่อสร้างห้อง', 'warn');
            return;
          }
          modal.close();
          try {
            await controller.start(MODES.REMOTE, {
              action: 'create',
              token,
              engineColor: color,
              title: titleInput.value.trim() || 'การประลอง AI',
            });
            const url = controller.remoteGistUrl;
            if (url) navigator.clipboard?.writeText(url).catch(() => {});
            ui.log(`ห้องพร้อม — URL ถูกคัดลอกแล้ว (ถ้าเบราว์เซอร์อนุญาต): ${url}`, 'sys');
          } catch (err) {
            ui.log(`สร้างห้องล้มเหลว: ${err.message}`, 'err');
          }
        },
        true,
      ])
    );

    const joinWrap = ui.el('div', 'dlg-section');
    joinWrap.append(ui.el('div', 'dlg-section-title', 'เข้าร่วมห้องที่มีอยู่'));
    const gistField = ui.el('label', 'field');
    gistField.append(ui.el('span', 'field-label', 'URL หรือ ID ของ Gist'));
    const gistInput = ui.el('input');
    gistInput.placeholder = 'https://gist.github.com/… หรือ gist id';
    gistField.appendChild(gistInput);
    joinWrap.appendChild(gistField);
    const tokJoin = tokenField('GitHub Token (ไม่จำเป็นถ้าดูอย่างเดียว)');
    joinWrap.appendChild(tokJoin.wrap);
    joinWrap.appendChild(
      dlgButtons([
        'เข้าร่วม',
        async () => {
          const raw = gistInput.value.trim();
          const m = raw.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/) || raw.match(/^([0-9a-f]+)$/);
          if (!m) {
            ui.log('Gist ID ไม่ถูกต้อง', 'warn');
            return;
          }
          modal.close();
          try {
            await controller.start(MODES.REMOTE, {
              action: 'join',
              gistId: m[1],
              token: tokJoin.input.value.trim(),
            });
          } catch (err) {
            ui.log(`เข้าร่วมห้องล้มเหลว: ${err.message}`, 'err');
          }
        },
        true,
      ])
    );

    body.append(createWrap, joinWrap);
  } else {
    // analyze
    body.append(ui.el('p', 'dlg-hint', 'เล่นเองทั้งสองสี — ไม่มีเอนจิน'));
    body.appendChild(
      dlgButtons([
        'เริ่ม',
        () => {
          controller.start(MODES.ANALYZE);
          modal.close();
        },
        true,
      ])
    );
  }
}

// ---- top bar ----------------------------------------------------------------

ui.refs.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  for (const t of ui.refs.tabs.querySelectorAll('.tab')) t.classList.remove('active');
  btn.classList.add('active');
  openModeDialog(btn.dataset.mode);
});

ui.refs.btnConfig.onclick = () => openModeDialog(controller.mode ?? MODES.HUMAN_VS_AI);
ui.refs.btnUndo.onclick = () => controller.undo();
ui.refs.btnFlip.onclick = () => controller.flip();
ui.refs.btnNew.onclick = () => controller.newGame();

// ---- boot --------------------------------------------------------------------

ui.setPlayers({ name: 'ฝ่ายดำ' }, { name: 'ฝ่ายขาว' });
openModeDialog(MODES.HUMAN_VS_AI);
