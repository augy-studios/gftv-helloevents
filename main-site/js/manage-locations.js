// The "Where" section's locations on the edit form: one card per place, each
// labelled as the event's location, the meeting location, or a label the
// editor types, up to MAX_LOCATIONS.
//
// Pasting a Google Maps link into a card fills in its venue, street address,
// city and country (api/manage/place.js reads the link); the editor checks
// them before saving. The server checks every field again
// (api/_lib/event-rules.js readLocations), and the first location labelled
// as the event's is the one the feed cards show.

import { t as translate } from '../assets/i18n/i18n.js';
import { post } from './api.js';
import { createElement, withBusy } from './ui.js';
import { iconNode } from './icons.js';
import { fillCountrySelect } from './choices.js';

const MAX_LOCATIONS = 10;
const LABELS = ['event', 'meeting', 'custom'];
// A Google Maps link anywhere in what was pasted.
const MAPS_LINK = /(?:maps\.app\.goo\.gl\/|goo\.gl\/maps\/|google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6})/i;
const TEXT_KEYS = ['customLabel', 'venueName', 'venueAddress', 'city', 'mapsUrl'];

const byId = (id) => document.getElementById(id);
const list = () => byId('locationList');
// Gives each card's link input an id of its own, for its label.
let cardsMade = 0;

// A labelled text input for one field of a card.
function textField(key, labelKey, { maxLength, wide = false, type = 'text', placeholder } = {}) {
  let fieldClass = 'field';
  if (wide) {
    fieldClass = 'field span-2';
  }
  return createElement('label', { class: fieldClass, 'data-field': key }, [
    createElement('span', { i18n: labelKey }),
    createElement('input', { type, 'data-key': key, maxlength: maxLength, placeholder, autocomplete: 'off' }),
  ]);
}

// The input or select for key in a card.
function input(card, key) {
  return card.querySelector(`[data-key="${key}"]`);
}

// Shows the custom label's field only while the card is labelled "custom".
function syncCustomLabel(card) {
  card.querySelector('[data-field="customLabel"]').hidden = input(card, 'label').value !== 'custom';
}

// Numbers the cards ("Location 1", ...), names their Remove buttons, and
// hides Add once the list is full.
function renumber() {
  const cards = [...list().children];
  cards.forEach((card, index) => {
    const number = index + 1;
    card.querySelector('.location-title').textContent = translate('manage.location-number', { number });
    card.querySelector('.location-remove').setAttribute('aria-label', translate('manage.location-remove-named', { number }));
  });
  byId('locationAdd').hidden = cards.length >= MAX_LOCATIONS;
  byId('locationsEmpty').hidden = cards.length > 0;
}

// Reads the Google Maps link in a card and fills in the card from it. Fields
// the link says nothing about are left as they were.
async function fillFromLink(card) {
  const linkInput = input(card, 'mapsUrl');
  const link = linkInput.value.trim();
  const status = card.querySelector('.location-status');
  status.textContent = '';
  status.className = 'field-status location-status';
  if (!MAPS_LINK.test(link)) {
    return;
  }
  card.dataset.lookedUp = link;
  await withBusy(card.querySelector('.location-fill'), card.querySelector('.location-error'), async () => {
    const { place } = await post('/api/manage/place', { link });
    for (const key of ['venueName', 'venueAddress', 'city']) {
      if (place[key]) {
        input(card, key).value = place[key];
      }
    }
    if (place.country) {
      fillCountrySelect(input(card, 'country'), place.country);
    }
    linkInput.value = place.mapsUrl;
    card.dataset.lookedUp = place.mapsUrl;
    status.textContent = translate('manage.location-filled');
    status.classList.add('ok');
  });
}

