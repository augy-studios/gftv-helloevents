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

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';

const BUILT_IN_MEALS = ['breakfast', 'lunch', 'dinner'];
const MAX_CUSTOM_MEALS = 5;
const ID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const byId = (id) => document.getElementById(id);
const list = () => byId('mealCustomList');

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
    nameLimit(limit, translate(`meal.${id}`));
    limit.disabled = !byId(`f-meal-${id}`).checked;
  }
  const rows = [...list().children];
  rows.forEach((row, index) => {
    row.querySelector('.meal-remove').setAttribute('aria-label', translate('manage.meal-remove-named', { number: index + 1 }));
    nameLimit(row.querySelector('[data-meal-limit]'), row.querySelector('[data-meal-id]').value);
  });
  byId('mealAdd').hidden = rows.length >= MAX_CUSTOM_MEALS;
}

// A meal's limit as the form shows it: '' for none.
function limitText(meal) {
  if (meal.limit === null || meal.limit === undefined) {
    return '';
  }
  return String(meal.limit);
}

// One named meal's row: its name, its places and a Remove button.
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
  const removeButton = createElement('button', { class: 'btn btn-small btn-quiet meal-remove', type: 'button' }, [
    iconNode('trash'),
    createElement('span', { class: 'btn-label', i18n: 'security.remove' }),
  ]);
  const row = createElement('div', { class: 'row meal-custom' }, [
    createElement('label', { class: 'field grow' }, [createElement('span', { i18n: 'manage.field.mealLabel' }), nameInput]),
    createElement('label', { class: 'field meal-custom-limit' }, [createElement('span', { i18n: 'manage.field.mealPlaces' }), limitInput]),
    removeButton,
  ]);
  removeButton.addEventListener('click', () => {
    let next = row.nextElementSibling;
    if (!next) {
      next = row.previousElementSibling;
    }
    row.remove();
    renumber();
    if (next) {
      next.querySelector('input').focus();
    } else {
      byId('mealAdd').focus();
    }
    announceChange();
  });
  return row;
}

// Shows these meals (as the server sends them: [{ id, label }]).
export function setMeals(meals) {
  for (const id of BUILT_IN_MEALS) {
    const meal = meals.find((each) => each.id === id);
    byId(`f-meal-${id}`).checked = meal !== undefined;
    let limit = '';
    if (meal) {
      limit = limitText(meal);
    }
    byId(`f-meal-${id}-limit`).value = limit;
  }
  const named = meals.filter((meal) => !BUILT_IN_MEALS.includes(meal.id));
  list().replaceChildren(...named.map((meal) => mealRow(meal)));
  renumber();
}

// The meals as the server takes them: the ticked ones by id, then each named
// one with its id and name, blank or not; each with its places ('' for no
// limit).
export function readMeals() {
  const meals = BUILT_IN_MEALS
    .filter((id) => byId(`f-meal-${id}`).checked)
    .map((id) => ({ id, label: '', limit: byId(`f-meal-${id}-limit`).value }));
  for (const row of list().children) {
    const nameInput = row.querySelector('[data-meal-id]');
    meals.push({ id: nameInput.dataset.mealId, label: nameInput.value, limit: row.querySelector('[data-meal-limit]').value });
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

// Wires the Add button and the tick boxes once.
export function startMeals() {
  byId('mealAdd').addEventListener('click', addMeal);
  for (const id of BUILT_IN_MEALS) {
    byId(`f-meal-${id}`).addEventListener('change', renumber);
  }
}

// Names the Remove buttons and places fields again in the reader's language.
export function relabelMeals() {
  renumber();
}
