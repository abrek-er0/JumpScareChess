import { Chess, DEFAULT_POSITION } from '../vendor/chess.js';
import { computerMoveCandidates, COMPUTER_MOVE_RANGE_CP, fromUci, prepareAnalysis, toUci } from './engine.js';

export const OPENING_DEPTH = 18;
export const OPENING_BUILD = '19.0.0-full';

// This bank is generated offline, loaded once, and never filled or evicted
// during play. It contains the start and all 20 possible White first moves.
export class OpeningBook {
  constructor() {
    this.positions = new Map();
    this.loading = null;
    this.whiteOpeningBag = [];
  }

  async load(fetcher = globalThis.fetch) {
    if (!this.loading) {
      this.loading = (async () => {
        const response = await fetcher(new URL('../assets/openings-stockfish19-depth18.json?v=1-full-21', import.meta.url));
        if (!response.ok) throw new Error('Could not load the opening moves. Try again.');
        this.install(await response.json());
      })().catch(error => {
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  install(data) {
    if (data?.schema !== 1 || data.engine !== 'Stockfish 19' || data.build !== OPENING_BUILD || data.depth !== OPENING_DEPTH || !Array.isArray(data.positions)) {
      throw new Error('Opening data is incompatible with this engine.');
    }
    const positions = new Map();
    for (const entry of data.positions) {
      if (!Array.isArray(entry.moves) || entry.moves.length > 1 || !Array.isArray(entry.scores)) throw new Error('Invalid opening position.');
      const position = new Chess();
      for (const move of entry.moves) position.move(fromUci(move));
      const key = entry.moves.join(' ');
      if (positions.has(key)) throw new Error('Duplicate opening position.');
      const legalMoves = new Set(position.moves({ verbose: true }).map(toUci));
      const scores = new Map(entry.scores);
      if (scores.size !== legalMoves.size || scores.size !== entry.scores.length) throw new Error('Opening analysis is incomplete.');
      for (const [move, score] of scores) {
        if (!legalMoves.has(move) || !score || !['cp', 'mate'].includes(score.type) || !Number.isFinite(score.value) || score.depth !== OPENING_DEPTH || !Array.isArray(score.pv) || score.pv[0] !== move) {
          throw new Error('Opening move has an invalid evaluation.');
        }
      }
      positions.set(key, { ...prepareAnalysis(position, { scores }), depth: OPENING_DEPTH });
    }
    const root = positions.get('');
    if (!root || positions.size !== root.scores.size + 1 || [...root.scores.keys()].some(move => !positions.has(move))) {
      throw new Error('Opening data must include responses to every White first move.');
    }
    // Replace atomically: a partial or corrupted file cannot enable the board.
    this.positions = positions;
    this.whiteOpeningBag = [];
  }

  get(position) {
    const history = position.history({ verbose: true });
    if (history.length > 1 || (history[0]?.before || position.fen()) !== DEFAULT_POSITION) return null;
    return this.positions.get(history.map(toUci).join(' ')) || null;
  }

  start(side, random = Math.random) {
    const root = this.positions.get('');
    if (!root) return null;
    const position = new Chess();
    if (side === 'w') return { position, analysis: root };
    // Shuffle a complete set of strong openings so every option appears once
    // before any repeats. This keeps repeated practice games varied.
    if (!this.whiteOpeningBag.length) {
      this.whiteOpeningBag = computerMoveCandidates(root, COMPUTER_MOVE_RANGE_CP);
      for (let i = this.whiteOpeningBag.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(random() * (i + 1)));
        [this.whiteOpeningBag[i], this.whiteOpeningBag[j]] = [this.whiteOpeningBag[j], this.whiteOpeningBag[i]];
      }
    }
    const move = this.whiteOpeningBag.pop();
    position.move(fromUci(move));
    return { position, move, analysis: this.positions.get(move) };
  }
}
