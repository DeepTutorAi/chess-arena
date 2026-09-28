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
