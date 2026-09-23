import { Chess } from '../vendor/chess.js';
import { chooseBestMove, moveLoss, toUci } from '../src/engine.js';
import { copyPosition, prepareComputerTurn } from '../src/turns.js';

const output = typeof print === 'function' ? print : console.log;
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(name, run) { await run(); count++; output(`PASS ${name}`); }
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function analysisFor(position, bestMoves = []) {
  const scores = new Map(position.moves({ verbose: true }).map(move => {
    const uci = toUci(move);
    return [uci, { type: 'cp', value: bestMoves.includes(uci) ? 100 : 0, pv: [uci], depth: 12 }];
  }));
  return { scores, best: [...scores.values()].sort((a, b) => b.value - a.value)[0] };
}

await test('Computer handoff waits for every player response without changing the visible game', async () => {
  const game = new Chess(); game.move('e4');
  const originalFen = game.fen();
  const selection = deferred();
  const preload = deferred();
  const preloadStarted = deferred();
  const requests = [];
  let randomCalls = 0;
  let settled = false;
  const pending = prepareComputerTurn(game, {
    analyze: position => {
      requests.push({ fen: position.fen(), moves: position.history(), count: position.moves().length });
      if (requests.length === 1) return selection.promise;
      preloadStarted.resolve(position);
      return preload.promise;
    },
    random: () => { randomCalls++; return .999; },
  });
  pending.then(() => { settled = true; });
  assert(requests.length === 1 && game.fen() === originalFen, 'Computer moved before selection finished');
  const choices = analysisFor(game, ['e7e5', 'c7c5']);
  const selectedMove = chooseBestMove(choices, () => .999);
  selection.resolve(choices);
  const futurePosition = await preloadStarted.promise;
  assert(game.fen() === originalFen && game.history().join(' ') === 'e4', 'Computer move became visible during preloading');
  assert(!settled, 'Player was handed the turn before its scores were ready');
  assert(futurePosition.turn() === 'w', 'Wrong side was preloaded');
  assert(toUci(futurePosition.history({ verbose: true }).at(-1)) === selectedMove, 'Preloaded a different move than the selected reply');
  const responses = analysisFor(futurePosition);
  preload.resolve(responses);
  const prepared = await pending;
  assert(randomCalls === 1, 'Computer reselected its move after preloading');
  assert(prepared.analysis === responses && prepared.move === selectedMove, 'Handoff did not include the preloaded scores');
  assert(prepared.analysis.scores.size === prepared.position.moves().length, 'Player cannot immediately play every legal move');
  assert(game.fen() === originalFen, 'Preparation changed the live game');
  const playerMove = prepared.position.moves({ verbose: true })[0];
  const loss = moveLoss(prepared.analysis.best, prepared.analysis.scores.get(toUci(playerMove)));
  assert(Number.isFinite(loss) && requests.length === 2, 'Immediate player feedback triggered another search');
});

await test('Playing Black preloads Black responses before revealing White’s opening move', async () => {
  const game = new Chess();
  const calls = [];
  const prepared = await prepareComputerTurn(game, {
    analyze: async position => {
      calls.push(position.turn());
      return analysisFor(position, ['e2e4']);
    },
  });
  assert(calls.join(' ') === 'w b', 'Wrong analysis sequence for playing Black');
  assert(prepared.move === 'e2e4' && prepared.position.turn() === 'b', 'Wrong opening handoff');
  assert(prepared.analysis.scores.size === 20, 'Black responses were not ready');
  assert(game.history().length === 0, 'Initial board changed prematurely');
});

await test('Cancelling during move selection prevents preloading or committing stale work', async () => {
  const game = new Chess(); game.move('e4');
  const gate = deferred();
  let current = true;
  let searches = 0;
  const pending = prepareComputerTurn(game, {
    analyze: () => { searches++; return gate.promise; },
    isCurrent: () => current,
  });
  current = false;
  gate.resolve(analysisFor(game, ['e7e5']));
  assert(await pending === null, 'Cancelled selection was committed');
  assert(searches === 1 && game.history().join(' ') === 'e4', 'Cancelled selection affected the game');
});

await test('Changing sides or depth during preloading discards the entire pending handoff', async () => {
  const game = new Chess(); game.move('e4');
  const originalFen = game.fen();
  const gate = deferred();
  const started = deferred();
  let current = true;
  let searches = 0;
  const pending = prepareComputerTurn(game, {
    analyze: async position => {
      searches++;
      if (searches === 1) return analysisFor(position, ['e7e5']);
      started.resolve(position);
      return gate.promise;
    },
    isCurrent: () => current,
  });
  const futurePosition = await started.promise;
  current = false;
  gate.resolve(analysisFor(futurePosition));
  assert(await pending === null, 'Stale preloaded result survived cancellation');
  assert(game.fen() === originalFen, 'Cancelled preloading changed the visible board');
});

await test('A preload error leaves the computer move unrevealed so the turn can be retried', async () => {
  const game = new Chess(); game.move('e4');
  const originalFen = game.fen();
  let calls = 0;
  let caught = false;
  try {
    await prepareComputerTurn(game, {
      analyze: async position => {
        if (++calls === 1) return analysisFor(position, ['e7e5']);
        throw new Error('Engine failed during preload');
      },
    });
  } catch (error) { caught = error.message === 'Engine failed during preload'; }
  assert(caught && game.fen() === originalFen, 'Failure left the game on an unprepared player turn');
});

await test('A mating computer move completes without requesting analysis of a finished game', async () => {
  const game = new Chess();
  for (const move of ['f3', 'e5', 'g4']) game.move(move);
  let calls = 0;
  const prepared = await prepareComputerTurn(game, {
    analyze: async position => { calls++; return analysisFor(position, ['d8h4']); },
  });
  assert(calls === 1 && prepared.analysis === null && prepared.position.isCheckmate(), 'Checkmate started an unnecessary or invalid search');
  assert(!game.isGameOver(), 'Mate was revealed before handoff');
});

await test('Private preloading preserves repetition history and recognizes a terminal draw', async () => {
  const game = new Chess();
  for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']) game.move(move);
  let calls = 0;
  const prepared = await prepareComputerTurn(game, {
    analyze: async position => { calls++; return analysisFor(position, ['f6g8']); },
  });
  assert(calls === 1 && prepared.analysis === null, 'Attempted to preload after a draw');
  assert(prepared.position.isThreefoldRepetition(), 'Private board lost repetition history');
  assert(game.history().length === 7 && !game.isThreefoldRepetition(), 'Draw changed the original game');
});

await test('Position copies preserve special-move rights and nonstandard starting positions', async () => {
  const game = new Chess('r3k2r/ppp2ppp/8/3pP3/8/8/PPP2PPP/R3K2R w KQkq d6 0 14');
  const copy = copyPosition(game);
  assert(copy.fen() === game.fen(), 'Custom starting position changed');
  const legal = copy.moves({ verbose: true }).map(toUci);
  assert(legal.includes('e1g1') && legal.includes('e1c1') && legal.includes('e5d6'), 'Castling or en passant was lost');
  game.move('exd6');
  const movedCopy = copyPosition(game);
  assert(movedCopy.fen() === game.fen() && movedCopy.history().join(' ') === game.history().join(' '), 'Custom history was not replayed correctly');
});

output(`${count} preloading tests passed.`);
