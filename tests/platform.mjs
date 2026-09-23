import { StockfishEngine } from '../src/engine.js';

const output = typeof print === 'function' ? print : console.log;
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(name, run) { await run(); count++; output(`PASS ${name}`); }

const keys = ['navigator', 'crossOriginIsolated', 'SharedArrayBuffer'];
const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function environment({ isolated = false, sharedMemory = true, cores = 8 } = {}) {
  for (const [key, value] of Object.entries({
    navigator: { hardwareConcurrency: cores },
    crossOriginIsolated: isolated,
    SharedArrayBuffer: sharedMemory ? originals.get('SharedArrayBuffer')?.value : undefined,
  })) Object.defineProperty(globalThis, key, { value, configurable: true });
}

// Probe engine selection without downloading WASM or replacing its UCI logic.
class EngineProbe extends StockfishEngine {
  constructor(options) { super(options); this.loads = []; this.failThreaded = false; }
  async load(threaded) {
    this.loads.push(threaded);
    if (threaded && this.failThreaded) throw new Error('Shared-memory initialization failed');
  }
}

try {
  await test('Static hosting without isolation loads only the full single-thread engine', async () => {
    environment();
    const engine = new EngineProbe();
    await engine.init();
    assert(engine.loads.length === 1 && engine.loads[0] === false && engine.threads === 1, 'Static hosting required a multithread engine');
    const ready = engine.init();
    assert(ready === engine.ready && engine.loads.length === 1, 'Repeated initialization loaded the engine again');
  });

  await test('Browsers without isolation or shared-memory APIs use the single-thread build', async () => {
    environment();
    delete globalThis.crossOriginIsolated;
    const legacy = new EngineProbe();
    await legacy.init();
    assert(legacy.loads[0] === false, 'Missing isolation API did not select the static build');
    environment({ isolated: true, sharedMemory: false });
    const noSharedMemory = new EngineProbe();
    await noSharedMemory.init();
    assert(noSharedMemory.loads[0] === false, 'Missing shared memory did not select the static build');
  });

  await test('Isolated hosts retain bounded multithreading and the single-thread override', async () => {
    environment({ isolated: true });
    const threaded = new EngineProbe();
    await threaded.init();
    assert(threaded.loads[0] === true && threaded.threads === 4, 'Multithreading was lost or used too many cores');
    const single = new EngineProbe({ singleThread: true });
    await single.init();
    assert(single.loads[0] === false && single.threads === 1, 'Explicit single-thread mode was ignored');
  });

  await test('A failed multithread engine falls back to the full single-thread engine', async () => {
    environment({ isolated: true });
    const engine = new EngineProbe();
    let terminated = false;
    engine.worker = { terminate() { terminated = true; } };
    engine.failThreaded = true;
    await engine.init();
    assert(engine.loads.join(',') === 'true,false' && engine.threads === 1 && terminated, 'Fallback did not replace the failed worker');
  });
} finally {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

output(`${count} static hosting tests passed.`);
