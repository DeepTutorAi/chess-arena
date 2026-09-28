#!/usr/bin/env node
// Build public/assets/botbook.json — the bot's opening book (roadmap A2).
//
//   node scripts/build-botbook.mjs [--depth 12] [--threshold 50] [--plies 12] [--parallel 3]
//
// Source: public/assets/openings.json (named lines, see `npm run openings`).
// That dataset is a *catalogue* of every named opening, gambits and junk lines
// included, so it is not safe to play from as-is. This script walks it into a
// position tree and asks the engine about every move: a book move is kept only
// when it scores within `threshold` centipawns of the engine's best move in the
// same position (searched to the same depth).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';

import { positionKey } from '../src/botbook.js';
import { ROOT, UciEngine, prepareEngineDir } from './uci-node.mjs';

const OUT = join(ROOT, 'public/assets/botbook.json');

/**
 * Turn named opening lines into a position tree.
 * @param {{moves: string}[]} entries
 * @param {number} maxPlies  lines are cut after this many plies
 * @returns {Map<string, {fen: string, moves: Map<string, {count: number, childFen: string}>}>}
 */
export function collectEdges(entries, maxPlies) {
  const nodes = new Map();
  for (const entry of entries) {
    const game = new Chess();
    for (const san of entry.moves.split(' ').slice(0, maxPlies)) {
      const fen = game.fen();
      const key = positionKey(fen);
      const move = game.move(san);
      const uci = move.from + move.to + (move.promotion ?? '');
      if (!nodes.has(key)) nodes.set(key, { fen, moves: new Map() });
      const edges = nodes.get(key).moves;
      const edge = edges.get(uci) ?? { count: 0, childFen: game.fen() };
      edge.count += 1;
      edges.set(uci, edge);
    }
  }
  return nodes;
}

/**
 * Keep the moves within `threshold` cp of the best move.
 * @param {ReturnType<typeof collectEdges>} nodes
 * @param {(fen: string) => number} evalOf  side-to-move centipawns for a position
 * @returns {{[key: string]: [string, number][]}}
 */
export function filterEdges(nodes, evalOf, threshold) {
  const positions = {};
  for (const [key, node] of nodes) {
    const best = evalOf(node.fen);
    const kept = [];
    for (const [uci, edge] of node.moves) {
      const value = -evalOf(edge.childFen); // the child is scored for the opponent
      if (value >= best - threshold) kept.push([uci, edge.count]);
    }
    if (kept.length) positions[key] = kept.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }
  return positions;
}

function parseArgs(argv) {
  const args = { depth: 12, threshold: 50, plies: 12, parallel: 3 };
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = Number(argv[i + 1]);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = JSON.parse(readFileSync(join(ROOT, 'public/assets/openings.json'), 'utf8'));
  const nodes = collectEdges(entries, args.plies);

  // Every distinct position that has to be scored: each node and each child.
  const todo = new Map();
  for (const node of nodes.values()) {
    todo.set(positionKey(node.fen), node.fen);
    for (const edge of node.moves.values()) todo.set(positionKey(edge.childFen), edge.childFen);
  }
  console.log(`${nodes.size} book positions, ${todo.size} to evaluate at depth ${args.depth}`);

  const engineDir = prepareEngineDir();
  const scores = new Map();
  const queue = [...todo];
  let done = 0;
  const worker = async () => {
    const engine = new UciEngine(engineDir);
    await engine.init({ Hash: 32 });
    while (queue.length) {
      const [key, fen] = queue.pop();
      scores.set(key, (await engine.search(fen, `depth ${args.depth}`)).score);
      done += 1;
      if (done % 500 === 0) console.log(`  ${done}/${todo.size}`);
    }
    engine.quit();
  };
  await Promise.all(Array.from({ length: args.parallel }, worker));

  const positions = filterEdges(nodes, (fen) => scores.get(positionKey(fen)), args.threshold);
  const edgesBefore = [...nodes.values()].reduce((s, n) => s + n.moves.size, 0);
  const edgesAfter = Object.values(positions).reduce((s, list) => s + list.length, 0);
  writeFileSync(OUT, `${JSON.stringify({
    meta: { depth: args.depth, threshold: args.threshold, plies: args.plies },
    positions,
  })}\n`);
  console.log(`kept ${edgesAfter}/${edgesBefore} moves in ${Object.keys(positions).length} positions -> ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
