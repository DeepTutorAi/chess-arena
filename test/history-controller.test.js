// The controller keeps finished games, reopens them from history / pasted PGN /
// share links, and can hand a game out as a PGN file or a link.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Chess } from 'chess.js';

import { Controller, MODES } from '../src/controller.js';
import { createHistoryStore, createMemoryAdapter } from '../src/history.js';
import { createStatsStore } from '../src/stats.js';
import { LEVELS, levelRating } from '../src/config.js';
import { encodeShareToken, parsePgn } from '../src/pgn.js';

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, { timeout = 3000, label = 'condition' } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

class FakeWorker {
  static instances = [];
  constructor() { this.messages = []; this.fen = null; this.terminated = false; FakeWorker.instances.push(this); }
  postMessage(cmd) {
    const line = String(cmd);
    this.messages.push(line);
    if (line === 'uci') this.onmessage?.({ data: 'uciok' });
    if (line === 'isready') this.onmessage?.({ data: 'readyok' });
    if (line.startsWith('position fen ')) this.fen = line.slice('position fen '.length);
    if (line.startsWith('go ')) {
      const move = new Chess(this.fen).moves({ verbose: true })[0];
      const uci = move.from + move.to + (move.promotion ?? '');
      this.onmessage?.({ data: `info depth 12 multipv 1 score cp 20 wdl 50 900 50 nodes 1 pv ${uci}` });
      this.onmessage?.({ data: `bestmove ${uci}` });
    }
  }
  terminate() { this.terminated = true; }
}

let cleanups = [];
function harness(t, { fetchImpl = async () => ({ ok: false }) } = {}) {
  cleanups = [];
  const window = new Window({ url: 'https://chess.example.test/app/' });
  const saved = { Worker: globalThis.Worker, fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, raf: globalThis.requestAnimationFrame };
  Object.assign(globalThis, { window, document: window.document, Worker: FakeWorker, fetch: fetchImpl, requestAnimationFrame: (cb) => { cb(); return 1; } });
  FakeWorker.instances = [];
  const calls = { toasts: [], gameOvers: [], home: 0, ratings: [] };
  const ui = new Proxy({
    showFloatingToast(opts) { calls.toasts.push(opts); },
    showGameOver(title, detail) {
      calls.gameOvers.push({ title, detail });
      const overlay = { body: { isConnected: true }, close() { overlay.body.isConnected = false; } };
      return overlay;
    },
    showHomeView() { calls.home += 1; },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {}, setAutoShapes() {}, cancelPremove() {}, playPremove() {} };
  const history = createHistoryStore({ adapter: createMemoryAdapter(), now: (() => { let n = 1_000; return () => (n += 10); })() });
  const shared = { downloads: [], copies: [] };
  const controller = new Controller({
    ui, ground, onPromotion: async () => 'q', gameOverDelayMs: 0, history,
    stats: createStatsStore({ storage: null, levelRating, levelCount: LEVELS.length }),
    loadBotBook: async () => null,
    turnAlert: { notify() {}, clear() {}, destroy() {} },
    shareTools: {
      download: (name, text) => { shared.downloads.push({ name, text }); return true; },
      copy: async (text) => { shared.copies.push(text); return true; },
      url: (token) => `https://chess.example.test/app/#g=${token}`,
    },
  });
  cleanups.push(() => controller.dispose());
  t.after(() => {
    for (const fn of cleanups.splice(0)) fn();
    window.close();
    Object.assign(globalThis, { Worker: saved.Worker, fetch: saved.fetch, window: saved.window, document: saved.document, requestAnimationFrame: saved.raf });
  });
  return { controller, history, calls, shared };
}

const foolsMate = () => { const g = new Chess(); for (const s of ['f3', 'e5', 'g4', 'Qh4#']) g.move(s); return g; };
const PGN = `[Event "Casual"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n`;

// ---- saving --------------------------------------------------------------------------------

test('a finished bot game is saved once, with who the bot was', async (t) => {
  const { controller, history } = harness(t);
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'b';
  controller.levelIndex = 3;
  controller.timeControlId = 'blitz_5_0';
  controller.game = foolsMate();
  controller._announceGameOver();
  controller._announceGameOver(); // announced again (e.g. after an undo): still one entry
  await sleep(20);
  const list = await history.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'bot');
  assert.equal(list[0].botLevel, 4);
  assert.equal(list[0].humanColor, 'b');
  assert.equal(list[0].plies, 4);
  const entry = await history.get(list[0].id);
  assert.deepEqual(entry.record.timeControl, { initialMs: 300000, incMs: 0 });
  assert.equal(entry.record.result, '0-1');
});

