import { Chess } from 'chess.js';

export const ONLINE_PROTOCOL = 'chess-arena-online';
export const ONLINE_VERSION = 1;

const error = (code, message, extra = {}) => ({ ok: false, error: { code, message }, ...extra });

function copy(value) {
  return structuredClone(value);
}

function gameFromState(state) {
  const game = new Chess(state.initialFen);
  for (const uci of state.moves) {
    const move = game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (!move) throw new Error('Stored room history is invalid');
  }
  return game;
}

function gameOutcome(game) {
  if (!game.isGameOver()) return null;
  if (game.isCheckmate()) {
    return {
      result: game.turn() === 'w' ? '0-1' : '1-0',
      reason: 'checkmate',
    };
  }
  return { result: '1/2-1/2', reason: 'draw' };
}

function finishByTimeout(state, loser) {
  const next = copy(state);
  next.status = 'finished';
  next.result = loser === 'w' ? '0-1' : '1-0';
  next.reason = 'timeout';
  next.revision += 1;
  next.updatedAt = next.clock.activeSince + (loser === 'w' ? next.clock.whiteMs : next.clock.blackMs);
  next.clock[loser === 'w' ? 'whiteMs' : 'blackMs'] = 0;
  next.clock.activeSince = null;
  return next;
}

export function createGameState(input, now = Date.now()) {
  const initialFen = input.initialFen;
  const game = new Chess(initialFen);
  const hostColor = input.hostColor === 'b' ? 'b' : 'w';
  const guestColor = hostColor === 'w' ? 'b' : 'w';
  const players = {
    w: { role: hostColor === 'w' ? 'host' : 'guest', name: null, avatar: null },
    b: { role: hostColor === 'b' ? 'host' : 'guest', name: null, avatar: null },
  };
  players[hostColor].name = input.hostName;
  players[hostColor].avatar = input.hostAvatar ?? 'knight';

  const tc = input.timeControl;
  const clock = tc
    ? {
        initialMs: tc.initialMs,
        incrementMs: tc.incrementMs,
        whiteMs: tc.initialMs,
        blackMs: tc.initialMs,
        activeSince: null,
      }
    : null;

  return {
    protocol: ONLINE_PROTOCOL,
    version: ONLINE_VERSION,
    roomId: input.roomId,
    title: input.title,
    visibility: input.visibility ?? 'public',
    allowSpectators: input.allowSpectators ?? true,
    timeControlId: input.timeControlId ?? 'unlimited',
    revision: 0,
    status: 'waiting',
    initialFen,
    fen: game.fen(),
    turn: game.turn(),
    lastMove: null,
    lastMoveSan: null,
    moves: [],
    result: null,
    reason: null,
    players,
    hostColor,
    guestColor,
    clock,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
  };
}

export function joinGameState(state, guestName, now = Date.now(), guestAvatar = 'pawns') {
  if (now >= state.expiresAt) return error('room_expired', 'ห้องนี้หมดอายุแล้ว');
  if (state.status !== 'waiting' || state.players[state.guestColor].name) {
    return error('room_full', 'ห้องนี้มีผู้เล่นครบแล้ว');
  }

  const next = copy(state);
  next.players[next.guestColor].name = String(guestName).trim();
  next.players[next.guestColor].avatar = guestAvatar;
  next.status = 'active';
  next.revision += 1;
  next.updatedAt = now;
  if (next.clock) next.clock.activeSince = now;
  return { ok: true, state: next };
}

export function realizeTimeout(state, now = Date.now()) {
  if (state.status !== 'active' || !state.clock || state.clock.activeSince === null) {
    return { changed: false, state };
  }

  const elapsed = Math.max(0, now - state.clock.activeSince);
  const remainingKey = state.turn === 'w' ? 'whiteMs' : 'blackMs';
  if (elapsed < state.clock[remainingKey]) return { changed: false, state };
  return { changed: true, state: finishByTimeout(state, state.turn) };
}

