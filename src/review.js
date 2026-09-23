import { Chess } from '../vendor/chess.js';
import { fromUci } from './engine.js';
import { previewAlternative } from './history.js';
import { formatCentipawnChange } from './feedback.js';

const $ = id => document.getElementById(id);
const outcomes = { blunder: 'Over tolerance', win: 'Checkmate · You won', loss: 'Checkmate', draw: 'Draw' };
const svgNamespace = 'http://www.w3.org/2000/svg';
const reviewLoss = loss => loss >= 90000 ? '−M' : formatCentipawnChange(-loss);

function copyWithSelection(fen) {
  const input = document.createElement('textarea');
  input.value = fen;
  input.readOnly = true;
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  // Keep the temporary field inside the modal so Safari can focus it.
  $('mistakes-dialog').append(input);
  try {
    input.focus();
    input.select();
    return document.execCommand?.('copy') === true;
  } finally {
    input.remove();
    $('copy-fen').focus();
  }
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function squareCenter(square, side) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return side === 'w' ? [file * 100 + 50, (7 - rank) * 100 + 50] : [(7 - file) * 100 + 50, rank * 100 + 50];
}

function arrowPath(uci, side) {
  const [x1, y1] = squareCenter(uci.slice(0, 2), side);
  const [x2, y2] = squareCenter(uci.slice(2, 4), side);
  const dx = x2 - x1;
  const dy = y2 - y1;
  // The marker joins the shaft at x=9 and ends at x=32. Stop the shaft
  // 23 units early so its rounded cap stays inside the head, not past its tip.
  const headLength = 32 - 9;
  // Knight moves take a right-angle route so their destinations are easy to read.
  if (Math.abs(dx * dy) === 20000 && Math.abs(dx) + Math.abs(dy) === 300) {
    return Math.abs(dx) > Math.abs(dy)
      ? `M ${x1 + Math.sign(dx) * 24} ${y1} L ${x2} ${y1} L ${x2} ${y2 - Math.sign(dy) * headLength}`
      : `M ${x1} ${y1 + Math.sign(dy) * 24} L ${x1} ${y2} L ${x2 - Math.sign(dx) * headLength} ${y2}`;
  }
  const length = Math.hypot(dx, dy);
  return `M ${x1 + dx / length * 24} ${y1 + dy / length * 24} L ${x2 - dx / length * headLength} ${y2 - dy / length * headLength}`;
}

function drawMoveArrows(element, ending, mode, selectedMove) {
  const layer = svgElement('svg', { class: 'review-arrows', viewBox: '0 0 800 800', 'aria-hidden': 'true' });
  const definitions = svgElement('defs');
  for (const kind of ['playable', 'played']) {
    const marker = svgElement('marker', { id: `review-arrow-${kind}`, markerWidth: 36, markerHeight: 36, refX: 9, refY: 18, orient: 'auto', markerUnits: 'userSpaceOnUse', viewBox: '0 0 36 36' });
    marker.append(svgElement('path', { d: 'M 2 2 L 32 18 L 2 34 L 9 18 Z', class: `arrowhead-${kind}` }));
    definitions.append(marker);
  }
  layer.append(definitions);
  const addArrow = (move, kind, focused = false) => {
    const arrow = svgElement('path', {
      d: arrowPath(move.uci, ending.side),
      class: `move-arrow move-arrow-${kind}${focused ? ' focused' : ''}`,
      'marker-end': `url(#review-arrow-${kind})`,
    });
    const title = svgElement('title');
    title.textContent = `${kind === 'played' ? 'You played' : 'Playable'}: ${move.san}`;
    arrow.append(title);
    layer.append(arrow);
  };

  // Alternative promotions can share a route; draw that route only once.
  // The list retains the separate promotion choices and their scores.
  if (mode !== 'played') {
    const routes = new Map(ending.alternatives.map(move => [move.uci.slice(0, 4), move]));
    for (const [route, move] of routes) {
      if (route !== selectedMove?.uci.slice(0, 4)) addArrow(move, 'playable');
    }
    if (selectedMove) addArrow(selectedMove, 'playable', true);
  }
  // Always draw the actual move last so its red arrow remains visible.
  addArrow(ending.played, 'played');
  element.append(layer);
}