test('bot-vs-bot games are saved as arena games; the sandbox is not saved', async (t) => {
  const { controller, history } = harness(t);
  controller.mode = MODES.AI_VS_AI;
  controller.game = foolsMate();
  controller._announceGameOver();
  await sleep(20);
  assert.deepEqual((await history.list()).map((g) => g.source), ['arena']);

  const sandbox = harness(t);
  sandbox.controller.mode = MODES.ANALYZE;
  sandbox.controller.game = foolsMate();
  sandbox.controller._announceGameOver();
  await sleep(20);
  assert.equal((await sandbox.history.list()).length, 0);
});

test('a broken history store never breaks the end of a game', async (t) => {
  const { controller, calls } = harness(t);
  controller.history = { save: async () => { throw new Error('disk full'); }, setAnalysis: async () => {} };
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'b';
  controller.game = foolsMate();
  controller._announceGameOver();
  await sleep(20);
  assert.equal(calls.gameOvers.length, 1, 'the game-over card still appeared');
});

test('the finished review is stored with the game so it opens instantly next time', async (t) => {
  const { controller, history } = harness(t);
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'b';
  controller.game = foolsMate();
  controller._announceGameOver();
  controller.startReview();
  await until(() => document.querySelector('.review-summary-modal'), { label: 'summary' });
  await until(async () => true);
  await sleep(30);
  const [meta] = await history.list();
  assert.equal(meta.analyzed, true);
  assert.ok(meta.accuracy);
  assert.equal((await history.get(meta.id)).analysis.plies.length, 4);
});

// ---- reopening -------------------------------------------------------------------------------

test('importing a PGN puts the game on the board, saves it and starts the review', async (t) => {
  const { controller, history, calls } = harness(t);
  const result = await controller.importText(PGN);
  assert.equal(result.ok, true);
  assert.equal(controller.mode, MODES.ANALYZE);
  assert.equal(controller.game.history().length, 7);
  assert.equal(controller._reviewActive, true);
  assert.ok(document.querySelector('.review-modal-overlay'), 'analysis is under way');
  const [meta] = await history.list();
  assert.equal(meta.source, 'import');
  assert.equal(meta.white, 'Alice');
  await until(() => document.querySelector('.review-summary-modal'), { label: 'summary' });
  assert.equal(calls.toasts.length, 0);
});

test('a multi-game PGN uses the first game and says so', async (t) => {
  const { controller } = harness(t);
  const result = await controller.importText(`${PGN}\n${PGN.replace('Casual', 'Second').replace('Alice', 'Carol')}`);
  assert.equal(result.ok, true);
  assert.match(result.note, /พบ 2 เกม/u);
  assert.equal(controller._lastGameRecord.players.white.name, 'Alice');
});

test('bad text is refused with a message and leaves the current state alone', async (t) => {
  const { controller, history } = harness(t);
  controller.mode = MODES.HUMAN_VS_AI;
  const before = controller.mode;
  for (const bad of ['', 'hello there', '1. e4 e5 2. Qxx7', '[Event "x"]\n\n1. e5']) {
    const result = await controller.importText(bad);
    assert.equal(result.ok, false, bad);
    assert.ok(result.error);
  }
  assert.equal(controller.mode, before);
  assert.equal((await history.list()).length, 0);
});

test('a pasted FEN opens the analysis board on that position with the engine on', async (t) => {
  const { controller } = harness(t);
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const result = await controller.importText(fen);
  assert.equal(result.ok, true);
  assert.equal(controller.mode, MODES.ANALYZE);
  assert.equal(controller.game.fen(), fen);
  assert.equal(controller.spectatorEval?.enabled, true, 'the live evaluation is running');
  assert.equal(controller._reviewActive, false);
});

