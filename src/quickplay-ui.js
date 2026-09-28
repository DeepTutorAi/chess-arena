// The Quick Play box (roadmap D3): a name, an avatar and one of three clocks.

// The avatar choices — the same six the server accepts (src/online.js AVATARS).
const AVATAR_OPTIONS = [
  ['knight', '♞ Knight'], ['king', '♚ King'], ['rook', '♜ Rook'],
  ['bishop', '♝ Bishop'], ['pawns', '♟ Pawns'], ['shield', '♛ Royal Shield'],
];

function make(document, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * @param {object} opts
 * @param {Document} opts.document
 * @param {boolean} opts.apiReady  whether an online server is configured
 * @param {{name: string, avatar: string}} opts.profile
 * @param {ReadonlyArray<{id: string, label: string, sub: string}>} opts.times
 * @param {string} opts.timeControlId  the preselected clock
 * @param {(request: {playerName: string, avatar: string, timeControlId: string}) => Promise<{ok: boolean, message?: string}>} opts.onStart
 * @param {() => void} opts.onCancel  called when the player gives up the search
 * @returns {HTMLElement}
 */
export function createQuickPlayView({ document, apiReady, profile, times, timeControlId, onStart, onCancel }) {
  const root = make(document, 'div', 'quick-card');
  if (!apiReady) {
    root.append(make(document, 'p', 'dlg-hint', 'Quick Play ต้องใช้เซิร์ฟเวอร์ห้องออนไลน์ ซึ่งยังไม่ได้ตั้งค่าที่นี่ — ยังเล่นกับบอทหรือสร้างห้องส่วนตัวได้ตามปกติ'));
    return root;
  }
  root.append(make(document, 'p', 'dlg-hint', 'ระบบจะหาโต๊ะสาธารณะที่กำลังรอผู้เล่นให้นั่งทันที ถ้าไม่มีจะเปิดโต๊ะใหม่รอคู่แข่งให้'));

  const nameField = make(document, 'label', 'field');
  nameField.append(make(document, 'span', 'field-label', 'ชื่อที่แสดง'));
  const name = make(document, 'input');
  name.maxLength = 40;
  name.autocomplete = 'nickname';
  name.value = profile.name ?? '';
  nameField.append(name);

  const avatarField = make(document, 'label', 'field');
  avatarField.append(make(document, 'span', 'field-label', 'ตราประจำตัว'));
  const avatar = make(document, 'select');
  for (const [value, label] of AVATAR_OPTIONS) {
    const option = make(document, 'option', null, label);
    option.value = value;
    avatar.append(option);
  }
  avatar.value = profile.avatar || 'knight';
  avatarField.append(avatar);

  root.append(nameField, avatarField, make(document, 'div', 'field-label', 'เวลาต่อฝ่าย'));
  const row = make(document, 'div', 'radio-row');
  for (const time of times) {
    const pill = make(document, 'label', 'pill');
    const input = make(document, 'input');
    input.type = 'radio';
    input.name = 'quick-time';
    input.value = time.id;
    input.checked = time.id === timeControlId;
    pill.append(input, make(document, 'span', null, `${time.label} · ${time.sub}`));
    row.append(pill);
  }
  root.append(row);

  const status = make(document, 'p', 'dlg-hint quick-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const start = make(document, 'button', 'btn primary', 'เริ่มหาคู่แข่ง');
  start.type = 'button';
  const cancel = make(document, 'button', 'btn', 'ยกเลิก');
  cancel.type = 'button';
  cancel.hidden = true;
  const actions = make(document, 'div', 'dlg-actions');
  actions.append(start, cancel);
  root.append(status, actions);

  const show = (text, isError = false) => {
    status.hidden = !text;
    status.textContent = text;
    status.classList.toggle('import-error', isError);
  };

  async function submit() {
    const playerName = name.value.trim();
    if (!playerName) {
      show('กรุณาใส่ชื่อที่แสดงก่อน', true);
      name.focus();
      return;
    }
    const chosen = root.querySelector('input[name="quick-time"]:checked')?.value ?? timeControlId;
    start.disabled = true;
    cancel.hidden = false;
    show('กำลังหาโต๊ะที่รอผู้เล่น…');
    try {
      const result = await onStart({ playerName, avatar: avatar.value, timeControlId: chosen });
      if (!result.ok) show(result.message ?? 'เริ่มเกมไม่สำเร็จ', true);
    } catch (error) {
      show(`เริ่มเกมไม่สำเร็จ: ${error?.message ?? 'ข้อผิดพลาดที่ไม่ทราบสาเหตุ'}`, true);
    } finally {
      start.disabled = false;
      cancel.hidden = true;
    }
  }

  start.onclick = submit;
  cancel.onclick = () => {
    onCancel();
    show('ยกเลิกการค้นหาแล้ว');
  };
  root.submit = submit;
  return root;
}
