// Profile / statistics card (roadmap A5 / C2). Built from the local stats store
// only — there are no accounts — so it is a plain DOM builder that takes its data
// and callbacks as arguments and is easy to test.

import { PROVISIONAL_GAMES } from './stats.js';

const RESULT_LABEL = { 1: 'ชนะ', 0.5: 'เสมอ', 0: 'แพ้' };
const REASON_LABEL = {
  checkmate: 'รุกฆาต', stalemate: 'อับ', draw: 'เสมอ', timeout: 'หมดเวลา', resign: 'ยอมแพ้', abandoned: 'ออกจากเกมกลางคัน',
};

function make(document, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * @param {object} opts
 * @param {Document} opts.document
 * @param {ReturnType<import('./stats.js').createStatsStore>} opts.stats
 * @param {Array<{level: number, elo: number}>} opts.levels
 * @param {(level: number) => void} [opts.onPlayLevel]  start a bot game at a level
 * @param {() => void} [opts.onReset]  called after the player confirms a reset
 * @param {(message: string) => boolean} [opts.confirm]
 * @returns {HTMLElement}
 */
export function createProfileView({ document, stats, levels, onPlayLevel, onReset, confirm = () => true }) {
  const root = make(document, 'div', 'profile-card');

  const results = stats.results;
  const rated = results.filter((r) => r.rated);
  const wins = results.filter((r) => r.score === 1).length;
  const draws = results.filter((r) => r.score === 0.5).length;
  const losses = results.length - wins - draws;

  // -- headline rating
  const head = make(document, 'div', 'profile-rating');
  head.append(
    make(document, 'div', 'profile-rating-value', `${stats.rating}${stats.provisional ? '?' : ''}`),
    make(document, 'div', 'profile-rating-label', stats.provisional
      ? `เรตติ้งชั่วคราว · ${stats.ratedGames}/${PROVISIONAL_GAMES} เกมที่นับ`
      : `เรตติ้งจาก ${stats.ratedGames} เกมกับบอท`),
  );
  root.append(head);

  if (!results.length) {
    root.append(make(document, 'p', 'dlg-hint', 'ยังไม่มีเกมกับบอท — เล่นสักเกมเพื่อเริ่มสะสมเรตติ้งและสถิติ'));
  } else {
    const totals = make(document, 'div', 'profile-totals');
    for (const [label, value] of [['เกมทั้งหมด', results.length], ['ชนะ', wins], ['เสมอ', draws], ['แพ้', losses]]) {
      const cell = make(document, 'div', 'profile-total');
      cell.append(make(document, 'b', null, String(value)), make(document, 'span', null, label));
      totals.append(cell);
    }
    root.append(totals);

    if (rated.length >= 2) root.append(ratingSparkline(document, rated.map((r) => r.ratingAfter)));

    // -- per level record
    const table = stats.byLevel();
    const played = levels.filter((l) => table[l.level]);
    const list = make(document, 'div', 'profile-levels');
    list.append(make(document, 'h3', 'profile-heading', 'ผลแยกตามระดับบอท'));
    for (const level of played) {
      const row = table[level.level];
      const line = make(document, 'div', 'profile-level-row');
      line.append(
        make(document, 'span', 'profile-level-name', `ระดับ ${level.level} · Elo ${level.elo}`),
        make(document, 'span', 'profile-level-score', `${row.wins} ชนะ · ${row.draws} เสมอ · ${row.losses} แพ้`),
      );
      list.append(line);
    }
    root.append(list);

    // -- recent games
    const recent = make(document, 'div', 'profile-recent');
    recent.append(make(document, 'h3', 'profile-heading', 'เกมล่าสุด'));
    for (const r of results.slice(-8).reverse()) {
      const chip = make(document, 'span', `profile-chip result-${r.score === 1 ? 'win' : r.score === 0.5 ? 'draw' : 'loss'}`,
        `${RESULT_LABEL[r.score]} · Lv${r.level}${r.rated ? '' : ' *'}`);
      if (r.reason && REASON_LABEL[r.reason]) chip.title = REASON_LABEL[r.reason];
      recent.append(chip);
    }
    if (results.some((r) => !r.rated)) {
      recent.append(make(document, 'p', 'dlg-hint', '* ไม่นับเรตติ้ง (ใช้ย้อนตา/คำใบ้ หรือเกมสั้นเกินไป)'));
    }
    root.append(recent);
  }

  // -- next step
  const suggested = levels.find((l) => l.level === stats.suggestedLevel());
  const actions = make(document, 'div', 'dlg-actions');
  if (suggested && onPlayLevel) {
    const play = make(document, 'button', 'btn primary', `เล่นระดับที่เหมาะกับคุณ (ระดับ ${suggested.level} · Elo ${suggested.elo})`);
    play.type = 'button';
    play.onclick = () => onPlayLevel(suggested.level);
    actions.append(play);
  }
  if (results.length) {
    const reset = make(document, 'button', 'btn', 'ล้างสถิติ');
    reset.type = 'button';
    reset.onclick = () => {
      if (!confirm('ล้างเรตติ้งและสถิติทั้งหมดในเครื่องนี้? ย้อนกลับไม่ได้')) return;
      stats.reset();
      onReset?.();
    };
    actions.append(reset);
  }
  root.append(actions);
  root.append(make(document, 'p', 'dlg-hint', 'เรตติ้งคิดจากเกมกับบอทและเก็บไว้ในเบราว์เซอร์นี้เท่านั้น — เทียบกับระดับบอท ไม่ใช่เรตติ้ง FIDE'));
  return root;
}

/** Tiny inline SVG of the rating after each rated game. */
function ratingSparkline(document, values) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const width = 260;
  const height = 48;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 8) + 4;
    const y = height - 6 - ((v - min) / span) * (height - 12);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'profile-spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `เรตติ้งจาก ${values[0]} เป็น ${values[values.length - 1]}`);
  const line = document.createElementNS(svgNs, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  return svg;
}
