import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const output = console.log;
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(name, run) { await run(); count++; output(`PASS ${name}`); }

function worker() {
  const listeners = new Map();
  const stores = new Map();
  const scope = 'https://example.github.io/chess/';
  const harness = { requests: [], claimed: false, storageBlocked: false, writesBlocked: false, status: 200 };
  const cacheStorage = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (harness.storageBlocked) throw new Error('Storage blocked');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(request.url)?.clone(); },
        async put(request, response) {
          if (harness.writesBlocked) throw new Error('Quota exceeded');
          entries.set(request.url, response.clone());
        },
      };
    },
  };
  runInNewContext(source, {
    URL, Headers, Request, Response,
    self: {
      registration: { scope }, location: { origin: 'https://example.github.io' },
      addEventListener: (type, handler) => listeners.set(type, handler),
      skipWaiting: async () => {},
      clients: { claim: async () => { harness.claimed = true; } },
    },
    caches: cacheStorage,
    fetch: async request => {
      harness.requests.push(request.url);
      return new Response(`download ${harness.requests.length}`, { status: harness.status, headers: { 'Content-Type': request.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
    },
  });
  harness.dispatch = async (type, request) => {
    let response;
    const pending = [];
    listeners.get(type)({ request, respondWith: value => { response = value; }, waitUntil: promise => pending.push(promise) });
    const result = await response;
    await Promise.all(pending);
    return result;
  };
  harness.get = path => harness.dispatch('fetch', new Request(new URL(path, scope)));
  harness.stores = stores;
  return harness;
}

await test('Navigation and worker responses receive the required isolation headers', async () => {
  const runtime = worker();
  for (const path of ['./', 'src/startup.js', 'vendor/stockfish/stockfish-19.js']) {
    const response = await runtime.get(path);
    assert(response.headers.get('Cross-Origin-Opener-Policy') === 'same-origin', 'COOP header missing');
    assert(response.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp', 'COEP header missing');
    assert(response.headers.get('Cross-Origin-Resource-Policy') === 'same-origin', 'Resource policy missing');
  }
});

await test('Engine downloads are cached on demand and reused without a network request', async () => {
  const runtime = worker();
  await runtime.dispatch('install');
  await runtime.dispatch('activate');
  assert(runtime.claimed && runtime.requests.length === 0, 'Installation downloaded engines in advance');
  const first = await runtime.get('vendor/stockfish/stockfish-19.wasm');
  const second = await runtime.get('vendor/stockfish/stockfish-19.wasm');
  assert(await first.text() === await second.text() && runtime.requests.length === 1, 'Cached WASM was downloaded again');
  assert(second.headers.get('Content-Type') === 'application/wasm', 'Caching lost the WASM MIME type');
  assert(second.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp', 'Cached engine lost its isolation headers');
  assert(!runtime.requests.some(url => url.includes('single')), 'Unused fallback engine was downloaded');
});

await test('Application code stays fresh and the worker leaves other sites alone', async () => {
  const runtime = worker();
  const first = await runtime.get('src/app.js');
  const second = await runtime.get('src/app.js');
  assert(await first.text() !== await second.text(), 'App code was trapped in an engine cache');
  assert(await runtime.get('https://example.github.io/other/site.js') === undefined, 'Worker intercepted another repository');
  assert(await runtime.get('https://other.test/engine.wasm') === undefined, 'Worker intercepted another origin');
  assert(runtime.requests.length === 2, 'Unrelated requests reached this worker');
});

await test('Engine HTTP errors and partial downloads are never cached', async () => {
  for (const status of [404, 206]) {
    const runtime = worker(); runtime.status = status;
    await runtime.get('vendor/stockfish/stockfish-19.wasm');
    runtime.status = 200;
    const retry = await runtime.get('vendor/stockfish/stockfish-19.wasm');
    assert(retry.status === 200 && runtime.requests.length === 2, 'A failed or incomplete download was reused');
  }
});

await test('Cache restrictions never prevent engine downloads or isolation', async () => {
  for (const restriction of ['storageBlocked', 'writesBlocked']) {
    const runtime = worker(); runtime[restriction] = true;
    const response = await runtime.get('vendor/stockfish/stockfish-19-single.wasm');
    assert(response.status === 200 && await response.text() === 'download 1', 'Restricted cache broke the download');
    assert(response.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp', 'Cache failure disabled isolation');
  }
});

await test('Activation removes only obsolete engine caches for this repository', async () => {
  const runtime = worker();
  await runtime.get('vendor/stockfish/stockfish-19.wasm');
  const current = [...runtime.stores.keys()][0];
  const old = 'jumpscare-engine:https://example.github.io/chess/:old-engine';
  const other = 'jumpscare-engine:https://example.github.io/other/:old-engine';
  runtime.stores.set(old, new Map()); runtime.stores.set(other, new Map());
  await runtime.dispatch('activate');
  assert(!runtime.stores.has(old) && runtime.stores.has(current) && runtime.stores.has(other), 'Cleanup deleted current or unrelated cached data');
});

output(`${count} service worker tests passed.`);
