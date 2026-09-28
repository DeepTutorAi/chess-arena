// The human-like bot: which move it picks from the engine's lines.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import {
  HUMAN_LINES, STYLE_BONUS_CP, annotateLines, lineScore, pickHumanMove, styleBonus, temperatureFor,
} from '../src/humanbot.js';

/** A small seeded generator so distribution tests are stable. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const lines = (...cps) => cps.map((cp, i) => ({ uci: `m${i}`, cp }));
const share = (candidates, opts, pick, n = 4000) => {
  const rng = seeded(7);
  let hits = 0;
  for (let i = 0; i < n; i++) if (pick(pickHumanMove(candidates, { ...opts, rng }))) hits += 1;
  return hits / n;
};

test('the temperature falls with strength and is clamped', () => {
  let last = Infinity;
  for (let level = 1; level <= 11; level++) {
    assert.ok(temperatureFor(level) < last, `level ${level}`);
    last = temperatureFor(level);
  }
  assert.equal(temperatureFor(1), 240);
  assert.equal(temperatureFor(0), 240);
  assert.equal(temperatureFor(99), temperatureFor(11));
  assert.ok(temperatureFor(11) < 5);
});

test('no lines, one line and a single legal reply are handled', () => {
  assert.equal(pickHumanMove([], { level: 5 }), null);
  assert.equal(pickHumanMove([{ uci: 'e2e4', cp: 10 }], { level: 1 }), 'e2e4');
  assert.equal(pickHumanMove([null, { uci: '' }], { level: 1 }), null, 'unusable entries are ignored');
});

test('a strong level almost always plays the engine\'s move; a beginner often does not', () => {
  const candidates = lines(50, 30, 10, -20);
  const strong = share(candidates, { level: 11 }, (m) => m === 'm0');
  const weak = share(candidates, { level: 1 }, (m) => m === 'm0');
  assert.ok(strong > 0.9, `level 11 played the best move ${strong}`);
  assert.ok(weak < 0.5 && weak > 0.15, `level 1 played the best move ${weak}`);
});

test('the better a move, the likelier it is', () => {
  const rng = seeded(3);
  const counts = { m0: 0, m1: 0, m2: 0, m3: 0 };
  for (let i = 0; i < 6000; i++) counts[pickHumanMove(lines(40, 10, -30, -90), { level: 3, rng })] += 1;
  assert.ok(counts.m0 > counts.m1 && counts.m1 > counts.m2 && counts.m2 > counts.m3, JSON.stringify(counts));
});

test('the ladder is monotonic: each level gives up less than the one below', () => {
  const candidates = lines(60, 20, -40, -120);
  const loss = (level) => {
    const rng = seeded(11);
    let total = 0;
    const cps = { m0: 60, m1: 20, m2: -40, m3: -120 };
    for (let i = 0; i < 3000; i++) total += 60 - cps[pickHumanMove(candidates, { level, rng })];
    return total / 3000;
  };
  let last = Infinity;
  for (let level = 1; level <= 11; level++) {
    const l = loss(level);
    assert.ok(l < last + 1, `level ${level} loses ${l.toFixed(1)} cp vs ${last.toFixed(1)}`);
    last = l;
  }
  assert.ok(loss(1) > 8 * loss(11), 'and the ends are far apart');
});

test('a forced mate is always played, whatever the level', () => {
  const candidates = [{ uci: 'mate', mate: 3 }, { uci: 'pawn', cp: 900 }, { uci: 'other', cp: 200 }];
  for (const level of [1, 4, 11]) {
    assert.equal(share(candidates, { level }, (m) => m === 'mate', 500), 1, `level ${level}`);
  }
});

test('the quickest mate is the one played', () => {
  const candidates = [{ uci: 'slow', mate: 9 }, { uci: 'fast', mate: 1 }, { uci: 'mid', mate: 6 }, { uci: 'other', cp: 900 }];
  for (const level of [1, 6, 11]) assert.equal(pickHumanMove(candidates, { level, style: 'aggressive', rng: () => 0.7 }), 'fast');
});

test('when mate is unavoidable the longest resistance scores best', () => {
  assert.ok(lineScore({ mate: -9 }) > lineScore({ mate: -2 }));
  assert.ok(lineScore({ mate: 1 }) > lineScore({ mate: 6 }));
  assert.ok(lineScore({ cp: 900 }) < lineScore({ mate: 30 }));
  assert.equal(pickHumanMove([{ uci: 'soon', mate: -2 }, { uci: 'later', mate: -9 }], { level: 11, rng: () => 0.5 }), 'later');
});

test('moves far worse than the best are never chosen, even by a beginner', () => {
  const candidates = lines(100, 60, -500, -900);
  const rng = seeded(5);
  for (let i = 0; i < 3000; i++) {
    assert.ok(['m0', 'm1'].includes(pickHumanMove(candidates, { level: 1, rng })), 'no throwing the game away');
  }
});

test('the extreme random numbers pick the first and the last option', () => {
  const candidates = lines(50, 40, 30);
  assert.equal(pickHumanMove(candidates, { level: 3, rng: () => 0 }), 'm0');
  assert.equal(pickHumanMove(candidates, { level: 3, rng: () => 0.9999999 }), 'm2');
});

test('lineScore turns mates into a huge score with the right sign', () => {
  assert.equal(lineScore({ cp: 35 }), 35);
  assert.ok(lineScore({ mate: 2 }) > 900);
  assert.ok(lineScore({ mate: -2 }) < -900);
  assert.equal(lineScore({}), 0);
});

// ---- style ------------------------------------------------------------------------------

test('style tilts the choice by a bounded amount', () => {
  assert.equal(styleBonus('balanced', { capture: true }), 0);
  assert.equal(styleBonus('aggressive', { capture: true }), STYLE_BONUS_CP);
  assert.equal(styleBonus('aggressive', { check: true }), STYLE_BONUS_CP);
  assert.equal(styleBonus('aggressive', {}), 0);
  assert.equal(styleBonus('solid', { capture: true }), 0);
  assert.equal(styleBonus('solid', { castle: true }), STYLE_BONUS_CP);
  assert.ok(styleBonus('solid', {}) > 0 && styleBonus('solid', {}) < STYLE_BONUS_CP);
  for (const style of ['balanced', 'aggressive', 'solid']) {
    for (const f of [{}, { capture: true }, { castle: true }, { check: true, promotion: true }]) {
      assert.ok(Math.abs(styleBonus(style, f)) <= STYLE_BONUS_CP);
    }
  }
});

test('an aggressive bot reaches for captures and checks more than a solid one', () => {
  const candidates = [
    { uci: 'quiet', cp: 40 },
    { uci: 'grab', cp: 25, capture: true },
    { uci: 'check', cp: 25, check: true },
  ];
  const forcing = (m) => m === 'grab' || m === 'check';
  const aggressive = share(candidates, { level: 4, style: 'aggressive' }, forcing);
  const balanced = share(candidates, { level: 4, style: 'balanced' }, forcing);
  const solid = share(candidates, { level: 4, style: 'solid' }, forcing);
  assert.ok(aggressive > balanced + 0.08, `${aggressive} vs ${balanced}`);
  assert.ok(solid < balanced - 0.03, `${solid} vs ${balanced}`);
});

test('at the top level a style cannot beat a genuinely better move', () => {
  // T is ~4 cp at level 11: a 30 cp style bonus would make a 25 cp deficit the favourite.
  const aggressive = [{ uci: 'quiet', cp: 60 }, { uci: 'grab', cp: 35, capture: true }];
  assert.ok(share(aggressive, { level: 11, style: 'aggressive' }, (m) => m === 'grab') < 0.02);
  const solid = [{ uci: 'capture', cp: 60, capture: true }, { uci: 'quiet', cp: 45 }];
  assert.ok(share(solid, { level: 11, style: 'solid' }, (m) => m === 'quiet') < 0.05);
  // ...while a beginner is nudged the full way.
  const flat = [{ uci: 'quiet', cp: 20 }, { uci: 'grab', cp: 5, capture: true }];
  assert.ok(share(flat, { level: 1, style: 'aggressive' }, (m) => m === 'grab') > share(flat, { level: 1, style: 'balanced' }, (m) => m === 'grab') + 0.03);
});

test('style never makes a strong bot play a clearly worse move', () => {
  const candidates = [{ uci: 'best', cp: 80 }, { uci: 'flashy', cp: -40, capture: true }];
  assert.ok(share(candidates, { level: 11, style: 'aggressive' }, (m) => m === 'flashy') < 0.02);
  assert.ok(share(candidates, { level: 1, style: 'aggressive' }, (m) => m === 'flashy') < 0.5, 'a beginner may, but not most of the time');
});

// ---- annotating the engine's lines ------------------------------------------------------------

test('annotateLines reads captures, checks, castling and promotions off the board', () => {
  const start = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']) start.move(san);
  const found = annotateLines((fen) => new Chess(fen), start.fen(), [
    { pv: ['e1g1'], cp: 30, mate: null },   // castling
    { pv: ['f3e5'], cp: 20, mate: null },   // capture
    { pv: ['d2d3'], cp: 10, mate: null },
    { pv: ['g1h3'], cp: 0, mate: null },    // illegal here (no knight on g1)
    { pv: [], cp: 0, mate: null },          // no move
  ]);
  assert.deepEqual(found.map((l) => l.uci), ['e1g1', 'f3e5', 'd2d3']);
  assert.equal(found[0].castle, true);
  assert.equal(found[1].capture, true);
  assert.equal(found[2].capture, false);

  const checks = annotateLines((fen) => new Chess(fen), 'k7/8/8/8/8/8/8/K6R w - - 0 1', [{ pv: ['h1h8'], cp: 500, mate: null }]);
  assert.equal(checks[0].check, true);
  const promo = annotateLines((fen) => new Chess(fen), '8/P7/8/8/8/8/k7/4K3 w - - 0 1', [{ pv: ['a7a8q'], cp: 900, mate: null }]);
  assert.equal(promo[0].promotion, true);
});

test('annotateLines keeps at most HUMAN_LINES lines and survives a broken position', () => {
  const many = Array.from({ length: 8 }, () => ({ pv: ['e2e4'], cp: 0, mate: null }));
  assert.equal(annotateLines((fen) => new Chess(fen), new Chess().fen(), many).length, HUMAN_LINES);
  assert.deepEqual(annotateLines((fen) => new Chess(fen), 'not a fen', many), []);
});
