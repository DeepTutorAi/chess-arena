import test from 'node:test';
import assert from 'node:assert/strict';

import { consumeCreateAttempt } from '../worker/rate-limit.js';

const WINDOW = 60_000;
const MAX = 30;

test('allows up to the cap inside the window then blocks', () => {
  const attempts = new Map();
  for (let index = 0; index < MAX; index += 1) {
    assert.equal(consumeCreateAttempt(attempts, '1.2.3.4', index * 1_000), true);
  }
  assert.equal(consumeCreateAttempt(attempts, '1.2.3.4', MAX * 1_000), false);
});

test('the window slides: expired attempts stop counting', () => {
  const attempts = new Map();
  for (let index = 0; index < MAX; index += 1) {
    consumeCreateAttempt(attempts, 'ip', index);
  }
  assert.equal(consumeCreateAttempt(attempts, 'ip', 30_000), false);
  // Every recorded attempt is now older than the window.
  assert.equal(consumeCreateAttempt(attempts, 'ip', WINDOW + 1), true);
});

test('buckets are isolated per key', () => {
  const attempts = new Map();
  for (let index = 0; index < MAX; index += 1) {
    consumeCreateAttempt(attempts, 'a', 0);
  }
  assert.equal(consumeCreateAttempt(attempts, 'a', 1), false);
  assert.equal(consumeCreateAttempt(attempts, 'b', 1), true);
});

test('tracked keys are bounded so memory cannot grow without limit', () => {
  const attempts = new Map();
  for (let index = 0; index < 20_000; index += 1) {
    consumeCreateAttempt(attempts, `ip-${index}`, 0);
  }
  assert.ok(attempts.size <= 10_000, `size was ${attempts.size}`);
});
