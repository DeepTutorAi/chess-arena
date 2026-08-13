import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapability, digestCapability, safeDigestEqual } from '../worker/capabilities.js';

test('createCapability returns independent 256-bit base64url capabilities', () => {
  const first = createCapability();
  const second = createCapability();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('digestCapability is stable and safeDigestEqual distinguishes capabilities', async () => {
  const first = await digestCapability('one');
  const same = await digestCapability('one');
  const other = await digestCapability('two');

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(safeDigestEqual(first, same), true);
  assert.equal(safeDigestEqual(first, other), false);
  assert.equal(safeDigestEqual(first, 'short'), false);
});
