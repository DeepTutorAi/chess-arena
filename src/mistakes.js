// Mistake bank (roadmap C1): the positions where the player went wrong, kept and
// asked again on a spaced schedule until they are solved for good.
//
// Each mistake the review finds (mistake / blunder / miss, on the player's own
// moves) becomes a puzzle: the position BEFORE the move, with the engine's
// solutions. The schedule is a Leitner ladder — solve it and it moves up a box and
// comes back later, miss it and it drops to the bottom to be asked again. It all
// lives in this browser's localStorage; a corrupt store just starts empty.

import { hashString, positionKey } from './botbook.js';

export const MISTAKES_KEY = 'chess-arena-mistakes-v1';
export const MAX_MISTAKES = 400;
const DAY = 24 * 60 * 60 * 1000;
/** Delay before a mistake is asked again, by box (0 = new or just missed). */
export const BOX_DELAYS_MS = [0, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
export const TOP_BOX = BOX_DELAYS_MS.length - 1;
export const PRACTICE_BATCH = 10;
const PRACTICE_TIERS = new Set(['mistake', 'blunder', 'miss']);

/** A stable identity for a finished game (start position + moves), so reviewing the
 *  same game twice — or after re-importing it — never files its mistakes twice. */
export function gameKey(record) {
  const moves = (record?.moves ?? []).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).join(' ');
  return hashString(`${record?.initialFen ?? ''}|${moves}`);
}

const moveOk = (m) => m && /^[a-h][1-8]$/.test(m.from) && /^[a-h][1-8]$/.test(m.to);

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || typeof raw.fen !== 'string' || !/^[\w./ +-]{15,100}$/.test(raw.fen)) return null;
  if (!Array.isArray(raw.acceptable) || !raw.acceptable.length || !raw.acceptable.every(moveOk)) return null;
  const box = Number.isInteger(raw.box) ? Math.max(0, Math.min(TOP_BOX, raw.box)) : 0;
  return {
    id: raw.id,
    fen: raw.fen,
    acceptable: raw.acceptable.map((m) => ({ from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) })),
    bestSan: typeof raw.bestSan === 'string' ? raw.bestSan.slice(0, 12) : '',
    playedSan: typeof raw.playedSan === 'string' ? raw.playedSan.slice(0, 12) : '',
    tier: PRACTICE_TIERS.has(raw.tier) ? raw.tier : 'mistake',
    deltaW: Number.isFinite(raw.deltaW) ? raw.deltaW : 0,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : 0,
    box,
    dueAt: Number.isFinite(raw.dueAt) ? raw.dueAt : 0,
    solved: Number.isInteger(raw.solved) ? raw.solved : 0,
    missed: Number.isInteger(raw.missed) ? raw.missed : 0,
  };
}

function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * The mistakes in a finished review that belong in the bank.
 * @param {object} analysis  GameReviewAnalyzer result
 * @param {'w'|'b'} humanColor  whose mistakes to keep
 * @returns {object[]}  bank items (without schedule fields)
 */
export function mistakesFromAnalysis(analysis, humanColor) {
  if (humanColor !== 'w' && humanColor !== 'b') return [];
  const items = [];
  for (const ply of analysis?.plies ?? []) {
    if (ply.color !== humanColor || !PRACTICE_TIERS.has(ply.tier) || !ply.bestMove) continue;
    const fen = analysis.fens?.[ply.ply];
    if (!fen) continue;
    const acceptable = (ply.acceptable?.length ? ply.acceptable : [ply.bestMove])
      .map((m) => ({ from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) }));
    const best = ply.bestMove;
    items.push({
      id: `${positionKey(fen)}:${best.from}${best.to}${best.promotion ?? ''}`,
      fen,
      acceptable,
      bestSan: ply.bestSan ?? '',
      playedSan: ply.san ?? '',
      tier: ply.tier,
      deltaW: ply.deltaW ?? 0,
    });
  }
  return items;
}

/**
 * @param {object} [opts]
 * @param {{getItem(k: string): string|null, setItem(k: string, v: string): void}|null} [opts.storage]
 * @param {() => number} [opts.now]
 */
