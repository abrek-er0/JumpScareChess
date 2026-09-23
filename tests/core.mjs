import { Chess } from '../vendor/chess.js';
import { chooseBestMove, moveLoss, parseInfo, prepareAnalysis, scoreValue, toUci } from '../src/engine.js';
import { captureDecision, PracticeHistory, HISTORY_KEY, previewAlternative } from '../src/history.js';
import { describeMove, evaluationDisplay, scoreAfterMove, formatCentipawnChange } from '../src/feedback.js';
import { choosePlayerSide } from '../src/turns.js';

const output = typeof print === 'function' ? print : console.log;
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
function test(name, run) { run(); count++; output(`PASS ${name}`); }
function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function analysisFor(game, values) {
  const scores = new Map(game.moves({ verbose: true }).map((move, index) => [toUci(move), { type: 'cp', value: values(index), pv: [toUci(move)], depth: 12 }]));
  return { scores, best: [...scores.values()].sort((a, b) => scoreValue(b) - scoreValue(a))[0] };
}
function decisionFor(game = new Chess(), tolerance = 80) {
  const analysis = analysisFor(game, index => 100 - index * 10);
  const move = game.moves({ verbose: true }).at(-1);
  return captureDecision(game, analysis, move, { side: game.turn(), tolerance, depth: 12 });
}
function endingDetails(decision, attempt = 1) {
  return { finalFen: previewAlternative(decision, decision.played.uci), lastMove: { from: decision.played.uci.slice(0, 2), to: decision.played.uci.slice(2, 4) }, outcome: 'blunder', safeMoves: attempt, attempt };
}

test('UCI parsing ignores bounds and preserves negative, side-relative scores', () => {
  const result = parseInfo('info depth 12 multipv 2 score cp -38 nodes 20 pv e7e5 g1f3');
  assert(result.value === -38 && result.depth === 12 && result.pv[1] === 'g1f3', 'Incorrect UCI parse');
  assert(parseInfo('info depth 12 score cp 50 lowerbound pv e2e4') === null, 'Bound is not an exact score');
});

test('Fixed player colors do not draw a random color', () => {
  const random = () => { throw new Error('Fixed color unexpectedly used randomness'); };
  assert(choosePlayerSide('w', random) === 'w', 'White preference changed');
  assert(choosePlayerSide('b', random) === 'b', 'Black preference changed');
});

test('Random player colors split evenly and are selected once per new game', () => {
  let calls = 0;
  const draws = [0, 0.4999, 0.5, 0.9999];
  const random = () => draws[calls++];
  const sides = draws.map(() => choosePlayerSide('random', random));
  assert(sides.join(' ') === 'w w b b', 'Random colors do not split at one half');
  assert(calls === 4, 'A game drew its color more than once');
});

test('Random replies include all exact best ties and exclude merely good moves', () => {
  const scores = new Map([
    ['e2e4', { type: 'cp', value: 32 }],
    ['d2d4', { type: 'cp', value: 32 }],
    ['g1f3', { type: 'cp', value: 31 }],
  ]);
  const analysis = { scores, best: scores.get('e2e4') };
  assert(chooseBestMove(analysis, () => 0) === 'e2e4', 'First tie unavailable');
  assert(chooseBestMove(analysis, () => 0.999) === 'd2d4', 'Last tie unavailable or inferior move selected');
  scores.get('d2d4').value = 31;
  assert(chooseBestMove(analysis, () => 0.999) === 'e2e4', 'Unique best move must always be chosen');
});

test('Random replies honor exact negative scores for Black and mate distances', () => {
  const scores = new Map([['e7e5', { type: 'cp', value: -20 }], ['c7c5', { type: 'cp', value: -20 }], ['d7d5', { type: 'cp', value: -21 }]]);
  assert(chooseBestMove({ scores, best: scores.get('e7e5') }, () => .9) === 'c7c5', 'Scores were flipped for Black');
  const mates = new Map([['e7e5', { type: 'mate', value: 2 }], ['c7c5', { type: 'mate', value: 3 }]]);
  assert(chooseBestMove({ scores: mates, best: mates.get('e7e5') }, () => .9) === 'e7e5', 'Different mate distances are not exact ties');
});

