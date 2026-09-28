// Engine URL resolution (roadmap.md D2): the multi-threaded lite build needs
// COOP/COEP (crossOriginIsolated) — without it every caller must fall back to
// the single-threaded lite build, exactly as deployed on GitHub Pages today.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEngineWorkerUrl,
  isCrossOriginIsolated,
  getStrongEnginePreference,
  setStrongEnginePreference,
  ENGINE_STRONG_KEY,
} from '../src/config.js';

const SINGLE = './engine/stockfish-18-lite-single.js';
const MULTI = './engine/stockfish-18-lite.js';

function withIsolated(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'crossOriginIsolated');
  const previous = globalThis.crossOriginIsolated;
  if (value === undefined) delete globalThis.crossOriginIsolated;
  else globalThis.crossOriginIsolated = value;
  try {
    fn();
  } finally {
    if (had) globalThis.crossOriginIsolated = previous;
    else delete globalThis.crossOriginIsolated;
  }
}

function withStorage(fn) {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    fn(store);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('isCrossOriginIsolated reads the runtime flag and defaults to false', () => {
  withIsolated(undefined, () => assert.equal(isCrossOriginIsolated(), false));
  withIsolated(true, () => assert.equal(isCrossOriginIsolated(), true));
  withIsolated(false, () => assert.equal(isCrossOriginIsolated(), false));
});

test('resolveEngineWorkerUrl falls back to single-thread without isolation', () => {
  withIsolated(undefined, () => {
    assert.equal(resolveEngineWorkerUrl({ strong: true }), SINGLE);
    assert.equal(resolveEngineWorkerUrl({ strong: false }), SINGLE);
    assert.equal(resolveEngineWorkerUrl({}), SINGLE);
  });
  withIsolated(false, () => {
    assert.equal(resolveEngineWorkerUrl({ strong: true }), SINGLE);
  });
});

test('resolveEngineWorkerUrl uses the multi-thread build only when isolated AND preferred', () => {
  withIsolated(true, () => {
    assert.equal(resolveEngineWorkerUrl({ strong: true }), MULTI);
    assert.equal(resolveEngineWorkerUrl({ strong: false }), SINGLE);
  });
});

test('strong-engine preference persists and defaults to off', () => {
  withStorage((store) => {
    assert.equal(getStrongEnginePreference(), false);
    assert.equal(store.has(ENGINE_STRONG_KEY), false);

    setStrongEnginePreference(true);
    assert.equal(getStrongEnginePreference(), true);
    assert.equal(store.get(ENGINE_STRONG_KEY), '1');

    setStrongEnginePreference(false);
    assert.equal(getStrongEnginePreference(), false);
    assert.equal(store.has(ENGINE_STRONG_KEY), false);
  });
});