export function createMistakeBank({ storage = browserStorage(), now = Date.now } = {}) {
  let items = [];
  let ingested = [];

  const reload = () => {
    try {
      const raw = JSON.parse(storage?.getItem(MISTAKES_KEY) ?? 'null');
      if (raw?.v === 1) {
        items = (Array.isArray(raw.items) ? raw.items : []).map(sanitizeItem).filter(Boolean).slice(-MAX_MISTAKES);
        ingested = (Array.isArray(raw.ingested) ? raw.ingested : []).filter((g) => typeof g === 'string').slice(-500);
      }
    } catch { /* unreadable: keep what we have */ }
  };
  const save = () => {
    try { storage?.setItem(MISTAKES_KEY, JSON.stringify({ v: 1, items, ingested })); } catch { /* quota / private mode */ }
  };
  reload();

  const byUrgency = (a, b) => a.dueAt - b.dueAt || a.box - b.box || a.addedAt - b.addedAt;

  return {
    reload,

    /** Add the mistakes of one finished review. Idempotent per game and per position. */
    addFromAnalysis(analysis, humanColor, gameId = null) {
      reload(); // another tab may have added some
      if (gameId && ingested.includes(gameId)) return 0;
      const known = new Set(items.map((i) => i.id));
      let added = 0;
      for (const found of mistakesFromAnalysis(analysis, humanColor)) {
        if (known.has(found.id)) continue;
        known.add(found.id);
        const item = sanitizeItem({ ...found, addedAt: now(), box: 0, dueAt: 0 });
        if (item) { items.push(item); added += 1; }
      }
      if (items.length > MAX_MISTAKES) items = items.slice(-MAX_MISTAKES);
      if (gameId) ingested.push(gameId);
      save();
      return added;
    },

    get all() { return items.slice(); },

    /** Mistakes whose turn has come, most overdue first. */
    due(limit = PRACTICE_BATCH, at = now()) {
      return items.filter((i) => i.dueAt <= at).sort(byUrgency).slice(0, limit);
    },

    /** When nothing is due: the ones furthest from mastered, for extra practice. */
    ahead(limit = PRACTICE_BATCH) {
      return items.filter((i) => i.box < TOP_BOX).sort((a, b) => a.box - b.box || a.dueAt - b.dueAt).slice(0, limit);
    },

    /** Record an attempt. Solved: up a box and later; missed: back to the start, due now. */
    record(id, solved, at = now()) {
      reload();
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      if (solved) {
        item.box = Math.min(TOP_BOX, item.box + 1);
        item.solved += 1;
      } else {
        item.box = 0;
        item.missed += 1;
      }
      item.dueAt = at + BOX_DELAYS_MS[item.box];
      save();
      return { ...item };
    },

    remove(id) {
      items = items.filter((i) => i.id !== id);
      save();
    },

    clear() {
      items = [];
      ingested = [];
      save();
    },

    stats(at = now()) {
      const byBox = Array(BOX_DELAYS_MS.length).fill(0);
      for (const i of items) byBox[i.box] += 1;
      return {
        total: items.length,
        due: items.filter((i) => i.dueAt <= at).length,
        mastered: byBox[TOP_BOX],
        byBox,
      };
    },
  };
}

/**
 * A stand-in "analysis" the review stepper and puzzle run can play: one entry per
 * mistake, in the order given. Everything the puzzle machinery reads is there; the
 * game-only fields (eval graph, accuracy) are neutral.
 */
export function practiceAnalysis(mistakes) {
  const plies = mistakes.map((m, i) => ({
    ply: i,
    color: m.fen.split(' ')[1] === 'b' ? 'b' : 'w',
    san: m.playedSan || '—',
    from: m.acceptable[0].from,
    to: m.acceptable[0].to,
    promotion: null,
    captured: null,
    fenAfter: m.fen,
    turnAfter: m.fen.split(' ')[1] === 'b' ? 'w' : 'b',
    bestMove: m.acceptable[0],
    bestSan: m.bestSan,
    acceptable: m.acceptable,
    reply: null,
    replySan: null,
    tier: m.tier,
    deltaW: m.deltaW,
    cpLoss: 0,
    bestEvalCp: 0,
    bestMate: null,
    afterMate: null,
  }));
  return {
    initialFen: mistakes[0]?.fen ?? null,
    fens: mistakes.map((m) => m.fen),
    plies,
    positions: mistakes.map((m, i) => ({
      ply: i, fen: m.fen, turn: m.fen.split(' ')[1] === 'b' ? 'b' : 'w', whiteWinProb: 50, whiteEvalCp: 0, clock: null, pvSan: [], wdl: null,
    })).concat([{ ply: mistakes.length, fen: mistakes.at(-1)?.fen ?? null, turn: 'w', whiteWinProb: 50, whiteEvalCp: 0, clock: null, pvSan: [], wdl: null }]),
    criticalMoments: [],
    opening: null,
    accuracy: { w: null, b: null },
    counts: { w: {}, b: {} },
    result: '*',
    reason: '',
    players: { white: { name: 'คลังตาพลาด' }, black: { name: 'ทบทวน' } },
    gamemode: 'practice',
    practice: true,
  };
}
