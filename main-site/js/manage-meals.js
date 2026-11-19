// The "Coming just for a meal" section of the edit form: which meals people
// can RSVP for on their own, instead of the whole event (migrations/007),
// and how many places each has (migrations/009; blank for no limit).
// Breakfast, lunch and dinner are tick boxes; up to MAX_CUSTOM_MEALS more
// are named by the editor, one row each.
//
// A named meal gets an id here when it is added ("m-" and six letters and
// digits) and keeps it, so the people coming for it stay with it when it is
// renamed. The server checks every entry again (api/_lib/event-rules.js
// readMeals) and drops a named meal left blank.
//
// Each meal offered can be held somewhere other than the event: ticking
// "Held somewhere else" under it opens location cards like the ones in
// "Where" (manage-locations.js), up to MAX_MEAL_LOCATIONS, labelled as the
// meal's location, the meeting location, or the editor's own label.
// Unticked, the meal is at the event's place and its cards are not sent
// (but kept on the form, so ticking it again brings them back).

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';
import { createLocationList } from './manage-locations.js';

const BUILT_IN_MEALS = ['breakfast', 'lunch', 'dinner'];
const MAX_CUSTOM_MEALS = 5;
const MEAL_LOCATION_LABELS = ['meal', 'meeting', 'custom'];
const MAX_MEAL_LOCATIONS = 3;
const ID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const byId = (id) => document.getElementById(id);
const list = () => byId('mealCustomList');

// Each built-in meal's place (mealPlace), by id, and each named meal's, by
// its item in the list.
const builtInPlaces = new Map();
const namedPlaces = new WeakMap();

// Tells the edit form the meals changed without a field being left (a named
// meal removed), so it autosaves them.
export const MEALS_CHANGED = 'meals-changed';
function announceChange() {
  list().dispatchEvent(new CustomEvent(MEALS_CHANGED, { bubbles: true }));
}

// A new named meal's id.
function newMealId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `m-${[...bytes].map((byte) => ID_LETTERS[byte % ID_LETTERS.length]).join('')}`;
}

// A meal's name as the form shows it now, for naming its fields.
function builtInName(id) {
  return translate(`meal.${id}`);
}
function namedName(item) {
  const name = item.querySelector('[data-meal-id]').value.trim();
  if (name) {
    return name;
  }
  return translate('manage.field.mealLabel');
}

// The name of a meal on the form by its id, for saying where a refused
// field is ("Check this field in Lunch, location 1").
export function mealNameFor(id) {
  if (BUILT_IN_MEALS.includes(id)) {
    return builtInName(id);
  }
  for (const item of list().children) {
    if (item.querySelector('[data-meal-id]').dataset.mealId === id) {
      return namedName(item);
    }
  }
  return translate('manage.field.mealLabel');
}

// Where one meal is held: a "Held somewhere else" tick box and, while it is
// ticked, the meal's own location cards. nameOf() is the meal's name now.
// Returns { element, set, read, name, relabel }.
function mealPlace(nameOf) {
  const toggle = createElement('input', { type: 'checkbox', 'data-meal-elsewhere': '' });
  const cards = createElement('div', { class: 'location-list' });
  const addButton = createElement('button', { class: 'btn btn-small', type: 'button' }, [
    iconNode('plus'),
    createElement('span', { i18n: 'manage.meal-location-add' }),
  ]);
  const panel = createElement('div', { class: 'meal-place-panel' }, [
    createElement('p', { class: 'field-hint', i18n: 'manage.hint.mealElsewhere' }),
    cards,
    createElement('div', { class: 'actions inline' }, [addButton]),
  ]);
  const element = createElement('div', { class: 'meal-place' }, [
    createElement('label', { class: 'check' }, [toggle, createElement('span', { i18n: 'manage.field.mealElsewhere' })]),
    panel,
  ]);
  const places = createLocationList({
    list: cards,
    addButton,
    labels: MEAL_LOCATION_LABELS,
    max: MAX_MEAL_LOCATIONS,
    title: (number) => translate('manage.meal-location-number', { meal: nameOf(), number }),
    removeLabel: (number) => translate('manage.meal-location-remove-named', { meal: nameOf(), number }),
  });

  function sync() {
    panel.hidden = !toggle.checked;
  }
  // Ticked with no cards yet: a first one, ready for a Google Maps link.
  toggle.addEventListener('change', () => {
    sync();
    if (toggle.checked && places.count() === 0) {
      places.add();
    }
  });

  return {
    element,
    // Shows a meal's places as the server sends them; ticked when it has any.
    set(locations) {
      let shown = [];
      if (Array.isArray(locations)) {
        shown = locations;
      }
      places.set(shown);
      toggle.checked = shown.length > 0;
      sync();
    },
    // The meal's places as the server takes them: none while unticked.
    read() {
      if (!toggle.checked) {
        return [];
      }
      return places.read();
    },
    // Names the tick box and the cards after the meal, in the reader's
    // language.
    name() {
      toggle.setAttribute('aria-label', translate('manage.meal-elsewhere-named', { meal: nameOf() }));
      places.retitle();
    },
    relabel() {
      places.relabel();
    },
  };
}

// A meal's places field, named after its meal for screen readers ("Places
// for Lunch"); a named meal's follows its name as it is typed.
function nameLimit(input, mealName) {
  let name = mealName.trim();
  if (!name) {
    name = translate('manage.field.mealLabel');
  }
  input.setAttribute('aria-label', translate('manage.meal-places-named', { meal: name }));
}

