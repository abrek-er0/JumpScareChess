import { PRESSURE_SECONDS, TurnClock } from '../src/pressure.js';

const output = typeof print === 'function' ? print : console.log;
function assert(condition, message) { if (!condition) throw new Error(message); }

let now = 0;
let callback = null;
let expirations = 0;
const shown = [];
const soundStates = [];
const clock = new TurnClock({
  now: () => now,
  setTimer: fn => { callback = fn; return 1; },
  clearTimer: () => { callback = null; },
  onTick: seconds => shown.push(seconds),
  onExpire: () => { expirations++; },
  onRunChange: running => soundStates.push(running),
});

clock.start();
assert(shown.at(-1) === PRESSURE_SECONDS, 'Turn did not start at ten seconds');
assert(soundStates.at(-1) === true, 'Pressure sound did not start with the clock');
now = 6100; callback();
assert(shown.at(-1) === 4, 'Clock does not count real elapsed time');
clock.pause();
now = 20000;
assert(callback === null && expirations === 0, 'Paused clock expired');
assert(soundStates.at(-1) === false, 'Pressure sound did not pause with the clock');
clock.resume();
assert(shown.at(-1) === 4, 'Resume lost the remaining time');
assert(soundStates.at(-1) === true, 'Pressure sound did not resume with the clock');
now = 23900; callback();
assert(expirations === 1 && callback === null && shown.at(-1) === 0, 'Timeout did not fire exactly once');
assert(soundStates.at(-1) === false, 'Pressure sound kept playing after timeout');

clock.start();
now = 25000;
clock.start();
assert(shown.at(-1) === 10, 'New move did not reset the full ten seconds');
clock.stop();
assert(callback === null, 'Stopped clock left a pending tick');

let browserTimersUsed = 0;
globalThis.setInterval = function () {
  assert(this === globalThis, 'Browser interval lost its window receiver');
  browserTimersUsed++;
  return 7;
};
globalThis.clearInterval = function () {
  assert(this === globalThis, 'Browser interval cleanup lost its window receiver');
  browserTimersUsed++;
};
const browserClock = new TurnClock({ onTick() {}, onExpire() {}, now: () => 0 });
browserClock.start();
browserClock.stop();
assert(browserTimersUsed === 2, 'Browser timer functions were not called safely');
output('Pressure clock tests passed.');
