import { Chess } from '../vendor/chess.js';
import { MistakesReview } from '../src/review.js';

const output = typeof print === 'function' ? print : console.log;
let count = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
function test(name, run) { run(); count++; output(`PASS ${name}`); }

// Minimal DOM surface for exercising the review's real click handlers without
// a browser or engine. These checks cover behavior, not browser layout.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.classList = { add: name => { this.className += ` ${name}`; } };
  }
  append(...nodes) { this.children.push(...nodes.flatMap(node => node.tagName === '#fragment' ? node.children : [node])); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  click() { this.listeners.get('click')?.({ target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const ids = ['my-mistakes', 'close-mistakes', 'mistakes-dialog', 'mistakes-empty', 'mistakes-content', 'ending-list', 'review-outcome', 'review-played', 'review-settings', 'alternatives-title', 'alternatives-description', 'alternative-list', 'review-board', 'playable-arrow-legend', 'review-caption'];
const elements = new Map(ids.map(id => [id, new Element('div')]));
const $ = id => elements.get(id);
globalThis.document = {
  getElementById: id => $(id),
  createElement: tag => new Element(tag),
  createElementNS: (_, tag) => new Element(tag),
  createDocumentFragment: () => new Element('#fragment'),
};

function fixture(side = 'w') {
  const game = new Chess();
  if (side === 'b') game.move('e4');
  const beforeFen = game.fen();
  const played = side === 'w' ? { uci: 'f2f3', san: 'f3' } : { uci: 'f7f6', san: 'f6' };
  const move = game.move(played.san);
  return {
    id: side, side, outcome: 'blunder', tolerance: 30, depth: 12, safeMoves: 3, loss: 40.2,
    beforeFen, finalFen: game.fen(), lastMove: { from: move.from, to: move.to }, played,
    alternatives: side === 'w'
      ? [{ uci: 'e2e4', san: 'e4', loss: 0 }, { uci: 'd2d4', san: 'd4', loss: 0.2 }]
      : [{ uci: 'e7e5', san: 'e5', loss: 0 }, { uci: 'd7d5', san: 'd5', loss: 0.2 }],
  };
}

const ending = fixture();
const original = JSON.stringify(ending);
const review = new MistakesReview({ endings: [ending] });
const rows = () => $('alternative-list').children;
const arrows = () => $('review-board').children.at(-1).children.filter(node => node.tagName === 'path');
function assertSelected(row) {
  assert(row.getAttribute('aria-pressed') === 'true', 'Clicked row is not selected');
  assert(rows().filter(button => button.getAttribute('aria-pressed') === 'true').length === 1, 'Multiple rows selected');
}
function assertPosition(fen, side) {
  const position = new Chess(fen);
  const files = side === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = side === 'w' ? '87654321' : '12345678';
  for (let index = 0; index < 64; index++) {
    const square = files[index % 8] + ranks[Math.floor(index / 8)];
    const piece = position.get(square);
    const image = $('review-board').children[index].children.find(child => child.tagName === 'img');
    assert(piece ? image?.src === `assets/pieces/${piece.color}${piece.type.toUpperCase()}.svg` : !image, `Wrong piece on ${square}`);
  }
}

test('Review opens with reset first, signed alternatives, and the wrong move last', () => {
  $('my-mistakes').click();
  assert($('mistakes-dialog').open, 'Review did not open');
  assert(rows().length === 4, 'Move rows are missing');
  assert(rows()[0].children[0].textContent === '↺' && rows()[0].children[1].textContent === 'Reset', 'Reset is not the first row');
  assert(rows()[1].children[2].textContent === '+0.0 cp' && rows()[2].children[2].textContent === '−0.2 cp', 'Alternative scores are unsigned or rounded');
  assert(rows().at(-1).className.includes('alternative-played') && rows().at(-1).children[1].textContent === 'Wrong move · f3', 'Wrong move is not the red bottom row');
  assert(rows().at(-1).children[2].textContent === '−40.2 cp', 'Wrong move is missing its signed loss');
  assertSelected(rows()[0]);
  assertPosition(ending.beforeFen, 'w');
  assert(arrows().length === 3, 'Initial move arrows are missing');
});

test('Alternative, wrong move, and reset clicks preview independent positions', () => {
  rows()[1].click();
  const alternative = new Chess(ending.beforeFen); alternative.move('e4');
  assertPosition(alternative.fen(), 'w');
  assertSelected(rows()[1]);
  assert($('review-caption').textContent === 'e4 · +0.0 cp', 'Alternative caption does not match its score');
  rows().at(-1).click();
  assertPosition(ending.finalFen, 'w');
  assertSelected(rows().at(-1));
  assert(arrows().length === 1 && arrows()[0].getAttribute('class').includes('move-arrow-played'), 'Wrong move should show only its red arrow');
  assert($('playable-arrow-legend').hidden, 'Hidden green arrows still have a legend');
  rows()[0].click();
  assertPosition(ending.beforeFen, 'w');
  assertSelected(rows()[0]);
  assert(arrows().length === 3 && !$('playable-arrow-legend').hidden, 'Reset did not restore all arrows');
  assert(JSON.stringify(ending) === original, 'Previews changed saved history');
});

test('Black move preview and reset keep the board orientation', () => {
  const black = fixture('b');
  review.select(black);
  rows().at(-1).click();
  assertPosition(black.finalFen, 'b');
  rows()[0].click();
  assertPosition(black.beforeFen, 'b');
  assertSelected(rows()[0]);
});

test('Empty alternatives still offer reset and the wrong move without a fake mate CP value', () => {
  review.select({ ...ending, alternatives: [], loss: 100000 });
  assert(rows().length === 2, 'Reset or played move was dropped when there were no alternatives');
  assert(rows()[1].children[2].textContent === '−M', 'Forced mate is shown as a fictitious centipawn value');
  rows()[1].click();
  assertPosition(ending.finalFen, 'w');
  rows()[0].click();
  assertPosition(ending.beforeFen, 'w');
});

test('A played move also in the alternatives selects only its clicked row', () => {
  const completed = { ...ending, outcome: 'draw', loss: 0, alternatives: [{ ...ending.played, loss: 0 }] };
  review.select(completed);
  assert(rows().at(-1).children[1].textContent === 'Your move · f3', 'A safe move was mislabeled as wrong');
  rows()[1].click();
  assertSelected(rows()[1]);
  rows().at(-1).click();
  assertSelected(rows().at(-1));
});

output(`${count} review interaction tests passed.`);
