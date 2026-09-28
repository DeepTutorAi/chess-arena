// The bot used to ignore its own clock: at 1+0 it burned ~110 s of "thinking"
// per 40 moves against a 60 s clock and flagged itself around move 22.

import test from 'node:test';
import assert from 'node:assert/strict';

import { clockBudgetMs, planThinkTime } from '../src/thinktime.js';
import { TIME_CONTROLS } from '../src/config.js';

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const timed = TIME_CONTROLS.filter((tc) => tc.category !== 'unlimited');

test('the bot never flags itself: 100 moves against an instant opponent, every control and level', () => {
  const positions = [
    { legalMoves: 38, pieceCount: 30, inCheck: false, lastWasCaptureOrCheck: false },
    { legalMoves: 8, pieceCount: 7, inCheck: true, lastWasCaptureOrCheck: true },
    { legalMoves: 25, pieceCount: 16, inCheck: false, lastWasCaptureOrCheck: true },
  ];
  for (const tc of timed) {
    for (const level of [1, 4, 8, 11]) {
      const rng = seeded(tc.initialMs + level);
      let remaining = tc.initialMs;
      for (let move = 0; move < 100; move++) {
        const ctx = positions[move % positions.length];
        const plan = planThinkTime({
          tcId: tc.id, initialMs: tc.initialMs, level, historyLength: move * 2 + 1,
          ...ctx, remainingMs: remaining, incrementMs: tc.incMs, rng,
        });
        remaining = remaining - plan.delay - plan.search + tc.incMs;
        assert.ok(remaining > 0, `${tc.id} level ${level}: flagged on its own move ${move + 1}`);
      }
      assert.ok(remaining > 250, `${tc.id} level ${level}: ended with only ${Math.round(remaining)} ms`);
    }
  }
});

test('the governor only ever shortens the human-like pause, never lengthens it', () => {
  for (const tc of timed) {
    for (const remaining of [500, 3000, 20000, tc.initialMs]) {
      const free = planThinkTime({ tcId: tc.id, initialMs: tc.initialMs, level: 4, historyLength: 20, rng: seeded(7) });
      const governed = planThinkTime({
        tcId: tc.id, initialMs: tc.initialMs, level: 4, historyLength: 20, remainingMs: remaining, incrementMs: tc.incMs, rng: seeded(7),
      });
      assert.ok(governed.total <= Math.max(30, free.total) + 1, `${tc.id}@${remaining}: ${governed.total} > ${free.total}`);
      assert.ok(governed.search >= 20 && governed.delay >= 0);
    }
  }
});

test('time trouble: under 8 s the bot speeds up, under 2 s it moves almost instantly', () => {
  const calm = planThinkTime({ tcId: 'blitz_3_1_5', initialMs: 180000, level: 4, historyLength: 30, remainingMs: 60000, incrementMs: 1500, rng: seeded(3) });
  const trouble = planThinkTime({ tcId: 'blitz_3_1_5', initialMs: 180000, level: 4, historyLength: 30, remainingMs: 6000, incrementMs: 1500, rng: seeded(3) });
  const panic = planThinkTime({ tcId: 'blitz_3_1_5', initialMs: 180000, level: 4, historyLength: 30, remainingMs: 1200, incrementMs: 0, rng: seeded(3) });
  assert.ok(trouble.total < calm.total, 'less time -> faster');
  assert.ok(panic.total <= 120, `last seconds: ${panic.total} ms`);
});

test('budget grows with time left and with the increment', () => {
  const at = (remainingMs, incrementMs = 0) => clockBudgetMs({ remainingMs, incrementMs, historyLength: 20 });
  assert.ok(at(120000) > at(60000));
  assert.ok(at(60000, 2000) > at(60000, 0));
  assert.ok(at(60000) >= 30);
});

test('untimed games keep the original human-like pacing (no governor)', () => {
  const plan = planThinkTime({ tcId: 'unlimited', initialMs: 0, level: 4, historyLength: 30, rng: seeded(11) });
  assert.equal(plan.search, 1500);
  assert.ok(plan.delay >= 800 && plan.delay <= 12000, `delay ${plan.delay}`);
  const opening = planThinkTime({ tcId: 'unlimited', initialMs: 0, level: 4, historyLength: 1, rng: seeded(11) });
  assert.ok(opening.delay >= 600 && opening.delay <= 1600, 'opening plies come quickly');
});

test('stronger engines answer faster than weaker ones at the same control', () => {
  const avg = (level) => {
    const rng = seeded(99);
    let sum = 0;
    for (let i = 0; i < 200; i++) sum += planThinkTime({ tcId: 'unlimited', initialMs: 0, level, historyLength: 30, rng }).delay;
    return sum / 200;
  };
  assert.ok(avg(1) > avg(6) && avg(6) > avg(11));
});

// ---- controller integration ------------------------------------------------

import { Chess } from 'chess.js';
import { Controller, MODES } from '../src/controller.js';

function botController({ timeControlId, remaining, incrementMs = 0 }) {
  const ui = new Proxy({}, { get: () => () => {} });
  const ground = { state: { dom: { bounds: { clear() {} } } }, set() {}, setShapes() {} };
  const controller = new Controller({ ui, ground, onPromotion: async () => 'q' });
  controller.mode = MODES.HUMAN_VS_AI;
  controller.timeControlId = timeControlId;
  controller.levelIndex = 3;
  controller.clock = { unlimited: false, times: { w: remaining, b: remaining }, incrementMs };
  const game = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6']) game.move(san);
  controller.game = game;
  return controller;
}

test('controller: _thinkTime reads the moving side\'s clock (1+0 with 6 s left is nearly instant)', () => {
  const rich = botController({ timeControlId: 'bullet_1_0', remaining: 60000 })._thinkTime();
  const poor = botController({ timeControlId: 'bullet_1_0', remaining: 6000 })._thinkTime();
  assert.ok(rich.delay + rich.search <= 1400, `${rich.delay + rich.search} ms with a full 60 s clock`);
  assert.ok(poor.delay + poor.search <= 400, `${poor.delay + poor.search} ms with 6 s left`);
});

test('controller: an untimed game keeps the level\'s pace', () => {
  const controller = botController({ timeControlId: 'unlimited', remaining: 0 });
  controller.clock = null;
  const plan = controller._thinkTime();
  assert.equal(plan.search, 1500);
  assert.ok(plan.delay >= 800);
});
