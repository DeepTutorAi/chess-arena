// Chess Arena — central configuration & local room storage engine.

// Engine worker loaded at runtime (public assets, same-origin, no COOP/COEP
// required — compatible with GitHub Pages). Keep in sync with scripts/copy-engine.mjs.
export const ENGINE_WORKER_URL = './engine/stockfish-18-lite-single.js';

// Hint engine (GM-level suggestion for human vs bot): the same single-thread
// build pushed to absolute max strength — Skill 20, Hash 64, depth 20 search.
// The full NNUE build (stockfish-18-single.wasm ~108MB) exceeds GitHub's
// 100MB per-file limit so it cannot be deployed to Pages; max-strength deep
// search is the strongest option available here.
export const ENGINE_HINT_URL = './engine/stockfish-18-lite-single.js';

export const ENGINE_NAME = 'Stockfish 18 (Lite)';
export const HUMAN_NAME = 'คุณ';

// Human vs AI — strength mapping (level 1..8 -> UCI Skill Level 1..20 & Elo).
export const LEVELS = [
  { level: 1, elo: 800, skill: 2, depth: 4, movetime: 500, label: '800 (มือใหม่)' },
  { level: 2, elo: 1000, skill: 5, depth: 5, movetime: 600, label: '1000' },
  { level: 3, elo: 1200, skill: 8, depth: 6, movetime: 700, label: '1200' },
  { level: 4, elo: 1400, skill: 10, depth: 7, movetime: 800, label: '1400 (ทั่วไป)' },
  { level: 5, elo: 1600, skill: 13, depth: 8, movetime: 900, label: '1600' },
  { level: 6, elo: 1800, skill: 15, depth: 9, movetime: 1000, label: '1800 (ฝีมือดี)' },
  { level: 7, elo: 2000, skill: 18, depth: 10, movetime: 1200, label: '2000 (เชี่ยวชาญ)' },
  { level: 8, elo: 2200, skill: 20, depth: 12, movetime: 1500, label: '2200+ (มาสเตอร์)' },
  { level: 9, elo: 2400, skill: 20, depth: 14, movetime: 1800, label: '2400' },
  { level: 10, elo: 2600, skill: 20, depth: 16, movetime: 2200, label: '2600' },
  { level: 11, elo: 2800, skill: 20, depth: 18, movetime: 2800, label: '2800 (กรังด์มาสเตอร์)' },
];

// Player-facing WebSocket rooms use bounded retries. The room-scoped session
// capability is persisted separately by src/online.js.
export const ONLINE_RECONNECT_BASE_MS = 500;
export const ONLINE_RECONNECT_MAX_ATTEMPTS = 5;

// Time controls for Chess Arena (Bullet, Blitz, Rapid, Classical, Unlimited)
export const TIME_CONTROLS = [
  { id: 'unlimited', label: 'ไม่มีเวลา', category: 'unlimited', initialMs: 0, incMs: 0 },
  { id: 'bullet_1_0', label: '1 นาที', category: 'bullet', initialMs: 60000, incMs: 0 },
  { id: 'bullet_1_1', label: '1 นาที + 1 วิ', category: 'bullet', initialMs: 60000, incMs: 1000 },
  { id: 'blitz_3_1_5', label: '3 นาที + 1.5 วิ', category: 'blitz', initialMs: 180000, incMs: 1500 },
  { id: 'blitz_5_0', label: '5 นาที', category: 'blitz', initialMs: 300000, incMs: 0 },
  { id: 'rapid_10_0', label: '10 นาที', category: 'rapid', initialMs: 600000, incMs: 0 },
  { id: 'rapid_15_0', label: '15 นาที', category: 'rapid', initialMs: 900000, incMs: 0 },
  { id: 'classical_30_0', label: '30 นาที', category: 'classical', initialMs: 1800000, incMs: 0 },
];
export const DEFAULT_TIME_CONTROL = 'unlimited';

// Sandbox Mode — FEN Presets for custom board setup
export const SANDBOX_PRESETS = [
  { id: 'standard', name: 'กระดานมาตรฐาน (Standard)', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { id: 'endgame_kp', name: 'ฝึกปลายกระดาน King & Pawn', fen: '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1' },
  { id: 'endgame_rk', name: 'ฝึกรุกฆาต Rook & King', fen: '8/8/8/4k3/8/8/4K3/R7 w - - 0 1' },
  { id: 'custom', name: 'จัดกระดานอิสระ (Custom Setup)', fen: '' },
];

// Room Storage Store for Real Online Room Discovery
const ROOMS_KEY = 'chess-arena-rooms-store';

export function getRooms() {
  try {
    const raw = localStorage.getItem(ROOMS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRoom(room) {
  const rooms = getRooms();
  const idx = rooms.findIndex((r) => r.id === room.id || (room.gistId && r.gistId === room.gistId));
  if (idx >= 0) {
    rooms[idx] = { ...rooms[idx], ...room };
  } else {
    rooms.unshift(room);
  }
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms.slice(0, 20)));
}
