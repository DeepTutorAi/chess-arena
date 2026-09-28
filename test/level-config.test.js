// Level table: calibrated ratings from the Bot Arena feed the labels, the
// nominal design targets stay available, and the calibration helpers behave.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, levelRating } from '../src/config.js';
import { LEVEL_RATINGS } from '../src/level-ratings.js';
import { OPENINGS, adjudicate, scoreOf } from '../scripts/calibrate-levels.mjs';
import { Chess } from 'chess.js';

test('11 levels, each stronger than the last in both settings and rating', () => {
  assert.equal(LEVELS.length, 11);
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].elo > LEVELS[i - 1].elo, `level ${i + 1} is rated above level ${i}`);
    assert.ok(LEVELS[i].depth >= LEVELS[i - 1].depth);
    assert.ok(LEVELS[i].skill >= LEVELS[i - 1].skill);
    assert.ok(LEVELS[i].nominal > LEVELS[i - 1].nominal);
  }
  LEVELS.forEach((cfg, i) => assert.equal(cfg.level, i + 1));
});

test('elo comes from the calibration when there is one and the label shows it', () => {
  for (const cfg of LEVELS) {
    const calibrated = LEVEL_RATINGS.ratings?.[cfg.level];
    assert.equal(cfg.elo, calibrated ?? cfg.nominal);
    assert.ok(cfg.label.startsWith(String(cfg.elo)), `${cfg.label} starts with ${cfg.elo}`);
  }
  assert.match(LEVELS[0].label, /มือใหม่/u);
  assert.match(LEVELS[10].label, /กรังด์มาสเตอร์/u);
});

test('the generated ratings cover every level, in order, with a sane spread', () => {
  const { ratings, games } = LEVEL_RATINGS;
  if (!games) return; // placeholder before the first calibration
  const values = LEVELS.map((cfg) => ratings[cfg.level]);
  assert.ok(values.every(Number.isFinite), 'a rating for every level');
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1]);
  assert.ok(values[0] >= 300 && values[10] <= 3500);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const nominalMean = LEVELS.reduce((s, cfg) => s + cfg.nominal, 0) / LEVELS.length;
  assert.ok(Math.abs(mean - nominalMean) < 40, 'anchored to the nominal mean');
});

test('levelRating clamps out-of-range levels', () => {
  assert.equal(levelRating(1), LEVELS[0].elo);
  assert.equal(levelRating(11), LEVELS[10].elo);
  assert.equal(levelRating(0), LEVELS[0].elo);
  assert.equal(levelRating(99), LEVELS[10].elo);
});

test('calibration openings are legal 4-ply lines', () => {
  assert.ok(OPENINGS.length >= 8);
  for (const line of OPENINGS) {
    const game = new Chess();
    const moves = line.split(' ');
    assert.equal(moves.length, 4);
    for (const san of moves) assert.ok(game.move(san), `${line}: ${san}`);
  }
});

test('adjudication: decisive only after four consecutive evals beyond 600 cp', () => {
  assert.equal(adjudicate([700, 800, 650, 900]), '1-0');
  assert.equal(adjudicate([-700, -800, -650, -900]), '0-1');
  assert.equal(adjudicate([700, 800, 650, 500]), null, 'one shaky eval breaks the run');
  assert.equal(adjudicate([900, 900, 900]), null, 'too few evals');
  assert.equal(adjudicate([0, 0, 0, 0]), null);
});

test('adjudication: a long dead-equal endgame is drawn, a short one is not', () => {
  assert.equal(adjudicate(Array(120).fill(10)), '1/2-1/2');
  assert.equal(adjudicate(Array(119).fill(10)), null);
  assert.equal(adjudicate([...Array(110).fill(10), ...Array(10).fill(80)]), null, 'not equal at the end');
});

test('scoreOf is from the first player\'s point of view', () => {
  assert.equal(scoreOf('1-0', true), 1);
  assert.equal(scoreOf('1-0', false), 0);
  assert.equal(scoreOf('0-1', false), 1);
  assert.equal(scoreOf('0-1', true), 0);
  assert.equal(scoreOf('1/2-1/2', true), 0.5);
  assert.equal(scoreOf('1/2-1/2', false), 0.5);
});
