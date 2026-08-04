// Copies the Stockfish engine (js + wasm) from node_modules into public/engine.
// The engine worker is loaded at runtime from public assets, so the browser
// gets a plain, same-origin script + wasm — no COOP/COEP headers required,
// which means it works on static hosts like GitHub Pages.
//
// Usage: node scripts/copy-engine.mjs
// The generated files under public/engine/ are committed to the repo so the
// deployed site is fully self-contained.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'engine');

// 'lite-single' = Stockfish 18 lite single-threaded (~7MB, no CORS headers needed).
// Other options: 'full-single' (stronger, ~40MB), 'asm' (slow fallback).
const variant = process.argv[2] ?? 'lite-single';

const files = {
  'lite-single': ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm'],
  'full-single': ['stockfish-18-single.js', 'stockfish-18-single.wasm'],
  asm: ['stockfish-18-asm.js'],
}[variant];

if (!files) {
  console.error(`Unknown variant "${variant}". Use: lite-single | full-single | asm`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

for (const f of files) {
  const src = join(root, 'node_modules', 'stockfish', 'bin', f);
  if (!existsSync(src)) {
    console.error(`Missing ${src}. Run "npm install" first.`);
    process.exit(1);
  }
  copyFileSync(src, join(outDir, f));
  console.log(`copied ${f}`);
}

console.log(`engine ready: public/engine (${variant})`);
