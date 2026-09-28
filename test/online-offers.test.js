// Draw offers, takebacks and abort on the client: what is offered when, what an
// incoming request looks like, and what happens when ours is answered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { Window } from 'happy-dom';

import { Controller, MODES } from '../src/controller.js';
import { createOnlineActionRows, onlineActionAvailability } from '../src/online-actions.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ID = 'abcdefgh23456722';
const TOKEN = 'A'.repeat(43);

function stateAfter(moves = [], overrides = {}) {
  const game = new Chess();
  let last = null;
  for (const uci of moves) last = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return {
    protocol: 'chess-arena-online', version: 1, type: 'state', roomId: ROOM_ID, title: 'Room', revision: 1 + moves.length,
    status: 'active', initialFen: START_FEN, fen: game.fen(), turn: game.turn(),
    lastMove: last ? last.from + last.to : null, lastMoveSan: last?.san ?? null, moves, result: null, reason: null,
    drawOffer: null, takebackOffer: null,
    players: { w: { name: 'Host', avatar: 'knight', connected: true }, b: { name: 'Guest', avatar: 'rook', connected: true } },
    visibility: 'public', allowSpectators: true, spectators: [], spectatorCount: 0, clock: null, afk: null, hostColor: 'w',
    expiresAt: Date.now() + 60_000, ...overrides,
  };
}
const TWO = ['e2e4', 'e7e5'];

// ---- availability -----------------------------------------------------------------------

test('nothing is offered outside an active game or to someone without a side', () => {
  assert.equal(onlineActionAvailability(null, 'w'), null);
  assert.equal(onlineActionAvailability(stateAfter(TWO, { status: 'finished' }), 'w'), null);
  assert.equal(onlineActionAvailability(stateAfter(TWO, { status: 'waiting' }), 'w'), null);
  assert.equal(onlineActionAvailability(stateAfter(TWO), null), null);
});

test('abort only in the first moves; draws from the second ply; takeback only for your own last move', () => {
  const start = onlineActionAvailability(stateAfter([]), 'w');
  assert.deepEqual(start, { abort: true, draw: 'unavailable', takeback: 'unavailable' });
  const oneMove = stateAfter(['e2e4']); // black to move
  assert.deepEqual(onlineActionAvailability(oneMove, 'w'), { abort: true, draw: 'unavailable', takeback: 'available' }, 'white can take back e4');
  assert.deepEqual(onlineActionAvailability(oneMove, 'b'), { abort: true, draw: 'unavailable', takeback: 'unavailable' }, 'black has nothing to take back');
  const two = stateAfter(TWO);
  assert.deepEqual(onlineActionAvailability(two, 'w'), { abort: false, draw: 'available', takeback: 'unavailable' }, 'black just moved');
  assert.deepEqual(onlineActionAvailability(two, 'b'), { abort: false, draw: 'available', takeback: 'available' });
});

test('an open offer is "waiting" for its maker and "incoming" for the other side', () => {
  const draw = stateAfter(TWO, { drawOffer: { by: 'w' } });
  assert.equal(onlineActionAvailability(draw, 'w').draw, 'waiting');
  assert.equal(onlineActionAvailability(draw, 'b').draw, 'incoming');
  const takeback = stateAfter(['e2e4'], { takebackOffer: { by: 'w' } });
  assert.equal(onlineActionAvailability(takeback, 'w').takeback, 'waiting');
  assert.equal(onlineActionAvailability(takeback, 'b').takeback, 'incoming');
});

// ---- the option rows ----------------------------------------------------------------------

function rowsFor(availability, t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => window.close());
  const calls = [];
  let closed = 0;
  const names = ['abort', 'drawOffer', 'drawAccept', 'drawDecline', 'drawCancel', 'takebackRequest', 'takebackAccept', 'takebackDecline', 'takebackCancel'];
  const actions = Object.fromEntries(names.map((n) => [n, () => calls.push(n)]));
  const rows = createOnlineActionRows({ document: window.document, availability, actions, close: () => { closed += 1; } });
  const buttons = rows.flatMap((r) => [...r.querySelectorAll('button')]);
  return { rows, buttons, calls, closedCount: () => closed, text: () => rows.map((r) => r.textContent).join(' | ') };
}
const button = (rows, label) => rows.buttons.find((b) => b.textContent === label);

