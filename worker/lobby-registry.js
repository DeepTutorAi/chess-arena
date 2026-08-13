import { DurableObject } from 'cloudflare:workers';

import { AVATARS, parseLobbyQuery, TIME_CONTROLS } from './protocol.js';

const ROOM_PATTERN = /^[a-z2-7]{16}$/u;
const PAGE_SIZE = 24;
const STATUSES = ['waiting', 'active', 'finished'];

function json(value, status = 200) {
  return Response.json(value, { status });
}

function isProfile(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.name === 'string'
    && Array.from(value.name.trim()).length > 0
    && Array.from(value.name.trim()).length <= 40
    && AVATARS.includes(value.avatar);
}

function validProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = [
    'roomId', 'title', 'status', 'host', 'guest', 'openColor', 'timeControlId',
    'createdAt', 'updatedAt', 'spectatorCount', 'allowSpectators', 'expiresAt',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (!ROOM_PATTERN.test(value.roomId) || typeof value.title !== 'string') return false;
  if (Array.from(value.title.trim()).length === 0 || Array.from(value.title.trim()).length > 80) return false;
  if (!STATUSES.includes(value.status) || !isProfile(value.host)) return false;
  if (value.guest !== null && !isProfile(value.guest)) return false;
  if (![null, 'w', 'b'].includes(value.openColor)) return false;
  if (!Object.hasOwn(TIME_CONTROLS, value.timeControlId)) return false;
  if (![value.createdAt, value.updatedAt, value.expiresAt].every(Number.isSafeInteger)) return false;
  if (value.updatedAt < value.createdAt || value.expiresAt <= value.createdAt) return false;
  if (!Number.isSafeInteger(value.spectatorCount) || value.spectatorCount < 0 || value.spectatorCount > 50) return false;
  return typeof value.allowSpectators === 'boolean';
}

function encodeCursor(updatedAt, roomId) {
  return btoa(JSON.stringify([updatedAt, roomId]))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(normalized + padding));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || !Number.isSafeInteger(parsed[0]) || !ROOM_PATTERN.test(parsed[1])) return null;
    return { updatedAt: parsed[0], roomId: parsed[1] };
  } catch {
    return null;
  }
}

function rowToProjection(row) {
  return {
    roomId: row.room_id,
    title: row.title,
    status: row.status,
    host: { name: row.host_name, avatar: row.host_avatar },
    guest: row.guest_name === null ? null : { name: row.guest_name, avatar: row.guest_avatar },
    openColor: row.open_color,
    timeControlId: row.time_control_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    spectatorCount: row.spectator_count,
    allowSpectators: Boolean(row.allow_spectators),
    expiresAt: row.expires_at,
  };
}

export class LobbyRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        host_name TEXT NOT NULL,
        host_avatar TEXT NOT NULL,
        guest_name TEXT,
        guest_avatar TEXT,
        open_color TEXT,
        time_control_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        spectator_count INTEGER NOT NULL,
        allow_spectators INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS rooms_order ON rooms(updated_at DESC, room_id ASC)');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/upsert') return this.upsert(request);
    if (request.method === 'POST' && url.pathname === '/remove') return this.remove(request);
    if (request.method === 'GET' && url.pathname === '/list') return this.list(url);
    return json({ error: 'not_found' }, 404);
  }

  async upsert(request) {
    let value;
    try {
      value = await request.json();
    } catch {
      return json({ error: 'invalid_request' }, 400);
    }
    if (!validProjection(value)) return json({ error: 'invalid_projection' }, 400);
    this.ctx.storage.sql.exec(`
      INSERT INTO rooms (
        room_id, title, status, host_name, host_avatar, guest_name, guest_avatar,
        open_color, time_control_id, created_at, updated_at, spectator_count,
        allow_spectators, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        host_name = excluded.host_name,
        host_avatar = excluded.host_avatar,
        guest_name = excluded.guest_name,
        guest_avatar = excluded.guest_avatar,
        open_color = excluded.open_color,
        time_control_id = excluded.time_control_id,
        updated_at = excluded.updated_at,
        spectator_count = excluded.spectator_count,
        allow_spectators = excluded.allow_spectators,
        expires_at = excluded.expires_at
    `,
    value.roomId, value.title.trim(), value.status, value.host.name.trim(), value.host.avatar,
    value.guest?.name.trim() ?? null, value.guest?.avatar ?? null, value.openColor,
    value.timeControlId, value.createdAt, value.updatedAt, value.spectatorCount,
    value.allowSpectators ? 1 : 0, value.expiresAt);
    return new Response(null, { status: 204 });
  }

  async remove(request) {
    let value;
    try {
      value = await request.json();
    } catch {
      return json({ error: 'invalid_request' }, 400);
    }
    if (!value || Object.keys(value).length !== 1 || !ROOM_PATTERN.test(value.roomId)) {
      return json({ error: 'invalid_request' }, 400);
    }
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', value.roomId);
    return new Response(null, { status: 204 });
  }

  list(url) {
    const parsed = parseLobbyQuery(url);
    if (!parsed.ok) return json({ error: parsed.code, message: parsed.message }, 400);
    const cursor = parsed.value.cursor ? decodeCursor(parsed.value.cursor) : null;
    if (parsed.value.cursor && !cursor) return json({ error: 'invalid_cursor' }, 400);

    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE expires_at <= ?', now);

    const conditions = ['expires_at > ?', "status != 'finished'"];
    const params = [now];
    if (parsed.value.status === 'open') conditions.push("status = 'waiting'");
    if (parsed.value.status === 'watch') conditions.push("status = 'active' AND allow_spectators = 1");
    if (parsed.value.time === 'unlimited') conditions.push("time_control_id = 'unlimited'");
    if (parsed.value.time === 'bullet') conditions.push("time_control_id LIKE 'bullet_%'");
    if (parsed.value.time === 'blitz') conditions.push("time_control_id LIKE 'blitz_%'");
    if (parsed.value.time === 'rapid') conditions.push("(time_control_id LIKE 'rapid_%' OR time_control_id LIKE 'classical_%')");
    if (parsed.value.search) {
      conditions.push('(instr(lower(title), ?) > 0 OR instr(lower(host_name), ?) > 0)');
      const search = parsed.value.search.toLocaleLowerCase('en-US');
      params.push(search, search);
    }
    if (cursor) {
      conditions.push('(updated_at < ? OR (updated_at = ? AND room_id > ?))');
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.roomId);
    }

    const rows = [...this.ctx.storage.sql.exec(`
      SELECT * FROM rooms
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC, room_id ASC
      LIMIT ${PAGE_SIZE + 1}
    `, ...params)];
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return json({
      rooms: page.map(rowToProjection),
      nextCursor: hasMore ? encodeCursor(last.updated_at, last.room_id) : null,
      serverTime: now,
    });
  }
}
