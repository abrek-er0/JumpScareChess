export function formatCentipawnChange(change) {
  return `${change < 0 ? '−' : '+'}${Math.abs(change).toFixed(1)} cp`;
}

export function describeMove(loss, tolerance, chosen, best) {
  const kind = loss > tolerance ? 'bad' : loss === 0 ? 'good' : 'neutral';
  // A forced-mate score has no finite centipawn value. Do not display the
  // engine's internal mate sentinel as a fictitious 100,000-centipawn change.
  if (loss > 0 && (chosen.type === 'mate' || best.type === 'mate')) return { kind, headline: '−M' };
  return { kind, headline: formatCentipawnChange(-loss) };
}

// Root scores describe a candidate before it is played. Express the same score
// from the next side's perspective, including the move used toward a forced mate.
export function scoreAfterMove(score) {
  return { type: score.type, value: score.type === 'cp' ? -score.value : score.value > 0 ? 1 - score.value : -score.value };
}

export function evaluationDisplay(score, perspective) {
  if (!score) return { label: '—', description: 'Waiting for engine evaluation', whitePercent: 50, advantage: 'w' };
  if (score.type === 'mate') {
    const winner = score.value > 0 ? perspective : perspective === 'w' ? 'b' : 'w';
    const color = winner === 'w' ? 'White' : 'Black';
    return {
      label: score.value === 0 ? (winner === 'w' ? '1–0' : '0–1') : `${winner === 'w' ? '+' : '−'}M${Math.abs(score.value)}`,
      description: score.value === 0 ? `${color} wins by checkmate` : `${color} has a forced mate in ${Math.abs(score.value)}`,
      whitePercent: winner === 'w' ? 100 : 0,
      advantage: winner,
    };
  }
  const whiteScore = score.value * (perspective === 'w' ? 1 : -1);
  const pawns = Math.abs(whiteScore / 100).toFixed(2);
  return {
    label: `${whiteScore > 0 ? '+' : whiteScore < 0 ? '−' : ''}${pawns}`,
    description: whiteScore === 0 ? 'Equal position' : `${whiteScore > 0 ? 'White' : 'Black'} is ahead by ${pawns} pawns`,
    // This is a visual advantage scale, not a claimed win probability.
    whitePercent: 50 + 45 * Math.tanh(whiteScore / 400),
    advantage: whiteScore < 0 ? 'b' : 'w',
  };
}

export class FloatingMoveFeedback {
  constructor() { this.element = null; this.timeout = null; }

  show(square, result, san) {
    this.clear();
    const rect = square.getBoundingClientRect();
    const element = document.createElement('div');
    element.className = `move-feedback move-feedback-${result.kind}`;
    element.setAttribute('aria-hidden', 'true');
    element.style.left = `${Math.max(90, Math.min(window.innerWidth - 90, rect.left + rect.width / 2))}px`;
    element.style.top = `${Math.max(85, rect.top + rect.height / 2 - 10)}px`;
    const headline = document.createElement('strong');
    headline.textContent = result.headline;
    element.append(headline);
    document.body.append(element);
    document.getElementById('move-feedback-status').textContent = `${san}: ${result.headline}.`;
    this.element = element;
    // Also remove the text on time when reduced-motion disables the animation.
    this.timeout = setTimeout(() => this.clear(), 1000);
  }

  clear() {
    clearTimeout(this.timeout);
    this.element?.remove();
    this.element = null;
    this.timeout = null;
  }
}
