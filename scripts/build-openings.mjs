// Build public/assets/openings.json (roadmap.md A2) from lichess-org/chess-openings
// (CC0). Raw GitHub may be blocked on some networks — falls back to `gh api`.
// Usage: npm run openings

import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'assets', 'openings.json');
const FILES = ['a', 'b', 'c', 'd', 'e'].map((f) => `${f}.tsv`);
const MAX_PLIES = 14; // opening theory rarely goes deeper; keeps the file small

async function fetchTsv(file) {
  const raw = `https://raw.githubusercontent.com/lichess-org/chess-openings/master/${file}`;
  try {
    const res = await fetch(raw);
    if (res.ok) return await res.text();
    console.warn(`fetch ${file} -> HTTP ${res.status}, falling back to gh api`);
  } catch (err) {
    console.warn(`fetch ${file} failed (${err.cause?.code ?? err.message}), falling back to gh api`);
  }
  const gh = await promisify(execFile)('gh', [
    'api', `repos/lichess-org/chess-openings/contents/${file}`,
    '-H', 'Accept: application/vnd.github.raw',
  ]);
  return gh.stdout;
}

const normalize = (san) => san.replace(/[+#]/g, '');
const entries = [];

for (const file of FILES) {
  const tsv = await fetchTsv(file);
  for (const line of tsv.split('\n').slice(1)) {
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !name || !pgn) continue;
    const moves = pgn
      .trim()
      .split(/\s+/)
      .filter((tok) => !/^\d+\.*$/.test(tok)) // drop "1." style move numbers
      .map(normalize);
    if (!moves.length || moves.length > MAX_PLIES) continue;
    if (moves.some((m) => !/^(O-O(-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?|[a-h]x?[a-h]?[1-8](=[QRBN])?)$/.test(m))) {
      continue; // guard against malformed dataset rows
    }
    entries.push({ moves: moves.join(' '), eco: eco.trim(), name: name.trim() });
  }
}

entries.sort((a, b) => (a.moves < b.moves ? -1 : a.moves > b.moves ? 1 : 0));
const seen = new Set();
const unique = entries.filter((e) => (seen.has(e.moves) ? false : (seen.add(e.moves), true)));

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(unique)}\n`);
const kb = Math.round(JSON.stringify(unique).length / 1024);
console.log(`openings.json: ${unique.length} lines, ~${kb} KB -> ${path.relative(ROOT, OUT)}`);
