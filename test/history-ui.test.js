// History list + import box + share plumbing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { createHistoryView, createImportView, formatDate } from '../src/history-ui.js';
import { createHistoryStore, createMemoryAdapter } from '../src/history.js';
import { copyText, downloadTextFile, pgnFilename, shareUrl } from '../src/share-ui.js';

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/app/' });
  t.after(() => window.close());
  const store = createHistoryStore({ adapter: createMemoryAdapter(), now: (() => { let n = 1_000; return () => (n += 100); })() });
  return { window, document: window.document, store };
}

const record = (white = 'Alice', black = 'Bob', extra = {}) => ({
  initialFen: null, moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }, { from: 'g1', to: 'f3' }],
  result: '1-0', reason: 'checkmate', players: { white: { name: white }, black: { name: black } }, ...extra,
});

// ---- history list ---------------------------------------------------------------------

test('an empty history says so and disables clearing', async (t) => {
  const { document, store } = setup(t);
  const view = createHistoryView({ document, store, onOpen() {}, onPgn() {}, onLink() {}, onImport() {} });
  await sleep();
  assert.equal(view.querySelectorAll('.history-row').length, 0);
  assert.match(view.querySelector('.history-empty').textContent, /ยังไม่มีเกม/u);
  assert.equal([...view.querySelectorAll('button')].find((b) => b.textContent === 'ล้างประวัติ').disabled, true);
});

