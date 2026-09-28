// Game history (roadmap B6): finished games are kept in this browser's IndexedDB
// so they can be reviewed again, exported or shared. There is no account and no
// server — the history lives and dies with the browser profile.
//
// Two object stores keep the list cheap: `meta` holds a small summary per game
// (what the history list shows), `games` holds the full record and, once a review
// has run, its analysis. Where IndexedDB is unavailable (some private modes) the
// store falls back to memory for the session and says so through `persistent`.

export const DB_NAME = 'chess-arena';
export const DB_VERSION = 1;
export const HISTORY_LIMIT = 200;
const META = 'meta';
const GAMES = 'games';

/** Summary shown in the list — never the full move list or analysis. */
export function summarize(entry) {
  const { record, analysis } = entry;
  return {
    id: entry.id,
    savedAt: entry.savedAt,
    source: entry.source,
    white: record.players?.white?.name ?? '',
    black: record.players?.black?.name ?? '',
    result: record.result ?? '*',
    reason: record.reason ?? '',
    plies: record.moves?.length ?? 0,
    botLevel: record.botLevel ?? null,
    humanColor: record.humanColor ?? null,
    analyzed: Boolean(analysis),
    accuracy: analysis?.accuracy ?? null,
    opening: analysis?.opening?.name ?? null,
  };
}

// ---------------------------------------------------------------- adapters

/** Session-only storage, also the test double. */
export function createMemoryAdapter() {
  const stores = { [META]: new Map(), [GAMES]: new Map() };
  return {
    persistent: false,
    async put(store, value) { stores[store].set(value.id, structuredClone(value)); },
    async get(store, id) { return structuredClone(stores[store].get(id) ?? null); },
    async getAll(store) { return [...stores[store].values()].map((v) => structuredClone(v)); },
    async remove(store, id) { stores[store].delete(id); },
    async clearAll() { for (const s of Object.values(stores)) s.clear(); },
  };
}

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error('indexeddb_error'));
});

/** IndexedDB-backed storage. Resolves lazily; a failure to open rejects every call. */
export function createIdbAdapter(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return null;
  let dbPromise = null;
  const open = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDBImpl.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(GAMES)) db.createObjectStore(GAMES, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexeddb_open_failed'));
      req.onblocked = () => reject(new Error('indexeddb_blocked'));
    });
    dbPromise.catch(() => { dbPromise = null; }); // let a later call retry
    return dbPromise;
  };
  const run = async (store, mode, fn) => {
    const db = await open();
    const tx = db.transaction(store, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb_tx_failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb_tx_aborted'));
    });
    // Both promises are awaited together: a failed transaction rejects `done` as
    // well as the request, and neither may be left unhandled.
    const [result] = await Promise.all([request(fn(tx.objectStore(store))), done]);
    return result;
  };
  return {
    persistent: true,
    put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
    get: async (store, id) => (await run(store, 'readonly', (s) => s.get(id))) ?? null,
    getAll: (store) => run(store, 'readonly', (s) => s.getAll()),
    remove: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
    async clearAll() {
      await run(META, 'readwrite', (s) => s.clear());
      await run(GAMES, 'readwrite', (s) => s.clear());
    },
  };
}

// ---------------------------------------------------------------- store

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof createMemoryAdapter>} [opts.adapter]
 * @param {() => number} [opts.now]
 * @param {() => string} [opts.newId]
 * @param {number} [opts.limit]
 */
export function createHistoryStore({
  adapter = null,
  now = Date.now,
  newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  limit = HISTORY_LIMIT,
} = {}) {
  // The durable backend (IndexedDB) plus a session-only store that catches what
  // the durable one could not take. Reads merge both, so one failed write costs
  // durability for that game only — never the games already on disk, and never a
  // silent switch of the whole history to an empty store.
  const primary = adapter ?? createIdbAdapter();
  const session = createMemoryAdapter();
  let degraded = false;

  const attempt = async (fn, otherwise) => {
    if (!primary) return otherwise;
    try {
      return await fn(primary);
    } catch {
      degraded = true;
      return otherwise;
    }
  };

  const io = {
    async put(store, value) {
      const ok = await attempt(async (a) => { await a.put(store, value); return true; }, false);
      if (ok) await session.remove(store, value.id); // the durable copy is the truth
      else await session.put(store, value);
    },
    async get(store, id) {
      return (await session.get(store, id)) ?? (await attempt((a) => a.get(store, id), null));
    },
    async getAll(store) {
      const durable = await attempt((a) => a.getAll(store), []);
      const merged = new Map(durable.map((v) => [v.id, v]));
      for (const v of await session.getAll(store)) merged.set(v.id, v);
      return [...merged.values()];
    },
    async remove(store, id) {
      await attempt((a) => a.remove(store, id), null);
      await session.remove(store, id);
    },
    async clearAll() {
      await attempt((a) => a.clearAll(), null);
      await session.clearAll();
    },
  };
  const call = (method, ...args) => io[method](...args);

  async function trim() {
    const all = (await call('getAll', META)).sort((a, b) => b.savedAt - a.savedAt);
    for (const old of all.slice(limit)) {
      await call('remove', META, old.id);
      await call('remove', GAMES, old.id);
    }
  }

  return {
    /** False when there is no durable storage, or a write to it has failed. */
    get persistent() { return Boolean(primary?.persistent) && !degraded; },

    /**
     * Save (or overwrite, when `id` is given) a game.
     * @param {{record: object, source: string, analysis?: object|null, id?: string}} input
     * @returns {Promise<string>} the entry id
     */
    async save({ record, source, analysis = null, id = null }) {
      const previous = id ? await call('get', GAMES, id) : null;
      const entry = {
        id: id ?? newId(),
        savedAt: previous?.savedAt ?? now(),
        source,
        record,
        analysis: analysis ?? previous?.analysis ?? null,
      };
      await call('put', GAMES, entry);
      await call('put', META, summarize(entry));
      await trim();
      return entry.id;
    },

    /** Attach a finished review to a saved game (a no-op when it was deleted meanwhile). */
    async setAnalysis(id, analysis) {
      const entry = await call('get', GAMES, id);
      if (!entry) return false;
      entry.analysis = analysis;
      await call('put', GAMES, entry);
      await call('put', META, summarize(entry));
      return true;
    },

    /** Newest first. */
    async list() {
      return (await call('getAll', META)).sort((a, b) => b.savedAt - a.savedAt);
    },

    get: (id) => call('get', GAMES, id),

    async remove(id) {
      await call('remove', META, id);
      await call('remove', GAMES, id);
    },

    clear: () => call('clearAll'),
  };
}
