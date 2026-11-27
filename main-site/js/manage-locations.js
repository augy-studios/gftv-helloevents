// The "Where" section's locations on the edit form: one card per place, each
// labelled as the event's location, the meeting location, or a label the
// editor types, up to MAX_LOCATIONS.
//
// Pasting a Google Maps link into a card fills in its venue, street address,
// city and country (api/manage/place.js reads the link); the editor checks
// them before saving. Once filled in, two buttons copy the street address,
// or the full address (venue, street, city, country), to paste elsewhere.
// The server checks every field again
// (api/_lib/event-rules.js readLocations), and the first location labelled
// as the event's is the one the feed cards show.
//
// The same cards, in a list of their own, are a meal's places when it is
// held somewhere other than the event (manage-meals.js, createLocationList).

import { t as translate } from '../assets/i18n/i18n.js';
import { post } from './api.js';
import { createElement, withBusy, copyText } from './ui.js';
import { iconNode } from './icons.js';
import { fillCountrySelect } from './choices.js';

const MAX_LOCATIONS = 10;
const LABELS = ['event', 'meeting', 'custom'];
// A Google Maps link anywhere in what was pasted.
const MAPS_LINK = /(?:maps\.app\.goo\.gl\/|goo\.gl\/maps\/|google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6})/i;
const TEXT_KEYS = ['customLabel', 'venueName', 'venueAddress', 'city', 'mapsUrl'];

const byId = (id) => document.getElementById(id);

// Tells the edit form the locations changed without a field being left
// (filled in from a link, or a card removed), so it autosaves them.
export const LOCATIONS_CHANGED = 'locations-changed';
function announceChange(element) {
  element.dispatchEvent(new CustomEvent(LOCATIONS_CHANGED, { bubbles: true }));
}
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

// The full address on one line: venue, street address, city and country.
// The city and country are left out when the street address (or the city)
// already says them, as a Google Maps street address often ends with them.
// The venue's name is not looked in: "Kuala Lumpur Convention Centre" still
// gets ", Kuala Lumpur".
function fullAddress(card) {
  const country = input(card, 'country');
  let countryName = '';
  if (country.value) {
    countryName = country.selectedOptions[0].textContent;
  }
  const venue = input(card, 'venueName').value.trim();
  const place = [];
  for (const part of [input(card, 'venueAddress').value, input(card, 'city').value, countryName]) {
    const text = part.trim();
    if (text && !place.join(', ').toLowerCase().includes(text.toLowerCase())) {
      place.push(text);
    }
  }
  if (venue && !place.join(', ').toLowerCase().startsWith(venue.toLowerCase())) {
    place.unshift(venue);
  }
  return place.join(', ');
}

// Shows the copy buttons once Google Maps filled in the card (or a saved card
// has its link), while it has a street address.
function syncCopy(card) {
  let show = false;
  if (card.dataset.mapsFilled === 'yes' && input(card, 'mapsUrl').value.trim() !== '') {
    show = input(card, 'venueAddress').value.trim() !== '';
  }
  card.querySelector('.location-copy').hidden = !show;
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
  card.dataset.mapsFilled = '';
  syncCopy(card);
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
    card.dataset.mapsFilled = 'yes';
    syncCopy(card);
    status.textContent = translate('manage.location-filled');
    status.classList.add('ok');
    announceChange(card);
  });
}