function drawPosition(element, fen, side, highlight, small = false) {
  const game = new Chess(fen);
  const files = side === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = side === 'w' ? '87654321' : '12345678';
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = files[col] + ranks[row];
      const piece = game.get(square);
      const cell = document.createElement('span');
      cell.className = `square${(row + col) % 2 ? ' dark' : ''}`;
      if (highlight?.from === square || highlight?.to === square) cell.classList.add('last-move');
      if (piece) {
        const image = document.createElement('img');
        image.src = `assets/pieces/${piece.color}${piece.type.toUpperCase()}.svg`;
        image.alt = '';
        image.draggable = false;
        cell.append(image);
      }
      if (!small && (col === 0 || row === 7)) {
        if (col === 0) { const label = document.createElement('span'); label.className = 'rank'; label.textContent = ranks[row]; cell.append(label); }
        if (row === 7) { const label = document.createElement('span'); label.className = 'file'; label.textContent = files[col]; cell.append(label); }
      }
      fragment.append(cell);
    }
  }
  element.replaceChildren(fragment);
  if (!small) element.setAttribute('aria-label', `Reviewed position, ${side === 'w' ? 'White' : 'Black'} at the bottom. ${fen}`);
}

export class MistakesReview {
  constructor(history) {
    this.history = history;
    this.selected = null;
    this.currentFen = null;
    $('my-mistakes').addEventListener('click', () => this.open());
    $('copy-fen').addEventListener('click', () => this.copyFen());
    $('close-mistakes').addEventListener('click', () => $('mistakes-dialog').close());
    $('mistakes-dialog').addEventListener('click', event => {
      if (event.target !== $('mistakes-dialog')) return;
      const rect = $('mistakes-dialog').getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('mistakes-dialog').close();
    });
  }

  async copyFen() {
    if (!this.currentFen) return;
    const fen = this.currentFen;
    try {
      if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(fen);
      else if (!copyWithSelection(fen)) throw new Error('Clipboard unavailable');
      if (this.currentFen === fen) $('copy-fen-label').textContent = 'Copied!';
    } catch {
      try {
        if (copyWithSelection(fen)) {
          if (this.currentFen === fen) $('copy-fen-label').textContent = 'Copied!';
          return;
        }
      } catch { /* Manual copy is still possible when browser permissions block both APIs. */ }
      globalThis.window?.prompt?.('Copy FEN:', fen);
      if (this.currentFen === fen) $('copy-fen-label').textContent = 'Copy FEN';
    }
  }

  open() {
    const endings = this.history.endings;
    $('mistakes-empty').hidden = endings.length > 0;
    $('mistakes-content').hidden = endings.length === 0;
    $('ending-list').replaceChildren(...endings.map((ending, index) => {
      const button = document.createElement('button');
      button.className = 'ending-card';
      button.dataset.endingId = ending.id;
      button.setAttribute('aria-label', `Game ${endings.length - index}, ${outcomes[ending.outcome]}, ${ending.played.san}, ${ending.safeMoves} safe moves`);
      const thumbnail = document.createElement('span');
      thumbnail.className = 'board ending-thumbnail';
      thumbnail.setAttribute('aria-hidden', 'true');
      drawPosition(thumbnail, ending.finalFen, ending.side, ending.lastMove, true);
      const label = document.createElement('strong');
      label.textContent = index === 0 ? 'Latest game' : `Game ${endings.length - index}`;
      const move = document.createElement('span');
      move.className = 'ending-card-move';
      move.textContent = ending.played.san;
      button.append(thumbnail, label, move);
      button.addEventListener('click', () => this.select(ending));
      return button;
    }));
    if (endings.length) this.select(endings[0]);
    $('mistakes-dialog').showModal();
  }