// One location's card, filled with values (a location as the server sends
// it, or a new one's defaults).
function locationCard(values) {
  cardsMade += 1;
  const linkId = `location-link-${cardsMade}`;
  const labelSelect = createElement(
    'select',
    { 'data-key': 'label' },
    LABELS.map((label) => createElement('option', { value: label, i18n: `location.${label}` }))
  );
  const countrySelect = createElement('select', { 'data-key': 'country' });
  const fillButton = createElement('button', { class: 'btn location-fill', type: 'button' }, [
    iconNode('map'),
    createElement('span', { i18n: 'manage.location-fill' }),
  ]);
  const removeButton = createElement('button', { class: 'btn btn-small btn-quiet location-remove', type: 'button' }, [
    iconNode('trash'),
    createElement('span', { class: 'btn-label', i18n: 'security.remove' }),
  ]);

  const card = createElement('div', { class: 'location-card' }, [
    createElement('div', { class: 'row between' }, [createElement('h3', { class: 'section-label location-title' }), removeButton]),
    createElement('div', { class: 'form-grid' }, [
      createElement('label', { class: 'field' }, [createElement('span', { i18n: 'manage.field.locationLabel' }), labelSelect]),
      textField('customLabel', 'manage.field.customLabel', { maxLength: 60 }),
      createElement('div', { class: 'field span-2' }, [
        createElement('label', { class: 'field-label', for: linkId, i18n: 'manage.field.mapsUrl' }),
        createElement('div', { class: 'row' }, [
          createElement('input', {
            id: linkId,
            class: 'grow',
            type: 'text',
            inputmode: 'url',
            'data-key': 'mapsUrl',
            maxlength: 500,
            autocomplete: 'off',
            spellcheck: 'false',
            placeholder: 'https://maps.app.goo.gl/...',
          }),
          fillButton,
        ]),
        createElement('span', { class: 'field-hint', i18n: 'manage.hint.mapsUrl' }),
        createElement('p', { class: 'field-status location-status', role: 'status' }),
        createElement('div', { class: 'callout danger location-error', role: 'alert' }),
      ]),
      textField('venueName', 'manage.field.venueName', { maxLength: 160 }),
      textField('city', 'manage.field.city', { maxLength: 80 }),
      textField('venueAddress', 'manage.field.venueAddress', { maxLength: 300, wide: true }),
      createElement('label', { class: 'field' }, [createElement('span', { i18n: 'manage.field.country' }), countrySelect]),
    ]),
  ]);

  let label = values.label;
  if (!LABELS.includes(label)) {
    label = 'event';
  }
  labelSelect.value = label;
  for (const key of TEXT_KEYS) {
    let value = values[key];
    if (value === null || value === undefined) {
      value = '';
    }
    input(card, key).value = value;
  }
  fillCountrySelect(countrySelect, values.country);
  card.dataset.lookedUp = input(card, 'mapsUrl').value;
  syncCustomLabel(card);

  labelSelect.addEventListener('change', () => syncCustomLabel(card));
  fillButton.addEventListener('click', () => fillFromLink(card));
  const linkInput = input(card, 'mapsUrl');
  // A link pasted or typed in is read straight away; Fill in reads it again.
  linkInput.addEventListener('paste', () => setTimeout(() => fillFromLink(card), 0));
  linkInput.addEventListener('change', () => {
    if (linkInput.value.trim() !== card.dataset.lookedUp) {
      fillFromLink(card);
    }
  });
  removeButton.addEventListener('click', () => {
    let next = card.nextElementSibling;
    if (!next) {
      next = card.previousElementSibling;
    }
    card.remove();
    renumber();
    if (next) {
      next.querySelector('select').focus();
    } else {
      byId('locationAdd').focus();
    }
  });
  return card;
}

// Replaces the cards with these locations (as the server sends them).
export function setLocations(locations) {
  list().replaceChildren(...locations.map((location) => locationCard(location)));
  renumber();
}

// The cards' values, in order, as the server takes them.
export function readLocations() {
  return [...list().children].map((card) => {
    const location = { label: input(card, 'label').value, country: input(card, 'country').value };
    for (const key of TEXT_KEYS) {
      location[key] = input(card, key).value;
    }
    return location;
  });
}

// A new, empty card: the event's location when it is the first, the meeting
// location after that.
function addLocation() {
  let label = 'meeting';
  if (list().children.length === 0) {
    label = 'event';
  }
  const card = locationCard({ label });
  list().append(card);
  renumber();
  input(card, 'mapsUrl').focus();
}

// Wires the Add button once.
export function startLocations() {
  byId('locationAdd').addEventListener('click', addLocation);
}

// Redraws the cards in the reader's language, keeping what was typed.
export function relabelLocations() {
  setLocations(readLocations());
}
