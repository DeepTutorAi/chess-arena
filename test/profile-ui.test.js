// Profile card: real numbers from the local stats store, an honest empty state,
// and a confirmed reset.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { createProfileView } from '../src/profile-ui.js';
import { createStatsStore } from '../src/stats.js';

const levels = Array.from({ length: 11 }, (_, i) => ({ level: i + 1, elo: 800 + i * 200 }));
const levelRating = (level) => levels[level - 1].elo;

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  const store = createStatsStore({ storage: null, levelRating, levelCount: 11, now: () => 1 });
  return { document: window.document, stats: store };
}

test('empty state invites the player to play, and shows no per-level table', (t) => {
  const { document, stats } = setup(t);
  const root = createProfileView({ document, stats, levels });
  assert.match(root.textContent, /ยังไม่มีเกมกับบอท/u);
  assert.equal(root.querySelector('.profile-level-row'), null);
  assert.equal(root.querySelector('.profile-rating-value').textContent, '1000?', 'provisional marker');
  assert.equal(root.querySelectorAll('button').length, 0 + (root.querySelector('.btn.primary') ? 1 : 0));
});

test('shows totals, per-level records and recent games from the store', (t) => {
  const { document, stats } = setup(t);
  stats.recordBotGame({ level: 3, score: 1, color: 'w', plies: 40 });
  stats.recordBotGame({ level: 3, score: 0, color: 'b', plies: 50 });
  stats.recordBotGame({ level: 4, score: 0.5, color: 'w', plies: 60, assisted: true });
  const root = createProfileView({ document, stats, levels });

  const totals = [...root.querySelectorAll('.profile-total')].map((el) => el.textContent);
  assert.deepEqual(totals, ['3เกมทั้งหมด', '1ชนะ', '1เสมอ', '1แพ้']);
  const rows = [...root.querySelectorAll('.profile-level-row')].map((el) => el.textContent);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /ระดับ 3 · Elo 1200.*1 ชนะ · 0 เสมอ · 1 แพ้/u);
  assert.equal(root.querySelectorAll('.profile-chip').length, 3);
  assert.match(root.textContent, /ไม่นับเรตติ้ง/u, 'the assisted game is explained');
  assert.ok(root.querySelector('svg.profile-spark'), 'two rated games draw a rating line');
});

test('names are never interpreted as HTML (no innerHTML in the card)', (t) => {
  const { document, stats } = setup(t);
  stats.recordBotGame({ level: 1, score: 1, color: 'w', plies: 30 });
  const hostileLevels = levels.map((l) => ({ ...l, elo: '<img src=x onerror=alert(1)>' }));
  const root = createProfileView({ document, stats, levels: hostileLevels });
  assert.equal(root.querySelector('img'), null);
});

test('the suggested-level button reports the level', (t) => {
  const { document, stats } = setup(t);
  const played = [];
  const root = createProfileView({ document, stats, levels, onPlayLevel: (level) => played.push(level) });
  const button = root.querySelector('.btn.primary');
  assert.match(button.textContent, /ระดับ 2 · Elo 1000/u, 'a rating of 1000 matches level 2');
  button.click();
  assert.deepEqual(played, [2]);
});

test('reset asks first and only clears after confirmation', (t) => {
  const { document, stats } = setup(t);
  stats.recordBotGame({ level: 2, score: 1, color: 'w', plies: 30 });
  let resets = 0;
  let confirms = 0;
  let answer = false;
  const root = createProfileView({
    document, stats, levels, onReset: () => { resets += 1; }, confirm: () => { confirms += 1; return answer; },
  });
  const reset = [...root.querySelectorAll('button')].find((b) => b.textContent === 'ล้างสถิติ');
  reset.click();
  assert.equal(confirms, 1);
  assert.equal(resets, 0);
  assert.equal(stats.results.length, 1, 'declined: nothing cleared');
  answer = true;
  reset.click();
  assert.equal(resets, 1);
  assert.equal(stats.results.length, 0);
});

test('recent games explain how they ended', (t) => {
  const { document, stats } = setup(t);
  stats.recordBotGame({ level: 2, score: 0, color: 'w', plies: 30, reason: 'abandoned' });
  stats.recordBotGame({ level: 2, score: 1, color: 'w', plies: 30, reason: 'checkmate' });
  const titles = [...createProfileView({ document, stats, levels }).querySelectorAll('.profile-chip')].map((c) => c.title);
  assert.deepEqual(titles, ['รุกฆาต', 'ออกจากเกมกลางคัน']);
});

// ---- mistake bank + accuracy trend ------------------------------------------------------

