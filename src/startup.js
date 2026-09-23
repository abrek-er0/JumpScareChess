import { prepareBrowser } from './browser-runtime.js';

// No game or engine starts until the one-time isolation setup has settled.
// Later controller changes never reload an in-progress game.
const { reloading } = await prepareBrowser();
if (!reloading) await import('./app.js');
