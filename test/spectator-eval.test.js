// Spectator live evaluation (roadmap.md C1): one depth-capped engine per
// spectator that always searches the CURRENT position, pauses when the tab is
// hidden, and converts the side-to-move score into white perspective.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

import { SpectatorEval } from '../src/spectator-eval.js';
import { convertCentipawnsToWinProbability } from '../src/analyzer.js';

const FEN_A = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_B = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

const workers = [];

class FakeWorker {
  static latest = null;
  constructor() {
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.latest = this;
    workers.push(this);
  }
  postMessage(cmd) {
    const line = String(cmd);
    this.messages.push(line);
    if (line === 'uci') this.onmessage?.({ data: 'uciok' });
    if (line === 'isready') this.onmessage?.({ data: 'readyok' });
  }
  terminate() {
    this.terminated = true;
  }
  finish(pvUci, scoreCp) {
    this.onmessage?.({
      data: `info depth 10 seldepth 12 multipv 1 score cp ${scoreCp} nodes 5000 nps 200000 time 25 pv ${pvUci.join(' ')}`,
    });
    this.onmessage?.({ data: `bestmove ${pvUci[0]}` });
  }
}

function setup(t) {
  const window = new Window({ url: 'https://chess.example.test/' });
  t.after(() => {
    window.close();
    workers.length = 0;
  });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Worker = FakeWorker;
  return window;
}

test('enabling spawns one engine and searches the current position at capped depth', (t) => {
  setup(t);
  const ev = new SpectatorEval({ fenProvider: () => FEN_A });
  const seen = [];
  ev.setHandler((result) => seen.push(result));

  ev.notifyPosition(); // ignored while disabled
  ev.setEnabled(true);
  assert.ok(ev.enabled);

  const worker = workers.at(-1);
  assert.ok(worker, 'engine worker spawned on first enable');
  assert.ok(worker.messages.includes(`position fen ${FEN_A}`));
  assert.ok(worker.messages.includes('go depth 10'));

  // Progressive info is emitted in WHITE perspective with the best move.
  worker.onmessage?.({ data: 'info depth 8 multipv 1 score cp 120 nodes 1 nps 1 time 1 pv g1f3 e7e5' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].whiteCp, 120);
  assert.equal(seen[0].whiteWinProb, Math.round(convertCentipawnsToWinProbability(120)));
  assert.deepEqual(seen[0].best, { from: 'g1', to: 'f3' });
  assert.equal(seen[0].fen, FEN_A);
  ev.destroy();
  assert.ok(worker.terminated);
});

test('a position change mid-search restarts the search on the newest fen', (t) => {
  setup(t);
  let fen = FEN_A;
  const ev = new SpectatorEval({ fenProvider: () => fen });
  ev.setEnabled(true);
  const worker = workers.at(-1);
  const goCount = () => worker.messages.filter((m) => m.startsWith('go ')).length;

  fen = FEN_B;
  ev.notifyPosition();
  assert.ok(worker.messages.includes('stop'), 'stale search is stopped');
  worker.finish(['e2e4'], 30); // stop makes stockfish emit bestmove
  assert.equal(goCount(), 2, 'the search restarts on the new position');
  assert.ok(worker.messages.includes(`position fen ${FEN_B}`));

  // Repeating notifyPosition with an unchanged fen must NOT re-search.
  const before = goCount();
  ev.notifyPosition();
  ev.notifyPosition();
  assert.equal(goCount(), before);
  ev.destroy();
});

test('hiding the tab pauses the search; showing it resumes', (t) => {
  const window = setup(t);
  const ev = new SpectatorEval({ fenProvider: () => FEN_A });
  ev.setEnabled(true);
  const worker = workers.at(-1);
  const goCount = () => worker.messages.filter((m) => m.startsWith('go ')).length;
  const before = goCount();

  Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.ok(worker.messages.includes('stop'), 'hidden tab stops the search');

  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(goCount(), before + 1, 'visible tab restarts the search');
  ev.destroy();
});

test('disabling clears the display and re-enabling reuses the same worker', (t) => {
  setup(t);
  const ev = new SpectatorEval({ fenProvider: () => FEN_A });
  ev.setEnabled(true);
  const worker = workers.at(-1);
  ev.setEnabled(false);
  assert.ok(!worker.terminated, 'disable pauses but keeps the worker for reuse');

  ev.setEnabled(true);
  assert.equal(workers.length, 1, 'no second worker spawned');
  ev.destroy();
  assert.ok(worker.terminated);
});

test('a worker error respawns the engine on the next position update (P2)', (t) => {
  setup(t);
  const ev = new SpectatorEval({ fenProvider: () => FEN_A });
  ev.setEnabled(true);
  const first = workers.at(-1);
  first.onerror?.({ message: 'engine worker crashed' });
  assert.ok(first.terminated, 'the dead worker is disposed');
  assert.equal(workers.length, 1);

  ev.notifyPosition();
  assert.equal(workers.length, 2, 'a fresh worker is spawned');
  const second = workers.at(-1);
  assert.ok(second.messages.includes(`position fen ${FEN_A}`), 'the fresh worker searches the current position');
  ev.destroy();
  assert.ok(second.terminated);
});
