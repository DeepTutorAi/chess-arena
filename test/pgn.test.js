// PGN / FEN / share-link import and export: valid games survive a round trip,
// hostile or broken input becomes a clear error and never reaches the analyzer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';

import {
  ImportError,
  MAX_PLIES,
  START_FEN,
  classifyImportText,
  cleanName,
  decodeShareToken,
  encodeShareToken,
  parseFen,
  parseImport,
  parsePgn,
  recordToPgn,
  shareTokenFromHash,
  splitPgnGames,
} from '../src/pgn.js';

function recordFrom(sans, extra = {}) {
  const game = new Chess(extra.initialFen ?? START_FEN);
  const moves = sans.map((san) => {
    const m = game.move(san);
    return { san: m.san, from: m.from, to: m.to, promotion: m.promotion || undefined };
  });
  return {
    initialFen: START_FEN,
    moves,
    result: '1-0',
    reason: 'checkmate',
    players: { white: { name: 'Alice' }, black: { name: 'Bob' } },
    gamemode: 'hva',
    times: [],
    ...extra,
  };
}

const SCHOLARS = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];

// ---- export ------------------------------------------------------------------------

test('recordToPgn writes the seven-tag roster, numbered moves and the result', () => {
  const pgn = recordToPgn(recordFrom(SCHOLARS), { date: new Date(2026, 8, 28) });
  assert.match(pgn, /^\[Event "Chess Arena"\]\n\[Site "Chess Arena"\]\n\[Date "2026\.09\.28"\]\n\[Round "-"\]\n\[White "Alice"\]\n\[Black "Bob"\]\n\[Result "1-0"\]/u);
  assert.match(pgn, /\[Termination "normal"\]/u);
  assert.match(pgn, /1\. e4 e5 2\. Qh5 Nc6 3\. Bc4 Nf6 4\. Qxf7# 1-0\n$/u);
  assert.equal(pgn.includes('SetUp'), false, 'a standard start has no FEN tag');
});

test('the Date tag is the day it was played; an unknown day is written the PGN way, never as today', () => {
  const played = new Date(2026, 2, 7, 15, 30).getTime();
  assert.match(recordToPgn(recordFrom(['e4'], { playedAt: played, result: '*' })), /\[Date "2026\.03\.07"\]/u);
  assert.match(recordToPgn(recordFrom(['e4'], { result: '*' })), /\[Date "\?\?\?\?\.\?\?\.\?\?"\]/u);
  assert.match(recordToPgn(recordFrom(['e4'], { result: '*' }), { date: new Date(2020, 0, 2) }), /\[Date "2020\.01\.02"\]/u);
});

test('the Date tag comes back as playedAt on import (and "????.??.??" as unknown)', () => {
  const dated = parsePgn('[Date "2026.03.07"]\n\n1. e4 e5 *').record;
  const day = new Date(dated.playedAt);
  assert.deepEqual([day.getFullYear(), day.getMonth() + 1, day.getDate()], [2026, 3, 7]);
  assert.equal(parsePgn('[Date "????.??.??"]\n\n1. e4 e5 *').record.playedAt, null);
  assert.equal(parsePgn('[Date "2026.13.45"]\n\n1. e4 e5 *').record.playedAt, null, 'an impossible date is dropped');
  // export -> import keeps the day
  const again = parsePgn(recordToPgn(recordFrom(['e4', 'e5'], { playedAt: new Date(2026, 2, 7).getTime(), result: '*' }))).record;
  assert.equal(new Date(again.playedAt).getDate(), 7);
});

test('the result comes from the closing token or the final position when the tag is missing or "*"', () => {
  assert.equal(parsePgn('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0').record.result, '1-0');
  assert.equal(parsePgn('[Result "*"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0').record.result, '1-0');
  assert.equal(parsePgn('1. e4 e5 {a comment 1-0 inside} *').record.result, '*', 'a result mentioned in a comment is not the result');
  assert.equal(parsePgn('1. e4 e5 2. Nf3 Nc6 1/2-1/2').record.result, '1/2-1/2');
  assert.equal(parsePgn('1. f3 e5 2. g4 Qh4#').record.result, '0-1', 'a mate with no token at all');
  assert.equal(parsePgn('[Result "0-1"]\n\n1. e4 e5 0-1').record.result, '0-1', 'a tag that agrees with the movetext');
  assert.equal(parsePgn('[Result "0-1"]\n\n1. e4 e5 1-0').record.result, '1-0', 'when they disagree the movetext token (what the game ended with) wins');
});

test('a timeout is reported as a time forfeit and the time control is written', () => {
  const pgn = recordToPgn(recordFrom(['e4', 'e5'], {
    result: '0-1', reason: 'timeout', timeControl: { initialMs: 300000, incMs: 2000 },
  }));
  assert.match(pgn, /\[TimeControl "300\+2"\]/u);
  assert.match(pgn, /\[Termination "time forfeit"\]/u);
  assert.match(recordToPgn(recordFrom(['e4'], { result: '*', reason: '' })), /\[Termination "unterminated"\]/u);
});

test('a custom start position gets SetUp/FEN tags and black-first numbering', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const record = recordFrom(['e5', 'Nf3'], { initialFen: fen, result: '*', reason: '' });
  const pgn = recordToPgn(record);
  assert.match(pgn, /\[SetUp "1"\]\n\[FEN "rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b KQkq e3 0 1"\]/u);
  assert.match(pgn, /1\.\.\. e5 2\. Nf3 \*/u);
});

