// Opening names (roadmap.md A2) — a trimmed lichess chess-openings (CC0)
// dataset built by scripts/build-openings.mjs into public/assets/openings.json.
// The lookup is the longest line whose normalized SAN moves form a prefix of
// the game's moves; used for the review's opening label and the real "Book"
// tier boundary (analyzer.js).

const OPENINGS_URL = './assets/openings.json';

const stripSuffix = (san) => san.replace(/[+#]/g, '');

export class OpeningBook {
  /** entries: [{ moves: "e4 c5", eco: "B20", name: "Sicilian Defense" }] */
  constructor(entries) {
    this.entries = (entries ?? []).map((e) => ({
      eco: e.eco,
      name: e.name,
      sans: e.moves.split(' ').map(stripSuffix),
    }));
  }

  /** sanMoves: per-ply SAN array. Returns { eco, name, plies } for the longest
   *  matching line, or null when nothing matches. */
  lookup(sanMoves) {
    const moves = sanMoves.map(stripSuffix);
    let best = null;
    for (const entry of this.entries) {
      const plies = entry.sans.length;
      if (best && plies <= best.plies) continue;
      if (plies > moves.length) continue;
      let ok = true;
      for (let i = 0; i < plies; i++) {
        if (entry.sans[i] !== moves[i]) {
          ok = false;
          break;
        }
      }
      if (ok) best = { eco: entry.eco, name: entry.name, plies };
    }
    return best;
  }
}

let bookPromise = null;

/** Lazily fetch + cache the opening book once per page load. A FAILED attempt
 *  (offline first load, 404 on an old deploy) clears the cached promise so the
 *  next review retries instead of staying book-less until reload. */
export function getOpeningBook() {
  bookPromise ??= fetch(OPENINGS_URL)
    .then((res) => {
      if (!res.ok) {
        bookPromise = null;
        return null;
      }
      return res.json();
    })
    .then((entries) => {
      if (!entries) {
        bookPromise = null;
        return null;
      }
      return new OpeningBook(entries);
    })
    .catch(() => {
      bookPromise = null;
      return null;
    });
  return bookPromise;
}
