import { Chess } from '../vendor/chess.js';
import { scoreValue, fromUci, toUci } from '../src/engine.js';
import { OpeningBook, OPENING_DEPTH } from '../src/openings.js';
import { choosePlayerSide } from '../src/turns.js';

const output = typeof print === 'function' ? print : console.log;
const file = 'assets/openings-stockfish19-depth18.json';
const text = typeof readFile === 'function' ? readFile(file) : await (await import('node:fs/promises')).readFile(file, 'utf8');
const data = JSON.parse(text);
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
function test(name, run) { run(); count++; output(`PASS ${name}`); }
function book() { const result = new OpeningBook(); result.install(data); return result; }
function copyData() { return JSON.parse(text); }

test('Shipped Stockfish book covers all 420 first-turn evaluations at maximum app depth', () => {
  const openings = book();
  const root = new Chess();
  const white = openings.get(root);
  assert(openings.positions.size === 21 && white.scores.size === 20, 'Starting position is incomplete');
  let evaluations = white.scores.size;
  for (const move of root.moves({ verbose: true })) {
    const position = new Chess(); position.move(move);
    const black = openings.get(position);
    assert(black && black.depth === OPENING_DEPTH, `Missing Black opening: ${toUci(move)}`);
    assert(black.scores.size === position.moves().length, 'Not every Black response is scored');
    assert([...black.scores.values()].every(score => score.depth === 18), 'Opening contains a partial-depth evaluation');
    evaluations += black.scores.size;
  }
  assert(evaluations === 420, 'Wrong number of offline evaluations');
});

test('White and Black can restart repeatedly using the same ready opening scores', () => {
  const openings = book();
  const root = openings.get(new Chess());
  const selectedOpenings = new Set();
  for (let attempt = 0; attempt < 100; attempt++) {
    const white = openings.start('w');
    const black = openings.start('b', () => attempt / 100);
    assert(white.analysis === root && white.position.turn() === 'w', 'White opening was rebuilt');
    assert(black.analysis === openings.positions.get(black.move) && black.position.turn() === 'b', 'Black opening was filled on demand');
    assert(scoreValue(root.best) - scoreValue(root.scores.get(black.move)) <= 10, 'Computer selected a move outside the opening range');
    selectedOpenings.add(black.move);
  }
  assert(selectedOpenings.size === 4, 'Expected all four close opening moves to be selectable');
  assert(openings.positions.size === 21, 'Restarts modified the opening bank');
});

test('Computer cycles through every strong White opening before repeating one', () => {
  const openings = book();
  for (let cycle = 0; cycle < 3; cycle++) {
    const moves = Array.from({ length: 4 }, () => openings.start('b', () => .2).move);
    assert(new Set(moves).size === 4, 'A strong opening repeated before all four were played');
  }
});

test('Reading every White move never adds or replaces precomputed Black data', () => {
  const openings = book();
  const entries = new Map(openings.positions);
  for (const move of new Chess().moves({ verbose: true })) {
    const game = new Chess(); game.move(move);
    assert(openings.get(game) === entries.get(toUci(move)), 'A White move filled or replaced Black data');
  }
  assert([...entries].every(([key, value]) => openings.positions.get(key) === value), 'Opening bank changed during play');
});

test('Random-side games immediately use the precomputed opening for the chosen color', () => {
  const openings = book();
  for (const draw of [0, 0.75, 0.25, 0.99]) {
    const side = choosePlayerSide('random', () => draw);
    const opening = openings.start(side);
    assert(opening.position.turn() === side, 'Opening handed the turn to the wrong color');
    assert(opening.analysis === openings.get(opening.position), 'Random color bypassed the ready opening scores');
    assert(opening.analysis.scores.size === opening.position.moves().length, 'Random-side game has unscored legal moves');
  }
});

test('Openings cannot leak into later moves or unrelated custom positions', () => {
  const openings = book();
  const game = new Chess(); game.move('e4'); game.move('e5');
  assert(openings.get(game) === null, 'Later position used an opening score');
  const custom = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  assert(openings.get(custom) === null, 'Custom position used the standard opening');
});

test('Missing Black openings are rejected atomically rather than calculated during play', () => {
  const openings = book();
  const original = openings.positions;
  const incomplete = copyData(); incomplete.positions.pop();
  let rejected = false;
  try { openings.install(incomplete); } catch { rejected = true; }
  assert(rejected && openings.positions === original, 'Partial bank replaced the complete opening data');
});

test('Wrong engine versions, incomplete scores, and unfinished depths are rejected', () => {
  const invalidCases = [copyData(), copyData(), copyData(), copyData()];
  invalidCases[0].build = 'old-engine';
  invalidCases[1].positions[0].scores.pop();
  invalidCases[2].positions[0].scores[0][1].depth = 17;
  invalidCases[3].positions[0].scores[0][0] = 'e2e5';
  for (const data of invalidCases) {
    let rejected = false;
    try { new OpeningBook().install(data); } catch { rejected = true; }
    assert(rejected, 'Invalid opening data was accepted');
  }
});

test('Every precomputed principal variation begins with a legal move and reply', () => {
  for (const entry of data.positions) {
    for (const [uci, score] of entry.scores) {
      const position = new Chess();
      for (const move of entry.moves) position.move(fromUci(move));
      assert(score.pv[0] === uci, 'Principal variation belongs to a different move');
      for (const move of score.pv) position.move(fromUci(move));
    }
  }
});

output(`${count} opening tests passed.`);
