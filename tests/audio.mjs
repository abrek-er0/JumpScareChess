import { GameAudio } from '../src/audio.js';

const output = typeof print === 'function' ? print : console.log;
function assert(condition, message) { if (!condition) throw new Error(message); }

let contexts = 0;
let sources = 0;
class FakeAudioContext {
  constructor() { contexts++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createGain() { return { gain: { value: 1 }, connect: () => this.destination, disconnect() {} }; }
  createOscillator() {
    sources++;
    return { connect: target => target, start() {}, stop() {}, disconnect() {} };
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

const muted = new GameAudio();
muted.muted = true;
muted.prepare();
muted.unlock();
assert(contexts === 1, 'Muted audio should not start the output path');
muted.muted = false;
muted.unlock();
await Promise.resolve();
assert(contexts === 2 && muted.warmed, 'Unmuting should prepare and warm audio');

output('Audio startup tests passed.');
