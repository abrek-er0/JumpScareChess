/** Prepare isolation before starting the game or downloading either engine. */
export async function prepareBrowser(runtime = globalThis, {
  workerURL = new URL('../sw.js', import.meta.url),
  timeoutMs = 4000,
} = {}) {
  try {
    const serviceWorker = runtime.navigator?.serviceWorker;
    if (!runtime.isSecureContext || !serviceWorker) return { reloading: false };
    const scope = new URL('./', workerURL).href;
    const controlsPage = () => serviceWorker.controller?.scriptURL === workerURL.href;

    const controlled = await new Promise(resolve => {
      let finished = false;
      let timeout;
      const finish = value => {
        if (finished) return;
        finished = true;
        runtime.clearTimeout(timeout);
        serviceWorker.removeEventListener('controllerchange', changed);
        resolve(value);
      };
      const changed = () => { if (controlsPage()) finish(true); };
      serviceWorker.addEventListener('controllerchange', changed);
      timeout = runtime.setTimeout(() => finish(false), timeoutMs);
      // Register even on isolated hosts to cache the engine, and check for
      // service-worker updates without letting HTTP caches hide a new version.
      try {
        serviceWorker.register(workerURL.href, { scope, updateViaCache: 'none' }).then(changed, () => finish(false));
      } catch { finish(false); }
      changed();
    });

    const reloadKey = `jumpscare-isolation-reload:${scope}`;
    if (runtime.crossOriginIsolated === true) {
      try { runtime.sessionStorage.removeItem(reloadKey); } catch { /* Optional storage. */ }
      return { reloading: false };
    }
    if (!controlled || runtime.crossOriginIsolated !== false) return { reloading: false };

    // Claiming a page cannot isolate its existing document. Reload once before
    // play begins; unsupported/private browsers must never enter a reload loop.
    try {
      if (runtime.sessionStorage.getItem(reloadKey)) return { reloading: false };
      runtime.sessionStorage.setItem(reloadKey, '1');
      if (runtime.sessionStorage.getItem(reloadKey) !== '1') return { reloading: false };
    } catch { return { reloading: false }; }
    runtime.location.reload();
    return { reloading: true };
  } catch {
    return { reloading: false };
  }
}
