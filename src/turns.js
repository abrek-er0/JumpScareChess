import { Chess } from '../vendor/chess.js';
import { chooseBestMove, COMPUTER_MOVE_RANGE_CP, fromUci } from './engine.js';

// Resolve the preference once per new game; the actual side stays fixed until
// the next restart, including while changing depth or retrying analysis.
export function choosePlayerSide(preference, random = Math.random) {
  if (preference === 'random') return random() < 0.5 ? 'w' : 'b';
  return preference === 'b' ? 'b' : 'w';
}

// Replaying the history preserves repetition detection, castling, and en passant.
// Constructing a copy from only the current FEN would lose repetition history.
export function copyPosition(game) {
  const history = game.history({ verbose: true });
  const position = new Chess(history[0]?.before || game.fen());
  for (const move of history) position.move(move);
  return position;
}

/** Prepare the entire handoff without changing the board visible to the player. */
export async function prepareComputerTurn(game, { analyze, isCurrent = () => true, random = Math.random }) {
  if (!isCurrent()) return null;
  const position = copyPosition(game);
  const choices = await analyze(position);
  if (!isCurrent() || !choices) return null;

  // Choose once, then preload exactly that resulting position before revealing it.
  const move = chooseBestMove(choices, random, COMPUTER_MOVE_RANGE_CP);
  position.move(fromUci(move));
  if (position.isGameOver()) return { position, move, analysis: null };

  const analysis = await analyze(position);
  if (!isCurrent() || !analysis) return null;
  return { position, move, analysis };
}