test('Move loss treats preserving a forced mate as safe', () => {
  assert(moveLoss({ type: 'mate', value: 2 }, { type: 'mate', value: 8 }) === 0, 'Preserved mate was penalized');
  assert(moveLoss({ type: 'cp', value: 20 }, { type: 'mate', value: -3 }) > 90000, 'Allowing mate was not penalized');
});

test('Review alternatives are ranked and strictly below the saved tolerance', () => {
  const game = new Chess();
  const before = game.fen();
  const decision = decisionFor(game, 30);
  assert(decision.alternatives.length === 3, 'Must show only the three valid moves, without padding');
  assert(decision.alternatives.every(move => move.loss < 30), 'Threshold boundary leaked into results');
  assert(decision.alternatives.map(move => move.loss).join(',') === '0,10,20', 'Wrong ranking');
  assert(game.fen() === before && game.history().length === 0, 'Capturing review data changed the live board');
});

test('Review alternatives are capped at ten even when more qualify', () => {
  const decision = decisionFor(new Chess(), 300);
  assert(decision.alternatives.length === 10, 'Too many alternatives');
  assert(decision.alternatives[9].loss === 90, 'Did not keep the best ten');
});

test('Black move reviews use Black perspective and preserve the original position', () => {
  const game = new Chess(); game.move('e4');
  const decision = decisionFor(game, 40);
  assert(decision.side === 'b' && decision.alternatives.length === 4, 'Incorrect Black alternatives');
  const preview = new Chess(previewAlternative(decision, decision.alternatives[0].uci));
  assert(preview.turn() === 'w', 'Black preview did not apply a move');
  assert(game.history().join(' ') === 'e4', 'Review altered live history');
});

test('Promotion alternatives retain the promotion piece and can be previewed', () => {
  const game = new Chess('k7/4P3/8/8/8/8/8/4K3 w - - 0 1');
  const analysis = analysisFor(game, () => 50);
  const move = game.moves({ verbose: true }).find(move => move.promotion === 'n');
  const decision = captureDecision(game, analysis, move, { side: 'w', tolerance: 80, depth: 12 });
  assert(decision.played.uci === 'e7e8n', 'Underpromotion lost');
  assert(new Chess(previewAlternative(decision, decision.played.uci)).get('e8').type === 'n', 'Promotion preview is wrong');
});

test('History retains the latest ten completed games with final positions', () => {
  const history = new PracticeHistory(memoryStorage());
  const decision = decisionFor();
  for (let attempt = 1; attempt <= 12; attempt++) history.record(decision, endingDetails(decision, attempt));
  assert(history.endings.length === 10, 'Incorrect retained game count');
  assert(history.endings[0].attempt === 12 && history.endings[9].attempt === 3, 'Wrong history order');
  assert(history.endings[0].finalFen !== decision.beforeFen, 'Saved the pre-move board instead of the ending');
});

test('History and longest streak survive refresh and shorter subsequent runs', () => {
  const storage = memoryStorage();
  const history = new PracticeHistory(storage);
  history.updateStreak(80, 18);
  history.updateStreak(80, 3);
  const decision = decisionFor();
  history.record(decision, endingDetails(decision));
  const restored = new PracticeHistory(storage);
  assert(restored.getLongestStreak(80) === 18 && restored.endings.length === 1, 'Progress was not persisted');
  assert(restored.endings[0].tolerance === 80 && restored.endings[0].depth === 12, 'Historical settings changed');
});

