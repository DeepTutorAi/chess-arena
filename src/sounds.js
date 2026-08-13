// Sound manager — lazy audio elements (browser autoplay policy requires a
// user gesture before any sound plays, so the first play() also unlocks).
//
// Files live in public/assets/sounds/ (committed, self-contained for Pages).
// victory is two files played simultaneously for a fuller fanfare.

const BASE = './assets/sounds/';

const FILES = {
  move: 'move.mp3',
  capture: 'capture.mp3',
  check: 'check.mp3',
  lose: 'lose.mp3',
  victory: ['victory1.mp3', 'victory2.mp3'], // played together
  draw: 'stalemate.mp3',
  lowtime: 'lowtime.mp3',
  afk: 'afk-timeout.mp3',
  click: 'click.mp3',
};

class SoundManager {
  constructor() {
    this.muted = false;
    this._cache = new Map();
    this._lowTimeAt = 0;
    this._unlock = () => this._ensure();
  }

  /** Must run at least once from a user gesture (click/keydown). */
  _ensure() {
    if (!this._listening) {
      this._listening = true;
      window.addEventListener('pointerdown', this._unlock, { once: true });
      window.addEventListener('keydown', this._unlock, { once: true });
    }
    // Warm the cache so the first real play() is instant.
    for (const f of new Set(Object.values(FILES).flat())) {
      if (!this._cache.has(f)) {
        const a = new Audio(BASE + f);
        a.preload = 'auto';
        this._cache.set(f, a);
      }
    }
  }

  play(name) {
    if (this.muted) return;
    try {
      this._ensure();
      const files = Array.isArray(FILES[name]) ? FILES[name] : [FILES[name]];
      for (const f of files) {
        let a = this._cache.get(f);
        if (!a) {
          a = new Audio(BASE + f);
          this._cache.set(f, a);
        }
        a.currentTime = 0;
        a.play().catch(() => {});
      }
    } catch {
      // audio never blocks the game
    }
  }

  /** Low-time warning with a ~5s cooldown so it doesn't rattle. */
  playLowTime() {
    if (Date.now() - this._lowTimeAt < 5000) return;
    this._lowTimeAt = Date.now();
    this.play('lowtime');
  }
}

export const sounds = new SoundManager();
