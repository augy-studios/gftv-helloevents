// The ticket tiers in the edit form's Price section (migrations/008): one
// card per tier, with its name, price and benefits (one per line), up to
// MAX_TIERS. From the second tier on, a card can include the benefits of
// the tier before it, and says how the event page shows them: listed again
// in full, or as "Everything in <previous tier>, plus:".
//
// The server checks every field again (api/_lib/event-rules.js readTiers)
// and drops a card left wholly blank.
//
// Each tier can also take its own ways to pay (migrations/016): any of on the
// day, a payment link and a QR code, none ticked for the event's own (the
// Payment section), with its own link and QR code in place of the event's.
// A tier keeps an id (made here for a new one), by which the server keeps
// its QR code: that is uploaded on its own (api/manage/payment-qr.js), once
// the tier has saved.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement, withBusy } from './ui.js';
import { iconNode } from './icons.js';
import { post } from './api.js';
import { qrPicture } from './picture-file.js';

const MAX_TIERS = 10;
const DISPLAYS = ['reference', 'full'];
const METHODS = ['onsite', 'link', 'qr'];
// The open event ({ id }), or null for one not saved yet, and what to do
// with an answer that changes the payment problems.
let currentEvent = () => null;
let onPaymentChange = () => {};

// A new tier's id, as the server takes it: "t-" and ten letters or digits.
function newTierId() {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = crypto.getRandomValues(new Uint8Array(10));
  return `t-${[...random].map((value) => letters[value % letters.length]).join('')}`;
}

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

// A card's link field shows with "Payment link" ticked, and its QR code with
// "QR code" ticked; the QR code's buttons once the tier has saved.
function syncPay(card) {
  card.querySelector('.tier-pay-link').hidden = !input(card, 'pay-link').checked;
  card.querySelector('.tier-pay-qr').hidden = !input(card, 'pay-qr').checked;
  const url = card.dataset.qrUrl;
  card.querySelector('.tier-qr-preview').hidden = !url;
  card.querySelector('.tier-qr-remove').hidden = !url;
  if (url && card.querySelector('.tier-qr-preview img').getAttribute('src') !== url) {
    card.querySelector('.tier-qr-preview img').src = url;
  }
  card.querySelector('.tier-qr-pick').hidden = currentEvent() === null;
}

// Uploads (or, with remove, takes off) a card's QR code, then shows every
// tier's QR code and the payment problems as the server now has them.
async function uploadTierQr(card, body, button) {
  const errorBox = card.querySelector('.tier-qr-error');
  errorBox.textContent = '';
  await withBusy(button, errorBox, async () => {
    const data = await post('/api/manage/payment-qr', { id: currentEvent().id, tier: input(card, 'id').value, ...body });
    for (const each of data.event.tierQrUrls) {
      const match = [...list().children].find((other) => input(other, 'id').value === each.id);
      if (match) {
        match.dataset.qrUrl = each.paymentQrUrl;
        syncPay(match);
      }
    }
    onPaymentChange(data.event.paymentProblems);
  });
}

// A card's own ways to pay: three boxes, its link, and its QR code.
function payPart() {
  const qrInput = createElement('input', { type: 'file', accept: 'image/*', class: 'visually-hidden tier-qr-file' });
  return createElement('div', { class: 'span-2 tier-pay' }, [
    createElement('p', { class: 'tier-pay-title', i18n: 'manage.field.tierPayment' }),
    createElement('div', { class: 'payment-methods' }, METHODS.map((method) => createElement('label', { class: 'check' }, [
      createElement('input', { type: 'checkbox', 'data-key': `pay-${method}` }),
      createElement('span', { i18n: `manage.payment.${method}` }),
    ]))),
    createElement('p', { class: 'field-hint', i18n: 'manage.hint.tierPayment' }),
    createElement('label', { class: 'field payment-indent tier-pay-link' }, [
      createElement('span', { i18n: 'manage.field.tierPaymentLink' }),
      createElement('input', { type: 'url', 'data-key': 'paymentLink', maxlength: 500, placeholder: 'https://' }),
    ]),
    createElement('div', { class: 'field payment-indent tier-pay-qr' }, [
      createElement('span', { i18n: 'manage.field.tierPaymentQr' }),
      createElement('div', { class: 'pay-qr-preview tier-qr-preview' }, [createElement('img', { alt: '' })]),
      createElement('p', { class: 'field-hint', i18n: 'manage.hint.tierPaymentQr' }),
      createElement('div', { class: 'actions inline' }, [
        createElement('label', { class: 'btn btn-small file-btn tier-qr-pick' }, [iconNode('image'), createElement('span', { i18n: 'manage.payment-qr-choose' }), qrInput]),
        createElement('button', { class: 'btn btn-small btn-quiet tier-qr-remove', type: 'button' }, [createElement('span', { i18n: 'manage.payment-qr-remove' })]),
      ]),
      createElement('div', { class: 'callout danger tier-qr-error', role: 'alert' }),
    ]),
  ]);
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
      payPart(),
    ]),
    createElement('input', { type: 'hidden', 'data-key': 'id' }),
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
  let id = values.id;
  if (typeof id !== 'string' || !/^t-[a-z0-9]{4,16}$/.test(id)) {
    id = newTierId();
  }
  input(card, 'id').value = id;
  let methods = [];
  if (Array.isArray(values.paymentMethods)) {
    methods = values.paymentMethods;
  }
  for (const method of METHODS) {
    input(card, `pay-${method}`).checked = methods.includes(method);
  }
  let link = values.paymentLink;
  if (link === null || link === undefined) {
    link = '';
  }
  input(card, 'paymentLink').value = link;
  let qrUrl = values.paymentQrUrl;
  if (!qrUrl) {
    qrUrl = '';
  }
  card.dataset.qrUrl = qrUrl;
  for (const method of METHODS) {
    input(card, `pay-${method}`).addEventListener('change', () => syncPay(card));
  }
  card.querySelector('.tier-qr-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || !currentEvent()) {
      return;
    }
    const pick = card.querySelector('.tier-qr-pick');
    try {
      await uploadTierQr(card, { image: await qrPicture(file) }, pick);
    } catch (error) {
      card.querySelector('.tier-qr-error').textContent = translate(`error.${error.code}`);
    }
  });
  card.querySelector('.tier-qr-remove').addEventListener('click', (event) => {
    uploadTierQr(card, { remove: true }, event.currentTarget);
  });
  syncPay(card);

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
      id: input(card, 'id').value,
      name: input(card, 'name').value,
      price: input(card, 'price').value,
      benefits: input(card, 'benefits').value,
      includesPrevious,
      previousDisplay: input(card, 'previousDisplay').value,
      paymentMethods: METHODS.filter((method) => input(card, `pay-${method}`).checked),
      paymentLink: input(card, 'paymentLink').value,
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

// Wires the Add button once. getEvent: the open event ({ id }), or null for
// a new one not saved yet; onProblems: called with the payment problems
// after a tier's QR code changes.
export function startTiers({ getEvent = () => null, onProblems = () => {} } = {}) {
  currentEvent = getEvent;
  onPaymentChange = onProblems;
  byId('tierAdd').addEventListener('click', addTier);
}

// After the event first saves, the QR code buttons can show.
export function syncTierPayment() {
  for (const card of list().children) {
    syncPay(card);
  }
}

// Redraws the wording in the reader's language, keeping what was typed.
export function relabelTiers() {
  renumber();
}
