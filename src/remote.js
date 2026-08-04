// Remote battle channel — lets an external AI agent play against this arena
// over the public GitHub Gist API. No server of our own: the room state is a
// JSON file inside a gist. Anyone (including another AI) can read it without
// auth; writes require the gist owner's token (entered in the app).
//
// State schema (documented in docs/agent-battle.md):
// {
//   "protocol": "chess-arena-battle",
//   "version": 1,
//   "status": "active" | "finished",
//   "fen": "...",
//   "turn": "w" | "b",
//   "lastMove": "e2e4" | null,
//   "lastMoveSan": "e4" | null,
//   "white": { "name": string, "kind": "engine"|"human"|"agent", "source": string },
//   "black": { ... },
//   "result": null | "1-0" | "0-1" | "1/2-1/2",
//   "moves": ["e2e4", ...],
//   "updatedAt": "ISO",
// }
//
// Write strategy: read-modify-write with a compare-and-swap on `updatedAt` to
// avoid clobbering a move made by the opponent between our read and write.

import { REMOTE_POLL_MS, REMOTE_MAX_MOVES } from './config.js';

const API = 'https://api.github.com';

export function sanitizeName(name) {
  return String(name ?? 'คู่แข่ง AI').slice(0, 40);
}

export class RemoteChannel {
  /**
   * @param {object} opts
   * @param {string} opts.token — GitHub token (write access)
   * @param {string} opts.gistId
   * @param {Function} opts.onState (state, meta) => void — every poll/fetch result
   * @param {Function} opts.onError (msg) => void
   * @param {number} [opts.pollMs]
   */
  constructor({ token, gistId, onState, onError, pollMs = REMOTE_POLL_MS }) {
    this.token = token;
    this.gistId = gistId;
    this.onState = onState;
    this.onError = onError;
    this.pollMs = pollMs;
    this._timer = null;
    this._seq = 0;
    this._lastEtag = null;
    this._running = false;
    this.state = null; // latest fetched room state
  }

  get gistUrl() {
    return `https://gist.github.com/${this.gistId}`;
  }

  _headers(json) {
    const h = { Accept: 'application/vnd.github+json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async _readStateRaw() {
    const res = await fetch(`${API}/gists/${this.gistId}`, {
      headers: this._headers(false),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`อ่านห้องไม่สำเร็จ (HTTP ${res.status})`);
    const gist = await res.json();
    let file = gist.files?.['state.json'];
    // Friendly fallback: if the room was created manually with a single JSON
    // file under a different name, accept it.
    if (!file) {
      const jsonFiles = Object.values(gist.files ?? {}).filter((f) => f?.filename?.endsWith('.json'));
      if (jsonFiles.length === 1) file = jsonFiles[0];
    }
    if (!file) throw new Error('ห้องนี้ไม่มี state.json');
    return { gist, state: JSON.parse(file.content), updatedAt: gist.updated_at };
  }

  /** Read the current room state (public). */
  async fetchState() {
    const { state } = await this._readStateRaw();
    return state;
  }

  /**
   * Atomically update the room state.
   * @param {Function} mutate (state) => nextState — must return a new state object
   * @param {number} [attempts]
   */
  async updateState(mutate, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      const { state, updatedAt } = await this._readStateRaw();
      const next = { ...mutate(state), updatedAt: new Date().toISOString() };
      if (next.moves?.length > REMOTE_MAX_MOVES) {
        next.moves = next.moves.slice(-REMOTE_MAX_MOVES);
      }
      const res = await fetch(`${API}/gists/${this.gistId}`, {
        method: 'PATCH',
        headers: this._headers(true),
        cache: 'no-store',
        body: JSON.stringify({
          files: { 'state.json': { content: JSON.stringify(next, null, 2) } },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 409 || res.status === 422) continue; // conflict — retry
        throw new Error(`เขียนห้องไม่สำเร็จ (HTTP ${res.status}) ${body.slice(0, 200)}`);
      }
      return next;
    }
    throw new Error('เขียนห้องไม่สำเร็จ: มีการชนกันหลายครั้ง ลองใหม่');
  }

  /** Start polling for external moves. */
  start() {
    if (this._running) return;
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      const seq = ++this._seq;
      try {
        const state = await this.fetchState();
        if (this._running && seq === this._seq) {
          this.state = state;
          this.onState(state, { external: true });
        }
      } catch (err) {
        this.onError(err.message);
      } finally {
        if (this._running) this._timer = setTimeout(tick, this.pollMs);
      }
    };
    this._timer = setTimeout(tick, this.pollMs);
  }

  /**
   * Publish one move to the room (needs the room owner token).
   * @param {string} uci — e.g. 'e2e4' or 'e7e8q'
   * @param {string} san — e.g. 'e4'
   * @param {string} fen — full FEN after the move
   * @param {string|null} [result] — '1-0' | '0-1' | '1/2-1/2' when the game ended
   */
  async appendMove(uci, san, fen, result = null) {
    await this.updateState((state) => {
      const next = {
        ...state,
        fen,
        turn: fen.split(' ')[1],
        lastMove: uci,
        lastMoveSan: san,
        moves: [...(state.moves ?? []), uci],
      };
      if (result) {
        next.status = 'finished';
        next.result = result;
      }
      return next;
    });
  }

  stop() {
    this._running = false;
    this._seq++;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

/**
 * Create a new remote battle room (host side).
 * @param {object} opts — token, title, white, black (player descriptors),
 *   arenaSide ('w'|'b'|null): which side the Chess Arena engine will auto-play,
 *   initialFen: custom starting position (e.g. from sandbox setup)
 * @returns {Promise<{gistId: string, url: string}>}
 */
export async function createRoom({ token, title, white, black, arenaSide = null, initialFen }) {
  const fen = initialFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const now = new Date().toISOString();
  const state = {
    protocol: 'chess-arena-battle',
    version: 1,
    status: 'active',
    fen,
    turn: fen.split(' ')[1],
    lastMove: null,
    lastMoveSan: null,
    arenaSide,
    white,
    black,
    result: null,
    moves: [],
    updatedAt: now,
  };
  const res = await fetch(`${API}/gists`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: `Chess Arena battle room — ${title}`,
      public: true,
      files: { 'state.json': { content: JSON.stringify(state, null, 2) } },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`สร้างห้องไม่สำเร็จ (HTTP ${res.status}) ${body.slice(0, 200)}`);
  }
  const gist = await res.json();
  return { gistId: gist.id, url: gist.html_url };
}