test('clock comments follow each move from the mover\'s clock', () => {
  const record = recordFrom(['e4', 'e5', 'Nf3'], {
    times: [{ ply: 1, w: 298_000, b: 300_000 }, { ply: 2, w: 298_000, b: 297_500 }, { ply: 3, w: 8_400, b: 297_500 }],
  });
  const pgn = recordToPgn(record);
  assert.match(pgn, /1\. e4 \{ \[%clk 0:04:58\] \} e5 \{ \[%clk 0:04:57\] \} 2\. Nf3 \{ \[%clk 0:00:08\.4\] \}/u);
});

test('quotes and newlines in names cannot break the header', () => {
  const pgn = recordToPgn(recordFrom(['e4'], { players: { white: { name: 'A"li\nce' }, black: { name: 'Bob' } }, result: '*' }));
  const white = pgn.split('\n').find((l) => l.startsWith('[White '));
  assert.equal(white, '[White "A\\"li ce"]');
});

test('an illegal move in the record is an error, not a corrupt PGN', () => {
  const record = recordFrom(['e4']);
  record.moves.push({ from: 'a1', to: 'a5' });
  assert.throws(() => recordToPgn(record), ImportError);
});

// ---- import ------------------------------------------------------------------------

test('export then import gives the same game back', () => {
  const original = recordFrom(SCHOLARS, {
    times: SCHOLARS.map((_, i) => ({ ply: i + 1, w: 300_000 - i * 1000, b: 300_000 - i * 1000 })),
    timeControl: { initialMs: 300000, incMs: 0 },
  });
  const { record, gameCount } = parsePgn(recordToPgn(original));
  assert.equal(gameCount, 1);
  assert.deepEqual(record.moves.map((m) => m.san), SCHOLARS);
  assert.deepEqual(record.moves.map((m) => `${m.from}${m.to}`), original.moves.map((m) => `${m.from}${m.to}`));
  assert.equal(record.result, '1-0');
  assert.equal(record.players.white.name, 'Alice');
  assert.equal(record.players.black.name, 'Bob');
  assert.equal(record.initialFen, START_FEN);
  assert.equal(record.gamemode, 'imported');
  assert.equal(record.times.length, 7, 'a clock comment on every move is kept');
  assert.equal(record.times[0].w, 300_000 - 0, 'white\'s first clock');
  assert.deepEqual(record.timeControl, { initialMs: 300000, incMs: 0 });
});

