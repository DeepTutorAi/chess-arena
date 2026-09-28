#!/usr/bin/env node
// Bot Arena (headless): calibrate the app's 11 bot levels by playing them
// against each other and fitting Elo ratings from the results.
//
//   node scripts/calibrate-levels.mjs [--games 6] [--parallel 3] [--levels 1-11]
//                                     [--out src/level-ratings.js] [--results results.json]
//                                     [--seed earlier.json] [--offset 3]
//                                     [--style balanced|aggressive|solid]   # human-style bots
//   node scripts/calibrate-levels.mjs --fit results.json      # refit without playing
//   node scripts/calibrate-levels.mjs --style balanced --cross 4 --out scratch.js
//        # how each human-style level fares against the standard bot of the same level
//
// --seed adds the games of an earlier run to this one (more games = tighter
// ratings); --offset starts the opening list further along so the new games
// don't repeat the openings of the seeded ones.
//
// Every level is played with EXACTLY the settings the app uses (Skill Level +
// depth cap; see src/config.js), from paired openings with colours swapped.
// The fitted scale is relative (levels against each other) and anchored so its
// mean equals the mean of the nominal Elo labels — it tells players how the
// levels rank and how far apart they are, it is not a FIDE rating.
//
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';

import { LEVELS } from '../src/config.js';
import { HUMAN_LINES, HUMAN_STYLES, annotateLines, pickHumanMove } from '../src/humanbot.js';
import { enforceIncreasing, fitRatings, pairSchedule } from '../src/rating.js';
import { ROOT, UciEngine, prepareEngineDir } from './uci-node.mjs';

// Sound, varied 4-ply openings; a game and its colour-swapped twin share one.
export const OPENINGS = [
  'e4 e5 Nf3 Nc6', 'e4 c5 Nf3 d6', 'd4 d5 c4 e6', 'd4 Nf6 c4 g6',
  'e4 e6 d4 d5', 'c4 e5 Nc3 Nf6', 'Nf3 d5 g3 Nf6', 'e4 c6 d4 d5',
];

/**
 * Result adjudication so decided games don't play out to the end: white wins
 * when the last four evaluations (white's point of view, in centipawns) are all
 * >= +600, black when all <= -600; a long dead-equal endgame is drawn.
 * @param {number[]} whiteEvals  white-POV eval after each ply so far
 * @returns {'1-0'|'0-1'|'1/2-1/2'|null}
 */
export function adjudicate(whiteEvals) {
  const last4 = whiteEvals.slice(-4);
  if (last4.length === 4 && last4.every((e) => e >= 600)) return '1-0';
  if (last4.length === 4 && last4.every((e) => e <= -600)) return '0-1';
  const last12 = whiteEvals.slice(-12);
  if (whiteEvals.length >= 120 && last12.length === 12 && last12.every((e) => Math.abs(e) <= 25)) return '1/2-1/2';
  return null;
}

/**
 * One bot with the exact settings the app gives a level (see src/config.js).
 * style 'standard' is the Skill-Level bot; a human style plays the same depth at
 * full skill with MultiPV and picks among the lines like src/humanbot.js.
 */
async function createBot(engineDir, level, style = 'standard') {
  const engine = new UciEngine(engineDir);
  const human = style !== 'standard';
  await engine.init(human
    ? { 'Skill Level': 20, MultiPV: HUMAN_LINES, Hash: 16 }
    : { 'Skill Level': level.skill, Hash: 16 });
  const go = `depth ${level.depth} movetime ${level.movetime}`;
  return {
    /** Move + the engine's own eval (side to move, centipawns). */
    async choose(fen) {
      const result = await engine.search(fen, go);
      if (!human) return { move: result.move, score: result.score };
      const candidates = annotateLines((f) => new Chess(f), fen, result.lines);
      return { move: pickHumanMove(candidates, { level: level.level, style }) ?? result.move, score: result.score };
    },
    quit: () => engine.quit(),
  };
}

async function playGame(engineDir, whiteLevel, blackLevel, opening, styles = {}) {
  const [white, black] = await Promise.all([
    createBot(engineDir, whiteLevel, styles.white), createBot(engineDir, blackLevel, styles.black),
  ]);
  const game = new Chess();
  for (const san of opening.split(' ')) game.move(san);
  const whiteEvals = [];
  let result = null;
  while (!game.isGameOver() && game.history().length < 220 && !result) {
    const mover = game.turn() === 'w' ? white : black;
    const { move, score } = await mover.choose(game.fen());
    if (!move || move === '(none)') break;
    game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    whiteEvals.push(game.turn() === 'b' ? score : -score); // score is from the mover's side
    result = adjudicate(whiteEvals);
  }
  white.quit();
  black.quit();
  if (result) return { result, plies: game.history().length };
  if (game.isCheckmate()) return { result: game.turn() === 'w' ? '0-1' : '1-0', plies: game.history().length };
  return { result: '1/2-1/2', plies: game.history().length };
}

