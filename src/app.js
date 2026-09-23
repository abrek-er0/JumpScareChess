import { Chess } from '../vendor/chess.js';
import { StockfishEngine, toUci, moveLoss, prepareAnalysis } from './engine.js';
import { GameAudio } from './audio.js';
import { PracticeHistory, captureDecision } from './history.js';
import { MistakesReview } from './review.js';
import { choosePlayerSide, prepareComputerTurn } from './turns.js';
import { describeMove, evaluationDisplay, scoreAfterMove, FloatingMoveFeedback } from './feedback.js';
import { OpeningBook } from './openings.js';
import { TurnClock } from './pressure.js';

const $ = id => document.getElementById(id);
const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const pieceUrl = (color, type) => `assets/pieces/${color}${type.toUpperCase()}.svg`;
const audio = new GameAudio();
const floatingFeedback = new FloatingMoveFeedback();
const practiceHistory = new PracticeHistory();
const openings = new OpeningBook();
new MistakesReview(practiceHistory);
let engine = new StockfishEngine();
let game = new Chess();
let sidePreference = 'random';
let side = 'w';
let tolerance = 50;
let depth = 11;
let pressureMode = false;
let selected = null;
let legalTargets = [];
let phase = 'loading';
let analysis = null;
let attempt = 1;
let safeMoves = 0;
let toleranceStreak = 0;
let streakEligible = true;
let lastDecision = null;
let endingSaved = false;
let version = 0;
let controller = new AbortController();
let restartTimer = null;
let promotionMoves = null;
let drag = null;
let suppressClick = false;
const cache = new Map();
const pressureClock = new TurnClock({
  onTick: seconds => {
    $('pressure-time').textContent = `${seconds}s`;
    $('pressure-time').classList.toggle('urgent', seconds <= 3);
  },
  onExpire: () => pressureTimeout(),
  onRunChange: running => {
    $('pressure-control').classList.toggle('running', running);
    if (running) audio.startPressure();
    else audio.pausePressure();
  },
});

function resetPressureDisplay() {
  $('pressure-time').textContent = '10s';
  $('pressure-time').classList.remove('urgent');
}

try {
  const saved = JSON.parse(localStorage.getItem('jumpscare-preferences') || '{}');
  if (Number.isFinite(saved.tolerance)) tolerance = Math.max(10, Math.min(300, Math.round(saved.tolerance / 10) * 10));
  if (Number.isFinite(saved.depth)) depth = Math.max(6, Math.min(18, Math.round(saved.depth)));
  // The former default was on. Migrate that saved value once so existing
  // players see the new off-by-default behavior; later choices persist.
  pressureMode = saved.pressureDefaultVersion === 2 && saved.pressure === true;
  // Previous builds saved the old defaults as preferences. Update those once,
  // while retaining any values the player deliberately set elsewhere.
  if (saved.settingsDefaultVersion !== 2) {
    if (saved.tolerance === 80) tolerance = 50;
    if (saved.depth === 12) depth = 11;
  }
  if (['w', 'b', 'random'].includes(saved.side)) sidePreference = saved.side;
  // The original default was White. Migrate it once so existing local previews
  // pick up the new Random default while subsequent choices remain persistent.
  if (saved.side === 'w' && saved.sideDefaultVersion !== 2) sidePreference = 'random';
  audio.muted = saved.muted === true;
} catch { /* Preferences are optional, including in private browsing. */ }
audio.prepare();
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('keydown', () => audio.unlock(), { once: true });

function savePreferences() {
  try { localStorage.setItem('jumpscare-preferences', JSON.stringify({ tolerance, depth, side: sidePreference, sideDefaultVersion: 2, settingsDefaultVersion: 2, pressure: pressureMode, pressureDefaultVersion: 2, muted: audio.muted })); } catch { /* Storage can be disabled. */ }
}

