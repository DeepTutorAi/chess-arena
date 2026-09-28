// The engine wrapper reports every MultiPV line, and the human-style bot uses them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { Stockfish, uniqueLines } from '../src/engine.js';
import { Controller, MODES } from '../src/controller.js';
import { createStatsStore } from '../src/stats.js';
import { LEVELS, levelRating } from '../src/config.js';

class FakeWorker {
  static latest = null;
  constructor() { this.sent = []; FakeWorker.latest = this; }
  postMessage(cmd) {
    this.sent.push(String(cmd));
    if (cmd === 'uci') queueMicrotask(() => this.onmessage?.({ data: 'uciok' }));
  }
  say(line) { this.onmessage?.({ data: line }); }
  terminate() {}
}

function withWorker(fn) {
  return async (t) => {
    const saved = globalThis.Worker;
    globalThis.Worker = FakeWorker;
    t.after(() => { globalThis.Worker = saved; });
    await fn(t);
  };
}

test('every MultiPV line of the final depth is reported, best first, with the headline from line 1 only', withWorker(() => {
  const results = [];
  const infos = [];
  const engine = new Stockfish({ onBestMove: (uci, info, lines) => results.push({ uci, info, lines }), onInfo: (i) => infos.push(i) });
  engine.go({ depth: 10 });
  const w = FakeWorker.latest;
  w.say('info depth 9 seldepth 11 multipv 1 score cp 20 nodes 100 nps 1000 time 5 pv e2e4 e7e5');
  w.say('info depth 9 seldepth 11 multipv 2 score cp 5 nodes 100 nps 1000 time 5 pv d2d4 d7d5');
  w.say('info depth 10 seldepth 12 multipv 2 score cp 12 nodes 200 nps 1000 time 9 pv d2d4 g8f6');
  w.say('info depth 10 seldepth 12 multipv 1 score cp 31 nodes 200 nps 1000 time 9 pv e2e4 c7c5 g1f3');
  w.say('info depth 10 seldepth 12 multipv 3 score mate 4 nodes 200 nps 1000 time 9 pv g1f3');
  w.say('info depth 10 seldepth 12 multipv 4 score cp -40 lowerbound nodes 200 nps 1000 time 9 pv h2h4');
  w.say('bestmove e2e4 ponder e7e5');
  assert.equal(results.length, 1);
  const { uci, info, lines } = results[0];
  assert.equal(uci, 'e2e4');
  assert.deepEqual(lines.map((l) => [l.multipv, l.depth, l.cp, l.mate, l.pv[0]]), [
    [1, 10, 31, null, 'e2e4'],
    [2, 10, 12, null, 'd2d4'],
    [3, 10, null, 4, 'g1f3'],
  ], 'the latest depth wins and the bound line is not a score');
  assert.equal(info.score, 0.31, 'the headline is the best line, not the last one printed');
  assert.ok(infos.every((i) => i.pv[0] === 'e2e4'), 'the info stream follows the best line only');
}));

test('lines are reset for every search and a single-line search still works', withWorker(() => {
  const seen = [];
  const engine = new Stockfish({ onBestMove: (uci, info, lines) => seen.push(lines) });
  engine.go({ depth: 5 });
  FakeWorker.latest.say('info depth 5 multipv 2 score cp 1 nodes 1 nps 1 time 1 pv a2a3');
  FakeWorker.latest.say('bestmove a2a3');
  engine.go({ depth: 5 });
  FakeWorker.latest.say('info depth 5 score cp 7 nodes 1 nps 1 time 1 pv e2e4');
  FakeWorker.latest.say('bestmove e2e4');
  assert.deepEqual(seen[0].map((l) => l.multipv), [2]);
  assert.deepEqual(seen[1].map((l) => [l.multipv, l.cp]), [[1, 7]], 'nothing left over from the first search');
}));

// ---- the controller's human-style bot ------------------------------------------------------------

