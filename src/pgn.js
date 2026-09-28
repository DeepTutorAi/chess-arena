// Game import / export (roadmap B6): PGN out, PGN or FEN in, and a compact share
// token that fits in a URL. Pure functions over chess.js; everything that comes
// from outside (a pasted file, a link) is validated move by move and size-limited
// before it reaches the analyzer or the UI.

import { Chess, validateFen } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const MAX_PGN_CHARS = 200_000;
export const MAX_PLIES = 600;
export const MAX_NAME_CHARS = 40;
export const MAX_SHARE_TOKEN_CHARS = 12_000;
const MAX_SHARE_JSON_CHARS = 60_000;

export class ImportError extends Error {}

const isStandardStart = (fen) => !fen || fen.split(' ').slice(0, 4).join(' ') === START_FEN.split(' ').slice(0, 4).join(' ');

/** A display name from untrusted text: no control characters, bounded length. */
export function cleanName(value, fallback) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') // control characters vanish
    .replace(/\s+/g, ' ')                                                // newlines / tabs become a space
    .trim();
  if (!text || text === '?' || text === '-') return fallback;
  return text.length > MAX_NAME_CHARS ? `${text.slice(0, MAX_NAME_CHARS - 1)}…` : text;
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const cleanResult = (value) => (RESULTS.has(value) ? value : '*');

// ---------------------------------------------------------------- export

const pad = (n) => String(n).padStart(2, '0');

function clockText(ms) {
  const total = Math.max(0, ms) / 1000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const secondsText = total < 10 ? seconds.toFixed(1).padStart(4, '0') : pad(Math.floor(seconds));
  return `${hours}:${pad(minutes)}:${secondsText}`;
}

const escapeTag = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');

/**
 * Movetext + headers for a finished game.
 * @param {object} record  the app's game record (see controller._captureGameRecord)
 * @param {object} [opts]
 * @param {Date} [opts.date]
 */
export function recordToPgn(record, { date = new Date() } = {}) {
  const startFen = record.initialFen || START_FEN;
  const game = new Chess(startFen);
  const sans = [];
  for (const mv of record.moves ?? []) {
    let move = null;
    try {
      move = game.move({ from: mv.from, to: mv.to, promotion: mv.promotion || undefined });
    } catch {
      move = null; // chess.js throws on an illegal move
    }
    if (!move) throw new ImportError(`เดินผิดกติกา: ${mv.from}${mv.to}`);
    sans.push(move.san);
  }
  const result = cleanResult(record.result);
  const termination = record.reason === 'timeout' ? 'time forfeit'
    : record.reason === 'abandoned' ? 'abandoned'
      : result === '*' ? 'unterminated' : 'normal';

  const tags = [
    ['Event', 'Chess Arena'],
    ['Site', 'Chess Arena'],
    ['Date', `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`],
    ['Round', '-'],
    ['White', cleanName(record.players?.white?.name, 'White')],
    ['Black', cleanName(record.players?.black?.name, 'Black')],
    ['Result', result],
  ];
  if (record.timeControl && record.timeControl.initialMs > 0) {
    tags.push(['TimeControl', `${Math.round(record.timeControl.initialMs / 1000)}${record.timeControl.incMs ? `+${Math.round(record.timeControl.incMs / 1000)}` : ''}`]);
  }
  if (!isStandardStart(startFen)) tags.push(['SetUp', '1'], ['FEN', startFen]);
  tags.push(['Termination', termination]);

  // Remaining clock of the side that just moved, when the game recorded it.
  const clockAfter = new Map();
  for (const snap of record.times ?? []) clockAfter.set(snap.ply, snap);
  const firstMoveNumber = Number(startFen.split(' ')[5]) || 1;
  const blackFirst = startFen.split(' ')[1] === 'b';
  const parts = [];
  sans.forEach((san, i) => {
    const whiteMoves = blackFirst ? i % 2 === 1 : i % 2 === 0;
    const moveNumber = firstMoveNumber + Math.floor((i + (blackFirst ? 1 : 0)) / 2);
    if (whiteMoves) parts.push(`${moveNumber}. ${san}`);
    else parts.push(i === 0 ? `${moveNumber}... ${san}` : san);
    const snap = clockAfter.get(i + 1);
    const left = snap ? (whiteMoves ? snap.w : snap.b) : null;
    if (Number.isFinite(left)) parts.push(`{ [%clk ${clockText(left)}] }`);
  });
  parts.push(result);

  const header = tags.map(([k, v]) => `[${k} "${escapeTag(v)}"]`).join('\n');
  return `${header}\n\n${wrap(parts.join(' '))}\n`;
}