test('comments, variations and NAGs from other programs are tolerated', () => {
  const pgn = `[Event "Casual"]
[White "Alice"]
[Black "Bob"]
[Result "1/2-1/2"]

1. e4 {best by test} e5 $1 2. Nf3 (2. f4 exf4) 2... Nc6 3. Bb5 a6 1/2-1/2`;
  const { record } = parsePgn(pgn);
  assert.deepEqual(record.moves.map((m) => m.san), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
  assert.equal(record.result, '1/2-1/2');
  assert.deepEqual(record.times, [], 'no clock data');
});

test('a bare movetext without headers is accepted', () => {
  const { record } = parsePgn('1. d4 d5 2. c4 e6 *');
  assert.equal(record.moves.length, 4);
  assert.equal(record.players.white.name, 'ขาว');
  assert.equal(record.result, '*');
});

test('a FEN-start PGN keeps its start position', () => {
  const { record } = parsePgn('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n\n1. e4 Kd7 *');
  assert.equal(record.initialFen, '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  assert.equal(record.moves.length, 2);
});

test('only the first game of a multi-game file is used and the count is reported', () => {
  const two = `[Event "One"]\n[Result "*"]\n\n1. e4 e5 *\n\n[Event "Two"]\n[Result "*"]\n\n1. d4 d5 *\n`;
  assert.equal(splitPgnGames(two).length, 2);
  const { record, gameCount } = parsePgn(two);
  assert.equal(gameCount, 2);
  assert.equal(record.moves[0].san, 'e4');
});

test('broken input gives a message a person can act on', () => {
  assert.throws(() => parsePgn('1. e4 e5 2. Ke2 Ke7 3. Kd3 Ng8 *'), (e) => e instanceof ImportError && /Ng8/.test(e.message));
  assert.throws(() => parsePgn(''), /ยังไม่ได้วาง/u);
  assert.throws(() => parsePgn('[Event "x"]\n\n*'), /ยังไม่มีตาเดิน/u);
  assert.throws(() => parsePgn('x'.repeat(200_001)), /ใหญ่เกินไป/u);
});

test('a game over the ply limit is refused', () => {
  // Shuffle knights: 2 * 305 plies of legal moves.
  const game = new Chess();
  const cycle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
  const sans = [];
  for (let i = 0; i < MAX_PLIES + 4; i++) { sans.push(cycle[i % 4]); }
  const numbered = sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
  void game;
  assert.throws(() => parsePgn(`${numbered} *`), /ยาวเกินไป/u);
});

test('names are cleaned: control characters removed, length capped, placeholders replaced', () => {
  assert.equal(cleanName('  Al\u0000i\u0007ce\n Smith ', 'x'), 'Alice Smith');
  assert.equal(cleanName('?', 'ขาว'), 'ขาว');
  assert.equal(cleanName('', 'ดำ'), 'ดำ');
  assert.equal(cleanName('a'.repeat(100), 'x').length, 40);
  const { record } = parsePgn('[White "<img src=x onerror=alert(1)>"]\n[Black "?"]\n\n1. e4 e5 *');
  assert.equal(record.players.white.name, '<img src=x onerror=alert(1)>', 'kept as plain text — the UI escapes it');
  assert.equal(record.players.black.name, 'ดำ');
});

// ---- FEN ----------------------------------------------------------------------------

test('classifyImportText tells a FEN from a PGN from noise', () => {
  assert.equal(classifyImportText(START_FEN), 'fen');
  assert.equal(classifyImportText('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'), 'fen');
  assert.equal(classifyImportText('[Event "x"]\n\n1. e4 e5'), 'pgn');
  assert.equal(classifyImportText('1. e4 e5 2. Nf3'), 'pgn');
  assert.equal(classifyImportText('hello world'), 'unknown');
  assert.equal(classifyImportText('   \n '), 'empty');
  assert.equal(classifyImportText(null), 'empty');
});

test('parseFen accepts the short form, normalises, and explains what is wrong', () => {
  assert.equal(parseFen('4k3/8/8/8/8/8/4P3/4K3 w - -'), '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  assert.equal(parseFen(`  ${START_FEN}  `), START_FEN);
  assert.throws(() => parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'), /FEN ไม่ถูกต้อง/u);
  assert.throws(() => parseFen('8/8/8/8/8/8/8/8 w - - 0 1'), /FEN ไม่ถูกต้อง/u, 'no kings');
  assert.throws(() => parseFen(''), /ยังไม่ได้วาง/u);
});

test('parseImport routes to the right parser and rejects everything else', () => {
  assert.equal(parseImport(START_FEN).kind, 'fen');
  const pgn = parseImport('1. e4 e5 *');
  assert.equal(pgn.kind, 'pgn');
  assert.equal(pgn.record.moves.length, 2);
  assert.throws(() => parseImport('what is this'), /ไม่รู้จักรูปแบบ/u);
  assert.throws(() => parseImport('   '), /ยังไม่ได้วาง/u);
});

// ---- share tokens --------------------------------------------------------------------

test('a share token round-trips the game (names, result, moves) and stays short', async () => {
  const original = recordFrom(SCHOLARS);
  const token = await encodeShareToken(original);
  assert.match(token, /^d\.[A-Za-z0-9_-]+$/u);
  assert.ok(token.length < 200, `${token.length} chars`);
  const record = await decodeShareToken(token);
  assert.deepEqual(record.moves.map((m) => m.san), SCHOLARS);
  assert.equal(record.result, '1-0');
  assert.equal(record.players.white.name, 'Alice');
  assert.equal(record.gamemode, 'imported');
});

test('a game from a custom position keeps its start', async () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const record = await decodeShareToken(await encodeShareToken(recordFrom(['e5', 'Nf3'], { initialFen: fen, result: '*' })));
  assert.equal(record.initialFen, fen);
  assert.deepEqual(record.moves.map((m) => m.san), ['e5', 'Nf3']);
});

test('without CompressionStream the token falls back to plain base64 and still decodes', async () => {
  const saved = { c: globalThis.CompressionStream, d: globalThis.DecompressionStream };
  try {
    delete globalThis.CompressionStream;
    delete globalThis.DecompressionStream;
    const token = await encodeShareToken(recordFrom(SCHOLARS));
    assert.match(token, /^u\./u);
    assert.deepEqual((await decodeShareToken(token)).moves.map((m) => m.san), SCHOLARS);
  } finally {
    globalThis.CompressionStream = saved.c;
    globalThis.DecompressionStream = saved.d;
  }
});

test('tampered, truncated and oversized tokens are refused with an ImportError', async () => {
  const good = await encodeShareToken(recordFrom(SCHOLARS));
  for (const bad of ['', 'garbage', 'd.', 'd.!!!', `${good.slice(0, 20)}`, 'x.abcd', `d.${'A'.repeat(13_000)}`, null]) {
    await assert.rejects(decodeShareToken(bad), ImportError, String(bad).slice(0, 30));
  }
  const flipped = `${good.slice(0, 10)}${good[10] === 'A' ? 'B' : 'A'}${good.slice(11)}`;
  await assert.rejects(decodeShareToken(flipped), ImportError);
});

test('a game that could never be opened from a link is refused when the link is made', async () => {
  const shuffle = Array.from({ length: MAX_PLIES + 2 }, (_, i) => ['g1f3', 'g8f6', 'f3g1', 'f6g8'][i % 4])
    .map((uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) }));
  await assert.rejects(encodeShareToken({ initialFen: null, moves: shuffle, players: {} }), /ยาวเกิน/u);
});

test('a token that decodes to an illegal game is refused move by move', async () => {
  const forge = async (payload) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return `u.${Buffer.from(bytes).toString('base64url')}`;
  };
  await assert.rejects(decodeShareToken(await forge({ v: 1, m: 'e2e4 e2e4', r: '*' })), /ผิดกติกา/u);
  await assert.rejects(decodeShareToken(await forge({ v: 1, m: 'e2e4 zz', r: '*' })), /ไม่ถูกต้อง/u);
  await assert.rejects(decodeShareToken(await forge({ v: 2, m: 'e2e4' })), /เวอร์ชัน/u);
  await assert.rejects(decodeShareToken(await forge({ v: 1, m: '' })), /ไม่มีตาเดิน/u);
  await assert.rejects(decodeShareToken(await forge({ v: 1, m: Array(MAX_PLIES + 1).fill('g1f3').join(' ') })), ImportError);
  // a bad FEN falls back to the standard start rather than trusting it
  const record = await decodeShareToken(await forge({ v: 1, f: 'not a fen', m: 'e2e4', r: '9-9', w: '<b>x</b>' }));
  assert.equal(record.initialFen, START_FEN);
  assert.equal(record.result, '*');
  assert.equal(record.players.white.name, '<b>x</b>');
});

test('a decompression bomb is cut off', async () => {
  const huge = new TextEncoder().encode(JSON.stringify({ v: 1, m: 'e2e4', pad: 'a'.repeat(5_000_000) }));
  const packed = new Uint8Array(await new Response(new Blob([huge]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const token = `d.${Buffer.from(packed).toString('base64url')}`;
  assert.ok(token.length < 12_000, `the bomb is small on the wire (${token.length})`);
  await assert.rejects(decodeShareToken(token), /ใหญ่ผิดปกติ/u);
});

test('shareTokenFromHash only accepts #g=<token>', () => {
  assert.equal(shareTokenFromHash('#g=d.abc_-'), 'd.abc_-');
  assert.equal(shareTokenFromHash('g=u.xyz'), 'u.xyz');
  assert.equal(shareTokenFromHash('#room=abc'), null);
  assert.equal(shareTokenFromHash('#g='), null);
  assert.equal(shareTokenFromHash('#g=<script>'), null);
  assert.equal(shareTokenFromHash(''), null);
  assert.equal(shareTokenFromHash(undefined), null);
});
