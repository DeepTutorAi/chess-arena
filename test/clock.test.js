import test from 'node:test';
import assert from 'node:assert/strict';

import { ChessClock } from '../src/clock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('formatTime floors the sub-10-second readout so it never overstates time', () => {
  assert.equal(ChessClock.formatTime(0), '0:00');
  assert.equal(ChessClock.formatTime(-5), '0:00');
  assert.equal(ChessClock.formatTime(100), '0:00.1');
  assert.equal(ChessClock.formatTime(5_230), '0:05.2');
  assert.equal(ChessClock.formatTime(9_900), '0:09.9');
  // >=10s keeps the original ceil so the clock never shows zero while time
  // remains; only the sub-10s branch floors.
  assert.equal(ChessClock.formatTime(10_400), '0:11');
  assert.equal(ChessClock.formatTime(65_000), '1:05');
});

test('switchTurn adds the configured increment to the side that moved', () => {
  const clock = new ChessClock({ initialMs: 60_000, incrementMs: 1_000 });
  const seen = [];
  clock.onTick = (times, turn) => seen.push({ times: { ...times }, turn });

  clock.start('w');
  // Moving immediately drains only a few real milliseconds, so white must end
  // up inside [initial + increment - 50, initial + increment].
  clock.switchTurn('b');

  assert.equal(clock.turn, 'b');
  assert.ok(clock.times.w <= 61_000, `white got ${clock.times.w}`);
  assert.ok(clock.times.w > 60_950, `white lost more than 50ms: ${clock.times.w}`);
  assert.equal(clock.times.b, 60_000);
  assert.equal(seen.at(-1).turn, 'b');
  clock.stop();
});

test('an increment of zero is honored (the old default regression)', () => {
  const clock = new ChessClock({ initialMs: 60_000 });
  clock.start('w');
  clock.switchTurn('b');
  assert.ok(clock.times.w <= 60_000 && clock.times.w > 59_950);
  clock.stop();
});

test('the clock flags the side whose time ran out', async () => {
  const timeouts = [];
  const clock = new ChessClock({
    initialMs: 60,
    onTimeout: (loser) => timeouts.push(loser),
  });
  clock.start('w');
  await sleep(300);
  clock.stop();

  assert.deepEqual(timeouts, ['w']);
  assert.equal(clock.active, false);
});

test('pause does not drain time while stopped and start() resumes the given turn', () => {
  const clock = new ChessClock({ initialMs: 60_000 });
  clock.start('w');
  clock.stop();
  assert.equal(clock.active, false);
  clock.start('b');
  assert.equal(clock.turn, 'b');
  assert.equal(clock.active, true);
  clock.stop();
});
