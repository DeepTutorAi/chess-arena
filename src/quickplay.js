// Quick Play (roadmap D3): one click to a game. Look at the public lobby for a
// table that is waiting for an opponent and take a seat; if there is none, open
// one with the chosen time control and let the next Quick Play find it. It is a
// client-side convention over the ordinary lobby and room APIs — the server has
// no matchmaking.

export const QUICK_PLAY_KEY = 'chess-arena:quick-play-time';
export const QUICK_TIMES = Object.freeze([
  { id: 'blitz_3_1_5', label: '3+1.5', sub: 'บลิทซ์' },
  { id: 'blitz_5_0', label: '5 นาที', sub: 'บลิทซ์' },
  { id: 'rapid_10_0', label: '10 นาที', sub: 'ราปิด' },
]);
export const DEFAULT_QUICK_TIME = 'blitz_5_0';
export const MAX_JOIN_ATTEMPTS = 3;
const QUICK_TITLE = 'Quick Play';

export function isQuickTime(id) {
  return QUICK_TIMES.some((t) => t.id === id);
}

/**
 * The tables worth taking a seat at, best first: waiting for a guest, not ours,
 * with the requested time control, and — among those — the one that has waited
 * longest (nobody should sit alone while a newer table gets the next player).
 * @param {Array<object>} rooms  lobby rooms
 * @param {object} opts
 * @param {string} opts.timeControlId
 * @param {Set<string>|string[]} [opts.ownRoomIds]  rooms this browser created
 * @param {number} [opts.now]  server time
 */
export function quickPlayCandidates(rooms, { timeControlId, ownRoomIds = [], now = Date.now() }) {
  const own = new Set(ownRoomIds);
  return rooms
    .filter((room) => room.status === 'waiting'
      && room.openColor
      && !room.guest
      && room.timeControlId === timeControlId
      && !own.has(room.roomId)
      && (!room.expiresAt || room.expiresAt > now))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Find a game.
 * @param {object} deps
 * @param {(filters: object) => Promise<{rooms: object[], serverTime: number}>} deps.listLobby
 * @param {(room: object) => Promise<void>} deps.join     take a seat (throws when it is gone)
 * @param {(room: object) => Promise<void>} [deps.resume] go back to a table of ours that is still waiting
 * @param {() => Promise<void>} deps.create               open a table and wait
 * @param {object} opts
 * @param {string} opts.timeControlId
 * @param {string[]} [opts.ownRoomIds]
 * @param {() => boolean} [opts.cancelled]  polled between steps: stop quietly when true
 * @param {(phase: 'searching'|'joining'|'creating') => void} [opts.onPhase]  cancelling is only
 *        possible while searching — a join or a create already under way runs to its end
 * @returns {Promise<{outcome: 'joined'|'resumed'|'created'|'cancelled', room?: object, tried: number}>}
 */
export async function runQuickPlay({ listLobby, join, resume, create }, {
  timeControlId, ownRoomIds = [], cancelled = () => false, onPhase = () => {},
}) {
  if (!isQuickTime(timeControlId)) throw new Error('รูปแบบเวลาไม่ถูกต้อง');
  let tried = 0;
  let rooms = [];
  let now = Date.now();
  onPhase('searching');
  try {
    const lobby = await listLobby({ status: 'open', time: 'all' });
    rooms = lobby.rooms ?? [];
    now = lobby.serverTime ?? now;
  } catch {
    // The lobby could not be read: opening our own table still works, so do that.
    rooms = [];
  }
  if (cancelled()) return { outcome: 'cancelled', tried };

  // A table of ours on this clock is still waiting: go back to it instead of
  // opening a second one (and leaving the first standing empty in the lobby).
  const own = new Set(ownRoomIds);
  const mine = rooms.find((room) => own.has(room.roomId) && room.status === 'waiting' && !room.guest
    && room.timeControlId === timeControlId && (!room.expiresAt || room.expiresAt > now));
  if (mine && resume) {
    onPhase('joining');
    try {
      await resume(mine);
      return { outcome: 'resumed', room: mine, tried };
    } catch { /* the seat is gone: carry on */ }
  }

  for (const room of quickPlayCandidates(rooms, { timeControlId, ownRoomIds, now }).slice(0, MAX_JOIN_ATTEMPTS)) {
    tried += 1;
    onPhase('joining');
    try {
      await join(room);
      return { outcome: 'joined', room, tried };
    } catch {
      // Someone else took that seat first: try the next table.
    }
  }
  onPhase('creating');
  await create();
  return { outcome: 'created', tried };
}

/** The room a Quick Play table is created with. */
export function quickPlayRoom({ playerName, avatar, timeControlId }) {
  return {
    action: 'create',
    playerName,
    avatar,
    title: QUICK_TITLE,
    color: 'random',
    timeControlId,
    visibility: 'public',
    allowSpectators: true,
  };
}