test('no rows for spectators / finished games', (t) => {
  assert.deepEqual(rowsFor(null, t).rows, []);
});

test('a fresh game offers abort but not draw or takeback', (t) => {
  const r = rowsFor(onlineActionAvailability(stateAfter([]), 'w'), t);
  assert.equal(button(r, 'ยกเลิกเกม').disabled, false);
  assert.equal(button(r, 'ขอเสมอ').disabled, true);
  assert.equal(button(r, 'ขอย้อนตา').disabled, true);
  button(r, 'ยกเลิกเกม').click();
  assert.deepEqual(r.calls, ['abort']);
  assert.equal(r.closedCount(), 1, 'the dialog closes after an action');
});

test('a mid-game position offers draw, hides abort and lets the right side ask for a takeback', (t) => {
  const r = rowsFor(onlineActionAvailability(stateAfter(TWO), 'b'), t);
  assert.equal(button(r, 'ยกเลิกเกม'), undefined, 'too late to abort');
  button(r, 'ขอเสมอ').click();
  button(r, 'ขอย้อนตา').click();
  assert.deepEqual(r.calls, ['drawOffer', 'takebackRequest']);
});

test('incoming requests show accept / decline and pending ones can be withdrawn', (t) => {
  const incoming = rowsFor(onlineActionAvailability(stateAfter(TWO, { drawOffer: { by: 'w' }, takebackOffer: { by: 'w' } }), 'b'), t);
  button(incoming, 'ยอมรับ').click();
  assert.deepEqual(incoming.calls, ['drawAccept']);
  assert.match(incoming.text(), /ฝ่ายตรงข้ามเสนอเสมอ/u);
  assert.equal(incoming.buttons.filter((b) => b.textContent === 'ปฏิเสธ').length, 2);

  const waiting = rowsFor(onlineActionAvailability(stateAfter(TWO, { drawOffer: { by: 'w' } }), 'w'), t);
  assert.match(waiting.text(), /รอคำตอบ/u);
  button(waiting, 'ยกเลิกข้อเสนอ').click();
  assert.deepEqual(waiting.calls, ['drawCancel']);
});

// ---- the controller ------------------------------------------------------------------------------