function setStatus(message, hint, state = 'busy') {
  $('turn-status').textContent = message;
  $('board-hint').textContent = hint;
  $('turn-dot').className = `status-dot ${state}`;
  $('engine-dot').className = `status-dot ${state}`;
  $('engine-status').textContent = state === 'error' ? 'Engine unavailable' : state === 'busy' ? (phase === 'opponent' ? 'Stockfish 19 · Thinking' : 'Preparing your next move') : 'Stockfish 19 · Ready';
  $('move-label').textContent = state === 'error' ? 'Paused' : state === 'busy' ? (phase === 'opponent' ? 'Computer’s turn' : 'Getting ready') : 'Your move';
  $('retry').hidden = state !== 'error';
}

function syncControls() {
  for (const [id, value] of [['tolerance', tolerance], ['depth', depth]]) {
    const input = $(id);
    input.value = value;
    input.style.setProperty('--fill', `${(value - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
    $(`${id}-output`).value = value;
  }
  $('tolerance-description').textContent = tolerance <= 40 ? 'No room for error' : tolerance <= 120 ? 'Room to breathe' : 'Keep exploring';
  $('depth-description').textContent = depth <= 9 ? 'Quick' : depth <= 13 ? 'Balanced' : 'Thorough';
  $('board-depth').textContent = analysis?.depth ?? depth;
  $('your-color').textContent = side === 'w' ? 'White' : 'Black';
  $('your-piece').src = pieceUrl(side, 'p');
  $('evaluation-bar').dataset.side = side;
  document.querySelectorAll('.side-option[data-side]').forEach(button => {
    const active = button.dataset.side === sidePreference;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', active);
  });
  $('safe-moves').textContent = safeMoves;
  $('attempt').textContent = String(attempt).padStart(2, '0');
  $('longest-streak').textContent = streakEligible ? practiceHistory.getLongestStreak(tolerance) : '—';
  $('longest-streak').title = streakEligible ? `Longest streak at ${tolerance} cp tolerance` : 'This attempt does not count because tolerance changed mid-game';
  $('mistakes-count').textContent = practiceHistory.endings.length;
  $('sound-label').textContent = audio.muted ? 'Sound off' : 'Sound on';
  $('sound-toggle').setAttribute('aria-pressed', audio.muted);
  $('sound-toggle').setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  $('pressure-toggle').setAttribute('aria-pressed', pressureMode);
  $('pressure-toggle').setAttribute('aria-label', pressureMode ? 'Turn off pressure mode' : 'Turn on pressure mode');
  $('pressure-toggle').title = pressureMode ? 'Pressure mode on: 10 seconds per move after your first move' : 'Pressure mode off';
}

function setEvaluation(score, perspective = game.turn()) {
  const display = evaluationDisplay(score, perspective);
  $('evaluation-bar').style.setProperty('--white-share', `${display.whitePercent}%`);
  $('evaluation-bar').setAttribute('aria-label', `Evaluation: ${display.description}`);
  $('evaluation-bar').title = `${display.description}. Scores are from White’s perspective.`;
  $('evaluation-score').textContent = display.label;
  $('evaluation-score').dataset.advantage = display.advantage;
}

function renderBoard() {
  const focusedSquare = document.activeElement?.dataset.square;
  const history = game.history({ verbose: true });
  const last = history.at(-1);
  const files = side === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = side === 'w' ? '87654321' : '12345678';
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = files[col] + ranks[row];
      const piece = game.get(square);
      const target = legalTargets.some(move => move.to === square);
      const button = document.createElement('button');
      button.className = 'square';
      button.classList.toggle('dark', (row + col) % 2 === 1);
      button.classList.toggle('last-move', last?.from === square || last?.to === square);
      button.classList.toggle('selected', selected === square);
      button.classList.toggle('legal', target);
      button.classList.toggle('capture', target && !!piece);
      button.classList.toggle('selectable', phase === 'ready' && piece?.color === side);
      button.classList.toggle('in-check', piece?.type === 'k' && piece.color === game.turn() && game.isCheck());
      button.dataset.square = square;
      button.type = 'button';
      button.setAttribute('aria-label', `${square}${piece ? `, ${piece.color === 'w' ? 'White' : 'Black'} ${names[piece.type]}` : ', empty'}${target ? ', legal destination' : ''}`);
      button.setAttribute('aria-pressed', selected === square);
      button.setAttribute('aria-disabled', phase !== 'ready');
      if (piece) {
        const img = document.createElement('img');
        img.src = pieceUrl(piece.color, piece.type);
        img.alt = '';
        img.draggable = false;
        button.append(img);
      }
      if (col === 0) { const label = document.createElement('span'); label.className = 'rank'; label.textContent = ranks[row]; button.append(label); }
      if (row === 7) { const label = document.createElement('span'); label.className = 'file'; label.textContent = files[col]; button.append(label); }
      fragment.append(button);
    }
  }
  $('board').replaceChildren(fragment);
  $('board').setAttribute('aria-busy', phase !== 'ready');
  $('board').setAttribute('aria-label', `Chessboard, ${side === 'w' ? 'White' : 'Black'} at the bottom`);
  if (focusedSquare) $('board').querySelector(`[data-square="${focusedSquare}"]`)?.focus({ preventScroll: true });
}

function cancelWork() {
  pressureClock.stop();
  resetPressureDisplay();
  version++;
  controller.abort();
  controller = new AbortController();
  clearTimeout(restartTimer);
  floatingFeedback.clear();
  selected = null;
  legalTargets = [];
  promotionMoves = null;
  $('promotion').hidden = true;
  $('scare').hidden = true;
  clearDrag();
  return version;
}

async function getAnalysis(position, token) {
  const opening = openings.get(position);
  if (opening) return opening;
  const history = position.history({ verbose: true });
  const moves = history.map(toUci);
  const fen = history[0]?.before || position.fen();
  const searchDepth = depth;
  const key = `${searchDepth}:${fen}:${moves.join(' ')}`;
  if (cache.has(key)) return cache.get(key);
  const raw = await engine.analyze({
    fen, moves, depth: searchDepth, count: position.moves().length, signal: controller.signal,
    onProgress: current => {
      if (token === version) {
        const label = phase === 'opponent' ? 'Stockfish is thinking' : 'Preparing moves';
        $('turn-status').textContent = `${label} · depth ${Math.min(current, searchDepth)}/${searchDepth}`;
      }
    },
  });
  if (token !== version) return null;
  const result = { ...prepareAnalysis(position, raw), depth: searchDepth };
  cache.set(key, result);
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return result;
}

function showError(error, token) {
  if (token !== version || error.name === 'AbortError') return;
  pressureClock.stop();
  resetPressureDisplay();
  phase = 'error';
  setStatus('Could not prepare this position', error.message, 'error');
  renderBoard();
}

async function prepareTurn(token = version) {
  if (token !== version) return;
  if (finishIfOver()) return;
  if (game.history().length === 0) {
    // After the one-time file load, restarts and side switches take this fully
    // synchronous path. Neither side waits for a search or a rebuilt cache.
    const ready = openings.start(side);
    if (ready) { startOpening(ready); return; }
    phase = 'loading';
    analysis = null;
    setStatus('Loading opening moves…', '');
    renderBoard();
    try {
      await openings.load();
      if (token !== version) return;
      startOpening(openings.start(side));
    } catch (error) { showError(error, token); }
    return;
  }
  const computerTurn = game.turn() !== side;
  phase = computerTurn ? 'opponent' : 'preparing';
  analysis = null;
  setStatus(computerTurn ? 'Stockfish is thinking…' : 'Preparing your next move…', '');
  renderBoard();
  try {
    if (computerTurn) {
      const prepared = await prepareComputerTurn(game, {
        analyze: position => getAnalysis(position, token),
        isCurrent: () => token === version,
      });
      if (token !== version || !prepared) return;

      // Reveal the computer's move and enable already-analyzed player moves in
      // one synchronous update. Never show the new board followed by a search.
      game = prepared.position;
      audio.move();
      if (prepared.analysis) setEvaluation(prepared.analysis.best);
      if (!finishIfOver()) enablePlayerTurn(prepared.analysis);
    } else {
      // A depth change later in the game may require fresh analysis.
      const result = await getAnalysis(game, token);
      if (token !== version || !result) return;
      enablePlayerTurn(result);
    }
  } catch (error) { showError(error, token); }
}

function startOpening(opening) {
  game = opening.position;
  if (opening.move) setEvaluation(opening.analysis.best);
  enablePlayerTurn(opening.analysis);
  // Load the engine for later turns in the background. The initial board and
  // its complete evaluations are already usable without waiting for the WASM.
  engine.init().catch(() => {});
}

function enablePlayerTurn(preloaded) {
  analysis = preloaded;
  $('board-depth').textContent = preloaded.depth ?? depth;
  phase = 'ready';
  setStatus(game.isCheck() ? 'You’re in check. Find your move.' : 'Your move. Make it count.', '', 'ready');
  renderBoard();
  if (pressureMode && safeMoves > 0) {
    pressureClock.start();
    if ($('mistakes-dialog').open) pressureClock.pause();
  } else {
    pressureClock.stop();
    resetPressureDisplay();
  }
}

function restart({ increment = false } = {}) {
  const token = cancelWork();
  if (increment) attempt++;
  side = choosePlayerSide(sidePreference);
  game = new Chess();
  safeMoves = 0;
  toleranceStreak = 0;
  streakEligible = true;
  lastDecision = null;
  endingSaved = false;
  analysis = null;
  setEvaluation({ type: 'cp', value: 0 });
  syncControls();
  prepareTurn(token);
}

function finishIfOver() {
  if (!game.isGameOver()) return false;
  pressureClock.stop();
  resetPressureDisplay();
  setEvaluation(game.isCheckmate() ? { type: 'mate', value: 0 } : { type: 'cp', value: 0 });
  saveEnding(game.isCheckmate() ? (game.turn() === side ? 'loss' : 'win') : 'draw');
  phase = 'finished';
  let message = 'Draw. A fresh opening is next.';
  if (game.isCheckmate()) message = game.turn() === side ? 'Checkmate. A fresh opening is next.' : 'Checkmate. Beautifully played.';
  setStatus(message, 'Starting a new game…', 'ready');
  $('move-label').textContent = 'Game complete';
  renderBoard();
  restartTimer = setTimeout(() => restart({ increment: true }), 2200);
  return true;
}

function saveEnding(outcome) {
  if (endingSaved || !lastDecision) return;
  const lastMove = game.history({ verbose: true }).at(-1);
  practiceHistory.record(lastDecision, {
    finalFen: game.fen(), lastMove: { from: lastMove.from, to: lastMove.to },
    outcome, safeMoves, attempt, streak: lastDecision.streak,
  });
  endingSaved = true;
  syncControls();
}

function blunder(loss, chosen) {
  pressureClock.stop();
  resetPressureDisplay();
  phase = 'scare';
  saveEnding('blunder');
  $('scare-title').textContent = 'THAT’S A BLUNDER.';
  const forcedMateLost = analysis.best.type === 'mate' && analysis.best.value > 0 && !(chosen.type === 'mate' && chosen.value > 0);
  $('scare-detail').textContent = chosen.type === 'mate' && chosen.value < 0 ? 'You allowed a forced checkmate.' : forcedMateLost ? 'You let a forced checkmate slip away.' : `${Math.round(loss)} cp lost · Your tolerance is ${tolerance} cp`;
  $('scare').hidden = false;
  audio.buzz();
  renderBoard();
  restartTimer = setTimeout(() => restart({ increment: true }), 1900);
}

function pressureTimeout() {
  if (phase !== 'ready' || !pressureMode) return;
  phase = 'scare';
  $('scare-title').textContent = 'TIME’S UP.';
  $('scare-detail').textContent = 'Your 10 seconds ran out.';
  $('scare').hidden = false;
  audio.buzz();
  renderBoard();
  restartTimer = setTimeout(() => restart({ increment: true }), 1900);
}

function playMove(move) {
  if (phase !== 'ready' || !analysis) return;
  const chosen = analysis.scores.get(toUci(move));
  if (!chosen) return;
  pressureClock.stop();
  resetPressureDisplay();
  const loss = moveLoss(analysis.best, chosen);
  const feedback = describeMove(loss, tolerance, chosen, analysis.best);
  const token = version;
  lastDecision = captureDecision(game, analysis, move, { side, tolerance, depth: analysis.depth ?? depth });
  lastDecision.streak = toleranceStreak;
  game.move(move);
  setEvaluation(scoreAfterMove(chosen));
  floatingFeedback.show($('board').querySelector(`[data-square="${move.to}"]`), feedback, move.san);
  selected = null;
  legalTargets = [];
  if (loss > tolerance) { blunder(loss, chosen); return; }
  safeMoves++;
  toleranceStreak++;
  lastDecision.streak = toleranceStreak;
  if (streakEligible) practiceHistory.updateStreak(tolerance, toleranceStreak);
  syncControls();
  audio.move();
  if (finishIfOver()) return;
  // Feedback uses the preloaded scores immediately; all further analysis belongs
  // to the computer's turn, before its move is made visible.
  prepareTurn(token);
}

function chooseDestination(square) {
  const moves = legalTargets.filter(move => move.to === square);
  if (!moves.length) return false;
  if (moves.some(move => move.promotion)) {
    promotionMoves = moves;
    $('promotion-options').replaceChildren(...['q', 'r', 'b', 'n'].map(type => {
      const button = document.createElement('button');
      button.setAttribute('aria-label', `Promote to ${names[type]}`);
      button.innerHTML = `<img src="${pieceUrl(side, type)}" alt="" />`;
      button.addEventListener('click', () => {
        const move = promotionMoves?.find(candidate => candidate.promotion === type);
        promotionMoves = null;
        $('promotion').hidden = true;
        if (move) playMove(move);
      });
      return button;
    }));
    $('promotion').hidden = false;
    $('promotion-options').firstElementChild.focus();
  } else playMove(moves[0]);
  return true;
}

function clickSquare(square) {
  audio.unlock();
  if (phase !== 'ready' || promotionMoves) return;
  if (selected && chooseDestination(square)) return;
  if (square === selected) { selected = null; legalTargets = []; }
  else if (game.get(square)?.color === side) {
    selected = square;
    legalTargets = game.moves({ square, verbose: true });
  } else { selected = null; legalTargets = []; }
  renderBoard();
}

$('board').addEventListener('click', event => {
  if (suppressClick) { suppressClick = false; return; }
  const square = event.target.closest('[data-square]')?.dataset.square;
  if (square) clickSquare(square);
});

$('board').addEventListener('pointerdown', event => {
  audio.unlock();
  const square = event.target.closest('[data-square]')?.dataset.square;
  if (event.button !== 0 || phase !== 'ready' || promotionMoves || !square || game.get(square)?.color !== side) return;
  drag = { square, x: event.clientX, y: event.clientY, pointerId: event.pointerId, ghost: null };
});

window.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) {
    selected = drag.square;
    legalTargets = game.moves({ square: selected, verbose: true });
    renderBoard();
    drag.ghost = document.createElement('img');
    drag.ghost.className = 'drag-ghost';
    drag.ghost.src = pieceUrl(side, game.get(selected).type);
    const size = $('board').clientWidth / 8 * 0.88;
    drag.ghost.style.width = `${size}px`;
    drag.ghost.style.height = `${size}px`;
    document.body.append(drag.ghost);
    $('board').querySelector(`[data-square="${selected}"]`).classList.add('drag-origin');
  }
  if (drag.ghost) { drag.ghost.style.left = `${event.clientX}px`; drag.ghost.style.top = `${event.clientY}px`; }
});

function clearDrag() {
  drag?.ghost?.remove();
  drag = null;
  document.querySelector('.drag-origin')?.classList.remove('drag-origin');
}

window.addEventListener('pointerup', event => {
  if (!drag) return;
  const wasDragging = !!drag.ghost;
  const square = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-square]')?.dataset.square;
  clearDrag();
  if (wasDragging) {
    suppressClick = true;
    if (square) chooseDestination(square);
    renderBoard();
    setTimeout(() => { suppressClick = false; }, 0);
  }
});
window.addEventListener('pointercancel', clearDrag);

$('board').addEventListener('keydown', event => {
  const directions = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 };
  if (event.key in directions) {
    event.preventDefault();
    const buttons = [...$('board').children];
    const index = buttons.indexOf(document.activeElement);
    buttons[Math.max(0, Math.min(63, index + directions[event.key]))]?.focus();
  }
  if (event.key === 'Escape') { selected = null; legalTargets = []; renderBoard(); }
});

function closePromotion() { promotionMoves = null; $('promotion').hidden = true; renderBoard(); $('board').querySelector(`[data-square="${selected}"]`)?.focus(); }
$('cancel-promotion').addEventListener('click', closePromotion);
$('promotion').addEventListener('keydown', event => {
  if (event.key === 'Escape') closePromotion();
  if (event.key === 'Tab') {
    const buttons = [...$('promotion').querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
});

$('tolerance').addEventListener('input', event => {
  const nextTolerance = Number(event.target.value);
  if (nextTolerance !== tolerance) {
    toleranceStreak = 0;
    if (safeMoves > 0) streakEligible = false;
  }
  tolerance = nextTolerance;
  syncControls();
  savePreferences();
});
$('depth').addEventListener('input', event => {
  depth = Number(event.target.value);
  syncControls();
  if (phase !== 'scare' && phase !== 'finished') {
    cancelWork();
    phase = 'preparing';
    analysis = null;
    setStatus('Adjusting analysis depth…', 'Release the slider to prepare your moves.');
    renderBoard();
  }
});
$('depth').addEventListener('change', () => { savePreferences(); if (phase !== 'scare' && phase !== 'finished') prepareTurn(version); });
document.querySelectorAll('.side-option[data-side]').forEach(button => button.addEventListener('click', () => {
  audio.unlock();
  if (button.dataset.side === sidePreference) return;
  sidePreference = button.dataset.side;
  savePreferences();
  restart({ increment: game.history().length > 0 });
}));
$('sound-toggle').addEventListener('click', () => {
  audio.muted = !audio.muted;
  if (audio.muted) audio.pausePressure();
  else {
    audio.unlock();
    if (pressureClock.timer !== null) audio.startPressure();
  }
  syncControls();
  savePreferences();
});
$('pressure-toggle').addEventListener('click', () => {
  pressureMode = !pressureMode;
  syncControls();
  savePreferences();
  if (pressureMode && phase === 'ready' && safeMoves > 0) {
    pressureClock.start();
    if ($('mistakes-dialog').open) pressureClock.pause();
  } else {
    pressureClock.stop();
    resetPressureDisplay();
  }
});
$('my-mistakes').addEventListener('click', () => pressureClock.pause());
$('mistakes-dialog').addEventListener('close', () => {
  if (pressureMode && phase === 'ready' && safeMoves > 0) pressureClock.resume();
});
$('retry').addEventListener('click', () => { cancelWork(); engine.destroy(); engine = new StockfishEngine(); prepareTurn(version); });
window.addEventListener('pagehide', () => engine.destroy(), { once: true });

restart();
