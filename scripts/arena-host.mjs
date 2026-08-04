#!/usr/bin/env node
// Chess Arena — terminal host.
//
// Runs the arena's Stockfish engine against a battle room (gist) from the
// command line, so the arena side plays even without an open browser tab.
//
// Usage:
//   node scripts/arena-host.mjs <gistId> <token> <w|b> [movetimeMs]
//
// The token needs `gist` scope. Polls every 2.5s; whenever it is the arena
// side's turn it computes a move with Stockfish and writes it to the room
// (read-modify-write with CAS on the move list length, like agent-client).

import { Chess } from 'chess.js';

const [gistId, token, side, rawMs] = process.argv.slice(2);
const MOVETIME = Number(rawMs ?? 1200);
const POLL_MS = 2500;
const API = 'https://api.github.com';

if (!gistId || !token || !['w', 'b'].includes(side ?? '')) {
  console.error('usage: node scripts/arena-host.mjs <gistId> <token> <w|b> [movetimeMs]');
  process.exit(4);
}

// The Emscripten engine glue replaces globalThis.fetch when loaded in-process,
// so capture the real fetch first and never rely on the global afterwards.
const gFetch = globalThis.fetch.bind(globalThis);
const initEngine = (await import('stockfish')).default;

async function readState() {
  const res = await gFetch(`${API}/gists/${gistId}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`read gist failed (HTTP ${res.status})`);
  const gist = await res.json();
  let file = gist.files?.['state.json'];
  if (!file) {
    const jsonFiles = Object.values(gist.files ?? {}).filter((f) => f?.filename?.endsWith('.json'));
    if (jsonFiles.length === 1) file = jsonFiles[0];
  }
  if (!file) throw new Error('room has no state.json');
  return JSON.parse(file.content);
}

async function writeState(state) {
  const res = await gFetch(`${API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({ files: { 'state.json': { content: JSON.stringify(state, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`write gist failed (HTTP ${res.status})`);
}

function replay(moves) {
  const game = new Chess();
  for (const uci of moves) {
    const m = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!m) throw new Error(`history replay failed at ${uci}`);
  }
  return game;
}

function computeMove(fen, movetime) {
  return new Promise((resolve, reject) => {
    // The Node build of the engine prints its UCI output straight to stdout
    // (engine.onmessage is never called), so tap process.stdout.write: pass
    // output through and scan the stream for "bestmove".
    const origWrite = process.stdout.write.bind(process.stdout);
    let buf = '';
    let best = null;
    const capture = (chunk, ...rest) => {
      const s = String(chunk);
      origWrite(s, ...rest);
      buf += s;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('bestmove ')) {
          best = line.split(' ')[1];
        }
      }
      return true;
    };
    process.stdout.write = capture;
    const timer = setTimeout(() => {
      process.stdout.write = origWrite;
      reject(new Error('engine timeout'));
    }, movetime + 15000);
    const poll = setInterval(() => {
      if (best !== null) {
        clearTimeout(timer);
        clearInterval(poll);
        process.stdout.write = origWrite;
        resolve(best === '(none)' ? null : best);
      }
    }, 50);
    engine.sendCommand('position fen ' + fen);
    engine.sendCommand('go movetime ' + movetime);
  });
}

async function playTurn() {
  const state = await readState();
  if (state.status !== 'active') {
    console.log(`[host] room ${state.status} (result ${state.result ?? '-'}) — exiting`);
    return { done: true };
  }
  if (state.turn !== side) return { done: false };

  const game = replay(state.moves ?? []);
  const uci = await computeMove(game.fen(), MOVETIME);
  if (!uci) {
    console.log('[host] engine found no move');
    return { done: false };
  }

  // CAS: re-read and refuse if the opponent moved while we were thinking.
  const fresh = await readState();
  if ((fresh.moves ?? []).length !== (state.moves ?? []).length) {
    console.log('[host] room changed while thinking — re-syncing, no move sent');
    return { done: false };
  }

  const game2 = replay(fresh.moves ?? []);
  const applied = game2.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (!applied) {
    console.log(`[host] illegal move from engine: ${uci}`);
    return { done: false };
  }
  const over = game2.isGameOver();
  const result = over
    ? game2.isCheckmate()
      ? game2.turn() === 'w'
        ? '0-1'
        : '1-0'
      : '1/2-1/2'
    : fresh.result;

  await writeState({
    ...fresh,
    fen: game2.fen(),
    turn: game2.turn(),
    lastMove: uci,
    lastMoveSan: applied.san,
    moves: [...(fresh.moves ?? []), uci],
    status: over ? 'finished' : 'active',
    result,
    updatedAt: new Date().toISOString(),
  });
  console.log(`[host] played ${applied.san} (${uci}) — turn now ${game2.turn()}`);
  return { done: over };
}

console.log(`[host] arena engine (white=${side === 'w'}) on room ${gistId}, movetime ${MOVETIME}ms`);
const engine = await initEngine('lite-single');
console.log('[host] engine ready');

let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
  console.log('[host] stopping…');
  process.exit(0);
});

for (;;) {
  try {
    const out = await playTurn();
    if (out.done) break;
  } catch (err) {
    console.error(`[host] ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
console.log('[host] done');
process.exit(0);
