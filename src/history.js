import { Chess } from '../vendor/chess.js';
import { fromUci, toUci, moveLoss, scoreValue } from './engine.js';

export const HISTORY_KEY = 'jumpscare-history-v1';
export const HISTORY_LIMIT = 10;

const validTolerance = tolerance => Number.isInteger(tolerance) && tolerance >= 10 && tolerance <= 300 && tolerance % 10 === 0;
const validStreak = streak => Number.isSafeInteger(streak) && streak >= 0;

/** Snapshot the alternatives before making the player's move. No new search is needed. */
export function captureDecision(game, analysis, move, { side, tolerance, depth }) {
  const legalMoves = game.moves({ verbose: true });
  const played = legalMoves.find(candidate => toUci(candidate) === toUci(move));
  if (!played) throw new Error('Cannot review an illegal move.');
  const chosen = analysis.scores.get(toUci(played));
  const alternatives = legalMoves.flatMap(candidate => {
    const score = analysis.scores.get(toUci(candidate));
    if (!score) return [];
    const loss = moveLoss(analysis.best, score);
    return loss < tolerance ? [{ uci: toUci(candidate), san: candidate.san, loss, score: scoreValue(score) }] : [];
  }).sort((a, b) => b.score - a.score || a.uci.localeCompare(b.uci)).slice(0, 10);
  return {
    beforeFen: game.fen(), side, tolerance, depth,
    played: { uci: toUci(played), san: played.san },
    loss: moveLoss(analysis.best, chosen),
    alternatives,
  };
}

function validRecord(record) {
  if (!record || !['blunder', 'win', 'loss', 'draw'].includes(record.outcome) || !['w', 'b'].includes(record.side)) return false;
  if (!Number.isFinite(record.tolerance) || record.tolerance <= 0 || !Number.isFinite(record.depth)) return false;
  if (!validStreak(record.safeMoves) || !Array.isArray(record.alternatives) || !Number.isFinite(record.loss)) return false;
  if (record.streak !== undefined && (!validStreak(record.streak) || record.streak > record.safeMoves)) return false;
  try {
    const position = new Chess(record.beforeFen);
    new Chess(record.finalFen);
    if (!record.beforeFen || !record.finalFen || !record.played?.uci) return false;
    const legal = position.moves({ verbose: true });
    if (!legal.some(move => toUci(move) === record.played.uci && move.san === record.played.san)) return false;
    // Discard malformed storage instead of presenting illegal or out-of-tolerance advice.
    return record.alternatives.length <= 10 && record.alternatives.every(move =>
      Number.isFinite(move.loss) && move.loss >= 0 && move.loss < record.tolerance &&
      legal.some(candidate => toUci(candidate) === move.uci && candidate.san === move.san));
  } catch { return false; }
}

export class PracticeHistory {
  constructor(storage) {
    this.storage = storage;
    this.endings = [];
    this.longestStreaks = Object.create(null);
    this.legacyLongestStreak = 0;
    try {
      this.storage ??= globalThis.localStorage;
      const saved = JSON.parse(this.storage?.getItem(HISTORY_KEY) || '{}');
      // The old global record has no tolerance attached. Retain it without
      // incorrectly awarding it to the currently selected (or every) tolerance.
      for (const value of [saved.longestStreak, saved.legacyLongestStreak]) {
        if (validStreak(value)) this.legacyLongestStreak = Math.max(this.legacyLongestStreak, value);
      }
      for (const [key, streak] of Object.entries(saved.longestStreaks || {})) {
        const tolerance = Number(key);
        if (validTolerance(tolerance) && validStreak(streak)) this.longestStreaks[tolerance] = streak;
      }
      if (Array.isArray(saved.endings)) this.endings = saved.endings.filter(validRecord).slice(0, HISTORY_LIMIT);
      // Old finished games do have a saved tolerance, so their records can be
      // recovered accurately. New records separate total moves from the streak.
      for (const ending of this.endings) this.rememberStreak(ending.tolerance, ending.streak ?? ending.safeMoves);
    } catch { /* The app also works without browser storage. */ }
  }

  save() {
    try { this.storage?.setItem(HISTORY_KEY, JSON.stringify({ longestStreaks: this.longestStreaks, legacyLongestStreak: this.legacyLongestStreak, endings: this.endings })); } catch { /* Keep the in-memory history when storage is full or unavailable. */ }
  }

  getLongestStreak(tolerance) {
    return this.longestStreaks[tolerance] ?? 0;
  }

  rememberStreak(tolerance, streak) {
    if (!validTolerance(tolerance) || !validStreak(streak) || streak <= this.getLongestStreak(tolerance)) return false;
    this.longestStreaks[tolerance] = streak;
    return true;
  }

  updateStreak(tolerance, streak) {
    if (this.rememberStreak(tolerance, streak)) this.save();
  }

  record(decision, { finalFen, lastMove, outcome, safeMoves, attempt, streak = safeMoves }) {
    if (!decision) return;
    this.endings.unshift({
      ...decision, finalFen, lastMove, outcome, safeMoves, attempt, streak,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      endedAt: new Date().toISOString(),
    });
    this.endings.length = Math.min(this.endings.length, HISTORY_LIMIT);
    this.rememberStreak(decision.tolerance, streak);
    this.save();
  }
}

export function previewAlternative(ending, uci) {
  const position = new Chess(ending.beforeFen);
  position.move(fromUci(uci));
  return position.fen();
}
