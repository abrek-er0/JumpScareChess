// Run from the project root with macOS JavaScriptCore; uses the bundled full
// Stockfish WASM, without installing or downloading another engine.
import { Chess } from '../vendor/chess.js';
import { parseInfo, prepareAnalysis, fromUci } from '../src/engine.js';

const depth = 18;
const script = {};
globalThis.console = { log: printErr, error: printErr, warn: printErr };
globalThis.document = { currentScript: script };
load('vendor/stockfish/stockfish-19-single.js');

let active = null;
const engine = await script._exports({
  wasmBinary: readFile('vendor/stockfish/stockfish-19-single.wasm', 'binary'),
  listener: line => {
    const score = parseInfo(line);
    if (score && active) {
      active.scores.set(score.pv[0], score);
      if (score.depth >= 12 && score.depth > active.reported) {
        active.reported = score.depth;
        printErr(`${active.label}: depth ${score.depth}/${depth}`);
      }
    }
  },
});
const send = command => engine.ccall('command', null, ['string'], [command], { async: command.startsWith('go ') });
send('uci');
send('setoption name Hash value 64');

async function analyze(position, moves) {
  active = { scores: new Map(), reported: 0, label: moves.join(' ') || 'Starting position' };
  send(`setoption name MultiPV value ${position.moves().length}`);
  send(`position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
  await send(`go depth ${depth}`);
  if ([...active.scores.values()].some(score => score.depth !== depth)) throw new Error('Opening analysis did not finish at the requested depth.');
  const result = prepareAnalysis(position, { scores: active.scores });
  active = null;
  return result;
}

let saved = null;
try { saved = JSON.parse(readFile('assets/openings-stockfish19-depth18.json')); } catch { /* First build. */ }
const reusable = saved?.schema === 1 && saved.engine === 'Stockfish 19' && saved.build === '19.0.0-full' && saved.depth === depth
  ? new Map(saved.positions.map(position => [position.moves.join(' '), position])) : new Map();
const starting = new Chess();
const root = reusable.has('') ? prepareAnalysis(starting, { scores: new Map(reusable.get('').scores) }) : await analyze(starting, []);
const positions = [{ moves: [], scores: [...root.scores] }];
// Include EVERY legal White first move up front, not just whichever one a
// player or random engine choice happens to select during a game.
const openingMoves = [...root.scores.keys()];
printErr(`Preloading Black responses after all ${openingMoves.length} White opening moves`);
for (const move of openingMoves) {
  const position = new Chess();
  position.move(fromUci(move));
  const result = reusable.has(move) ? prepareAnalysis(position, { scores: new Map(reusable.get(move).scores) }) : await analyze(position, [move]);
  positions.push({ moves: [move], scores: [...result.scores] });
}
print(JSON.stringify({ schema: 1, engine: 'Stockfish 19', build: '19.0.0-full', depth, generatedAt: new Date().toISOString(), positions }));
printErr(`Opening book complete: ${positions.length} positions, full depth ${depth}.`);
