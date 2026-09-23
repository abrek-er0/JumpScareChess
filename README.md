# Jumpscare Chess

A static chess opening trainer with a blue-and-white board and full Stockfish 19 analysis. Chess, analysis, sound, and saved progress run entirely in the browser. No backend, API keys, database, build step, or package installation is needed to run the app.

## Browser engine

On supported browsers, **Stockfish runs locally with multiple threads**, using up to four CPU threads and leaving one reported core available when possible. `sw.js` supplies the cross-origin isolation headers needed for shared memory, even when the host cannot set them. The first visit registers the worker and refreshes once, before gameplay or any engine download starts. Subsequent visits start without that setup refresh. If workers, isolation, or storage are restricted, startup falls back safely to the full single-threaded engine. Worker activation that takes longer than four seconds never interrupts a game that has already started.

The first selected engine download is about 95 MiB. The service worker keeps its JavaScript and WASM in the browser's versioned Cache Storage and reuses them on later visits without fetching those files again. It only caches the engine actually requested, not both builds in advance. Browsers can evict caches or deny storage; in that case the app downloads the engine normally. When updating bundled Stockfish files, bump `engineCacheName` in `sw.js`. Only obsolete caches belonging to this repository are removed. HTML and app modules use normal HTTP freshness, so engine caching does not freeze the app at an old release. This is engine caching, not an offline copy of the entire website.

The small precomputed opening file makes starting moves available before the engine download finishes. Later moves need the engine to finish loading. Analysis speed depends on the visitor's CPU and chosen depth; scoring every legal move takes more work than finding a single best move. Scores, mistakes, and preferences stay in each visitor's browser and do not sync between devices or hosting addresses.

Browser references: [cross-origin isolation and shared memory](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated), [service-worker isolation on static hosts](https://github.com/gzuidhof/coi-serviceworker), [Cache Storage behavior](https://developer.mozilla.org/en-US/docs/Web/API/Cache).

## Preview locally

An ordinary static server is sufficient:

```sh
python3 -m http.server 8000
```

For an optional local preview that supplies isolation headers directly, avoiding the initial isolation refresh:

```sh
python3 server.py
```

Open http://127.0.0.1:8000. `server.py` only serves files and adds isolation headers; it does not run the game or engine. All game assets and engine files are bundled. Use an HTTP(S) URL rather than double-clicking `index.html`, because ES modules, fetch, and workers require web serving.

## How it works

- **Play as** offers White, Black, or Random. Random chooses a color with equal probability at the start of each game, including automatic restarts, and stays selected across refreshes. Your color, board orientation, and precomputed opening all follow that game's choice. Changing depth or retrying analysis keeps the same color for the current game.
- Every legal player move is evaluated at the selected depth before input is enabled. Centipawn loss is measured against the best move from the player's perspective.
- A move exceeding the tolerance immediately triggers a red cross, lightning, and buzzer, then restarts the game.
- Player moves show a one-second floating, signed centipawn change, with no quality labels: green for a best move, gray for a move within tolerance, and red for a mistake. Scores use actual centipawns (100 cp = one pawn); a forced-mate change uses `−M` because mate has no finite centipawn value. The evaluation bar at the board's right edge shows the current position from White's perspective in pawn units and flips with the board. Both use existing analysis, without adding any searches or delaying play.
- Both opening turns are **precomputed once at depth 18**, the app's maximum depth, using the bundled full Stockfish 19 engine. The shipped opening file covers 21 positions and 420 move evaluations: the initial position plus Black's responses to **all 20 legal White first moves**. Opening data is loaded once and kept separately from the normal position cache. Neither a new game, side switch, page refresh, nor White's move triggers an opening search or fills in Black's data. The board's depth badge shows the actual analysis depth; the depth slider controls later positions.
- The computer chooses randomly **only among exact ties for the best score**. A unique best move is always chosen. Beyond the precomputed opening, it preloads every player response on a private copy of the resulting position **before revealing its move**. The move and enabled board appear together, so the player can respond immediately. Player move feedback uses the preloaded scores instantly; further analysis stays on the computer's turn. Depth changes later in a game may require preparation.
- Longest streak is saved separately for each centipawn tolerance and persists across sessions. Moving the tolerance slider immediately shows that setting's record (zero if none exists). Changing tolerance starts a new streak count while preserving the board and the game's total safe moves. Previous completed games seed the records for their recorded tolerances; the old untagged global record is retained in storage without assigning it to an arbitrary tolerance.
- **My mistakes** stores the last 10 completed games, including their final positions and the position before the last player move. The review opens before your move, with green arrows for up to 10 legal alternatives ranked by engine score and strictly below that game's saved tolerance, and a red arrow for the move you played. The move list starts with a ↺ Reset row, followed by alternatives, and ends with your played move in red. Click a move to preview it; Reset restores the original position and all arrows. Scores show signed changes relative to the best move, matching floating feedback (for example, `+0.0 cp` or `−25.0 cp`). Historical depth, tolerance, and side are retained.
- Settings, history, and longest streak are stored in the browser's local storage. If storage is unavailable, they remain available for the current page session.

Click or drag pieces to move. Arrow keys navigate the board; Enter selects a square. Promotion supports all four pieces. The sound button mutes/unmutes audio, and reduced-motion preferences disable the animated impact and flash.

## Tests

Run the rules, engine-selection, and history regression suite with Node.js:

```sh
node --experimental-default-type=module tests/core.mjs
node --experimental-default-type=module tests/preload.mjs
node --experimental-default-type=module tests/openings.mjs
node --experimental-default-type=module tests/review.mjs
node --experimental-default-type=module tests/platform.mjs
node --experimental-default-type=module tests/browser/runtime.mjs
node --experimental-default-type=module tests/browser/service-worker.mjs
```

On macOS, the system JavaScriptCore runner also works:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/core.mjs
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/preload.mjs
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/openings.mjs
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/review.mjs
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/platform.mjs
```

The startup and service-worker suites require Node.js 24+ for its Web API and VM implementations. They check first-visit setup, reload-loop protection, late activation, isolation headers, cache hits, cache eviction, and storage failures. These are logic tests; actual isolation and performance still depend on the browser. The GitHub workflow runs all suites.

## Rebuild the opening file

The opening file is already included. Regenerate it only when changing engines or opening depth. This runs the local full WASM engine in JavaScriptCore; no downloads are required. It reuses existing matching opening entries and computes missing entries in one offline pass.

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m scripts/precompute-openings.mjs > /tmp/jumpscare-openings.json
cp /tmp/jumpscare-openings.json assets/openings-stockfish19-depth18.json
```

The depth-18 opening calculations are finite; they do not use Stockfish's unbounded `go infinite` mode.

## Third-party components

- [Stockfish.js 19.0.0](https://github.com/nmrugg/stockfish.js), by Nathan Rugg / Chess.com and the Stockfish contributors. Full NNUE WebAssembly builds, GPL-3.0. License: `vendor/stockfish/COPYING.txt`. Published package: https://registry.npmjs.org/stockfish/-/stockfish-19.0.0.tgz. Corresponding source and build instructions are available in the upstream repository.
- [chess.js 1.4.0](https://github.com/jhlywa/chess.js), BSD-2-Clause. License: `vendor/chess-LICENSE.txt`.
- Standard chess piece SVGs by Colin M. L. Burnett, GPL-2.0-or-later, obtained from [Lichess's cburnett set](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett). See the attribution in [Lichess's COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md).