import { createMistakeBank } from '../src/mistakes.js';
import { createHistoryStore, createMemoryAdapter } from '../src/history.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const bankWith = (count, { due = true } = {}) => {
  const data = {};
  const bank = createMistakeBank({ storage: { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } }, now: () => 1000 });
  const fens = Array.from({ length: count }, (_, i) => `4k3/8/8/8/8/8/${['P7', '1P6', '2P5', '3P4'][i % 4]}/${['K7', '1K6', '2K5'][Math.floor(i / 4)]} w - - 0 1`);
  bank.addFromAnalysis({
    plies: fens.map((_, i) => ({ ply: i, color: 'w', tier: 'blunder', san: 'x', deltaW: 30, bestMove: { from: 'a2', to: 'a3' }, bestSan: 'a3', acceptable: [{ from: 'a2', to: 'a3' }] })),
    fens,
  }, 'w', 'g');
  if (!due) for (const m of bank.all) bank.record(m.id, true);
  return bank;
};
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('an empty mistake bank explains where mistakes come from', (t) => {
  const { document, stats } = setup(t);
  const root = createProfileView({ document, stats, levels, mistakes: bankWith(0) });
  assert.match(root.querySelector('.profile-mistakes').textContent, /ยังไม่มีตาพลาดในคลัง/u);
  assert.equal(root.querySelector('.profile-mistakes button'), null);
});

test('due mistakes offer a practice batch of at most ten', (t) => {
  const { document, stats } = setup(t);
  const calls = [];
  const root = createProfileView({ document, stats, levels, mistakes: bankWith(12), onPractice: (o) => calls.push(o) });
  const totals = [...root.querySelectorAll('.profile-mistakes .profile-total')].map((el) => el.textContent);
  assert.deepEqual(totals, ['12ในคลัง', '12ถึงเวลาทบทวน', '0จำได้แล้ว']);
  const button = root.querySelector('.profile-mistakes .btn.primary');
  assert.match(button.textContent, /ทบทวนตาพลาด \(10 ข้อ\)/u);
  button.click();
  assert.deepEqual(calls, [{ ahead: false }]);
});

test('when nothing is due it offers extra practice instead', (t) => {
  const { document, stats } = setup(t);
  const calls = [];
  const root = createProfileView({ document, stats, levels, mistakes: bankWith(3, { due: false }), onPractice: (o) => calls.push(o) });
  assert.equal(root.querySelector('.profile-mistakes .btn.primary'), null);
  const ahead = [...root.querySelectorAll('.profile-mistakes button')].find((b) => /ล่วงหน้า/.test(b.textContent));
  ahead.click();
  assert.deepEqual(calls, [{ ahead: true }]);
});

test('clearing the bank asks first', (t) => {
  const { document, stats } = setup(t);
  const bank = bankWith(2);
  let answer = false;
  let resets = 0;
  const root = createProfileView({ document, stats, levels, mistakes: bank, confirm: () => answer, onReset: () => { resets += 1; } });
  const wipe = [...root.querySelectorAll('.profile-mistakes button')].find((b) => b.textContent === 'ล้างคลัง');
  wipe.click();
  assert.equal(bank.all.length, 2);
  answer = true;
  wipe.click();
  assert.equal(bank.all.length, 0);
  assert.equal(resets, 1);
});

test('the accuracy trend shows the player\'s own side across analysed games, oldest to newest', async (t) => {
  const { document, stats } = setup(t);
  const history = createHistoryStore({ adapter: createMemoryAdapter(), now: (() => { let n = 0; return () => (n += 10); })() });
  const rec = (humanColor) => ({ initialFen: START_FEN, moves: [{ from: 'e2', to: 'e4' }], result: '1-0', players: {}, humanColor });
  for (const [color, w, b] of [['w', 70, 50], ['b', 60, 80], ['w', 90, 40]]) {
    const id = await history.save({ record: rec(color), source: 'bot' });
    await history.setAnalysis(id, { accuracy: { w, b }, opening: null });
  }
  await history.save({ record: rec('w'), source: 'bot' }); // not analysed: not in the trend
  const root = createProfileView({ document, stats, levels, history });
  await sleep(20);
  const trend = root.querySelector('.profile-trend');
  assert.equal(trend.hidden, false);
  assert.match(trend.querySelector('.profile-heading').textContent, /3 เกมล่าสุด · เฉลี่ย 80%/u);
  assert.equal(trend.querySelector('svg').getAttribute('aria-label'), 'ความแม่นยำจาก 70% เป็น 90%');
});

test('no trend with fewer than two analysed games, and a failing history is harmless', async (t) => {
  const { document, stats } = setup(t);
  const empty = createProfileView({ document, stats, levels, history: createHistoryStore({ adapter: createMemoryAdapter() }) });
  await sleep(10);
  assert.equal(empty.querySelector('.profile-trend').hidden, true);
  const broken = createProfileView({ document, stats, levels, history: { list: async () => { throw new Error('boom'); } } });
  await sleep(10);
  assert.equal(broken.querySelector('.profile-trend').hidden, true);
});
