export const ENGINE_NAME = 'Stockfish 19';

export function parseInfo(line) {
  const depth = line.match(/\bdepth (\d+)/);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!depth || !score || !pv || /\b(lowerbound|upperbound)\b/.test(line)) return null;
  return { depth: Number(depth[1]), type: score[1], value: Number(score[2]), pv: pv[1].trim().split(/\s+/) };
}

// Every UCI score is from the root side's perspective, including when playing Black.
export function scoreValue(score) {
  if (score.type === 'cp') return score.value;
  return score.value > 0 ? 100000 - score.value : -100000 - score.value;
}

export const toUci = move => move.from + move.to + (move.promotion || '');
export const fromUci = move => ({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move.length === 5 ? { promotion: move[4] } : {}) });

export function moveLoss(best, chosen) {
  // Keeping a forced mate is never a centipawn blunder just for taking longer.
  if (best.type === 'mate' && best.value > 0 && chosen.type === 'mate' && chosen.value > 0) return 0;
  return Math.max(0, scoreValue(best) - scoreValue(chosen));
}

export const COMPUTER_MOVE_RANGE_CP = 10;

export function computerMoveCandidates(analysis, rangeCp = 0) {
  const bestScore = scoreValue(analysis.best);
  return [...analysis.scores.entries()]
    .filter(([, score]) => {
      if (analysis.best.type === 'mate' || score.type === 'mate') return scoreValue(score) === bestScore;
      return bestScore - scoreValue(score) <= rangeCp;
    })
    .map(([move]) => move);
}

export function chooseBestMove(analysis, random = Math.random, rangeCp = 0) {
  const tiedMoves = computerMoveCandidates(analysis, rangeCp);
  if (!tiedMoves.length) throw new Error('Stockfish did not return a best move.');
  return tiedMoves[Math.floor(random() * tiedMoves.length)];
}

export class StockfishEngine {
  constructor({ singleThread = false } = {}) {
    this.worker = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.singleThread = singleThread;
    this.ready = null;
    this.threads = 1;
  }

  init() {
    if (!this.ready) {
      // The startup service worker can enable shared-memory isolation even on
      // GitHub Pages. Fall back when the browser cannot provide it.
      const threaded = !this.singleThread && globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
      this.threads = threaded ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      this.ready = this.load(threaded).catch(async error => {
        if (!threaded) throw error;
        this.worker?.terminate();
        this.threads = 1;
        await this.load(false);
      });
    }
    return this.ready;
  }

  load(threaded) {
    const filename = threaded ? 'stockfish-19.js' : 'stockfish-19-single.js';
    this.worker = new Worker(new URL(`../vendor/stockfish/${filename}`, import.meta.url));
    return new Promise((resolve, reject) => {
      let initialized = false;
      // The full NNUE engine is about 95 MiB. Allow its first download on a
      // slower connection; precomputed openings remain playable meanwhile.
      const timeout = setTimeout(() => reject(new Error('The engine download took too long. Check your connection and try again.')), 300000);
      this.worker.onerror = () => {
        clearTimeout(timeout);
        const error = new Error('Stockfish could not start. Reload the page to try again.');
        if (!initialized) reject(error);
        this.pending?.reject(error);
        this.pending = null;
      };
      this.worker.onmessage = event => {
        for (const line of String(event.data).split('\n')) {
          if (line === 'uciok') {
            this.send(`setoption name Threads value ${this.threads}`);
            this.send('setoption name Hash value 64');
            this.send('isready');
          } else if (line === 'readyok' && !initialized) {
            initialized = true;
            clearTimeout(timeout);
            resolve();
          } else if (line.startsWith('info string CRITICAL ERROR')) {
            const error = new Error('Stockfish rejected the position. Try a new game.');
            clearTimeout(timeout);
            if (!initialized) reject(error);
            this.pending?.reject(error);
            this.pending = null;
          } else if (line.startsWith('info ') && this.pending) {
            const info = parseInfo(line);
            if (info) {
              this.pending.scores.set(info.pv[0], info);
              this.pending.onProgress?.(info.depth);
            }
          } else if (line.startsWith('bestmove ') && this.pending) {
            const pending = this.pending;
            this.pending = null;
            clearTimeout(pending.timeout);
            pending.resolve({ bestmove: line.split(' ')[1], scores: pending.scores });
          }
        }
      };
      this.send('uci');
    });
  }

  send(command) { this.worker.postMessage(command); }

  stop() { if (this.pending) this.send('stop'); }

  async analyze({ moves = [], fen, depth, count = 1, signal, onProgress }) {
    await this.init();
    const run = this.queue.catch(() => {}).then(() => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      return new Promise((resolve, reject) => {
        const abort = () => this.stop();
        const clean = callback => value => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) reject(new DOMException('Cancelled', 'AbortError'));
          else callback(value);
        };
        this.pending = {
          scores: new Map(), onProgress,
          resolve: clean(resolve), reject: clean(reject),
          timeout: setTimeout(() => {
            // Never accept a partial search as an analysis at the selected depth.
            const pending = this.pending;
            this.stop();
            if (pending) pending.reject(new Error('Analysis took too long. Lower the engine depth and try again.'));
          }, 300000),
        };
        signal?.addEventListener('abort', abort, { once: true });
        this.send(`setoption name MultiPV value ${count}`);
        this.send(fen ? `position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}` : `position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
        this.send(`go depth ${depth}`);
      });
    });
    this.queue = run;
    return run;
  }

  destroy() {
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new DOMException('Cancelled', 'AbortError'));
    }
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}

export function prepareAnalysis(chess, raw) {
  const scores = new Map(raw.scores);
  const legalMoves = chess.moves({ verbose: true });
  for (const move of legalMoves) {
    const uci = toUci(move);
    const score = scores.get(uci);
    if (!score) throw new Error('A move is missing from the analysis. Try again.');
    // The full game history matters for threefold repetition and the fifty-move rule.
    chess.move(move);
    if (chess.isCheckmate()) scores.set(uci, { ...score, type: 'mate', value: 1 });
    else if (chess.isDraw()) scores.set(uci, { ...score, type: 'cp', value: 0 });
    chess.undo();
  }
  const best = [...scores.values()].sort((a, b) => scoreValue(b) - scoreValue(a))[0];
  return { scores, best, bestmove: best?.pv[0] };
}