function makeHarness(role = 'host', color = 'w') {
  const harnessRef = {};
  const calls = { sent: [], toasts: [], gameOver: null, logs: [] };
  const toastNodes = [];
  const ui = new Proxy({
    log(message, level) { calls.logs.push([message, level]); },
    showFloatingToast(opts) {
      const node = { ...opts, isConnected: true, remove() { this.isConnected = false; } };
      toastNodes.forEach((n) => n.remove()); // like the real one: a new toast replaces the old
      toastNodes.push(node);
      calls.toasts.push(node);
      return node;
    },
    showGameOver(title, detail) {
      calls.gameOver = [title, detail];
      const overlay = { body: { isConnected: true }, close() { overlay.body.isConnected = false; } };
      return overlay;
    },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {}, cancelPremove() {} };
  let callbacks;
  const record = (name) => (...args) => calls.sent.push([name, ...args]);
  const client = {
    session: null, state: null,
    async create() {
      this.session = { sessionToken: TOKEN, role, color };
      this.state = stateAfter();
      return { roomId: ROOM_ID, inviteToken: 'I'.repeat(43), ...this.session, state: this.state };
    },
    connect() { callbacks.onConnectionState('connected'); },
    stop() {},
    abort: record('abort'), drawOffer: record('drawOffer'), drawAccept: record('drawAccept'), drawDecline: record('drawDecline'),
    drawCancel: record('drawCancel'), takebackRequest: record('takebackRequest'), takebackAccept: record('takebackAccept'),
    takebackDecline: record('takebackDecline'), takebackCancel: record('takebackCancel'),
  };
  const controller = new Controller({
    ui, ground, onPromotion: async () => 'q', gameOverDelayMs: 0,
    onlineClientFactory(options) { callbacks = options; harnessRef.callbacks = options; return client; },
    history: { save: async () => 'id', setAnalysis: async () => true },
    turnAlert: { notify() {}, clear() {}, destroy() {} },
  });
  return { controller, calls, client, harnessRef };
}

async function playing(t, role = 'host', color = 'w') {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const window = new Window({ url: 'https://chess.example.test/' });
  globalThis.window = window;
  globalThis.document = window.document;
  t.after(() => window.close());
  const h = makeHarness(role, color);
  await h.controller.start(MODES.ONLINE, { action: 'create', playerName: 'Me', title: 'T', color, timeControlId: 'unlimited' });
  t.after(() => h.controller.dispose());
  return h;
}

test('our requests go out with the current revision; the receipt comes from the server, not the click', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO));
  assert.equal(controller.offerDraw(), true);
  assert.equal(controller.requestTakeback(), true);
  assert.equal(controller.abortOnlineGame(), true);
  assert.deepEqual(calls.sent, [['drawOffer', 3], ['takebackRequest', 3], ['abort', 3]]);
  assert.equal(calls.toasts.length, 0, 'nothing is claimed before the server has answered');

  controller._onOnlineState(stateAfter(TWO, { revision: 4, drawOffer: { by: 'w' } }));
  assert.equal(calls.toasts.at(-1).title, 'ส่งข้อเสนอเสมอแล้ว', 'the snapshot with our offer confirms it');
  controller._onOnlineState(stateAfter(TWO, { revision: 5, drawOffer: { by: 'w' } }));
  assert.equal(calls.toasts.filter((t) => t.title === 'ส่งข้อเสนอเสมอแล้ว').length, 1, 'said once');
});

test('a refused request is shown to the player, not only logged', async (t) => {
  const { controller, calls, harnessRef } = await playing(t);
  controller._onOnlineState(stateAfter(TWO));
  harnessRef.callbacks.onError('อีกฝ่ายปฏิเสธข้อเสนอเสมอแล้ว — เดินหมากก่อนจึงจะขอใหม่ได้', { code: 'draw_blocked' });
  assert.match(calls.toasts.at(-1).title, /ปฏิเสธข้อเสนอเสมอแล้ว/u);
  const count = calls.toasts.length;
  harnessRef.callbacks.onError('rate limited', { code: 'rate_limited' });
  assert.equal(calls.toasts.length, count, 'other errors stay in the log');
});

test('a failed send is logged, not thrown', async (t) => {
  const { controller, client, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO));
  client.drawOffer = () => { throw new Error('ยังไม่ได้เชื่อมต่อห้อง'); };
  assert.equal(controller.offerDraw(), false);
  assert.match(calls.logs.at(-1)[0], /ส่งคำสั่งไม่สำเร็จ/u);
});

test('an incoming draw offer prompts accept / decline, once, and the prompt goes when it is gone', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO));
  controller._onOnlineState(stateAfter(TWO, { revision: 4, drawOffer: { by: 'b' } }));
  const prompt = calls.toasts.at(-1);
  assert.equal(prompt.title, 'ฝ่ายตรงข้ามเสนอเสมอ');
  assert.deepEqual(prompt.actions.map((a) => a[0]), ['ยอมรับ', 'ปฏิเสธ']);

  controller._onOnlineState(stateAfter(TWO, { revision: 5, drawOffer: { by: 'b' }, spectatorCount: 1 })); // unrelated update
  assert.equal(calls.toasts.length, 1, 'the same offer is not prompted again');

  prompt.actions[0][1](); // accept
  assert.deepEqual(calls.sent.at(-1), ['drawAccept', 5]);

  controller._onOnlineState(stateAfter(TWO, { revision: 6 })); // offer withdrawn
  assert.equal(prompt.isConnected, false, 'the stale prompt is removed');
});

