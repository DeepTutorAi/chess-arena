// Game history list and the import box (roadmap B6). DOM builders that take their
// data and callbacks as arguments: no globals, everything from outside (names,
// PGN text) goes in through textContent.

const RESULT_TEXT = { '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½', '*': '—' };
const SOURCE_TEXT = { bot: 'เล่นกับบอท', online: 'ออนไลน์', arena: 'บอทสู้กัน', import: 'นำเข้า' };

function make(document, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(document, label, onClick, className = 'btn') {
  const b = make(document, 'button', className, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

export function formatDate(ms, now = Date.now()) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? `วันนี้ ${two(d.getHours())}:${two(d.getMinutes())}` : `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * @param {object} opts
 * @param {Document} opts.document
 * @param {ReturnType<import('./history.js').createHistoryStore>} opts.store
 * @param {(id: string) => void} opts.onOpen           review this game
 * @param {(id: string) => void} opts.onPgn            save it as a PGN file
 * @param {(id: string) => void} opts.onLink           copy a share link
 * @param {() => void} opts.onImport                   open the import box
 * @param {(message: string) => boolean} [opts.confirm]
 * @param {() => number} [opts.now]
 * @returns {HTMLElement}
 */
export function createHistoryView({ document, store, onOpen, onPgn, onLink, onImport, confirm = () => true, now = Date.now }) {
  const root = make(document, 'div', 'history-card');
  const bar = make(document, 'div', 'history-bar');
  bar.append(button(document, 'นำเข้า PGN / FEN', () => onImport(), 'btn primary'));
  const clear = button(document, 'ล้างประวัติ', async () => {
    if (!confirm('ลบประวัติเกมทั้งหมดในเครื่องนี้? ย้อนกลับไม่ได้')) return;
    await store.clear();
    await render();
  });
  bar.append(clear);
  root.append(bar);
  const note = make(document, 'p', 'dlg-hint history-note');
  note.hidden = true;
  const list = make(document, 'ul', 'history-list');
  list.setAttribute('aria-label', 'ประวัติเกม');
  const empty = make(document, 'p', 'dlg-hint history-empty', 'กำลังโหลด…');
  root.append(note, list, empty);

  async function render() {
    let games;
    try {
      games = await store.list();
    } catch {
      games = [];
    }
    list.replaceChildren();
    clear.disabled = games.length === 0;
    empty.hidden = games.length > 0;
    empty.textContent = 'ยังไม่มีเกมที่บันทึกไว้ — เล่นจบสักเกมหรือนำเข้า PGN แล้วเกมจะมาอยู่ที่นี่';
    note.hidden = store.persistent;
    note.textContent = 'เบราว์เซอร์นี้ไม่อนุญาตให้เก็บข้อมูลถาวร — ประวัติจะอยู่จนกว่าจะปิดหน้านี้';
    for (const g of games) {
      const row = make(document, 'li', 'history-row');
      row.dataset.id = g.id;
      const main = make(document, 'div', 'history-main');
      main.append(
        make(document, 'span', 'history-players', `${g.white || 'ขาว'} vs ${g.black || 'ดำ'}`),
        make(document, 'span', 'history-result', RESULT_TEXT[g.result] ?? '—'),
      );
      const bits = [formatDate(g.savedAt, now()), SOURCE_TEXT[g.source] ?? g.source, `${Math.ceil(g.plies / 2)} ตา`];
      if (g.opening) bits.push(g.opening);
      if (g.accuracy) bits.push(`แม่นยำ ${g.accuracy.w ?? '—'}% / ${g.accuracy.b ?? '—'}%`);
      const sub = make(document, 'div', 'history-sub', bits.join(' · '));
      const actions = make(document, 'div', 'history-row-actions');
      actions.append(
        button(document, g.analyzed ? 'ดูรีวิว' : 'รีวิว', () => onOpen(g.id), 'btn primary'),
        button(document, 'PGN', () => onPgn(g.id)),
        button(document, 'ลิงก์', () => onLink(g.id)),
        button(document, 'ลบ', async () => {
          await store.remove(g.id);
          await render();
        }),
      );
      row.append(main, sub, actions);
      list.append(row);
    }
  }

  render();
  root.refresh = render;
  return root;
}

/**
 * The import box: paste PGN/FEN text or pick a file.
 * @param {object} opts
 * @param {Document} opts.document
 * @param {(text: string) => Promise<{ok: boolean, error?: string, note?: string}>} opts.onSubmit
 * @returns {HTMLElement}
 */
export function createImportView({ document, onSubmit }) {
  const root = make(document, 'div', 'import-card');
  root.append(make(document, 'p', 'dlg-hint', 'วางข้อความ PGN ของเกม (จาก Lichess, Chess.com, โปรแกรมอื่น) หรือ FEN ของตำแหน่ง แล้วกดวิเคราะห์'));
  const area = make(document, 'textarea', 'import-text');
  area.rows = 8;
  area.placeholder = '[Event "…"]\n\n1. e4 e5 2. Nf3 …\n\nหรือ  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  area.setAttribute('aria-label', 'PGN หรือ FEN');
  area.spellcheck = false;
  const fileInput = make(document, 'input');
  fileInput.type = 'file';
  fileInput.accept = '.pgn,.txt,text/plain';
  fileInput.setAttribute('aria-label', 'เลือกไฟล์ PGN');
  const status = make(document, 'p', 'dlg-hint import-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const go = button(document, 'วิเคราะห์', () => submit(), 'btn primary');
  const actions = make(document, 'div', 'dlg-actions');
  actions.append(go);
  root.append(area, fileInput, status, actions);

  const show = (text, isError) => {
    status.hidden = !text;
    status.textContent = text;
    status.classList.toggle('import-error', Boolean(isError));
  };

  async function submit() {
    go.disabled = true;
    show('กำลังตรวจสอบ…', false);
    try {
      const result = await onSubmit(area.value);
      if (!result.ok) show(result.error ?? 'นำเข้าไม่สำเร็จ', true);
      else show(result.note ?? '', false);
    } catch (error) {
      show(`นำเข้าไม่สำเร็จ: ${error?.message ?? 'ข้อผิดพลาดที่ไม่ทราบสาเหตุ'}`, true);
    } finally {
      go.disabled = false;
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 500_000) {
      show('ไฟล์ใหญ่เกินไป (สูงสุด 500 KB)', true);
      return;
    }
    try {
      area.value = await file.text();
      show(`โหลด ${file.name} แล้ว — กดวิเคราะห์`, false);
    } catch {
      show('อ่านไฟล์ไม่ได้', true);
    }
  });

  root.textarea = area;
  root.submit = submit;
  return root;
}
