// Chess Arena — central configuration.

// Engine worker loaded at runtime (public assets, same-origin, no COOP/COEP
// required — compatible with GitHub Pages). Keep in sync with scripts/copy-engine.mjs.
export const ENGINE_WORKER_URL = './engine/stockfish-18-lite-single.js';

export const ENGINE_NAME = 'Stockfish 18 (Lite)';
export const HUMAN_NAME = 'คุณ';
export const GUEST_NAME = 'คู่แข่ง AI';

// Human vs AI — strength mapping (level 1..8 -> UCI Skill Level 1..20).
export const LEVELS = [
  { level: 1, skill: 2, depth: 4, movetime: 500 },
  { level: 2, skill: 5, depth: 5, movetime: 600 },
  { level: 3, skill: 8, depth: 6, movetime: 700 },
  { level: 4, skill: 10, depth: 7, movetime: 800 },
  { level: 5, skill: 13, depth: 8, movetime: 900 },
  { level: 6, skill: 15, depth: 9, movetime: 1000 },
  { level: 7, skill: 18, depth: 10, movetime: 1200 },
  { level: 8, skill: 20, depth: 12, movetime: 1500 },
];

// AI vs AI — speed presets (engine time per move, ms).
export const SPEEDS = {
  fast: { label: 'เร็ว', movetime: 120 },
  normal: { label: 'ปานกลาง', movetime: 450 },
  slow: { label: 'ช้า', movetime: 1200 },
};
export const DEFAULT_SPEED = 'normal';

// Remote (agent battle) polling interval, ms.
export const REMOTE_POLL_MS = 2500;

// Max moves kept in the remote room state (trim old history to keep gist small).
export const REMOTE_MAX_MOVES = 512;