export function parseArgs(argv) {
  const args = { games: 6, parallel: 3, levels: '1-11', out: join(ROOT, 'src/level-ratings.js'), results: null, fit: null, seed: null, offset: 0, style: 'standard', cross: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  args.games = Number(args.games);
  args.parallel = Number(args.parallel);
  args.offset = Number(args.offset);
  args.cross = Number(args.cross);
  if (args.style !== 'standard' && !HUMAN_STYLES.includes(args.style)) throw new Error(`--style must be one of ${HUMAN_STYLES.join(', ')} (got ${args.style})`);
  // The shipped ratings describe the standard bots only: a human-style run must write elsewhere.
  if (args.style !== 'standard' && !args.fit && resolve(args.out) === resolve(ROOT, 'src/level-ratings.js')) throw new Error('a --style run needs its own --out (it must not overwrite src/level-ratings.js)');
  if (args.cross && args.style === 'standard') throw new Error('--cross compares a human style with the standard bot: add --style balanced|aggressive|solid');
  if (args.cross && (!Number.isInteger(args.cross) || args.cross < 2 || args.cross % 2)) throw new Error(`--cross must be an even number >= 2 (got ${args.cross})`);
  // Games come in colour-swapped pairs; an odd count would favour one colour.
  if (!Number.isInteger(args.games) || args.games < 2 || args.games % 2) throw new Error(`--games must be an even number >= 2 (got ${args.games})`);
  if (!Number.isInteger(args.parallel) || args.parallel < 1) throw new Error(`--parallel must be >= 1 (got ${args.parallel})`);
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error(`--offset must be >= 0 (got ${args.offset})`);
  return args;
}

function parseLevels(spec) {
  const [from, to] = String(spec).split('-').map(Number);
  return Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);
}

function writeRatingsModule(path, { ratings, games, gamesPerPair }) {
  const body = `// Generated by scripts/calibrate-levels.mjs — do not edit by hand.
// Relative ratings from ${games} bot-vs-bot games (${gamesPerPair} per scheduled pair, colours
// swapped, same settings as the app). Anchored to the mean of the nominal labels.
export const LEVEL_RATINGS = ${JSON.stringify({
    generatedAt: new Date().toISOString().slice(0, 10), games, gamesPerPair, ratings,
  }, null, 2)};
`;
  writeFileSync(path, body);
}

export function scoreOf(result, aIsWhite) {
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === aIsWhite ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const levelNumbers = parseLevels(args.levels);
  const anchorMean = levelNumbers.reduce((s, n) => s + LEVELS[n - 1].nominal, 0) / levelNumbers.length;

  // Cross-play games (human style vs standard) are a separate measurement: they never
  // feed the ladder fit, and a ladder run never mixes them into its own results.
  const ladderOnly = (list) => list.filter((r) => !r.cross);
  let results = args.seed ? JSON.parse(readFileSync(args.seed, 'utf8')) : [];
  results = args.cross ? results.filter((r) => r.cross) : ladderOnly(results);
  if (args.fit) {
    results = JSON.parse(readFileSync(args.fit, 'utf8'));
    if (!args.cross) results = ladderOnly(results);
  } else {
    const engineDir = prepareEngineDir();

    const jobs = [];
    if (args.cross) {
      // Human-style level k (a) against the standard level k (b): who is stronger, and by how much.
      for (const level of levelNumbers) {
        for (let g = 0; g < args.cross; g++) {
          jobs.push({ a: level, b: level, opening: OPENINGS[(Math.floor(g / 2) + args.offset) % OPENINGS.length], aIsWhite: g % 2 === 0, cross: true });
        }
      }
    } else {
      for (const [a, b] of pairSchedule(levelNumbers, 2)) {
        for (let g = 0; g < args.games; g++) {
          jobs.push({ a, b, opening: OPENINGS[(Math.floor(g / 2) + args.offset) % OPENINGS.length], aIsWhite: g % 2 === 0 });
        }
      }
    }
    console.log(`${jobs.length} games, ${args.parallel} at a time`);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const white = LEVELS[(job.aIsWhite ? job.a : job.b) - 1];
        const black = LEVELS[(job.aIsWhite ? job.b : job.a) - 1];
        const styleA = args.style;
        const styleB = job.cross ? 'standard' : args.style;
        const styles = { white: job.aIsWhite ? styleA : styleB, black: job.aIsWhite ? styleB : styleA };
        const { result, plies } = await playGame(engineDir, white, black, job.opening, styles);
        results.push({ a: job.a, b: job.b, score: scoreOf(result, job.aIsWhite), plies, result, ...(job.cross ? { cross: true } : {}) });
        done += 1;
        console.log(`[${done}/${jobs.length}] L${job.a} vs L${job.b} ${job.aIsWhite ? '(a=white)' : '(a=black)'} ${result} in ${plies} plies`);
        if (args.results) writeFileSync(args.results, JSON.stringify(results));
      }
    };
    await Promise.all(Array.from({ length: args.parallel }, worker));
    if (args.results) writeFileSync(args.results, JSON.stringify(results));
  }

  if (results.some((r) => r.cross)) {
    // Elo of a human-style level relative to the standard bot of the same level.
    console.log(`\nlevel  ${args.style} vs standard (score, Elo difference)`);
    for (const n of levelNumbers) {
      const games = results.filter((r) => r.cross && r.a === n);
      if (!games.length) continue;
      const score = games.reduce((sum, r) => sum + r.score, 0) / games.length;
      const clipped = Math.min(0.95, Math.max(0.05, score));
      console.log(String(n).padStart(5), score.toFixed(2).padStart(6), `${Math.round(400 * Math.log10(clipped / (1 - clipped)))}`.padStart(8), `(${games.length} games)`);
    }
    return;
  }

  // Levels are built to get stronger; sampling noise must not reorder them.
  const fitted = fitRatings(results, { levels: levelNumbers, anchorMean });
  const ordered = enforceIncreasing(levelNumbers.map((n) => fitted[n]));
  const ratings = Object.fromEntries(levelNumbers.map((n, i) => [n, Math.round(ordered[i] / 10) * 10]));
  console.log('\nlevel  nominal  calibrated');
  for (const n of levelNumbers) console.log(String(n).padStart(5), String(LEVELS[n - 1].nominal).padStart(8), String(ratings[n]).padStart(11));
  const pairCount = pairSchedule(levelNumbers, 2).length;
  writeRatingsModule(args.out, { ratings, games: results.length, gamesPerPair: Math.round(results.length / pairCount) });
  console.log(`\nwrote ${args.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
