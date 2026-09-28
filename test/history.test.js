// Game history store: the memory backend is the reference behaviour, the
// IndexedDB adapter is exercised against a tiny in-test IDBFactory.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_LIMIT, createHistoryStore, createIdbAdapter, createMemoryAdapter, summarize } from '../src/history.js';

// ---- a minimal IndexedDB double (only what history.js uses) --------------------------

function createFakeIndexedDB({ failOpen = false, failWrites = false } = {}) {
  const dbs = new Map(); // name -> { stores: Map(name -> Map(key -> value)), version }
  const factory = {
    opens: 0,
    failWrites,
    open(name, version) {
      factory.opens += 1;
      const req = { result: null, error: null };
      queueMicrotask(() => {
        if (failOpen) { req.error = new Error('nope'); req.onerror?.(); return; }
        let data = dbs.get(name);
        const fresh = !data;
        if (!data) { data = { stores: new Map(), version }; dbs.set(name, data); }
        const db = {
          objectStoreNames: { contains: (n) => data.stores.has(n) },
          createObjectStore(storeName) { data.stores.set(storeName, new Map()); return {}; },
          transaction(storeName) {
            const store = data.stores.get(storeName);
            if (!store) throw new Error(`no store ${storeName}`);
            const tx = { pending: 0, error: null };
            const schedule = (fn, isWrite = false) => {
              const r = { result: undefined, error: null };
              tx.pending += 1;
              queueMicrotask(() => {
                if (isWrite && factory.failWrites) { tx.error = new Error('write failed'); r.error = tx.error; r.onerror?.(); tx.onerror?.(); return; }
                r.result = fn();
                r.onsuccess?.();
                tx.pending -= 1;
                if (tx.pending === 0) queueMicrotask(() => tx.oncomplete?.());
              });
              return r;
            };
            tx.objectStore = () => ({
              put: (value) => schedule(() => { store.set(value.id, structuredClone(value)); return value.id; }, true),
              get: (id) => schedule(() => structuredClone(store.get(id))),
              getAll: () => schedule(() => [...store.values()].map((v) => structuredClone(v))),
              delete: (id) => schedule(() => { store.delete(id); }, true),
              clear: () => schedule(() => { store.clear(); }, true),
            });
            return tx;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return factory;
}

const record = (n, extra = {}) => ({
  initialFen: null,
  moves: Array.from({ length: n }, (_, i) => ({ from: 'a2', to: `a${i % 2 ? 3 : 4}` })),
  result: '1-0',
  reason: 'checkmate',
  players: { white: { name: 'Alice' }, black: { name: 'Stockfish' } },
  botLevel: 4,
  humanColor: 'w',
  ...extra,
});

let clock = 1_000;
const makeStore = (adapter, extra = {}) => createHistoryStore({ adapter, now: () => (clock += 10), ...extra });

test('save, list (newest first), get and remove', async () => {
  const store = makeStore(createMemoryAdapter());
  const a = await store.save({ record: record(10), source: 'bot' });
  const b = await store.save({ record: record(20, { result: '0-1' }), source: 'online' });
  const list = await store.list();
  assert.deepEqual(list.map((g) => g.id), [b, a]);
  assert.equal(list[0].plies, 20);
  assert.equal(list[0].white, 'Alice');
  assert.equal(list[0].analyzed, false);
  assert.equal(list[1].botLevel, 4);
  assert.equal((await store.get(a)).record.moves.length, 10);
  await store.remove(a);
  assert.deepEqual((await store.list()).map((g) => g.id), [b]);
  assert.equal(await store.get(a), null);
});

test('saving with an id overwrites that game but keeps its date and any analysis', async () => {
  const store = makeStore(createMemoryAdapter());
  const id = await store.save({ record: record(10), source: 'bot' });
  const first = (await store.list())[0].savedAt;
  await store.setAnalysis(id, { accuracy: { w: 90, b: 70 }, opening: { name: 'Italian Game' } });
  const again = await store.save({ id, record: record(12), source: 'bot' });
  assert.equal(again, id);
  const [meta] = await store.list();
  assert.equal(meta.plies, 12);
  assert.equal(meta.savedAt, first, 'same game, same date');
  assert.equal(meta.analyzed, true, 'analysis survives a re-save');
  assert.equal((await store.list()).length, 1);
});

test('setAnalysis adds the accuracy and opening to the list summary; a deleted game is left alone', async () => {
  const store = makeStore(createMemoryAdapter());
  const id = await store.save({ record: record(10), source: 'bot' });
  assert.equal(await store.setAnalysis(id, { accuracy: { w: 91.2, b: 64 }, opening: { name: 'Sicilian Defense' } }), true);
  const [meta] = await store.list();
  assert.deepEqual(meta.accuracy, { w: 91.2, b: 64 });
  assert.equal(meta.opening, 'Sicilian Defense');
  assert.equal((await store.get(id)).analysis.accuracy.w, 91.2);
  await store.remove(id);
  assert.equal(await store.setAnalysis(id, { accuracy: {} }), false);
  assert.equal((await store.list()).length, 0, 'no orphan summary was created');
});

test('only the newest games are kept', async () => {
  const store = makeStore(createMemoryAdapter(), { limit: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await store.save({ record: record(4 + i), source: 'bot' }));
  const kept = (await store.list()).map((g) => g.id);
  assert.deepEqual(kept, [ids[4], ids[3], ids[2]]);
  assert.equal(await store.get(ids[0]), null, 'the full record of a trimmed game is gone too');
  assert.equal(HISTORY_LIMIT, 200);
});

test('clear empties everything', async () => {
  const store = makeStore(createMemoryAdapter());
  await store.save({ record: record(4), source: 'bot' });
  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test('memory backend never shares references with the caller', async () => {
  const store = makeStore(createMemoryAdapter());
  const rec = record(6);
  const id = await store.save({ record: rec, source: 'bot' });
  rec.moves.length = 0; // mutate after saving
  assert.equal((await store.get(id)).record.moves.length, 6);
  const copy = await store.get(id);
  copy.record.moves.length = 0;
  assert.equal((await store.get(id)).record.moves.length, 6);
});

test('summarize handles a bare record', () => {
  const s = summarize({ id: 'x', savedAt: 5, source: 'import', record: { moves: [{}, {}] } });
  assert.deepEqual([s.plies, s.white, s.result, s.analyzed, s.botLevel], [2, '', '*', false, null]);
});

// ---- IndexedDB adapter -----------------------------------------------------------------

test('IndexedDB: data written by one store instance is there for the next (a reload)', async () => {
  const idb = createFakeIndexedDB();
  const first = makeStore(createIdbAdapter(idb));
  assert.equal(first.persistent, true);
  const id = await first.save({ record: record(10), source: 'bot' });
  await first.setAnalysis(id, { accuracy: { w: 80, b: 60 }, opening: null });

  const second = makeStore(createIdbAdapter(idb));
  const [meta] = await second.list();
  assert.equal(meta.id, id);
  assert.equal(meta.analyzed, true);
  assert.equal((await second.get(id)).record.moves.length, 10);
  await second.remove(id);
  assert.deepEqual(await makeStore(createIdbAdapter(idb)).list(), []);
});

test('IndexedDB: the schema is created once and the connection is reused', async () => {
  const idb = createFakeIndexedDB();
  const store = makeStore(createIdbAdapter(idb));
  await store.save({ record: record(4), source: 'bot' });
  await store.list();
  await store.save({ record: record(6), source: 'bot' });
  assert.equal(idb.opens, 1, 'one open for the whole session');
});

test('IndexedDB that cannot open falls back to memory for the session', async () => {
  const store = makeStore(createIdbAdapter(createFakeIndexedDB({ failOpen: true })));
  const id = await store.save({ record: record(6), source: 'bot' });
  assert.equal(store.persistent, false, 'the caller can tell it is session-only');
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get(id)).record.moves.length, 6);
});

test('a write that fails halfway does not lose the game or throw', async () => {
  const store = makeStore(createIdbAdapter(createFakeIndexedDB({ failWrites: true })));
  const id = await store.save({ record: record(8), source: 'bot' });
  assert.ok(id);
  assert.equal((await store.list())[0].plies, 8);
});

test('a failed write costs that game its durability only — earlier games stay listed and open', async () => {
  const idb = createFakeIndexedDB();
  const store = makeStore(createIdbAdapter(idb));
  const durable = await store.save({ record: record(6), source: 'bot' });
  assert.equal(store.persistent, true);

  idb.failWrites = true; // e.g. quota exceeded for a moment
  const volatile = await store.save({ record: record(8), source: 'bot' });
  assert.equal(store.persistent, false, 'the player is told');
  const list = await store.list();
  assert.deepEqual(list.map((g) => g.id).sort(), [durable, volatile].sort(), 'both games are still listed');
  assert.equal((await store.get(durable)).record.moves.length, 6);
  assert.equal((await store.get(volatile)).record.moves.length, 8);

  // After a reload only what really reached the disk is left.
  idb.failWrites = false;
  const reloaded = makeStore(createIdbAdapter(idb));
  assert.deepEqual((await reloaded.list()).map((g) => g.id), [durable]);

  await store.clear();
  assert.deepEqual(await store.list(), [], 'clear empties both the disk and the session copy');
});

test('the summary and the full record can never end up in different places', async () => {
  const idb = createFakeIndexedDB();
  const store = makeStore(createIdbAdapter(idb));
  const id = await store.save({ record: record(6), source: 'bot' });
  idb.failWrites = true;
  await store.setAnalysis(id, { accuracy: { w: 88, b: 66 }, opening: null });
  const [meta] = await store.list();
  assert.equal(meta.analyzed, true, 'the list shows the analysis that was just kept for this session');
  assert.equal((await store.get(id)).analysis.accuracy.w, 88);
});

test('no IndexedDB at all: the adapter is null and the store still works', async () => {
  assert.equal(createIdbAdapter(null), null);
  const saved = globalThis.indexedDB;
  try {
    delete globalThis.indexedDB;
    const store = createHistoryStore({ now: () => 1 });
    await store.save({ record: record(4), source: 'bot' });
    assert.equal(store.persistent, false);
    assert.equal((await store.list()).length, 1);
  } finally {
    if (saved !== undefined) globalThis.indexedDB = saved;
  }
});