  select(ending) {
    this.selected = ending;
    for (const button of $('ending-list').children) button.setAttribute('aria-pressed', button.dataset.endingId === ending.id);
    $('review-outcome').textContent = outcomes[ending.outcome];
    $('review-outcome').dataset.outcome = ending.outcome;
    $('review-played').textContent = `You played ${ending.played.san}`;
    const loss = ending.loss >= 90000 ? '−M · Forced mate missed or allowed' : reviewLoss(ending.loss);
    $('review-settings').textContent = `${loss} · ${ending.safeMoves} safe ${ending.safeMoves === 1 ? 'move' : 'moves'} · Depth ${ending.depth}`;
    $('alternatives-title').textContent = 'Moves within tolerance';
    $('alternatives-description').textContent = `Best ${ending.alternatives.length} ${ending.alternatives.length === 1 ? 'move' : 'moves'} below ${ending.tolerance} cp loss`;
    const reset = document.createElement('button');
    reset.className = 'alternative-move alternative-reset';
    reset.dataset.mode = 'before';
    reset.setAttribute('aria-label', 'Reset to position before your move');
    const resetIcon = document.createElement('span');
    resetIcon.className = 'alternative-rank alternative-reset-icon';
    resetIcon.textContent = '↺';
    resetIcon.setAttribute('aria-hidden', 'true');
    const resetLabel = document.createElement('strong'); resetLabel.textContent = 'Reset';
    reset.append(resetIcon, resetLabel);
    reset.addEventListener('click', () => this.showPosition('before'));

    const alternatives = ending.alternatives.map((move, index) => {
      const button = document.createElement('button');
      button.className = 'alternative-move';
      button.dataset.mode = 'alternative';
      button.dataset.uci = move.uci;
      button.setAttribute('aria-label', `Preview ${move.san}, ${reviewLoss(move.loss)}`);
      const rank = document.createElement('span'); rank.className = 'alternative-rank'; rank.textContent = String(index + 1).padStart(2, '0');
      const san = document.createElement('strong'); san.textContent = move.san;
      const score = document.createElement('span'); score.className = 'alternative-loss'; score.textContent = reviewLoss(move.loss);
      button.append(rank, san, score);
      button.addEventListener('click', () => this.showPosition('alternative', move));
      return button;
    });

    const played = document.createElement('button');
    played.className = 'alternative-move alternative-played';
    played.dataset.mode = 'played';
    const playedLabel = ending.outcome === 'blunder' ? 'Wrong move' : 'Your move';
    played.setAttribute('aria-label', `Preview ${playedLabel.toLowerCase()} ${ending.played.san}, ${reviewLoss(ending.loss)}`);
    const playedIcon = document.createElement('span');
    playedIcon.className = 'alternative-rank';
    playedIcon.textContent = ending.outcome === 'blunder' ? '×' : '↗';
    playedIcon.setAttribute('aria-hidden', 'true');
    const playedSan = document.createElement('strong'); playedSan.textContent = `${playedLabel} · ${ending.played.san}`;
    const playedScore = document.createElement('span'); playedScore.className = 'alternative-loss'; playedScore.textContent = reviewLoss(ending.loss);
    played.append(playedIcon, playedSan, playedScore);
    played.addEventListener('click', () => this.showPosition('played'));
    $('alternative-list').replaceChildren(reset, ...alternatives, played);
    if (!ending.alternatives.length) $('alternatives-description').textContent = 'No legal moves below this tolerance.';
    this.showPosition('before');
  }

  showPosition(mode, move) {
    const ending = this.selected;
    if (!ending) return;
    const previewMove = mode === 'played' ? ending.played : move;
    const fen = mode === 'before' ? ending.beforeFen : previewAlternative(ending, previewMove.uci);
    this.currentFen = fen;
    $('copy-fen-label').textContent = 'Copy FEN';
    const highlight = mode === 'before' ? null : fromUci(previewMove.uci);
    drawPosition($('review-board'), fen, ending.side, highlight);
    drawMoveArrows($('review-board'), ending, mode, move);
    const playable = mode === 'played' ? '' : ` Playable moves in green: ${ending.alternatives.map(candidate => candidate.san).join(', ') || 'none'}.`;
    $('review-board').setAttribute('aria-label', `${$('review-board').getAttribute('aria-label')} Red arrow: you played ${ending.played.san}.${playable}`);
    $('playable-arrow-legend').hidden = mode === 'played';
    for (const button of $('alternative-list').children) button.setAttribute('aria-pressed', button.dataset.mode === mode && (mode !== 'alternative' || button.dataset.uci === move.uci));
    $('review-caption').textContent = mode === 'before' ? `Position before ${ending.played.san}` : mode === 'played' ? `You played ${ending.played.san} · ${reviewLoss(ending.loss)}` : `${move.san} · ${reviewLoss(move.loss)}`;
  }
}
