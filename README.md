<img src="assets/jumpscare-chess-logo.png" alt="Jumpscare Chess logo" width="420">

# Jumpscare Chess

How long can you go without doing a blunder? Try it on: https://abrek-er0.github.io/JumpScareChess/

## Preview locally

Start the static server:

```sh
python3 -m http.server 8000
```

Go to [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

## Tests

Run all regression suites with Node.js 24+ (no dependency installation needed):

```sh
npm test
```

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
- Pressure clock sound: [Slow Cinematic Clock Ticking](https://pixabay.com/sound-effects/film-special-effects-slow-cinematic-clock-ticking-357979/) by [DRAGON-STUDIO](https://pixabay.com/users/dragon-studio-38165424/), used under the [Pixabay Content License](https://pixabay.com/service/license-summary/).