// Names each row's Remove button by its place and each places field by its
// meal, switches off the places of a meal not ticked, and hides Add once the
// list is full.
function renumber() {
  for (const id of BUILT_IN_MEALS) {
    const limit = byId(`f-meal-${id}-limit`);
    const ticked = byId(`f-meal-${id}`).checked;
    nameLimit(limit, builtInName(id));
    limit.disabled = !ticked;
    const place = builtInPlaces.get(id);
    place.element.hidden = !ticked;
    place.name();
  }
  const items = [...list().children];
  items.forEach((item, index) => {
    item.querySelector('.meal-remove').setAttribute('aria-label', translate('manage.meal-remove-named', { number: index + 1 }));
    nameLimit(item.querySelector('[data-meal-limit]'), item.querySelector('[data-meal-id]').value);
    namedPlaces.get(item).name();
  });
  byId('mealAdd').hidden = items.length >= MAX_CUSTOM_MEALS;
}

// A meal's limit as the form shows it: '' for none.
function limitText(meal) {
  if (meal.limit === null || meal.limit === undefined) {
    return '';
  }
  return String(meal.limit);
}

// One named meal's item: a row with its name, its places and a Remove
// button, and under it where the meal is held.
function mealRow(meal) {
  const nameInput = createElement('input', { type: 'text', maxlength: 40, autocomplete: 'off', 'data-meal-id': meal.id });
  let label = meal.label;
  if (label === null || label === undefined) {
    label = '';
  }
  nameInput.value = label;
  const limitInput = createElement('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', 'data-meal-limit': meal.id });
  limitInput.value = limitText(meal);
  nameInput.addEventListener('input', renumber);
  // Its location cards are titled after it once its name is typed.
  const removeButton = createElement('button', { class: 'btn btn-small btn-quiet meal-remove', type: 'button' }, [
    iconNode('trash'),
    createElement('span', { class: 'btn-label', i18n: 'security.remove' }),
  ]);
  const row = createElement('div', { class: 'row meal-custom' }, [
    createElement('label', { class: 'field grow' }, [createElement('span', { i18n: 'manage.field.mealLabel' }), nameInput]),
    createElement('label', { class: 'field meal-custom-limit' }, [createElement('span', { i18n: 'manage.field.mealPlaces' }), limitInput]),
    removeButton,
  ]);
  const item = createElement('div', { class: 'meal-custom-item' }, [row]);
  const place = mealPlace(() => namedName(item));
  item.append(place.element);
  namedPlaces.set(item, place);
  place.set(meal.locations);
  removeButton.addEventListener('click', () => {
    let next = item.nextElementSibling;
    if (!next) {
      next = item.previousElementSibling;
    }
    item.remove();
    renumber();
    if (next) {
      next.querySelector('input').focus();
    } else {
      byId('mealAdd').focus();
    }
    announceChange();
  });
  return item;
}

// Shows these meals (as the server sends them: [{ id, label, limit,
// locations }]).
export function setMeals(meals) {
  for (const id of BUILT_IN_MEALS) {
    const meal = meals.find((each) => each.id === id);
    byId(`f-meal-${id}`).checked = meal !== undefined;
    let limit = '';
    let locations = [];
    if (meal) {
      limit = limitText(meal);
      locations = meal.locations;
    }
    byId(`f-meal-${id}-limit`).value = limit;
    builtInPlaces.get(id).set(locations);
  }
  const named = meals.filter((meal) => !BUILT_IN_MEALS.includes(meal.id));
  list().replaceChildren(...named.map((meal) => mealRow(meal)));
  renumber();
}

// The meals as the server takes them: the ticked ones by id, then each named
// one with its id and name, blank or not; each with its places ('' for no
// limit) and where it is held (no locations: at the event's place).
export function readMeals() {
  const meals = BUILT_IN_MEALS
    .filter((id) => byId(`f-meal-${id}`).checked)
    .map((id) => ({ id, label: '', limit: byId(`f-meal-${id}-limit`).value, locations: builtInPlaces.get(id).read() }));
  for (const item of list().children) {
    const nameInput = item.querySelector('[data-meal-id]');
    meals.push({
      id: nameInput.dataset.mealId,
      label: nameInput.value,
      limit: item.querySelector('[data-meal-limit]').value,
      locations: namedPlaces.get(item).read(),
    });
  }
  return meals;
}

// A new, empty named meal, ready to type in.
function addMeal() {
  const row = mealRow({ id: newMealId(), label: '' });
  list().append(row);
  renumber();
  row.querySelector('input').focus();
}

// Wires the Add button and the tick boxes once, and puts where each of
// breakfast, lunch and dinner is held under its row.
export function startMeals() {
  byId('mealAdd').addEventListener('click', addMeal);
  for (const id of BUILT_IN_MEALS) {
    const place = mealPlace(() => builtInName(id));
    builtInPlaces.set(id, place);
    byId(`f-meal-${id}`).closest('.meal-row').after(place.element);
    byId(`f-meal-${id}`).addEventListener('change', renumber);
  }
}

// Names the Remove buttons, places fields and location cards again in the
// reader's language.
export function relabelMeals() {
  for (const place of builtInPlaces.values()) {
    place.relabel();
  }
  for (const item of list().children) {
    namedPlaces.get(item).relabel();
  }
  renumber();
}
