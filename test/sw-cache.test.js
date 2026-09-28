// Behavioural tests for public/sw.js caching rules. The worker is run inside a
// vm sandbox with a tiny fake CacheStorage so the real fetch handler executes.
//
// Regressions covered: unhashed public assets (images, openings.json, sounds)
// were cache-first forever, and Range/206 audio responses made Cache.put throw.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadWorker() {
  const listeners = {};
  const store = new Map(); // url -> Response (single runtime cache is enough)
  const fetchLog = [];
  let networkResponse = () => new Response('net', { status: 200 });

  const cache = {
    async match(request) { return store.get(request.url ?? request)?.clone(); },
    async put(request, response) { store.set(request.url ?? request, response); },
    async add() {},
  };
  const context = {
    URL, Request, Response, Headers, Promise, console,
    self: {
      registration: { scope: 'https://chess.test/app/' },
      location: { origin: 'https://chess.test' },
      addEventListener(type, fn) { listeners[type] = fn; },
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {
      async open() { return cache; },
      async keys() { return []; },
      async delete() {},
      async match(request) { return store.get(request.url)?.clone(); },
    },
    fetch: async (request) => { fetchLog.push(request.url); return networkResponse(); },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  async function dispatch(path, { headers = {}, mode = 'no-cors' } = {}) {
    const request = { method: 'GET', url: `https://chess.test${path}`, mode, headers: new Headers(headers) };
    let responded = null;
    const waits = [];
    listeners.fetch({
      request,
      respondWith(promise) { responded = promise; },
      waitUntil(promise) { waits.push(promise); },
    });
    const response = responded ? await responded : null;
    await Promise.all(waits);
    return { handled: responded !== null, response };
  }

  return {
    dispatch,
    store,
    fetchLog,
    setNetwork(fn) { networkResponse = fn; },
  };
}

test('cache version is bumped so the old cache-first copies are dropped on activate', () => {
  assert.match(source, /const CACHE_VERSION = 'chess-arena-v2'/u);
});

test('hashed bundles and the engine are cache-first', async () => {
  const sw = loadWorker();
  for (const path of ['/app/assets/index-uhKe0eMT.js', '/app/assets/index-BKqJtckQ.css', '/app/engine/stockfish-18-lite-single.wasm']) {
    sw.fetchLog.length = 0;
    await sw.dispatch(path);
    await sw.dispatch(path);
    assert.equal(sw.fetchLog.length, 1, `${path} hit the network only once`);
  }
});

test('unhashed public assets are stale-while-revalidate, so a redeploy reaches returning users', async () => {
  const sw = loadWorker();
  const path = '/app/assets/banners/banner_online.webp';
  sw.setNetwork(() => new Response('v1', { status: 200 }));
  const first = await sw.dispatch(path);
  assert.equal(await first.response.text(), 'v1');

  sw.setNetwork(() => new Response('v2', { status: 200 }));
  const second = await sw.dispatch(path);
  assert.equal(await second.response.text(), 'v1', 'answered instantly from the stale copy');
  assert.equal(sw.fetchLog.length, 2, 'and refreshed in the background');

  const third = await sw.dispatch(path);
  assert.equal(await third.response.text(), 'v2', 'the refreshed copy is served next time');
});

test('top-level unhashed public files (openings.json, logo) are not treated as immutable', async () => {
  const sw = loadWorker();
  for (const path of ['/app/assets/openings.json', '/app/assets/chess_arena_3d_logo.webp', '/app/manifest.webmanifest']) {
    sw.fetchLog.length = 0;
    await sw.dispatch(path);
    await sw.dispatch(path);
    assert.equal(sw.fetchLog.length, 2, `${path} revalidates on every load`);
  }
});

test('range requests (audio) bypass the worker and partial responses are never cached', async () => {
  const sw = loadWorker();
  const ranged = await sw.dispatch('/app/assets/sounds/move.mp3', { headers: { range: 'bytes=0-' } });
  assert.equal(ranged.handled, false, 'no respondWith for a Range request');

  sw.setNetwork(() => new Response('part', { status: 206 }));
  await sw.dispatch('/app/assets/banners/banner_bots.webp');
  assert.equal(sw.store.size, 0, 'a 206 is not written to the cache');
});

test('the online API is still never handled', async () => {
  const sw = loadWorker();
  const api = await sw.dispatch('/app/api/lobby');
  assert.equal(api.handled, false);
});