// A list of location cards in the element list, with an Add button
// (addButton) and a note shown while it is empty (emptyNote, optional).
// labels: what a card can be labelled, the first being a new list's first
// card and the second every card after it. max: how many cards at most.
// title(number) and removeLabel(number): a card's heading and its Remove
// button's name. Returns { set, read, add, count, retitle, relabel }.
export function createLocationList({ list, addButton, emptyNote = null, labels, max, title, removeLabel }) {
  // Numbers the cards, names their Remove buttons, and hides Add once the
  // list is full.
  function renumber() {
    const cards = [...list.children];
    cards.forEach((card, index) => {
      const number = index + 1;
      card.querySelector('.location-title').textContent = title(number);
      card.querySelector('.location-remove').setAttribute('aria-label', removeLabel(number));
    });
    addButton.hidden = cards.length >= max;
    if (emptyNote) {
      emptyNote.hidden = cards.length > 0;
    }
  }

  // One location's card, filled with values (a location as the server sends
  // it, or a new one's defaults).
  function locationCard(values) {
    cardsMade += 1;
    const linkId = `location-link-${cardsMade}`;
    const labelSelect = createElement(
      'select',
      { 'data-key': 'label' },
      labels.map((label) => createElement('option', { value: label, i18n: `location.${label}` }))
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

    const copyAddressButton = createElement('button', { class: 'btn btn-small btn-quiet location-copy-address', type: 'button' }, [
      iconNode('copy'),
      createElement('span', { i18n: 'manage.copy-address' }),
    ]);
    const copyFullButton = createElement('button', { class: 'btn btn-small btn-quiet location-copy-full', type: 'button' }, [
      iconNode('copy'),
      createElement('span', { i18n: 'manage.copy-full-address' }),
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
        createElement('div', { class: 'row span-2 location-copy', hidden: true }, [copyAddressButton, copyFullButton]),
        createElement('label', { class: 'field' }, [createElement('span', { i18n: 'manage.field.country' }), countrySelect]),
      ]),
    ]);

    let label = values.label;
    if (!labels.includes(label)) {
      label = labels[0];
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
    if (card.dataset.lookedUp) {
      card.dataset.mapsFilled = 'yes';
    }
    syncCustomLabel(card);
    syncCopy(card);

    labelSelect.addEventListener('change', () => syncCustomLabel(card));
    fillButton.addEventListener('click', () => fillFromLink(card));
    copyAddressButton.addEventListener('click', () => copyText(input(card, 'venueAddress').value.trim()));
    copyFullButton.addEventListener('click', () => copyText(fullAddress(card)));
    input(card, 'venueAddress').addEventListener('input', () => syncCopy(card));
    input(card, 'mapsUrl').addEventListener('input', () => syncCopy(card));
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
        addButton.focus();
      }
      announceChange(list);
    });
    return card;
  }

  // Replaces the cards with these locations (as the server sends them).
  function set(locations) {
    list.replaceChildren(...locations.map((location) => locationCard(location)));
    renumber();
  }

  // The cards' values, in order, as the server takes them.
  function read() {
    return [...list.children].map((card) => {
      const location = { label: input(card, 'label').value, country: input(card, 'country').value };
      for (const key of TEXT_KEYS) {
        location[key] = input(card, key).value;
      }
      return location;
    });
  }

  // A new, empty card, ready to paste a link into.
  function add() {
    let label = labels[1];
    if (list.children.length === 0) {
      label = labels[0];
    }
    const card = locationCard({ label });
    list.append(card);
    renumber();
    input(card, 'mapsUrl').focus();
  }

  addButton.addEventListener('click', add);

  return {
    set,
    read,
    add,
    count: () => list.children.length,
    // Titles the cards and names their Remove buttons again (a meal renamed).
    retitle: renumber,
    // Redraws the cards in the reader's language, keeping what was typed.
    relabel: () => set(read()),
  };
}

// The event's own places, in "Where".
let eventPlaces = null;

// Replaces the cards with these locations (as the server sends them).
export function setLocations(locations) {
  eventPlaces.set(locations);
}

// The cards' values, in order, as the server takes them.
export function readLocations() {
  return eventPlaces.read();
}

// Sets up "Where" once: a new card is the event's location when it is the
// first, the meeting location after that.
export function startLocations() {
  eventPlaces = createLocationList({
    list: byId('locationList'),
    addButton: byId('locationAdd'),
    emptyNote: byId('locationsEmpty'),
    labels: LABELS,
    max: MAX_LOCATIONS,
    title: (number) => translate('manage.location-number', { number }),
    removeLabel: (number) => translate('manage.location-remove-named', { number }),
  });
}

// Redraws the cards in the reader's language, keeping what was typed.
export function relabelLocations() {
  eventPlaces.relabel();
}
