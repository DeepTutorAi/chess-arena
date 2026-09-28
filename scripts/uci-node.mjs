// Shared helper for the offline scripts: drive the bundled Stockfish from Node.
//
// The engine in public/engine is a CommonJS browser/Node hybrid, so it is copied
// into a temp folder with its own package.json (this repo is "type": "module").

import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Copy the engine next to a CommonJS package.json; returns the folder. */
export function prepareEngineDir() {
  const engineDir = mkdtempSync(join(tmpdir(), 'chess-arena-sf-'));
  for (const file of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm']) {
    copyFileSync(join(ROOT, 'public/engine', file), join(engineDir, file));
  }
  writeFileSync(join(engineDir, 'package.json'), '{"type":"commonjs"}');
  return engineDir;
}

/** The final MultiPV lines of a search, best first: [{ multipv, depth, cp, mate, pv }]. */
export function finalLines(rawLines) {
  const byIndex = new Map();
  for (const line of rawLines) {
    if (/\b(?:lowerbound|upperbound)\b/.test(line)) continue;
    const m = /\bdepth (\d+).*?\bmultipv (\d+) score (cp|mate) (-?\d+).*? pv (.+)$/.exec(line);
    if (!m) continue;
    const depth = Number(m[1]);
    const index = Number(m[2]);
    const previous = byIndex.get(index);
    if (previous && previous.depth > depth) continue;
    byIndex.set(index, {
      multipv: index, depth,
      cp: m[3] === 'cp' ? Number(m[4]) : null,
      mate: m[3] === 'mate' ? Number(m[4]) : null,
      pv: m[5].trim().split(/\s+/),
    });
  }
  // A search cut off mid-iteration leaves later slots stale: keep the fresher copy of a move.
  const seen = new Set();
  return [...byIndex.values()].sort((a, b) => a.multipv - b.multipv).filter((line) => {
    if (seen.has(line.pv[0])) return false;
    seen.add(line.pv[0]);
    return true;
  });
}

/** Mates clamp to ±1000 cp so they stay comparable on one scale. */
export function scoreFromInfo(info) {
  const cp = /score cp (-?\d+)/.exec(info ?? '');
  const mate = /score mate (-?\d+)/.exec(info ?? '');
  if (cp) return Number(cp[1]);
  if (mate) return Math.sign(Number(mate[1])) * 1000;
  return 0;
}

export class UciEngine {
  constructor(engineDir) {
    this.proc = spawn('node', [join(engineDir, 'stockfish-18-lite-single.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buffer = '';
    this.listeners = [];
    this.lines = null;
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        this.lines?.push(line);
        this.listeners = this.listeners.filter((fn) => !fn(line));
      }
    });
  }

  send(command) { this.proc.stdin.write(`${command}\n`); }

  waitFor(predicate) {
    return new Promise((res) => this.listeners.push((line) => (predicate(line) ? (res(line), true) : false)));
  }

  /** @param {Record<string, string|number>} options UCI options to set */
  async init(options = {}) {
    this.send('uci');
    await this.waitFor((l) => l === 'uciok');
    for (const [name, value] of Object.entries(options)) this.send(`setoption name ${name} value ${value}`);
    this.send('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  /**
   * Run one search. Resolves with the best move and the engine's last score
   * (side to move, centipawns).
   * @param {string} fen
   * @param {string} go  the arguments after "go", e.g. "depth 12"
   */
  async search(fen, go) {
    this.lines = [];
    this.send(`position fen ${fen}`);
    this.send(`go ${go}`);
    const best = await this.waitFor((l) => l.startsWith('bestmove'));
    const lines = finalLines(this.lines);
    // The score is the BEST line's (with MultiPV the last info line belongs to the worst).
    const top = lines[0];
    const info = [...this.lines].reverse().find((l) => / score /.test(l) && / pv /.test(l));
    const score = top
      ? (top.mate !== null ? Math.sign(top.mate) * 1000 : top.cp)
      : scoreFromInfo(info);
    return { move: best.split(' ')[1], score, lines };
  }

  quit() { this.send('quit'); this.proc.kill(); }
}
