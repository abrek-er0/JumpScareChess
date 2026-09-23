import { prepareBrowser } from '../../src/browser-runtime.js';

const output = typeof print === 'function' ? print : console.log;
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(name, run) { await run(); count++; output(`PASS ${name}`); }
const workerURL = new URL('https://example.github.io/chess/sw.js');

function browser({ isolated = false, controlled = false, storage = new Map(), registerFails = false } = {}) {
  const listeners = new Set();
  const timers = new Set();
  const runtime = {
    isSecureContext: true, crossOriginIsolated: isolated, reloads: 0,
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
    location: { reload() { runtime.reloads++; } },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    navigator: { serviceWorker: {
      controller: controlled ? { scriptURL: workerURL.href } : null,
      registrations: [],
      register(url, options) {
        this.registrations.push({ url, options });
        return registerFails ? Promise.reject(new Error('Service workers blocked')) : Promise.resolve({});
      },
      addEventListener(_, listener) { listeners.add(listener); },
      removeEventListener(_, listener) { listeners.delete(listener); },
    } },
    takeControl() {
      runtime.navigator.serviceWorker.controller = { scriptURL: workerURL.href };
      for (const listener of listeners) listener();
    },
    timeout() { for (const timer of [...timers]) timer(); },
    listeners,
  };
  return runtime;
}

await test('First static-host visit activates isolation before starting the game', async () => {
  const runtime = browser();
  const pending = prepareBrowser(runtime, { workerURL });
  let finished = false;
  pending.then(() => { finished = true; });
  await Promise.resolve();
  assert(!finished && runtime.reloads === 0, 'Startup did not wait for the controlling worker');
  runtime.takeControl();
  assert((await pending).reloading && runtime.reloads === 1, 'First visit did not reload for isolation');
  const registration = runtime.navigator.serviceWorker.registrations[0];
  assert(registration.url === workerURL.href && registration.options.scope === 'https://example.github.io/chess/', 'Worker escaped the repository subpath');
  assert(runtime.listeners.size === 0, 'Startup retained a late reload listener');
});

await test('A returning isolated visit starts immediately and checks for worker updates', async () => {
  const runtime = browser({ isolated: true, controlled: true });
  const result = await prepareBrowser(runtime, { workerURL });
  assert(!result.reloading && runtime.reloads === 0, 'Returning visit reloaded unnecessarily');
  assert(runtime.navigator.serviceWorker.registrations[0].options.updateViaCache === 'none', 'Worker updates can be hidden by the HTTP cache');
});

await test('Unsupported isolation cannot cause a reload loop', async () => {
  const storage = new Map();
  const first = browser({ controlled: true, storage });
  assert((await prepareBrowser(first, { workerURL })).reloading, 'Initial isolation attempt was skipped');
  const second = browser({ controlled: true, storage });
  assert(!(await prepareBrowser(second, { workerURL })).reloading && second.reloads === 0, 'Unsupported isolation reloaded again');
});

await test('Timeout enables fallback and late activation never interrupts a game', async () => {
  const runtime = browser();
  const pending = prepareBrowser(runtime, { workerURL });
  runtime.timeout();
  assert(!(await pending).reloading, 'Timeout left startup waiting indefinitely');
  runtime.takeControl();
  await Promise.resolve();
  assert(runtime.reloads === 0 && runtime.listeners.size === 0, 'Late activation restarted an in-progress game');
});

await test('Blocked workers or storage and insecure hosts leave the app playable', async () => {
  const rejected = browser({ registerFails: true });
  assert(!(await prepareBrowser(rejected, { workerURL })).reloading, 'Rejected worker registration blocked startup');
  const blockedStorage = browser({ controlled: true });
  blockedStorage.sessionStorage.getItem = () => { throw new Error('Storage blocked'); };
  assert(!(await prepareBrowser(blockedStorage, { workerURL })).reloading, 'Storage failure triggered an unsafe reload');
  const insecure = browser(); insecure.isSecureContext = false;
  assert(!(await prepareBrowser(insecure, { workerURL })).reloading && insecure.navigator.serviceWorker.registrations.length === 0, 'Insecure host attempted registration');
  const unsupported = browser(); delete unsupported.navigator.serviceWorker;
  assert(!(await prepareBrowser(unsupported, { workerURL })).reloading, 'Unsupported service workers blocked startup');
});

output(`${count} browser startup tests passed.`);
