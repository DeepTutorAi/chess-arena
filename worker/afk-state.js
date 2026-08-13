const OPENING_LIMITS = Object.freeze({
  bullet_1_0: 15_000,
  bullet_1_1: 15_000,
  blitz_3_1_5: 20_000,
  blitz_5_0: 25_000,
  rapid_10_0: 30_000,
  rapid_15_0: 35_000,
  classical_30_0: 40_000,
  unlimited: 40_000,
});

const UNLIMITED_COUNTDOWN_MS = 40_000;
const UNLIMITED_INACTIVITY_MS = 240_000;
const HEARTBEAT_MISSING_MS = 30_000;

function copy(value) {
  return structuredClone(value);
}

function finish(state, loser, reason, now) {
  const next = copy(state);
  next.status = 'finished';
  next.result = loser === 'w' ? '0-1' : '1-0';
  next.reason = reason;
  next.revision += 1;
  next.updatedAt = now;
  next.afk.openingDeadlineAt = null;
  next.afk.episode = null;
  if (next.clock) next.clock.activeSince = null;
  return next;
}

function canUseUnlimitedAfk(state) {
  return state.status === 'active'
    && state.timeControlId === 'unlimited'
    && state.moves.length >= 2
    && state.afk;
}

function startEpisode(state, color, cause, now) {
  if (!canUseUnlimitedAfk(state) || state.turn !== color || state.afk.episode) {
    return { changed: false, state };
  }
  const next = copy(state);
  next.afk.strikes[color] += 1;
  if (next.afk.strikes[color] >= 3) {
    return { changed: true, state: finish(next, color, 'unlimited_afk_strikes', now) };
  }
  next.afk.episode = {
    color,
    cause,
    startedAt: now,
    deadlineAt: now + UNLIMITED_COUNTDOWN_MS,
  };
  next.updatedAt = now;
  return { changed: true, state: next };
}

export function openingAfkLimitMs(timeControlId) {
  const limit = OPENING_LIMITS[timeControlId];
  if (!Number.isSafeInteger(limit)) throw new Error('Unknown time control');
  return limit;
}

export function createAfkState(timeControlId, now = Date.now()) {
  const openingLimitMs = openingAfkLimitMs(timeControlId);
  return {
    openingLimitMs,
    openingDeadlineAt: now + openingLimitMs,
    turnStartedAt: now,
    strikes: { w: 0, b: 0 },
    episode: null,
    presence: {
      w: { visibility: 'visible', lastHeartbeatAt: now },
      b: { visibility: 'visible', lastHeartbeatAt: now },
    },
  };
}

export function advanceAfkAfterMove(state, now = Date.now()) {
  if (!state.afk) return state;
  const next = copy(state);
  next.afk.episode = null;
  next.afk.turnStartedAt = now;
  next.afk.openingDeadlineAt = next.moves.length < 2
    ? now + next.afk.openingLimitMs
    : null;
  next.afk.presence[next.turn].lastHeartbeatAt = now;
  if (canUseUnlimitedAfk(next) && next.afk.presence[next.turn].visibility === 'hidden') {
    return startEpisode(next, next.turn, 'hidden', now).state;
  }
  return next;
}

function applyVisibility(state, color, visibility, now, { heartbeat }) {
  if (!canUseUnlimitedAfk(state) || !['w', 'b'].includes(color) || !['visible', 'hidden'].includes(visibility)) {
    return { changed: false, state };
  }
  const next = copy(state);
  const previousVisibility = next.afk.presence[color].visibility;
  next.afk.presence[color].visibility = visibility;
  if (heartbeat || visibility === 'visible') next.afk.presence[color].lastHeartbeatAt = now;

  const episode = next.afk.episode;
  if (visibility === 'visible'
    && episode?.color === color
    && ['hidden', 'heartbeat'].includes(episode.cause)) {
    next.afk.episode = null;
    next.updatedAt = now;
    return { changed: true, state: next };
  }
  if (visibility === 'hidden' && state.turn === color && !episode) {
    return startEpisode(next, color, 'hidden', now);
  }
  const changed = previousVisibility !== visibility || heartbeat;
  if (changed) next.updatedAt = now;
  return { changed, state: changed ? next : state };
}

export function applyPlayerPresence(state, color, visibility, now = Date.now()) {
  return applyVisibility(state, color, visibility, now, { heartbeat: false });
}

export function applyPlayerHeartbeat(state, color, visibility, now = Date.now()) {
  return applyVisibility(state, color, visibility, now, { heartbeat: true });
}

export function realizeAfk(state, now = Date.now()) {
  if (state.status !== 'active' || !state.afk) return { changed: false, state };
  if (state.moves.length < 2) {
    if (now < state.afk.openingDeadlineAt) return { changed: false, state };
    return { changed: true, state: finish(state, state.turn, 'opening_afk_timeout', now) };
  }
  if (state.timeControlId !== 'unlimited') return { changed: false, state };
  if (state.afk.episode) {
    if (now < state.afk.episode.deadlineAt) return { changed: false, state };
    return {
      changed: true,
      state: finish(state, state.afk.episode.color, 'unlimited_afk_timeout', now),
    };
  }

  const presence = state.afk.presence[state.turn];
  if (presence.visibility === 'hidden') return startEpisode(state, state.turn, 'hidden', now);
  if (now >= presence.lastHeartbeatAt + HEARTBEAT_MISSING_MS) {
    return startEpisode(state, state.turn, 'heartbeat', now);
  }
  if (now >= state.afk.turnStartedAt + UNLIMITED_INACTIVITY_MS) {
    return startEpisode(state, state.turn, 'inactivity', now);
  }
  return { changed: false, state };
}

export function nextAfkDeadline(state) {
  if (state.status !== 'active' || !state.afk) return null;
  if (state.moves.length < 2) return state.afk.openingDeadlineAt;
  if (state.timeControlId !== 'unlimited') return null;
  if (state.afk.episode) return state.afk.episode.deadlineAt;
  const presence = state.afk.presence[state.turn];
  if (presence.visibility === 'hidden') return presence.lastHeartbeatAt;
  return Math.min(
    state.afk.turnStartedAt + UNLIMITED_INACTIVITY_MS,
    presence.lastHeartbeatAt + HEARTBEAT_MISSING_MS,
  );
}

export function toPublicAfk(state) {
  if (!state.afk) return null;
  return {
    strikes: { ...state.afk.strikes },
    countdown: state.afk.episode
      ? {
          color: state.afk.episode.color,
          cause: state.afk.episode.cause,
          deadlineAt: state.afk.episode.deadlineAt,
        }
      : state.status === 'active' && state.moves.length < 2
        ? { color: state.turn, cause: 'opening', deadlineAt: state.afk.openingDeadlineAt }
        : null,
  };
}
