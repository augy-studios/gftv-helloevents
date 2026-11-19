// The edit form's Timetable tab (migrations/014): how the event page shows
// the timetable (picked in the plain field f-timetableView), the rooms that
// are its grid's columns, and the items: what happens, on which day, from
// when to when, in which room.
//
// Rooms are rows (a name, an optional short tag such as "Level G"), in
// column order, moved with Up and Down. Each keeps an id made here when it
// is added ("r-" and eight letters and digits), so the items in a room stay
// with it when it is renamed; removing a room leaves its items in none.
// Items are cards. A new card starts on the day of the card before it (or
// the event's start date), and Duplicate copies a card, for something that
// happens more than once.
//
// An itinerary (the "timeline" view) has steps with a time only: its rooms
// and each item's end and room are hidden (manage.js syncDependent marks the
// panel .is-itinerary), but kept, so switching back to a timetable brings
// them back.
//
// Like a ticket tier card, a room row or item card is saved once it is left
// (manage.js), so it is not refused while it is half filled in. The server
// checks every field again (api/_lib/event-rules.js readTimetable), drops a
// row or card left blank, and keeps the items in time order: the cards show
// in that order the next time the event is opened.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';

const MAX_ROOMS = 20;
const MAX_ITEMS = 300;
const ROOM_ID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const byId = (id) => document.getElementById(id);
const roomList = () => byId('roomList');
const itemList = () => byId('itemList');

// Tells the edit form the timetable changed without a field being left (a
// row or card removed, moved or copied), so it autosaves it.
export const TIMETABLE_CHANGED = 'timetable-changed';
function announceChange() {
  roomList().dispatchEvent(new CustomEvent(TIMETABLE_CHANGED, { bubbles: true }));
}

// The input, textarea or select for key in a row or card.
function input(element, key) {
  return element.querySelector(`[data-key="${key}"]`);
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `r-${[...bytes].map((byte) => ROOM_ID_LETTERS[byte % ROOM_ID_LETTERS.length]).join('')}`;
}

