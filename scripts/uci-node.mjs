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
    const info = [...this.lines].reverse().find((l) => / score /.test(l) && / pv /.test(l));
    return { move: best.split(' ')[1], score: scoreFromInfo(info) };
  }

  quit() { this.send('quit'); this.proc.kill(); }
}
