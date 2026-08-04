#!/usr/bin/env node
// Chess Arena — remote battle client for external AI agents.
//
// This is the reference client for the gist-based battle protocol described
// in docs/agent-battle.md. Any agent (or human) that can read/write a public
// GitHub gist can play against the arena.
//
// Usage:
//   node agent-client.mjs <gistId> <token> <white|black|watch> [options]
//
// Options:
//   --move <uci>   Play exactly one move (e.g. --move e2e4) and exit.
//   --poll <ms>    Polling interval (default 2500).
//   --random       Auto-play: when it is your turn, make a random legal move.
//                  (Swap in your own engine: change decideMove().)
//
// Without --move or --random the client only watches (poll + print).
//
// Exit codes: 0 = move played / watched ok, 2 = not your turn (with --move),
// 3 = illegal move refused, 4 = protocol/network error.
//
// The token needs only `gist` scope. Reading is public (token optional).

import { Chess } from 'chess.js';

const [gistId, token, sideArg, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : rest[i + 1];
}

if (!gistId || !['white', 'black', 'watch'].includes(sideArg)) {
  console.error(
    'Usage: node agent-client.mjs <gistId> <token> <white|black|watch> [--move uci] [--random] [--poll ms]'
  );
  process.exit(4);
}

const side = sideArg === 'watch' ? null : sideArg[0]; // 'w' | 'b' | null
const moveOneShot = flag('move');
const randomMode = rest.includes('--random');
const pollMs = Number(flag('poll') ?? 2500);
const API = 'https://api.github.com';

async function readState() {
  const res = await fetch(`${API}/gists/${gistId}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`read gist failed (HTTP ${res.status})`);
  const gist = await res.json();
  return JSON.parse(gist.files['state.json'].content);
}

async function writeState(state) {
  if (!token) throw new Error('token required to write');
  const res = await fetch(`${API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: { 'state.json': { content: JSON.stringify(state, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`write gist failed (HTTP ${res.status})`);
}

/** Play one move on behalf of `side`. Returns { uci, san } or null if no move. */
async function playMove(side, wantUci = null) {
  const state = await readState();
  if (state.status !== 'active') {
    console.log(`room status: ${state.status} (result ${state.result ?? '-'})`);
    return { state, played: false, reason: 'finished' };
  }
  if (state.turn !== side) {
    console.log(`not my turn (turn=${state.turn}, I am ${side})`);
    return { state, played: false, reason: 'not-my-turn' };
  }

  const game = new Chess();
  for (const uci of state.moves ?? []) {
    const m = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!m) throw new Error(`history replay failed at ${uci}`);
  }

  const legal = game.moves({ verbose: true });
  const chosen = wantUci
    ? legal.find((m) => m.from + m.to + (m.promotion ?? '') === wantUci)
    : randomMode
      ? legal[Math.floor(Math.random() * legal.length)]
      : null;
  if (wantUci && !chosen) {
    console.log(`move ${wantUci} is illegal from fen ${game.fen()}`);
    return { state, played: false, reason: 'illegal' };
  }
  if (!chosen) return { state, played: false, reason: 'no-decision' };

  // Re-read right before writing (compare-and-swap on the move list length) to
  // avoid clobbering an opponent move that landed in between.
  const fresh = await readState();
  if ((fresh.moves ?? []).length !== (state.moves ?? []).length) {
    console.log('room changed while thinking — re-syncing, no move sent');
    return { state: fresh, played: false, reason: 'conflict' };
  }

  const game2 = new Chess();
  for (const uci of fresh.moves ?? []) {
    const m = game2.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!m) throw new Error('replay failed');
  }
  const applied = game2.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
  const uci = chosen.from + chosen.to + (applied.promotion ?? '');
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
  console.log(`played ${applied.san} (${uci}) — turn now ${game2.turn()}`);
  return { state: { ...fresh, moves: [...(fresh.moves ?? []), uci] }, played: true, reason: 'ok' };
}

async function watchLoop() {
  let lastCount = -1;
  for (;;) {
    try {
      const state = await readState();
      const n = (state.moves ?? []).length;
      if (n !== lastCount) {
        lastCount = n;
        const last = state.lastMoveSan ? ` last=${state.lastMoveSan}` : '';
        console.log(
          `[${new Date().toISOString()}] moves=${n} turn=${state.turn}${last} status=${state.status}${state.result ? ` result=${state.result}` : ''}`
        );
        if (state.status === 'finished') return;
        if (randomMode && state.turn === side) {
          const out = await playMove(side, null);
          if (out.played) lastCount = (out.state.moves ?? []).length;
          else if (out.reason === 'finished') return;
        }
      }
    } catch (err) {
      console.error(`poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

try {
  if (moveOneShot) {
    const out = await playMove(side, moveOneShot);
    process.exit(out.reason === 'illegal' ? 3 : out.reason === 'not-my-turn' ? 2 : out.reason === 'conflict' ? 2 : 0);
  } else {
    await watchLoop();
    process.exit(0);
  }
} catch (err) {
  console.error(`fatal: ${err.message}`);
  process.exit(4);
}
