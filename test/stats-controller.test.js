// A finished game against the bot feeds the local rating; assisted games are
// not rated; the game-over card says what happened.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import { Controller, MODES } from '../src/controller.js';
import { createStatsStore } from '../src/stats.js';
import { LEVELS, levelRating } from '../src/config.js';

function setup({ humanSide = 'w', level = 3 } = {}) {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  const overlays = [];
  const ratings = [];
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {}, playPremove() {}, cancelPremove() {} };
  const ui = new Proxy({}, {
    get: (_, name) => {
      if (name === 'showGameOver') return (title, detail) => { overlays.push({ title, detail }); return { body: null, close() {} }; };
      if (name === 'setPlayerRating') return (rating, provisional) => ratings.push({ rating, provisional });
      return () => {};
    },
  });
  const stats = createStatsStore({ storage: null, levelRating, levelCount: LEVELS.length, now: () => 1 });
  const controller = new Controller({
    ui, ground, onPromotion: async () => 'q', gameOverDelayMs: 0, stats, loadBotBook: async () => null,
    turnAlert: { notify() {}, clear() {}, destroy() {} },
  });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.humanSide = humanSide;
  controller.levelIndex = level - 1;
  return { controller, stats, overlays, ratings };
}

const foolsMate = () => {
  const game = new Chess();
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) game.move(san);
  return game;
};

// Play a long-enough game to its end by resignation.
const lengthyGame = () => {
  const game = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']) game.move(san);
  return game;
};

test('losing to the bot lowers the rating and the card shows the change', () => {
  const { controller, stats, overlays, ratings } = setup({ humanSide: 'w' });
  const before = stats.rating;
  controller.game = lengthyGame();
  controller.resign();
  assert.equal(stats.results.length, 1);
  assert.ok(stats.rating < before);
  assert.equal(ratings.at(-1).rating, stats.rating);
  assert.match(overlays.at(-1).detail, /เรตติ้งของคุณ \d+ \(−\d+\)/u);
  assert.match(overlays.at(-1).detail, /ชั่วคราว/u);
  controller.dispose();
});

test('checkmating the bot is a win at that level', () => {
  const { controller, stats, overlays } = setup({ humanSide: 'b' });
  controller.game = foolsMate(); // black delivers mate
  controller._announceGameOver();
  assert.equal(stats.results[0].score, 1);
  assert.equal(stats.results[0].color, 'b');
  assert.equal(stats.results[0].plies, 4);
  assert.match(overlays.at(-1).detail, /\(\+\d+\)/u);
  controller.dispose();
});

test('a game is recorded once even if the end is announced again', () => {
  const { controller, stats } = setup({ humanSide: 'b' });
  controller.game = foolsMate();
  controller._announceGameOver();
  controller._announceGameOver();
  assert.equal(stats.results.length, 1);
  controller.dispose();
});

test('using undo or a hint means the game is not rated, and the card says so', () => {
  const { controller, stats, overlays } = setup({ humanSide: 'b' });
  controller._assisted = true;
  controller.game = foolsMate();
  controller._announceGameOver();
  assert.equal(stats.results.length, 1);
  assert.equal(stats.results[0].rated, false);
  assert.equal(stats.rating, 1000);
  assert.match(overlays.at(-1).detail, /ไม่นับเรตติ้ง/u);
  controller.dispose();
});

test('bot-vs-bot and sandbox games never touch the rating', () => {
  for (const mode of [MODES.AI_VS_AI, MODES.ANALYZE]) {
    const { controller, stats } = setup({ humanSide: 'b' });
    controller.mode = mode;
    controller.game = foolsMate();
    controller._announceGameOver();
    assert.equal(stats.results.length, 0, mode);
    controller.dispose();
  }
});

test('a flag fall against the bot is scored for the side that kept time', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { controller, stats } = setup({ humanSide: 'w' });
    controller.game = lengthyGame();
    controller._isTimeout = true;
    controller._timeoutLoser = 'b'; // the bot flagged
    controller._captureGameRecord({ result: '1-0', reason: 'timeout' });
    assert.equal(stats.results[0].score, 1);
    controller.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('leaving an unfinished bot game counts as a loss', () => {
  const { controller, stats } = setup({ humanSide: 'w' });
  controller.game = lengthyGame();
  controller.goHome();
  assert.equal(stats.results.length, 1);
  assert.equal(stats.results[0].score, 0);
  assert.equal(stats.results[0].reason, 'abandoned');
  controller.goHome();
  assert.equal(stats.results.length, 1, 'not counted twice');
});

test('walking away from a game that just started, or one already decided, costs nothing', () => {
  const started = setup({ humanSide: 'w' });
  const opening = new Chess();
  opening.move('e4');
  started.controller.game = opening;
  started.controller.goHome();
  assert.equal(started.stats.results.length, 0, 'an aborted start is not a game');

  const finished = setup({ humanSide: 'b' });
  finished.controller.game = foolsMate();
  finished.controller._announceGameOver(); // the human won: recorded once
  finished.controller.goHome();
  assert.equal(finished.stats.results.length, 1);
  assert.equal(finished.stats.results[0].score, 1);

  const analysing = setup({ humanSide: 'w' });
  analysing.controller.mode = MODES.ANALYZE;
  analysing.controller.game = lengthyGame();
  analysing.controller.goHome();
  assert.equal(analysing.stats.results.length, 0);
});

test('the reason for the end is passed on to the stats', () => {
  const { controller, stats } = setup({ humanSide: 'w' });
  controller.game = lengthyGame();
  controller.resign();
  assert.equal(stats.results[0].reason, 'resign');
});

test('undo after the result was recorded does not let the next end reuse the old rating line', () => {
  const { controller, overlays } = setup({ humanSide: 'w' });
  controller.game = lengthyGame();
  controller.resign();
  assert.match(overlays.at(-1).detail, /เรตติ้งของคุณ/u);
  controller.game = foolsMate();
  controller.game.undo();
  controller.game.undo();
  controller.game.undo(); // three plies back: an ordinary position to continue from
  controller.undo();
  assert.match(controller._statsNote, /บันทึกไปแล้ว/u);
});