function makeBot(t, botStyle, level = 1) {
  const saved = { Worker: globalThis.Worker, raf: globalThis.requestAnimationFrame };
  globalThis.Worker = FakeWorker;
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  t.after(() => { globalThis.Worker = saved.Worker; globalThis.requestAnimationFrame = saved.raf; });
  const notes = [];
  const ui = new Proxy({ showGameOver() { return { body: { isConnected: true }, close() {} }; } }, {
    get: (target, key) => (key in target ? target[key] : () => {}),
  });
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {}, cancelPremove() {}, playPremove() {} };
  const stats = createStatsStore({ storage: null, levelRating, levelCount: LEVELS.length });
  const controller = new Controller({
    ui, ground, onPromotion: async () => 'q', gameOverDelayMs: 0, stats, loadBotBook: async () => null,
    turnAlert: { notify() {}, clear() {}, destroy() {} },
    history: { save: async () => 'id', setAnalysis: async () => true },
  });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = 'w';
  controller.levelIndex = level - 1;
  controller.botStyle = botStyle;
  t.after(() => controller.dispose());
  return { controller, notes, stats };
}

const LINES = [
  { multipv: 1, depth: 6, cp: 40, mate: null, pv: ['e7e5'] },
  { multipv: 2, depth: 6, cp: 30, mate: null, pv: ['c7c5'] },
  { multipv: 3, depth: 6, cp: 10, mate: null, pv: ['e7e6'] },
];

test('a human-style bot chooses among the lines; a standard bot always plays its best move', (t) => {
  const start = () => { const g = new Chess(); g.move('e4'); return g; };
  const human = makeBot(t, 'balanced', 1);
  human.controller.game = start();
  t.mock.method(Math, 'random', () => 0.9999);
  human.controller._onEngineBestMove('e7e5', LINES, human.controller.game.fen());
  assert.deepEqual(human.controller.game.history(), ['e4', 'e6'], 'the roll landed on the third line');

  const standard = makeBot(t, 'standard', 1);
  standard.controller.game = start();
  standard.controller._onEngineBestMove('e7e5', LINES);
  assert.deepEqual(standard.controller.game.history(), ['e4', 'e5']);
});

test('a human-style bot falls back to the engine move when it has no lines to choose from', (t) => {
  const { controller } = makeBot(t, 'aggressive', 3);
  const g = new Chess();
  g.move('e4');
  controller.game = g;
  controller._onEngineBestMove('c7c5', [], g.fen());
  assert.deepEqual(controller.game.history(), ['e4', 'c5']);
  const g2 = new Chess();
  g2.move('e4');
  controller.game = g2;
  controller.engineBusy = true;
  controller._onEngineBestMove('e7e5', [{ multipv: 1, depth: 3, cp: 0, mate: null, pv: ['e7e5'] }], g2.fen());
  assert.deepEqual(controller.game.history(), ['e4', 'e5'], 'one line is no choice');
});

test('a human-style bot searches at full skill with several lines; a standard one uses its level\'s Skill', async (t) => {
  for (const [style, expectMultiPv, expectedSkill] of [['balanced', true, 20], ['standard', false, LEVELS[2].skill]]) {
    const saved = { Worker: globalThis.Worker, raf: globalThis.requestAnimationFrame };
    globalThis.Worker = FakeWorker;
    globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
    const ui = new Proxy({}, { get: () => () => {} });
    const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {}, cancelPremove() {} };
    const controller = new Controller({
      ui, ground, onPromotion: async () => 'q', loadBotBook: async () => null,
      stats: createStatsStore({ storage: null, levelRating, levelCount: LEVELS.length }),
      history: { save: async () => 'id', setAnalysis: async () => true },
      turnAlert: { notify() {}, clear() {}, destroy() {} },
    });
    await controller.start(MODES.HUMAN_VS_AI, { color: 'w', level: 3, timeControlId: 'unlimited', botStyle: style });
    await Promise.resolve();
    const sent = FakeWorker.latest.sent;
    assert.ok(sent.includes(`setoption name Skill Level value ${expectedSkill}`), `${style}: skill`);
    assert.equal(sent.includes('setoption name MultiPV value 4'), expectMultiPv, `${style}: multipv`);
    controller.dispose();
    Object.assign(globalThis, { Worker: saved.Worker, requestAnimationFrame: saved.raf });
  }
});

test('an unknown style is treated as standard', async (t) => {
  const { controller } = makeBot(t, 'standard');
  const saved = globalThis.Worker;
  controller._startHumanVsAi({ color: 'w', level: 2, botStyle: 'wild' });
  assert.equal(controller.botStyle, 'standard');
  globalThis.Worker = saved;
});