test('Each tolerance keeps its own longest streak after refresh and history eviction', () => {
  const storage = memoryStorage();
  const history = new PracticeHistory(storage);
  history.updateStreak(30, 8);
  history.updateStreak(80, 18);
  history.updateStreak(300, 24);
  history.updateStreak(30, 2);
  const decision = decisionFor(new Chess(), 80);
  for (let attempt = 1; attempt <= 12; attempt++) history.record(decision, endingDetails(decision, attempt));
  const restored = new PracticeHistory(storage);
  assert(restored.getLongestStreak(30) === 8, 'A shorter run or another tolerance overwrote the record');
  assert(restored.getLongestStreak(80) === 18 && restored.getLongestStreak(300) === 24, 'Independent records were not saved');
  assert(restored.getLongestStreak(40) === 0, 'An unplayed tolerance inherited a record');
});

test('A changed-tolerance segment does not inherit the full game move count', () => {
  const storage = memoryStorage();
  const history = new PracticeHistory(storage);
  history.updateStreak(80, 17);
  const decision = decisionFor(new Chess(), 30);
  history.record(decision, { ...endingDetails(decision), safeMoves: 20, streak: 3 });
  const restored = new PracticeHistory(storage);
  assert(restored.getLongestStreak(30) === 3, 'Earlier moves were credited to the new tolerance');
  assert(restored.getLongestStreak(80) === 17, 'The original tolerance lost its record');
  assert(restored.endings[0].safeMoves === 20 && restored.endings[0].streak === 3, 'Total moves and segment streak were not kept separately');
});

test('Legacy history recovers tagged records without guessing the global record tolerance', () => {
  const storage = memoryStorage();
  const decision = decisionFor(new Chess(), 30);
  storage.setItem(HISTORY_KEY, JSON.stringify({
    longestStreak: 25,
    endings: [{ ...decision, ...endingDetails(decision, 7) }],
  }));
  const history = new PracticeHistory(storage);
  assert(history.getLongestStreak(30) === 7, 'Tagged legacy result was lost');
  assert(history.getLongestStreak(80) === 0, 'Untagged global record was assigned to a tolerance');
  history.updateStreak(80, 4);
  const restored = new PracticeHistory(storage);
  assert(restored.getLongestStreak(30) === 7 && restored.getLongestStreak(80) === 4, 'Migrated records did not survive refresh');
  assert(JSON.parse(storage.getItem(HISTORY_KEY)).legacyLongestStreak === 25, 'Unknown legacy record was discarded');
});

test('Malformed streak values and unsupported tolerance keys are ignored', () => {
  const storage = memoryStorage();
  storage.setItem(HISTORY_KEY, JSON.stringify({ longestStreaks: {
    0: 10, 15: 10, 310: 10, 30: -2, 40: 1.5, 50: '9', 80: 6, arbitrary: 100,
  } }));
  const history = new PracticeHistory(storage);
  history.updateStreak(80, NaN);
  history.updateStreak(15, 12);
  assert(history.getLongestStreak(80) === 6, 'Valid record was corrupted');
  assert([0, 15, 310, 30, 40, 50, 'arbitrary'].every(value => history.getLongestStreak(value) === 0), 'Malformed data was accepted');
});