test('our own offers never prompt us (they only get a receipt)', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO, { revision: 4, drawOffer: { by: 'w' } }));
  assert.equal(calls.toasts.filter((toast) => toast.actions?.length).length, 0, 'no accept / decline prompt');
  assert.deepEqual(calls.toasts.map((toast) => toast.title), ['ส่งข้อเสนอเสมอแล้ว']);
});

test('an incoming takeback request prompts too; a draw offer takes priority when both are open', async (t) => {
  const { controller, calls } = await playing(t, 'guest', 'b');
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 3, takebackOffer: { by: 'w' } }));
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามขอย้อนตา');
  calls.toasts.at(-1).actions[0][1]();
  assert.deepEqual(calls.sent.at(-1), ['takebackAccept', 3]);
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 4, takebackOffer: { by: 'w' }, drawOffer: { by: 'w' } }));
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามเสนอเสมอ');
});

test('a declined offer is announced to the one who made it', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO, { revision: 3, drawOffer: { by: 'w' } }));
  controller._onOnlineState(stateAfter(TWO, { revision: 4 })); // cleared, same position, still active
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามปฏิเสธข้อเสนอเสมอ');
});

test('an offer that vanished because the opponent moved on says nothing', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO, { revision: 3, drawOffer: { by: 'w' } }));
  const before = calls.toasts.length;
  controller._onOnlineState(stateAfter([...TWO, 'g1f3'], { revision: 4 }));
  assert.equal(calls.toasts.length, before);
});

test('an accepted takeback steps the board back and says so; a declined one says that', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 2 }));
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 3, takebackOffer: { by: 'w' } }));
  controller._onOnlineState(stateAfter([], { revision: 4 }));
  assert.equal(controller.game.fen(), START_FEN, 'the board is back at the start');
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามยอมให้ย้อนตา');

  controller._onOnlineState(stateAfter(['d2d4'], { revision: 5 }));
  controller._onOnlineState(stateAfter(['d2d4'], { revision: 6, takebackOffer: { by: 'w' } }));
  controller._onOnlineState(stateAfter(['d2d4'], { revision: 7 }));
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามไม่ยอมให้ย้อนตา');
});

test('a takeback prunes the replay clock snapshots of plies that no longer exist', async (t) => {
  const { controller } = await playing(t);
  const timed = (moves, rev, w, b) => stateAfter(moves, { revision: rev, clock: { initialMs: 60000, incrementMs: 0, whiteMs: w, blackMs: b, activeSince: 1 } });
  controller._onOnlineState(timed(['e2e4'], 2, 59000, 60000));
  controller._onOnlineState(timed(['e2e4', 'e7e5'], 3, 59000, 58000));
  assert.deepEqual(controller._clockSnapshots.map((s) => s.ply), [1, 2]);
  controller._onOnlineState(timed(['e2e4'], 4, 59000, 58000));
  assert.deepEqual(controller._clockSnapshots.map((s) => s.ply), [1], 'ply 2 is gone');
});

test('a spectator is never prompted or offered anything', async (t) => {
  const { controller, calls } = await playing(t, 'spectator', null);
  controller._onOnlineState(stateAfter(TWO, { revision: 4, drawOffer: { by: 'b' } }));
  assert.equal(calls.toasts.length, 0);
  assert.equal(controller.onlineActionAvailability(), null);
});

test('offers stop being prompted once the game is over', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO, { revision: 4, drawOffer: { by: 'b' } }));
  const prompt = calls.toasts.at(-1);
  controller._onOnlineState(stateAfter(TWO, { revision: 5, status: 'finished', result: '1/2-1/2', reason: 'agreement' }));
  assert.equal(prompt.isConnected, false);
});