test('the human-style bot makes no Elo claim and its games are not rated', (t) => {
  const { controller, stats } = makeBot(t, 'solid', 4);
  assert.equal(controller._botLabel(), 'บอทเหมือนมนุษย์ · สายรับ · ระดับ 4');
  assert.match(makeBot(t, 'standard', 4).controller._botLabel(), /Elo/u);
  const mate = new Chess();
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) mate.move(san);
  controller.humanSide = 'b';
  controller.game = mate;
  controller._announceGameOver();
  assert.equal(stats.results.length, 1);
  assert.equal(stats.results[0].rated, false);
  assert.equal(stats.rating, 1000);
  assert.match(controller._statsNote, /บอทเหมือนมนุษย์ยังไม่นับเรตติ้ง/u);
});

test('saved records say which style the bot had', async (t) => {
  const { controller } = makeBot(t, 'aggressive', 5);
  const record = { moves: [] };
  controller._addRecordExtras(record, null);
  assert.equal(record.botStyle, 'aggressive');
  assert.equal(record.botLevel, 5);
});

test('an answer for a position the board has left is played as the engine gave it, not re-chosen', (t) => {
  const { controller } = makeBot(t, 'balanced', 1);
  const g = new Chess();
  g.move('e4');
  controller.game = g;
  t.mock.method(Math, 'random', () => 0.9999);
  const other = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'; // searched another position
  controller._onEngineBestMove('e7e5', LINES, other);
  assert.deepEqual(controller.game.history(), ['e4', 'e5'], 'lines of another position are not trusted');
  const again = new Chess();
  again.move('e4');
  controller.game = again;
  controller._onEngineBestMove('e7e5', LINES, null);
  assert.deepEqual(controller.game.history(), ['e4', 'e5'], 'nor are lines that come without a position');
});

test('a search cut off mid-iteration reports no move twice', withWorker(() => {
  const results = [];
  const engine = new Stockfish({ onBestMove: (uci, info, lines) => results.push(lines) });
  engine.go({ movetime: 100 });
  const w = FakeWorker.latest;
  // Depth 9 filled every slot; depth 10 got as far as line 1, and its best is the old line 2.
  w.say('info depth 9 multipv 1 score cp 30 nodes 1 nps 1 time 1 pv e2e4 e7e5');
  w.say('info depth 9 multipv 2 score cp 20 nodes 1 nps 1 time 1 pv d2d4 d7d5');
  w.say('info depth 9 multipv 3 score cp 10 nodes 1 nps 1 time 1 pv g1f3 g8f6');
  w.say('info depth 10 multipv 1 score cp 25 nodes 1 nps 1 time 1 pv d2d4 g8f6');
  w.say('bestmove d2d4');
  // The move pushed out of the top slot is not lost: it fills the slot the duplicate freed.
  assert.deepEqual(results[0].map((l) => [l.depth, l.pv[0]]), [[10, 'd2d4'], [9, 'g1f3'], [9, 'e2e4']]);
}));

test('a bestmove reports the position its own search started on, even after a newer position was set', withWorker(() => {
  const answers = [];
  const engine = new Stockfish({ onBestMove: (uci, info, lines, fen) => answers.push([uci, fen]) });
  engine.setPosition('fen-A');
  engine.go({ movetime: 50 });
  engine.stop();
  engine.setPosition('fen-B'); // the stopped search has not answered yet
  engine.go({ movetime: 50 });
  const w = FakeWorker.latest;
  w.say('bestmove e2e4');
  w.say('bestmove d2d4');
  assert.deepEqual(answers, [['e2e4', 'fen-A'], ['d2d4', 'fen-B']]);
  w.say('bestmove a2a3'); // an unexpected extra answer has no position rather than a wrong one
  assert.deepEqual(answers[2], ['a2a3', null]);
}));

test('uniqueLines keeps the first copy of each move and passes empty lines through', () => {
  const lines = [{ multipv: 1, pv: ['a2a3'] }, { multipv: 2, pv: ['a2a3'] }, { multipv: 3, pv: [] }, { multipv: 4, pv: ['b2b3'] }];
  assert.deepEqual(uniqueLines(lines).map((l) => l.multipv), [1, 3, 4]);
});