test('Invalid or unavailable storage does not break training', () => {
  const storage = memoryStorage(); storage.setItem(HISTORY_KEY, '{invalid json');
  assert(new PracticeHistory(storage).endings.length === 0, 'Invalid JSON was accepted');
  const blocked = new PracticeHistory({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  blocked.updateStreak(80, 4);
  const decision = decisionFor(); blocked.record(decision, endingDetails(decision));
  assert(blocked.getLongestStreak(80) === 4 && blocked.endings.length === 1, 'In-memory fallback failed');
});

test('Invalid saved positions and illegal advice are discarded', () => {
  const storage = memoryStorage();
  const decision = decisionFor();
  const record = { ...decision, ...endingDetails(decision) };
  storage.setItem(HISTORY_KEY, JSON.stringify({ endings: [{ ...record, finalFen: 'invalid' }, { ...record, alternatives: [{ uci: 'e2e5', san: 'e5', loss: 0 }] }, record] }));
  assert(new PracticeHistory(storage).endings.length === 1, 'Invalid saved history was rendered');
});

test('Preloading catches missing moves rather than enabling unscored play', () => {
  const game = new Chess();
  const raw = analysisFor(game, () => 0);
  raw.scores.delete('e2e4');
  let failed = false;
  try { prepareAnalysis(game, raw); } catch { failed = true; }
  assert(failed, 'Incomplete analysis was accepted');
  assert(game.history().length === 0, 'Preparing analysis changed game history');
});

test('Threefold repetition is scored as a draw using the actual game history', () => {
  const game = new Chess();
  for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']) game.move(move);
  const before = game.fen();
  const raw = analysisFor(game, () => 100);
  const result = prepareAnalysis(game, raw);
  assert(result.scores.get('f6g8').value === 0, 'Repetition was not scored as a draw');
  assert(game.fen() === before && game.history().length === 7, 'History changed during preparation');
});

test('Evaluation stays in White perspective for moves by either side', () => {
  const whiteRoot = { type: 'cp', value: 125 };
  const before = evaluationDisplay(whiteRoot, 'w');
  const after = evaluationDisplay(scoreAfterMove(whiteRoot), 'b');
  assert(before.label === '+1.25' && after.label === before.label, 'White advantage changed sign after a move');
  assert(before.whitePercent === after.whitePercent && before.whitePercent > 50, 'Evaluation bar changed sides');
  const blackRoot = { type: 'cp', value: 75 };
  const blackAfter = evaluationDisplay(scoreAfterMove(blackRoot), 'w');
  assert(blackAfter.label === '−0.75' && blackAfter.whitePercent < 50 && blackAfter.advantage === 'b', 'Black advantage was displayed for White');
});

test('Evaluation correctly handles mate distance, checkmate, and drawn positions', () => {
  const mate = scoreAfterMove({ type: 'mate', value: 3 });
  assert(mate.value === -2 && evaluationDisplay(mate, 'b').label === '+M2', 'Mate distance did not account for the played move');
  const win = evaluationDisplay(scoreAfterMove({ type: 'mate', value: 1 }), 'b');
  assert(win.label === '1–0' && win.whitePercent === 100, 'White checkmate was inverted');
  const loss = evaluationDisplay({ type: 'mate', value: 0 }, 'w');
  assert(loss.label === '0–1' && loss.whitePercent === 0, 'Black checkmate was inverted');
  const draw = evaluationDisplay({ type: 'cp', value: 0 }, 'b');
  assert(draw.label === '0.00' && draw.whitePercent === 50, 'Draw was not displayed as equal');
});

test('Floating feedback uses only a signed number and the correct tolerance color', () => {
  const score = { type: 'cp', value: 30 };
  assert(describeMove(0, 80, score, score).headline === '+0.0 cp', 'Best move has a quality label instead of a number');
  assert(describeMove(0, 80, score, score).kind === 'good', 'Best move is not green');
  assert(describeMove(0.2, 80, score, score).headline === '−0.2 cp', 'Fractional centipawns were rounded away');
  assert(describeMove(80, 80, score, score).kind === 'neutral', 'An acceptable move was colored as a mistake');
  const mistake = describeMove(81, 80, score, score);
  assert(mistake.kind === 'bad' && mistake.headline === '−81.0 cp', 'Mistake has the wrong color, sign, or units');
  assert(describeMove(100000, 80, { type: 'mate', value: -2 }, score).headline === '−M', 'Mate was displayed as fictitious centipawns');
});

test('Centipawn changes keep their signs, fractional values, and units', () => {
  assert(formatCentipawnChange(0) === '+0.0 cp' && formatCentipawnChange(-0) === '+0.0 cp', 'Zero has an inconsistent sign');
  assert(formatCentipawnChange(0.2) === '+0.2 cp', 'Positive fractional change was lost');
  assert(formatCentipawnChange(-25.2) === '−25.2 cp', 'Negative centipawns changed sign or units');
});

output(`${count} tests passed.`);
