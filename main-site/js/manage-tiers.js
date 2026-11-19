// The ticket tiers in the edit form's Price section (migrations/008): one
// card per tier, with its name, price and benefits (one per line), up to
// MAX_TIERS. From the second tier on, a card can include the benefits of
// the tier before it, and says how the event page shows them: listed again
// in full, or as "Everything in <previous tier>, plus:".
//
// The server checks every field again (api/_lib/event-rules.js readTiers)
// and drops a card left wholly blank.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';

const MAX_TIERS = 10;
const DISPLAYS = ['reference', 'full'];

const byId = (id) => document.getElementById(id);
const list = () => byId('tierList');

// Tells the edit form the tiers changed without a field being left (a card
// removed), so it autosaves them.
export const TIERS_CHANGED = 'tiers-changed';
function announceChange() {
  list().dispatchEvent(new CustomEvent(TIERS_CHANGED, { bubbles: true }));
}

// The input, textarea or select for key in a card.
function input(card, key) {
  return card.querySelector(`[data-key="${key}"]`);
}

// The name a card shows for the tier before it: what was typed, or "Tier 1".
function tierName(card, index) {
  const name = input(card, 'name').value.trim();
  if (name) {
    return name;
  }
  return translate('manage.tier-number', { number: index + 1 });
}

// Numbers the cards, names their Remove buttons, words each "includes" box
// and display choice after the tier before it, shows those only from the
// second card on (and the choice only while the box is ticked), and hides
// Add once the list is full.
function renumber() {
  const cards = [...list().children];
  cards.forEach((card, index) => {
    const number = index + 1;
    card.querySelector('.tier-title').textContent = translate('manage.tier-number', { number });
    card.querySelector('.tier-remove').setAttribute('aria-label', translate('manage.tier-remove-named', { number }));
    const previous = cards[index - 1];
    card.querySelector('.tier-includes-field').hidden = !previous;
    if (!previous) {
      card.querySelector('.tier-display-field').hidden = true;
      return;
    }
    const previousName = tierName(previous, index - 1);
    card.querySelector('.tier-includes-label').textContent = translate('manage.field.includesPrevious', { tier: previousName });
    const display = input(card, 'previousDisplay');
    display.querySelector('[value="reference"]').textContent = translate('manage.tier-display.reference', { tier: previousName });
    display.querySelector('[value="full"]').textContent = translate('manage.tier-display.full');
    card.querySelector('.tier-display-field').hidden = !input(card, 'includesPrevious').checked;
  });
  byId('tierAdd').hidden = cards.length >= MAX_TIERS;
}

// One tier's card, filled with values (a tier as the server sends it, or a
// new one's blanks).
function tierCard(values) {
  const removeButton = createElement('button', { class: 'btn btn-small btn-quiet tier-remove', type: 'button' }, [
    iconNode('trash'),
    createElement('span', { class: 'btn-label', i18n: 'security.remove' }),
  ]);
  const display = createElement('select', { 'data-key': 'previousDisplay' }, DISPLAYS.map((value) => createElement('option', { value })));
  const card = createElement('div', { class: 'location-card tier-edit-card' }, [
    createElement('div', { class: 'row between' }, [createElement('h3', { class: 'section-label tier-title' }), removeButton]),
    createElement('div', { class: 'form-grid' }, [
      createElement('label', { class: 'field' }, [
        createElement('span', { i18n: 'manage.field.tierName' }),
        createElement('input', { type: 'text', 'data-key': 'name', maxlength: 60, autocomplete: 'off' }),
      ]),
      createElement('label', { class: 'field' }, [
        createElement('span', { i18n: 'manage.field.tierPrice' }),
        createElement('input', { type: 'number', 'data-key': 'price', min: 0, step: '0.01', inputmode: 'decimal' }),
      ]),
      createElement('label', { class: 'field span-2' }, [
        createElement('span', { i18n: 'manage.field.tierBenefits' }),
        createElement('textarea', { 'data-key': 'benefits', rows: 3, maxlength: 4200 }),
        createElement('span', { class: 'field-hint', i18n: 'manage.hint.tierBenefits' }),
      ]),
      createElement('label', { class: 'check span-2 tier-includes-field' }, [
        createElement('input', { type: 'checkbox', 'data-key': 'includesPrevious' }),
        createElement('span', { class: 'tier-includes-label' }),
      ]),
      createElement('label', { class: 'field span-2 tier-display-field' }, [
        createElement('span', { i18n: 'manage.field.previousDisplay' }),
        display,
      ]),
    ]),
  ]);

  for (const key of ['name', 'price', 'benefits']) {
    let value = values[key];
    if (value === null || value === undefined) {
      value = '';
    }
    input(card, key).value = value;
  }
  input(card, 'includesPrevious').checked = values.includesPrevious === true;
  let shown = values.previousDisplay;
  if (!DISPLAYS.includes(shown)) {
    shown = 'reference';
  }
  display.value = shown;

  // The next card's wording follows this tier's name as it is typed.
  input(card, 'name').addEventListener('input', renumber);
  input(card, 'includesPrevious').addEventListener('change', renumber);
  removeButton.addEventListener('click', () => {
    let next = card.nextElementSibling;
    if (!next) {
      next = card.previousElementSibling;
    }
    card.remove();
    renumber();
    if (next) {
      input(next, 'name').focus();
    } else {
      byId('tierAdd').focus();
    }
    announceChange();
  });
  return card;
}

// Replaces the cards with these tiers (as the server sends them).
export function setTiers(tiers) {
  list().replaceChildren(...tiers.map((tier) => tierCard(tier)));
  renumber();
}

// The cards' values, in order, as the server takes them. The first tier
// never includes another.
export function readTiers() {
  return [...list().children].map((card, index) => {
    let includesPrevious = false;
    if (index > 0) {
      includesPrevious = input(card, 'includesPrevious').checked;
    }
    return {
      name: input(card, 'name').value,
      price: input(card, 'price').value,
      benefits: input(card, 'benefits').value,
      includesPrevious,
      previousDisplay: input(card, 'previousDisplay').value,
    };
  });
}

// A new, empty card, ready to type in. It lists only its own benefits until
// the editor ticks "Includes everything in ..." (then naming that tier,
// unless they pick listing them in full).
export function addTier() {
  const card = tierCard({ includesPrevious: false, previousDisplay: 'reference' });
  list().append(card);
  renumber();
  input(card, 'name').focus();
}

// Wires the Add button once.
export function startTiers() {
  byId('tierAdd').addEventListener('click', addTier);
}

// Redraws the wording in the reader's language, keeping what was typed.
export function relabelTiers() {
  renumber();
}