// A small button with an icon and a label (hidden on narrow screens).
function smallButton(className, iconName, labelKey) {
  return createElement('button', { class: `btn btn-small btn-quiet ${className}`, type: 'button' }, [
    iconNode(iconName),
    createElement('span', { class: 'btn-label', i18n: labelKey }),
  ]);
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

// The rooms as the item cards offer them: [{ id, label }], each labelled with
// its name, or "Room 2" while it has none.
function roomChoices() {
  return [...roomList().children].map((row, index) => {
    let label = input(row, 'name').value.trim();
    if (!label) {
      label = translate('manage.room-number', { number: index + 1 });
    }
    const tag = input(row, 'tag').value.trim();
    if (tag) {
      label = translate('manage.room-with-tag', { room: label, tag });
    }
    return { id: row.dataset.roomId, label };
  });
}

// Fills one item card's room list with the rooms as they are now, keeping
// its choice (none, when that room has gone). With no rooms at all the list
// is hidden: every item is simply in the event's one place.
function fillRoomSelect(select, chosen) {
  const choices = roomChoices();
  const options = [createElement('option', { value: '', text: translate('manage.item-room-none') })];
  for (const choice of choices) {
    options.push(createElement('option', { value: choice.id, text: choice.label }));
  }
  select.replaceChildren(...options);
  let value = chosen;
  if (!choices.some((choice) => choice.id === value)) {
    value = '';
  }
  select.value = value;
  select.closest('.field').hidden = choices.length === 0;
}

function refreshRoomSelects() {
  for (const card of itemList().children) {
    const select = input(card, 'room');
    fillRoomSelect(select, select.value);
  }
}

// Names each row's buttons after its number, disables Up on the first and
// Down on the last, and hides Add once the list is full.
function renumberRooms() {
  const rows = [...roomList().children];
  rows.forEach((row, index) => {
    const number = index + 1;
    row.querySelector('.room-number').textContent = String(number);
    row.querySelector('.room-up').disabled = index === 0;
    row.querySelector('.room-down').disabled = index === rows.length - 1;
    row.querySelector('.room-up').setAttribute('aria-label', translate('manage.room-up-named', { number }));
    row.querySelector('.room-down').setAttribute('aria-label', translate('manage.room-down-named', { number }));
    row.querySelector('.room-remove').setAttribute('aria-label', translate('manage.room-remove-named', { number }));
  });
  byId('roomsEmpty').hidden = rows.length > 0;
  byId('roomAdd').hidden = rows.length >= MAX_ROOMS;
  refreshRoomSelects();
}

// One room's row, filled with values (a room as the server sends it, or a
// new one's blanks and fresh id).
function roomRow(values) {
  const up = smallButton('room-up', 'arrow-up', 'manage.room-up');
  const down = smallButton('room-down', 'arrow-down', 'manage.room-down');
  const remove = smallButton('room-remove', 'trash', 'security.remove');
  const row = createElement('div', { class: 'room-row' }, [
    createElement('span', { class: 'room-number', 'aria-hidden': 'true' }),
    createElement('label', { class: 'field room-name' }, [
      createElement('span', { i18n: 'manage.field.roomName' }),
      createElement('input', { type: 'text', 'data-key': 'name', maxlength: 60, autocomplete: 'off' }),
    ]),
    createElement('label', { class: 'field room-tag' }, [
      createElement('span', { i18n: 'manage.field.roomTag-optional' }),
      createElement('input', { type: 'text', 'data-key': 'tag', maxlength: 20, autocomplete: 'off' }),
    ]),
    createElement('div', { class: 'room-actions' }, [up, down, remove]),
  ]);
  let id = values.id;
  if (!id) {
    id = newRoomId();
  }
  row.dataset.roomId = id;
  for (const key of ['name', 'tag']) {
    let value = values[key];
    if (value === null || value === undefined) {
      value = '';
    }
    input(row, key).value = value;
  }

  // The item cards' room lists follow the name and tag as they are typed.
  input(row, 'name').addEventListener('input', refreshRoomSelects);
  input(row, 'tag').addEventListener('input', refreshRoomSelects);
  up.addEventListener('click', () => {
    if (row.previousElementSibling) {
      row.previousElementSibling.before(row);
      renumberRooms();
      // Up again, unless the row is now first (Up is then disabled).
      if (row.previousElementSibling) {
        up.focus();
      } else {
        down.focus();
      }
      announceChange();
    }
  });
  down.addEventListener('click', () => {
    if (row.nextElementSibling) {
      row.nextElementSibling.after(row);
      renumberRooms();
      if (row.nextElementSibling) {
        down.focus();
      } else {
        up.focus();
      }
      announceChange();
    }
  });
  remove.addEventListener('click', () => {
    let next = row.nextElementSibling;
    if (!next) {
      next = row.previousElementSibling;
    }
    row.remove();
    renumberRooms();
    if (next) {
      input(next, 'name').focus();
    } else {
      byId('roomAdd').focus();
    }
    announceChange();
  });
  return row;
}

function addRoom() {
  const row = roomRow({});
  roomList().append(row);
  renumberRooms();
  input(row, 'name').focus();
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const ITEM_TEXT_KEYS = ['title', 'date', 'start', 'end', 'note'];

// Numbers the cards, names their buttons, and hides Add and Duplicate once
// the list is full.
function renumberItems() {
  const cards = [...itemList().children];
  const full = cards.length >= MAX_ITEMS;
  cards.forEach((card, index) => {
    const number = index + 1;
    card.querySelector('.item-title').textContent = translate('manage.item-number', { number });
    card.querySelector('.item-copy').setAttribute('aria-label', translate('manage.item-copy-named', { number }));
    card.querySelector('.item-copy').hidden = full;
    card.querySelector('.item-remove').setAttribute('aria-label', translate('manage.item-remove-named', { number }));
  });
  byId('itemsEmpty').hidden = cards.length > 0;
  byId('itemAdd').hidden = full;
}

// One item's card, filled with values (an item as the server sends it, or a
// new one's blanks).
function itemCard(values) {
  const copy = smallButton('item-copy', 'copy', 'manage.item-copy');
  const remove = smallButton('item-remove', 'trash', 'security.remove');
  const card = createElement('div', { class: 'location-card timetable-item-card' }, [
    createElement('div', { class: 'row between' }, [
      createElement('h3', { class: 'section-label item-title' }),
      createElement('div', { class: 'row' }, [copy, remove]),
    ]),
    createElement('div', { class: 'form-grid' }, [
      createElement('label', { class: 'field span-2 item-f-title' }, [
        createElement('span', { i18n: 'manage.field.itemTitle' }),
        createElement('input', { type: 'text', 'data-key': 'title', maxlength: 120, autocomplete: 'off' }),
      ]),
      createElement('label', { class: 'field item-f-date' }, [
        createElement('span', { i18n: 'manage.field.itemDate' }),
        createElement('input', { type: 'date', 'data-key': 'date' }),
      ]),
      createElement('label', { class: 'field item-f-room' }, [
        createElement('span', { i18n: 'manage.field.itemRoom' }),
        createElement('select', { 'data-key': 'room' }),
      ]),
      createElement('label', { class: 'field item-f-start' }, [
        createElement('span', { class: 'only-grid', i18n: 'manage.field.itemStart' }),
        createElement('span', { class: 'only-timeline', i18n: 'manage.field.itemTime' }),
        createElement('input', { type: 'time', 'data-key': 'start' }),
      ]),
      createElement('label', { class: 'field item-f-end' }, [
        createElement('span', { i18n: 'manage.field.itemEnd-optional' }),
        createElement('input', { type: 'time', 'data-key': 'end' }),
      ]),
      createElement('label', { class: 'field span-2 item-f-note' }, [
        createElement('span', { i18n: 'manage.field.itemNote-optional' }),
        createElement('input', { type: 'text', 'data-key': 'note', maxlength: 300, autocomplete: 'off' }),
      ]),
    ]),
  ]);
  for (const key of ITEM_TEXT_KEYS) {
    let value = values[key];
    if (value === null || value === undefined) {
      value = '';
    }
    input(card, key).value = value;
  }
  let room = values.room;
  if (!room) {
    room = '';
  }
  fillRoomSelect(input(card, 'room'), room);

  copy.addEventListener('click', () => {
    if (itemList().children.length >= MAX_ITEMS) {
      return;
    }
    const twin = itemCard(readItem(card));
    card.after(twin);
    renumberItems();
    input(twin, 'title').focus();
    announceChange();
  });
  remove.addEventListener('click', () => {
    let next = card.nextElementSibling;
    if (!next) {
      next = card.previousElementSibling;
    }
    card.remove();
    renumberItems();
    if (next) {
      input(next, 'title').focus();
    } else {
      byId('itemAdd').focus();
    }
    announceChange();
  });
  return card;
}

function readItem(card) {
  const item = {};
  for (const key of ITEM_TEXT_KEYS) {
    item[key] = input(card, key).value;
  }
  item.room = input(card, 'room').value;
  return item;
}

// A new, empty card, on the day of the last card (or the event's start
// date), in the same room as it, ready to type in.
function addItem() {
  const last = itemList().lastElementChild;
  let date = byId('f-startDate').value;
  let room = '';
  if (last) {
    date = input(last, 'date').value;
    room = input(last, 'room').value;
  }
  const card = itemCard({ date, room });
  itemList().append(card);
  renumberItems();
  input(card, 'title').focus();
}

// ---------------------------------------------------------------------------
// The form's side
// ---------------------------------------------------------------------------

// Replaces the rows and cards with these rooms and items (as the server
// sends them). Rooms first, so the cards can offer them.
export function setTimetable(rooms, items) {
  roomList().replaceChildren(...rooms.map((room) => roomRow(room)));
  itemList().replaceChildren(...items.map((item) => itemCard(item)));
  renumberRooms();
  renumberItems();
}

// The rows' and cards' values, in order, as the server takes them:
// { timetableRooms, timetableItems }.
export function readTimetable() {
  return {
    timetableRooms: [...roomList().children].map((row) => ({
      id: row.dataset.roomId,
      name: input(row, 'name').value,
      tag: input(row, 'tag').value,
    })),
    timetableItems: [...itemList().children].map(readItem),
  };
}

// Wires the Add buttons once.
export function startTimetable() {
  byId('roomAdd').addEventListener('click', addRoom);
  byId('itemAdd').addEventListener('click', addItem);
}

// Redraws the wording in the reader's language, keeping what was typed.
export function relabelTimetable() {
  renumberRooms();
  renumberItems();
}
