// Opening book for the bot (roadmap A2).
//
// public/assets/botbook.json is generated offline by scripts/build-botbook.mjs
// from the named-openings dataset. Every move in it has been checked by the
// engine, so the bot only ever repeats *sound* theory (the raw dataset also holds
// junk like 1.Na3 or 2.Ke2 gambits that a book must not play).
//
// Positions are keyed by a hash of the FEN (board, side, castling, en passant),
// so transpositions are found too. Each entry lists the book replies with a
// popularity count; the pick is random, weighted by sqrt(count) so the main
// lines are favoured but rarer sound openings still appear.

const BOOK_URL = './assets/botbook.json';

/** A move backed by fewer named lines than this is a curiosity (1...h6), played
 *  only when the book has nothing better for the position. */
export const MIN_LINE_COUNT = 3;

/** How many plies of theory a level of the given strength may use. */
export function bookPlies(level) {
  return Math.min(12, 4 + level);
}

/** cyrb53 — a small, well-mixed 53-bit string hash, as base 36. */
export function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Position identity: the first four FEN fields (no move counters). */
export function positionKey(fen) {
  return hashString(fen.split(' ').slice(0, 4).join(' '));
}

export class BotBook {
  /** data: { positions: { [key]: [[uci, count], ...] } } */
  constructor(data) {
    this.positions = data?.positions ?? {};
  }

  /** Book replies for a position: [{ uci, weight }], best-known first. */
  candidates(fen) {
    const list = this.positions[positionKey(fen)];
    if (!list) return [];
    return list.map(([uci, count]) => ({ uci, count, weight: Math.sqrt(count) }));
  }

  /**
   * Pick a reply.
   * @param {string} fen
   * @param {object} [opts]
   * @param {(uci: string) => boolean} [opts.isLegal]  drops entries the position does not allow
   *        (guards against a hash collision or a stale book)
   * @param {() => number} [opts.rng]
   * @returns {string|null} UCI move, or null when the position is out of book
   */
  pick(fen, { isLegal = () => true, rng = Math.random } = {}) {
    let options = this.candidates(fen).filter((c) => isLegal(c.uci));
    const mainstream = options.filter((c) => c.count >= MIN_LINE_COUNT);
    if (mainstream.length) options = mainstream;
    if (!options.length) return null;
    const total = options.reduce((sum, c) => sum + c.weight, 0);
    let roll = rng() * total;
    for (const c of options) {
      roll -= c.weight;
      if (roll < 0) return c.uci;
    }
    return options[options.length - 1].uci;
  }
}

let bookPromise = null;

/** Lazily fetch the book once per page load. A failed attempt (offline first
 *  load, old deploy) clears the cache so a later game retries; the bot simply
 *  plays without a book meanwhile. */
export function getBotBook() {
  if (!bookPromise) {
    const fail = () => { bookPromise = null; return null; };
    try {
      bookPromise = fetch(BOOK_URL)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => (data?.positions ? new BotBook(data) : fail()))
        .catch(fail);
    } catch {
      return Promise.resolve(fail());
    }
  }
  return bookPromise;
}
