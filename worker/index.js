import { Chess } from 'chess.js';

import { createGameState } from './game-state.js';
import { parseCreateRequest, parseJoinRequest, TIME_CONTROLS } from './protocol.js';
export { ChessRoom } from './room.js';

const MAX_BODY_BYTES = 8_192;
const ROOM_TTL_MS = 24 * 60 * 60 * 1_000;
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_PATTERN = /^[a-z2-7]{16}$/u;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function roomId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let buffer = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Sec-WebSocket-Protocol',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(value, status, origin) {
  return Response.json(value, { status, headers: corsHeaders(origin) });
}

async function readJson(request, origin) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return { response: json({ error: 'content_type_required' }, 415, origin) };
  }
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { response: json({ error: 'body_too_large' }, 413, origin) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { response: json({ error: 'body_too_large' }, 413, origin) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { response: json({ error: 'invalid_json' }, 400, origin) };
  }
}

function withCors(response, origin) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(origin))) next.headers.set(key, value);
  return next;
}

function roomStub(env, id) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const requestOrigin = new URL(request.url).origin;
    if (origin !== requestOrigin && !allowedOrigins(env).includes(origin)) {
      return json({ error: 'origin_forbidden' }, 403, origin || 'null');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(request, origin);
      if (body.response) return body.response;
      const parsed = parseCreateRequest(body.value);
      if (!parsed.ok) return json({ error: parsed.code, message: parsed.message }, 400, origin);

      const id = roomId();
      const now = Date.now();
      const hostColor = parsed.value.color === 'random'
        ? (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 'w' : 'b')
        : parsed.value.color;
      const initialFen = parsed.value.initialFen ?? STANDARD_FEN;
      try {
        new Chess(initialFen);
      } catch {
        return json({ error: 'invalid_initial_position' }, 400, origin);
      }

      const stateInput = {
        roomId: id,
        title: parsed.value.title,
        hostName: parsed.value.playerName,
        hostColor,
        initialFen,
        timeControl: TIME_CONTROLS[parsed.value.timeControlId],
        expiresAt: now + ROOM_TTL_MS,
        now,
      };
      // Exercise domain construction before crossing the Durable Object boundary.
      createGameState(stateInput, now);
      const response = await roomStub(env, id).fetch('http://room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stateInput),
      });
      return withCors(response, origin);
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([a-z2-7]{16})\/join$/u);
    if (request.method === 'POST' && joinMatch) {
      const body = await readJson(request, origin);
      if (body.response) return body.response;
      const parsed = parseJoinRequest(body.value);
      if (!parsed.ok) return json({ error: parsed.code, message: parsed.message }, 400, origin);
      const response = await roomStub(env, joinMatch[1]).fetch('http://room/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...parsed.value, now: Date.now() }),
      });
      return withCors(response, origin);
    }

    const socketMatch = url.pathname.match(/^\/api\/rooms\/([a-z2-7]{16})\/socket$/u);
    if (request.method === 'GET' && socketMatch && ROOM_PATTERN.test(socketMatch[1])) {
      return roomStub(env, socketMatch[1]).fetch(new Request('http://room/socket', request));
    }

    return json({ error: 'not_found' }, 404, origin);
  },
};