test('a saved game with its analysis reopens straight into the summary, with no new engine run', async (t) => {
  const { controller, history } = harness(t);
  await controller.importText(PGN);
  await until(() => document.querySelector('.review-summary-modal'), { label: 'first summary' });
  await sleep(30);
  const [meta] = await history.list();
  document.querySelector('.review-modal-close').click();
  controller.goHome();
  const workersBefore = FakeWorker.instances.length;

  const result = await controller.openHistoryEntry(meta.id);
  assert.equal(result.ok, true);
  assert.ok(document.querySelector('.review-summary-modal'), 'summary shown at once from the stored analysis');
  assert.equal(FakeWorker.instances.length, workersBefore, 'no new analysis');
});

test('opening a game that was deleted meanwhile is a polite error', async (t) => {
  const { controller } = harness(t);
  const result = await controller.openHistoryEntry('gone');
  assert.equal(result.ok, false);
  assert.match(result.error, /ไม่พบเกมนี้/u);
});

test('a game opened from history has nothing to "play again": that goes home', async (t) => {
  const { controller, calls } = harness(t);
  await controller.importText(PGN);
  const homeBefore = calls.home;
  controller.newGame();
  assert.equal(calls.home, homeBefore + 1);
});

test('a game opened from history is not saved a second time when it ends its review', async (t) => {
  const { controller, history } = harness(t);
  await controller.importText(PGN);
  await until(() => document.querySelector('.review-summary-modal'));
  await sleep(30);
  assert.equal((await history.list()).length, 1);
});

// ---- share links ------------------------------------------------------------------------------

test('a share link opens the game for review; a broken one only shows a message', async (t) => {
  const { controller, calls, history } = harness(t);
  const record = parsePgn(PGN).record;
  const token = await encodeShareToken(record);
  const ok = await controller.openSharedToken(token);
  assert.equal(ok.ok, true);
  assert.equal(controller.game.history().length, 7);
  assert.equal((await history.list()).length, 1);

  const bad = await controller.openSharedToken('d.garbage!!');
  assert.equal(bad.ok, false);
  assert.equal(calls.toasts.at(-1).title, 'เปิดลิงก์ไม่ได้');
});

// ---- getting a game out --------------------------------------------------------------------------

test('exportPgn downloads a real, re-importable PGN', async (t) => {
  const { controller, shared, calls } = harness(t);
  await controller.importText(PGN);
  const record = controller._lastGameRecord;
  assert.equal(controller.exportPgn(record), true);
  assert.equal(shared.downloads.length, 1);
  assert.match(shared.downloads[0].name, /^Alice-vs-Bob-\d{4}-\d{2}-\d{2}\.pgn$/u);
  const pgn = shared.downloads[0].text;
  assert.match(pgn, /^\[Event "Chess Arena"\]/u);
  assert.match(pgn, /\[White "Alice"\]/u);
  assert.match(pgn, /1\. e4 e5 2\. Qh5 Nc6 3\. Bc4 Nf6 4\. Qxf7# 1-0/u);
  assert.deepEqual(parsePgn(pgn).record.moves.map((m) => m.san), record.moves.map((m) => m.san), 'the file imports back to the same game');
  assert.equal(calls.toasts.at(-1).title, 'บันทึกไฟล์ PGN แล้ว');
  assert.equal(controller.exportPgn({ moves: [] }), false, 'nothing to export');
});

test('copyShareLink copies a link that opens the same game', async (t) => {
  const { controller, shared, calls } = harness(t);
  await controller.importText(PGN);
  assert.equal(await controller.copyShareLink(controller._lastGameRecord), true);
  const link = shared.copies[0];
  assert.match(link, /^https:\/\/chess\.example\.test\/app\/#g=d\./u);
  assert.equal(calls.toasts.at(-1).title, 'คัดลอกลิงก์แล้ว');
  const token = link.split('#g=')[1];
  const again = await controller.openSharedToken(token);
  assert.equal(again.ok, true);
});

test('a clipboard that refuses shows the link so it can be copied by hand', async (t) => {
  const { controller, calls } = harness(t);
  await controller.importText(PGN);
  controller.shareTools.copy = async () => false;
  assert.equal(await controller.copyShareLink(controller._lastGameRecord), false);
  assert.match(calls.toasts.at(-1).detail, /#g=/u);
});