function wrap(text, width = 80) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// ---------------------------------------------------------------- import

/** Games in a multi-game PGN file, each still as text. */
export function splitPgnGames(text) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const games = normalized.split(/\n\s*\n(?=\[Event\s)/).map((g) => g.trim()).filter(Boolean);
  return games.length ? games : [normalized];
}

/** What kind of text was pasted: a PGN, a FEN, or something else. */
export function classifyImportText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'empty';
  const oneLine = trimmed.replace(/\s+/g, ' ');
  if (!trimmed.includes('\n') && /^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7} [wb] /.test(oneLine)) return 'fen';
  if (/^\[[A-Za-z]+\s+"/m.test(trimmed) || /(^|\s)1\.\s*[a-hNBRQKO]/.test(oneLine)) return 'pgn';
  if (/^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7}(\s|$)/.test(oneLine)) return 'fen';
  return 'unknown';
}

/**
 * Parse the first game of a PGN into an app game record.
 * @returns {{ record: object, gameCount: number }}
 * @throws {ImportError} with a message fit to show the user
 */
export function parsePgn(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ImportError('ยังไม่ได้วาง PGN');
  if (text.length > MAX_PGN_CHARS) throw new ImportError('ไฟล์ PGN ใหญ่เกินไป (สูงสุด 200,000 ตัวอักษร)');
  const games = splitPgnGames(text);
  const game = new Chess();
  try {
    game.loadPgn(games[0]);
  } catch (error) {
    const detail = String(error?.message ?? error).replace(/^Invalid move in PGN:\s*/u, '');
    throw new ImportError(`อ่าน PGN ไม่ได้: ตา "${detail}" ผิดกติกาหรือรูปแบบไม่ถูกต้อง`);
  }
  const verbose = game.history({ verbose: true });
  if (!verbose.length) throw new ImportError('PGN นี้ยังไม่มีตาเดินให้วิเคราะห์');
  if (verbose.length > MAX_PLIES) throw new ImportError(`เกมยาวเกินไป (สูงสุด ${MAX_PLIES} ตา)`);

  const headers = Object.fromEntries(Object.entries(game.getHeaders()).filter(([, v]) => v !== null && v !== undefined));
  const initialFen = headers.FEN && validateFen(headers.FEN).ok ? headers.FEN : START_FEN;

  // Clock comments, when there is exactly one per move.
  const clocks = [...games[0].matchAll(/\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/g)]
    .map((m) => (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);

  const times = clocks.length === verbose.length ? buildTimes(verbose, clocks, headers.TimeControl) : [];
  const record = {
    initialFen,
    moves: verbose.map((m) => ({ san: m.san, from: m.from, to: m.to, promotion: m.promotion || undefined })),
    result: cleanResult(headers.Result),
    reason: /time forfeit/i.test(headers.Termination ?? '') ? 'timeout' : '',
    players: {
      white: { name: cleanName(headers.White, 'ขาว') },
      black: { name: cleanName(headers.Black, 'ดำ') },
    },
    gamemode: 'imported',
    times,
    initial: null,
    timeControl: parseTimeControl(headers.TimeControl),
  };
  return { record, gameCount: games.length };
}

function parseTimeControl(value) {
  const match = /^(\d+)(?:\+(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { initialMs: Number(match[1]) * 1000, incMs: Number(match[2] ?? 0) * 1000 };
}

/** Per-ply clock snapshots ({ply, w, b}) from the mover's clock after each move. */
function buildTimes(verbose, clocks, timeControl) {
  const tc = parseTimeControl(timeControl);
  const last = { w: tc?.initialMs ?? clocks[0] ?? 0, b: tc?.initialMs ?? clocks[1] ?? 0 };
  return verbose.map((move, i) => {
    last[move.color] = clocks[i];
    return { ply: i + 1, w: last.w, b: last.b };
  });
}

/** Validate a FEN for the analysis board. @throws {ImportError} */
export function parseFen(text) {
  const fen = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!fen) throw new ImportError('ยังไม่ได้วาง FEN');
  // Accept the short four-field form people often paste.
  const full = fen.split(' ').length === 4 ? `${fen} 0 1` : fen;
  const check = validateFen(full);
  if (!check.ok) throw new ImportError(`FEN ไม่ถูกต้อง: ${check.error}`);
  try {
    return new Chess(full).fen();
  } catch (error) {
    throw new ImportError(`FEN ไม่ถูกต้อง: ${error.message}`);
  }
}

/** Import whatever was pasted: `{ kind: 'pgn', record, gameCount }` or `{ kind: 'fen', fen }`. */
export function parseImport(text) {
  const kind = classifyImportText(text);
  if (kind === 'empty') throw new ImportError('ยังไม่ได้วางข้อความ');
  if (kind === 'fen') return { kind: 'fen', fen: parseFen(text) };
  if (kind === 'pgn') return { kind: 'pgn', ...parsePgn(text) };
  throw new ImportError('ไม่รู้จักรูปแบบ — วาง PGN ของเกม หรือ FEN ของตำแหน่ง');
}

// ---------------------------------------------------------------- share link

const toBase64Url = (bytes) => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const fromBase64Url = (text) => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ImportError('ลิงก์แชร์ไม่ถูกต้อง');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

async function pipeBytes(bytes, transform, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new ImportError('ลิงก์แชร์ใหญ่ผิดปกติ');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** The game as a URL-safe token (moves as UCI, names, result — nothing else). */
export async function encodeShareToken(record) {
  const startFen = record.initialFen || START_FEN;
  const payload = {
    v: 1,
    m: (record.moves ?? []).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).join(' '),
    r: cleanResult(record.result),
    w: cleanName(record.players?.white?.name, ''),
    b: cleanName(record.players?.black?.name, ''),
  };
  if (!isStandardStart(startFen)) payload.f = startFen;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (canCompress()) {
    const packed = await pipeBytes(bytes, new CompressionStream('deflate-raw'), MAX_SHARE_JSON_CHARS);
    return `d.${toBase64Url(packed)}`;
  }
  return `u.${toBase64Url(bytes)}`;
}

/** Inverse of encodeShareToken; the moves are replayed so a forged token cannot
 *  smuggle an illegal game into the analyzer. @throws {ImportError} */
export async function decodeShareToken(token) {
  const text = String(token ?? '').trim();
  if (!text || text.length > MAX_SHARE_TOKEN_CHARS) throw new ImportError('ลิงก์แชร์ไม่ถูกต้องหรือยาวเกินไป');
  const kind = text.slice(0, 2);
  let json;
  try {
    const bytes = fromBase64Url(text.slice(2));
    if (kind === 'd.') {
      if (!canCompress()) throw new ImportError('เบราว์เซอร์นี้เปิดลิงก์แชร์แบบบีบอัดไม่ได้');
      json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw'), MAX_SHARE_JSON_CHARS));
    } else if (kind === 'u.') {
      if (bytes.length > MAX_SHARE_JSON_CHARS) throw new ImportError('ลิงก์แชร์ใหญ่ผิดปกติ');
      json = new TextDecoder().decode(bytes);
    } else {
      throw new ImportError('ลิงก์แชร์ไม่ถูกต้อง');
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('ลิงก์แชร์เสียหายหรืออ่านไม่ได้');
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ImportError('ลิงก์แชร์เสียหายหรืออ่านไม่ได้');
  }
  if (!data || data.v !== 1 || typeof data.m !== 'string') throw new ImportError('ลิงก์แชร์เป็นเวอร์ชันที่ไม่รู้จัก');
  const startFen = typeof data.f === 'string' && validateFen(data.f).ok ? data.f : START_FEN;
  const uciMoves = data.m.split(' ').filter(Boolean);
  if (!uciMoves.length) throw new ImportError('ลิงก์นี้ไม่มีตาเดิน');
  if (uciMoves.length > MAX_PLIES) throw new ImportError(`เกมยาวเกินไป (สูงสุด ${MAX_PLIES} ตา)`);
  const game = new Chess(startFen);
  const moves = [];
  for (const uci of uciMoves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new ImportError('ลิงก์แชร์มีตาเดินที่ไม่ถูกต้อง');
    let move = null;
    try {
      move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      move = null;
    }
    if (!move) throw new ImportError(`ลิงก์แชร์มีตาเดินผิดกติกา: ${uci}`);
    moves.push({ san: move.san, from: move.from, to: move.to, promotion: move.promotion || undefined });
  }
  return {
    initialFen: startFen,
    moves,
    result: cleanResult(data.r),
    reason: '',
    players: { white: { name: cleanName(data.w, 'ขาว') }, black: { name: cleanName(data.b, 'ดำ') } },
    gamemode: 'imported',
    times: [],
    initial: null,
    timeControl: null,
  };
}

/** `…#g=<token>` → token, or null when the hash is not a share link. */
export function shareTokenFromHash(hash) {
  const match = /^#?g=([A-Za-z0-9._-]+)$/.exec(String(hash ?? ''));
  return match ? match[1] : null;
}
