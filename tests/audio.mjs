import { GameAudio } from '../src/audio.js';

const output = typeof print === 'function' ? print : console.log;
function assert(condition, message) { if (!condition) throw new Error(message); }

let contexts = 0;
let sources = 0;
let pressureStarts = 0;
let pressureStops = 0;
class FakeAudioContext {
  constructor() { contexts++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve({ duration: 8 }); }
  createGain() { return { gain: { value: 1 }, connect: () => this.destination, disconnect() {} }; }
  createBufferSource() { return { buffer: null, loop: false, connect: target => target, start() { pressureStarts++; }, stop() { pressureStops++; }, disconnect() {} }; }
  createOscillator() {
    sources++;
    return { frequency: { setValueAtTime() {} }, connect: target => target, start() {}, stop() {}, disconnect() {} };
  }
}
globalThis.window = { AudioContext: FakeAudioContext };

const audio = new GameAudio();
audio.prepare();
assert(contexts === 1 && sources === 0, 'Audio context should be prepared before playback');
audio.unlock();
await Promise.resolve();
assert(audio.warmed && sources === 1, 'First interaction did not run a silent warmup');
audio.unlock();
assert(sources === 1, 'Warmup ran more than once');
audio.pressureBuffer = {};
audio.startPressure();
assert(pressureStarts === 1 && audio.pressureSource.loop && audio.pressureGain.gain.value === 0.14, 'Recorded pressure sound did not start quietly in a loop');
audio.pausePressure();
assert(pressureStops === 1 && !audio.pressureSource, 'Recorded pressure sound did not stop on pause');
audio.muted = true;
audio.startPressure();
assert(pressureStarts === 1, 'Muted timer still played the recording');

const muted = new GameAudio();
muted.muted = true;
muted.prepare();
muted.unlock();
assert(contexts === 1, 'Muted audio should not start the output path');
muted.muted = false;
muted.unlock();
await Promise.resolve();
assert(contexts === 2 && muted.warmed, 'Unmuting should prepare and warm audio');

let requestedSound = '';
globalThis.fetch = async url => {
  requestedSound = String(url);
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
};
const recorded = new GameAudio();
recorded.prepare();
recorded.startPressure();
recorded.unlock();
await recorded.pressureLoading;
assert(requestedSound === 'assets/pressure-clock.mp3' && recorded.pressureBuffer?.duration === 8, 'Requested pressure recording was not preloaded');
assert(pressureStarts === 2, 'Preloaded recording did not start during the active turn');
recorded.pausePressure();
assert(pressureStops === 2, 'Preloaded recording kept playing after the turn');

output('Audio startup tests passed.');