test('each saved game is a row with its players, result, size and source; newest first', async (t) => {
  const { document, store } = setup(t);
  await store.save({ record: record('Alice', 'Bob'), source: 'bot' });
  const id = await store.save({ record: record('Carol', 'Dave', { result: '0-1' }), source: 'online' });
  await store.setAnalysis(id, { accuracy: { w: 91.5, b: 70 }, opening: { name: 'Italian Game' } });
  const view = createHistoryView({ document, store, onOpen() {}, onPgn() {}, onLink() {}, onImport() {}, now: () => 1_200 });
  await sleep();
  const rows = [...view.querySelectorAll('.history-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector('.history-players').textContent, /Carol vs Dave/u);
  assert.equal(rows[0].querySelector('.history-result').textContent, '0–1');
  assert.match(rows[0].querySelector('.history-sub').textContent, /ออนไลน์.*2 ตา.*Italian Game.*แม่นยำ 91\.5% \/ 70%/u);
  assert.equal(rows[0].querySelector('.btn.primary').textContent, 'ดูรีวิว', 'an analysed game opens instantly');
  assert.equal(rows[1].querySelector('.btn.primary').textContent, 'รีวิว');
  assert.match(rows[1].querySelector('.history-sub').textContent, /เล่นกับบอท/u);
});

test('row actions call back with the game id', async (t) => {
  const { document, store } = setup(t);
  const id = await store.save({ record: record(), source: 'bot' });
  const calls = [];
  const view = createHistoryView({
    document, store, onOpen: (i) => calls.push(['open', i]), onPgn: (i) => calls.push(['pgn', i]),
    onLink: (i) => calls.push(['link', i]), onImport: () => calls.push(['import']),
  });
  await sleep();
  const row = view.querySelector('.history-row');
  for (const label of ['รีวิว', 'PGN', 'ลิงก์']) [...row.querySelectorAll('button')].find((b) => b.textContent === label).click();
  [...view.querySelectorAll('button')].find((b) => b.textContent === 'นำเข้า PGN / FEN').click();
  assert.deepEqual(calls, [['open', id], ['pgn', id], ['link', id], ['import']]);
});

test('deleting a row removes just that game; clearing asks first', async (t) => {
  const { document, store } = setup(t);
  const a = await store.save({ record: record('A', 'B'), source: 'bot' });
  await store.save({ record: record('C', 'D'), source: 'bot' });
  let answer = false;
  const view = createHistoryView({ document, store, onOpen() {}, onPgn() {}, onLink() {}, onImport() {}, confirm: () => answer });
  await sleep();
  [...view.querySelectorAll('.history-row')].at(-1).querySelectorAll('button')[3].click(); // ลบ on the older row (A vs B)
  await sleep(20);
  assert.equal(view.querySelectorAll('.history-row').length, 1);
  assert.equal(await store.get(a), null);

  const clear = [...view.querySelectorAll('button')].find((b) => b.textContent === 'ล้างประวัติ');
  clear.click();
  await sleep(20);
  assert.equal((await store.list()).length, 1, 'declined: nothing cleared');
  answer = true;
  clear.click();
  await sleep(20);
  assert.equal((await store.list()).length, 0);
  assert.equal(view.querySelectorAll('.history-row').length, 0);
});

test('names are shown as text, never as markup', async (t) => {
  const { document, store } = setup(t);
  await store.save({ record: record('<img src=x onerror=alert(1)>', '<b>Bob</b>'), source: 'import' });
  const view = createHistoryView({ document, store, onOpen() {}, onPgn() {}, onLink() {}, onImport() {} });
  await sleep();
  assert.equal(view.querySelector('img'), null);
  assert.equal(view.querySelector('b'), null);
  assert.match(view.querySelector('.history-players').textContent, /<img src=x/u);
});

test('a session-only store tells the player the history will not survive', async (t) => {
  const { document, store } = setup(t); // the memory adapter is not persistent
  const view = createHistoryView({ document, store, onOpen() {}, onPgn() {}, onLink() {}, onImport() {} });
  await sleep();
  assert.equal(view.querySelector('.history-note').hidden, false);
  const persistent = { persistent: true, list: async () => [], clear: async () => {}, remove: async () => {} };
  const view2 = createHistoryView({ document, store: persistent, onOpen() {}, onPgn() {}, onLink() {}, onImport() {} });
  await sleep();
  assert.equal(view2.querySelector('.history-note').hidden, true);
});

test('formatDate says "today" with the time, otherwise the date', () => {
  const now = new Date(2026, 8, 28, 15, 0).getTime();
  assert.equal(formatDate(new Date(2026, 8, 28, 9, 5).getTime(), now), 'วันนี้ 09:05');
  assert.equal(formatDate(new Date(2026, 8, 3, 9, 5).getTime(), now), '03/09/2026');
});

// ---- import box ------------------------------------------------------------------------

test('the import box submits its text and shows the result of the import', async (t) => {
  const { document } = setup(t);
  const seen = [];
  const view = createImportView({ document, onSubmit: async (text) => { seen.push(text); return { ok: false, error: 'ตา "Ng8" ผิดกติกา' }; } });
  view.textarea.value = '1. e4 e5';
  await view.submit();
  assert.deepEqual(seen, ['1. e4 e5']);
  const status = view.querySelector('.import-status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Ng8/u);
  assert.equal(status.classList.contains('import-error'), true);
  assert.equal(view.querySelector('.btn.primary').disabled, false, 'can try again');
});

test('a successful import shows its note without an error style; a thrown error is contained', async (t) => {
  const { document } = setup(t);
  const ok = createImportView({ document, onSubmit: async () => ({ ok: true, note: 'พบ 3 เกม — ใช้เกมแรก' }) });
  await ok.submit();
  assert.equal(ok.querySelector('.import-status').textContent, 'พบ 3 เกม — ใช้เกมแรก');
  assert.equal(ok.querySelector('.import-status').classList.contains('import-error'), false);

  const boom = createImportView({ document, onSubmit: async () => { throw new Error('kaboom'); } });
  await boom.submit();
  assert.match(boom.querySelector('.import-status').textContent, /kaboom/u);
  assert.equal(boom.querySelector('.btn.primary').disabled, false);
});

test('picking a file fills the box, and an oversized file is refused', async (t) => {
  const { document } = setup(t);
  const view = createImportView({ document, onSubmit: async () => ({ ok: true }) });
  const input = view.querySelector('input[type=file]');
  const pick = (file) => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new document.defaultView.Event('change'));
  };
  pick({ name: 'game.pgn', size: 40, text: async () => '1. d4 d5 *' });
  await sleep(10);
  assert.equal(view.textarea.value, '1. d4 d5 *');
  assert.match(view.querySelector('.import-status').textContent, /game\.pgn/u);
  pick({ name: 'huge.pgn', size: 900_000, text: async () => 'x' });
  await sleep(10);
  assert.match(view.querySelector('.import-status').textContent, /ใหญ่เกินไป/u);
  assert.equal(view.textarea.value, '1. d4 d5 *', 'the big file was not read');
});

// ---- share plumbing ----------------------------------------------------------------------

test('pgnFilename is filesystem-safe and readable', () => {
  const date = new Date(2026, 8, 5);
  assert.equal(pgnFilename({ players: { white: { name: 'Alice' }, black: { name: 'Stockfish 18 (Lite) Elo 1440' } } }, date), 'Alice-vs-Stockfish_18_Lite_Elo_14-2026-09-05.pgn');
  assert.equal(pgnFilename({ players: { white: { name: '../../etc/passwd' }, black: { name: '' } } }, date), 'etc_passwd-vs-black-2026-09-05.pgn');
  assert.equal(pgnFilename({ players: { white: { name: 'คุณ' }, black: { name: 'บอท' } } }, date), 'white-vs-black-2026-09-05.pgn', 'non-ASCII names would make the browser drop the whole file name');
  assert.equal(pgnFilename({}, date), 'white-vs-black-2026-09-05.pgn');
});

test('downloadTextFile clicks a temporary link and revokes the URL later', (t) => {
  const { document } = setup(t);
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (fn) => { timers.push(fn); return 1; });
  const revoked = [];
  let clicked = null;
  document.createElement = ((orig) => (tag) => {
    const el = orig.call(document, tag);
    if (tag === 'a') el.click = () => { clicked = { href: el.href, download: el.download, inDom: el.isConnected }; };
    return el;
  })(document.createElement);
  const ok = downloadTextFile('g.pgn', '1. e4 *', {
    doc: document,
    urlApi: { createObjectURL: () => 'blob:abc', revokeObjectURL: (u) => revoked.push(u) },
    BlobImpl: class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } },
  });
  assert.equal(ok, true);
  assert.deepEqual(clicked, { href: 'blob:abc', download: 'g.pgn', inDom: true });
  assert.equal(document.querySelector('a[download]'), null, 'the link is removed again');
  assert.deepEqual(revoked, [], 'not revoked immediately');
  timers.forEach((fn) => fn());
  assert.deepEqual(revoked, ['blob:abc']);
  assert.equal(downloadTextFile('g.pgn', 'x', { doc: document, urlApi: {}, BlobImpl: class {} }), false, 'failure is reported, not thrown');
});

test('copyText uses the clipboard API, falls back to selection copy, and reports failure', async (t) => {
  const { document } = setup(t);
  const written = [];
  assert.equal(await copyText('hello', { nav: { clipboard: { writeText: async (v) => written.push(v) } }, doc: document }), true);
  assert.deepEqual(written, ['hello']);

  let copied = null;
  document.execCommand = () => { copied = document.querySelector('textarea')?.value; return true; };
  assert.equal(await copyText('fallback', { nav: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc: document }), true);
  assert.equal(copied, 'fallback');
  assert.equal(document.querySelector('textarea'), null, 'the helper textarea is cleaned up');

  document.execCommand = () => false;
  assert.equal(await copyText('nope', { nav: {}, doc: document }), false);
});

test('shareUrl puts the token in the hash of the current page', () => {
  assert.equal(shareUrl('d.abc', { origin: 'https://x.test', pathname: '/arena/' }), 'https://x.test/arena/#g=d.abc');
});
