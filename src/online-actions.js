// What a player can do in a live online game besides moving (roadmap D2): offer a
// draw, ask for a takeback, abort a game that has barely started. The rules live on
// the server; this decides which controls to offer and builds the option rows.

import { iconClose, iconEqual, iconUndo } from './icons.js';

/**
 * @param {object|null} state  the latest public online state
 * @param {'w'|'b'|null} side  the local player's colour
 * @returns {null | {
 *   abort: boolean,
 *   draw: 'unavailable'|'available'|'blocked'|'waiting'|'incoming',
 *   takeback: 'unavailable'|'available'|'blocked'|'waiting'|'incoming',
 * }}
 */
export function onlineActionAvailability(state, side) {
  if (!state || state.status !== 'active' || (side !== 'w' && side !== 'b')) return null;
  const moves = state.moves.length;
  const offerState = (offer, allowed, block) => {
    if (offer) return offer.by === side ? 'waiting' : 'incoming';
    if (!allowed) return 'unavailable';
    return block === side ? 'blocked' : 'available'; // declined: not again until you have moved
  };
  return {
    abort: moves < 2,
    draw: offerState(state.drawOffer, moves >= 2, state.drawBlock),
    // Only your own last move, until the opponent has answered it.
    takeback: offerState(state.takebackOffer, moves >= 1 && state.turn !== side, state.takebackBlock),
  };
}

function make(document, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function row(document, { icon, danger = false, title, sub, buttons }) {
  const card = make(document, 'div', 'option-item-card');
  const info = make(document, 'div', 'option-item-info');
  const iconWrap = make(document, 'span', `option-item-icon${danger ? ' danger' : ''}`);
  iconWrap.innerHTML = icon; // static SVG from icons.js
  const text = make(document, 'div', 'option-item-text');
  text.append(make(document, 'strong', null, title), make(document, 'span', 'option-item-sub', sub));
  info.append(iconWrap, text);
  const actions = make(document, 'div', 'option-item-actions');
  for (const { label, onClick, className = 'btn', disabled = false } of buttons) {
    const b = make(document, 'button', className, label);
    b.type = 'button';
    b.disabled = disabled;
    b.onclick = onClick;
    actions.append(b);
  }
  card.append(info, actions);
  return card;
}

/**
 * Option rows for an online player: abort (very early), draw, takeback.
 * @param {object} opts
 * @param {Document} opts.document
 * @param {ReturnType<typeof onlineActionAvailability>} opts.availability
 * @param {{abort(): void, drawOffer(): void, drawAccept(): void, drawDecline(): void, drawCancel(): void,
 *          takebackRequest(): void, takebackAccept(): void, takebackDecline(): void, takebackCancel(): void}} opts.actions
 * @param {() => void} [opts.close]  closes the options dialog after an action
 * @returns {HTMLElement[]}
 */
export function createOnlineActionRows({ document, availability, actions, close = () => {} }) {
  if (!availability) return [];
  const then = (fn) => () => { close(); fn(); };
  const rows = [];

  if (availability.abort) {
    rows.push(row(document, {
      icon: iconClose({ size: 20 }), danger: true, title: 'ยกเลิกเกม (Abort)',
      sub: 'เกมเพิ่งเริ่ม — ยกเลิกได้โดยไม่มีผู้แพ้ผู้ชนะ',
      buttons: [{ label: 'ยกเลิกเกม', className: 'btn danger', onClick: then(actions.abort) }],
    }));
  }

  const draw = {
    unavailable: { sub: 'ขอเสมอได้หลังเดินกันคนละตา', buttons: [{ label: 'ขอเสมอ', disabled: true }] },
    available: { sub: 'เสนอให้จบเกมเสมอ — ฝ่ายตรงข้ามต้องยอมรับ', buttons: [{ label: 'ขอเสมอ', className: 'btn primary', onClick: then(actions.drawOffer) }] },
    blocked: { sub: 'ฝ่ายตรงข้ามปฏิเสธไปแล้ว — เดินหมากก่อนจึงจะขอใหม่ได้', buttons: [{ label: 'ขอเสมอ', disabled: true }] },
    waiting: { sub: 'ส่งข้อเสนอแล้ว — รอคำตอบ', buttons: [{ label: 'ยกเลิกข้อเสนอ', onClick: then(actions.drawCancel) }] },
    incoming: {
      sub: 'ฝ่ายตรงข้ามเสนอเสมอ',
      buttons: [
        { label: 'ยอมรับ', className: 'btn primary', onClick: then(actions.drawAccept) },
        { label: 'ปฏิเสธ', onClick: then(actions.drawDecline) },
      ],
    },
  }[availability.draw];
  rows.push(row(document, { icon: iconEqual({ size: 20 }), title: 'เสมอ (Draw)', ...draw }));

  const takeback = {
    unavailable: { sub: 'ย้อนตาได้เฉพาะตาที่เพิ่งเดินและฝ่ายตรงข้ามยังไม่ได้ตอบ', buttons: [{ label: 'ขอย้อนตา', disabled: true }] },
    available: { sub: 'ขอให้ฝ่ายตรงข้ามยอมให้เดินตาล่าสุดใหม่', buttons: [{ label: 'ขอย้อนตา', className: 'btn primary', onClick: then(actions.takebackRequest) }] },
    blocked: { sub: 'ฝ่ายตรงข้ามปฏิเสธไปแล้ว — เดินหมากก่อนจึงจะขอใหม่ได้', buttons: [{ label: 'ขอย้อนตา', disabled: true }] },
    waiting: { sub: 'ส่งคำขอแล้ว — รอคำตอบ', buttons: [{ label: 'ยกเลิกคำขอ', onClick: then(actions.takebackCancel) }] },
    incoming: {
      sub: 'ฝ่ายตรงข้ามขอย้อนตาล่าสุดของเขา',
      buttons: [
        { label: 'ยอมรับ', className: 'btn primary', onClick: then(actions.takebackAccept) },
        { label: 'ปฏิเสธ', onClick: then(actions.takebackDecline) },
      ],
    },
  }[availability.takeback];
  rows.push(row(document, { icon: iconUndo({ size: 20 }), title: 'ย้อนตา (Takeback)', ...takeback }));
  return rows;
}

