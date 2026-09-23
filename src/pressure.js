export const PRESSURE_SECONDS = 10;

export class TurnClock {
  constructor({ onTick, onExpire, onRunChange = () => {}, now = () => performance.now(), setTimer = (callback, delay) => globalThis.setInterval(callback, delay), clearTimer = timer => globalThis.clearInterval(timer) }) {
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.onRunChange = onRunChange;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.deadline = null;
    this.remainingMs = 0;
  }

  start(seconds = PRESSURE_SECONDS) {
    this.stop();
    this.remainingMs = seconds * 1000;
    this.resume();
  }

  resume() {
    if (this.timer !== null || this.remainingMs <= 0) return;
    this.deadline = this.now() + this.remainingMs;
    this.onTick(Math.ceil(this.remainingMs / 1000));
    this.timer = this.setTimer(() => this.tick(), 100);
    this.onRunChange(true);
  }

  pause() {
    if (this.timer === null) return;
    this.remainingMs = Math.max(0, this.deadline - this.now());
    this.clearTimer(this.timer);
    this.timer = null;
    this.deadline = null;
    this.onRunChange(false);
  }

  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.deadline = null;
    this.remainingMs = 0;
    this.onRunChange(false);
  }

  tick() {
    if (this.deadline === null) return;
    this.remainingMs = Math.max(0, this.deadline - this.now());
    this.onTick(Math.ceil(this.remainingMs / 1000));
    if (this.remainingMs === 0) {
      this.stop();
      this.onExpire();
    }
  }
}