export function applyGameCommand(state, actor, command, now = Date.now()) {
  if (now >= state.expiresAt) return error('room_expired', 'ห้องนี้หมดอายุแล้ว');
  if (!actor || !['host', 'guest'].includes(actor.role) || !['w', 'b'].includes(actor.color)) {
    return error('unauthorized', 'ไม่มีสิทธิ์ดำเนินการในห้องนี้');
  }
  if (state.players[actor.color]?.role !== actor.role) {
    return error('unauthorized', 'ไม่มีสิทธิ์ดำเนินการในห้องนี้');
  }
  if (!command || command.expectedRevision !== state.revision) {
    return error('stale_revision', 'สถานะเกมเปลี่ยนแล้ว กรุณาซิงก์ใหม่');
  }
  if (state.status !== 'active') {
    return error('game_not_active', 'เกมยังไม่พร้อมหรือจบแล้ว');
  }

  const timeout = realizeTimeout(state, now);
  if (timeout.changed) {
    return error('time_expired', 'เวลาของฝ่ายที่ต้องเดินหมดแล้ว', { state: timeout.state });
  }

  if (command.type === 'resign') {
    const next = copy(state);
    next.status = 'finished';
    next.result = actor.color === 'w' ? '0-1' : '1-0';
    next.reason = 'resignation';
    next.revision += 1;
    next.updatedAt = now;
    if (next.clock) next.clock.activeSince = null;
    return { ok: true, state: next };
  }

  if (command.type !== 'move') return error('unknown_command', 'ไม่รู้จักคำสั่งนี้');
  if (state.turn !== actor.color) return error('wrong_turn', 'ยังไม่ถึงตาของคุณ');

  const game = gameFromState(state);
  let move;
  try {
    move = game.move({
      from: command.from,
      to: command.to,
      promotion: command.promotion,
    });
  } catch {
    move = null;
  }
  if (!move) return error('illegal_move', 'ตาเดินนี้ไม่ถูกต้องตามกติกา');

  const next = copy(state);
  const uci = move.from + move.to + (move.promotion ?? '');
  next.fen = game.fen();
  next.turn = game.turn();
  next.lastMove = uci;
  next.lastMoveSan = move.san;
  next.moves.push(uci);
  next.revision += 1;
  next.updatedAt = now;

  if (next.clock) {
    const moverKey = actor.color === 'w' ? 'whiteMs' : 'blackMs';
    const elapsed = Math.max(0, now - next.clock.activeSince);
    next.clock[moverKey] = Math.max(0, next.clock[moverKey] - elapsed) + next.clock.incrementMs;
    next.clock.activeSince = now;
  }

  const outcome = gameOutcome(game);
  if (outcome) {
    next.status = 'finished';
    next.result = outcome.result;
    next.reason = outcome.reason;
    if (next.clock) next.clock.activeSince = null;
  }

  return { ok: true, state: next };
}

export function toPublicState(state, connections = {}) {
  const publicPlayers = {};
  for (const color of ['w', 'b']) {
    const player = state.players[color];
    publicPlayers[color] = {
      name: player.name,
      avatar: player.avatar ?? null,
      connected: Boolean(connections[player.role]),
    };
  }

  return {
    protocol: ONLINE_PROTOCOL,
    version: ONLINE_VERSION,
    type: 'state',
    roomId: state.roomId,
    title: state.title,
    visibility: state.visibility ?? 'public',
    allowSpectators: state.allowSpectators ?? true,
    revision: state.revision,
    status: state.status,
    initialFen: state.initialFen,
    fen: state.fen,
    turn: state.turn,
    lastMove: state.lastMove,
    lastMoveSan: state.lastMoveSan,
    moves: [...state.moves],
    result: state.result,
    reason: state.reason,
    players: publicPlayers,
    clock: state.clock ? copy(state.clock) : null,
    expiresAt: state.expiresAt,
  };
}