test('a draw by agreement and an abort get their own result cards', async (t) => {
  const draw = await playing(t);
  draw.controller._onOnlineState(stateAfter(TWO, { revision: 4, status: 'finished', result: '1/2-1/2', reason: 'agreement' }));
  assert.equal(draw.calls.gameOver[0], 'เสมอกัน');
  assert.match(draw.calls.gameOver[1], /ตกลงเสมอกัน/u);

  const aborted = await playing(t);
  aborted.controller._onOnlineState(stateAfter([], { revision: 3, status: 'finished', result: '*', reason: 'aborted' }));
  assert.equal(aborted.calls.gameOver[0], 'ยกเลิกเกมแล้ว');
  assert.match(aborted.calls.gameOver[1], /ไม่มีผู้แพ้ผู้ชนะ/u);
});

test('an aborted or one-move game is not kept in the history', async (t) => {
  const saved = [];
  const { controller } = await playing(t);
  controller.history = { save: async (x) => { saved.push(x); return 'id'; }, setAnalysis: async () => true };
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 3, status: 'finished', result: '*', reason: 'aborted' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(saved.length, 0);
});

test('taking back our own offer is not reported as a refusal', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO, { revision: 3, drawOffer: { by: 'w' } }));
  const before = calls.toasts.length;
  controller.cancelDraw();
  controller._onOnlineState(stateAfter(TWO, { revision: 4 }));
  assert.equal(calls.toasts.length, before, 'no "declined" notice');

  controller._onOnlineState(stateAfter(['e2e4'], { revision: 5, takebackOffer: { by: 'w' } }));
  const mid = calls.toasts.length;
  controller.cancelTakeback();
  controller._onOnlineState(stateAfter(['e2e4'], { revision: 6 }));
  assert.equal(calls.toasts.length, mid);

  // and a later real refusal still is reported
  controller._onOnlineState(stateAfter(TWO, { revision: 7, drawOffer: { by: 'w' } }));
  controller._onOnlineState(stateAfter(TWO, { revision: 8 }));
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามปฏิเสธข้อเสนอเสมอ');
});

test('the prompt for an incoming offer lives in its own channel and comes back if it was closed', async (t) => {
  const { controller, calls } = await playing(t);
  controller._onOnlineState(stateAfter(TWO, { revision: 3, drawOffer: { by: 'b' } }));
  const prompt = calls.toasts.at(-1);
  assert.equal(prompt.channel, 'offer', 'unrelated notices cannot replace it');
  // the prompt element vanished anyway (e.g. the page was re-rendered)
  prompt.remove();
  controller._onOnlineState(stateAfter(TWO, { revision: 4, drawOffer: { by: 'b' } }));
  assert.equal(calls.toasts.at(-1).title, 'ฝ่ายตรงข้ามเสนอเสมอ');
  assert.notEqual(calls.toasts.at(-1), prompt, 'a fresh prompt was made');
});

test('after a decline the button is greyed out until we have moved', (t) => {
  const declined = stateAfter(TWO, { drawBlock: 'w', takebackBlock: 'b' });
  assert.equal(onlineActionAvailability(declined, 'w').draw, 'blocked');
  assert.equal(onlineActionAvailability(declined, 'b').draw, 'available', 'the other side is free to offer');
  assert.equal(onlineActionAvailability(declined, 'b').takeback, 'blocked');

  const r = rowsFor(onlineActionAvailability(declined, 'w'), t);
  assert.equal(button(r, 'ขอเสมอ').disabled, true);
  assert.match(r.text(), /เดินหมากก่อนจึงจะขอใหม่ได้/u);
});

// ---- guards ----------------------------------------------------------------------------------------

test('nothing else is opened over a game that is being played', async (t) => {
  const { controller } = await playing(t);
  controller._onOnlineState(stateAfter(TWO));
  assert.equal(controller.hasGameInProgress(), true);
  assert.equal((await controller.startMistakePractice()).ok, false);
  assert.match((await controller.importText('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1')).error, /มีเกมที่กำลังเล่นอยู่/u);
  const rec = { initialFen: START_FEN, moves: [{ from: 'e2', to: 'e4' }], players: {} };
  assert.equal((await controller.openRecordForReview(rec)).ok, false);
  assert.equal(controller.mode, MODES.ONLINE, 'the game was left alone');
});
