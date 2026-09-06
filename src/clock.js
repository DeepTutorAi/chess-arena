// Chess Clock engine — tracks White and Black remaining time (ms),
// increments on move, countdown ticks, and flag timeouts.

export class ChessClock {
  /**
   * @param {object} opts
   * @param {number} opts.initialMs — initial time per player in ms (0 = unlimited)
   * @param {number} [opts.incrementMs] — increment per move in ms
   * @param {Function} [opts.onTick] — (times: { w: number, b: number }, turn: 'w'|'b') => void
   * @param {Function} [opts.onTimeout] — (loser: 'w'|'b') => void
   */
  constructor({ initialMs = 0, incrementMs = 0, onTick, onTimeout } = {}) {
    this.initialMs = initialMs;
    this.incrementMs = incrementMs;
    this.onTick = onTick ?? (() => {});
    this.onTimeout = onTimeout ?? (() => {});

    this.times = { w: initialMs, b: initialMs };
    this.turn = null;
    this.active = false;
    this.unlimited = initialMs <= 0;
    this._timer = null;
    this._lastTickTime = null;
  }

  start(turn = 'w') {
    if (this.unlimited) return;
    this.stop();
    this.turn = turn;
    this.active = true;
    this._lastTickTime = performance.now();
    this._timer = setInterval(() => this._tick(), 100);
    this.onTick(this.times, this.turn);
  }

  switchTurn(nextTurn) {
    if (this.unlimited || !this.active) return;
    this._updateCurrentTurn();
    if (this.turn && this.incrementMs > 0) {
      this.times[this.turn] += this.incrementMs;
    }
    this.turn = nextTurn;
    this._lastTickTime = performance.now();
    this.onTick(this.times, this.turn);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.active && !this.unlimited) {
      this._updateCurrentTurn();
    }
    this.active = false;
  }

  reset() {
    this.stop();
    this.times = { w: this.initialMs, b: this.initialMs };
    this.turn = null;
  }

  _updateCurrentTurn() {
    if (!this.active || !this.turn || !this._lastTickTime) return;
    const now = performance.now();
    const elapsed = now - this._lastTickTime;
    this._lastTickTime = now;
    this.times[this.turn] = Math.max(0, this.times[this.turn] - elapsed);
  }

  _tick() {
    if (!this.active || !this.turn) return;
    this._updateCurrentTurn();
    this.onTick(this.times, this.turn);
    if (this.times[this.turn] <= 0) {
      const loser = this.turn;
      this.stop();
      this.onTimeout(loser);
    }
  }

  static formatTime(ms) {
    if (ms <= 0) return '0:00';
    if (ms < 10_000) {
      // Floor both digits so the readout never claims more time than is left
      // (ceil here would show e.g. 0:01.0 while only 100ms remains).
      const totalTenths = Math.floor(ms / 100);
      const secs = Math.floor(totalTenths / 10);
      const tenths = totalTenths % 10;
      return `0:${secs.toString().padStart(2, '0')}.${tenths}`;
    }
    const totalSeconds = Math.ceil(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
