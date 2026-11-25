// The edit form's Editors tab (migrations/018), for admins only: the
// event's own editors, and adding one (api/manage/event-editors.js). The
// username box is a dropdown: as the admin types, it lists the registered
// accounts whose username or display name holds the text (any active
// account); left empty, the accounts active in the last 30 days. Arrow keys
// and Enter, or a click, pick one. Changes save at once, apart from the rest
// of the form.

import { t as translate } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, withBusy } from './ui.js';
import { iconNode } from './icons.js';

const byId = (id) => document.getElementById(id);
let currentEvent = () => null;
// The accounts active lately (shown for an empty box), and those the
// dropdown lists now.
let candidates = [];
let shown = [];
let active = -1;
// The account picked from the list ({ username, staff }), while the box
// still holds its username.
let chosen = null;
let searchTimer = null;
let searchSerial = 0;
const SEARCH_DELAY_MS = 200;

// One editor: the name, the username and staff or member, a warning while
// their two-step sign-in is off, and Remove.
function editorRow(editor) {
  let roleKey = 'role.member';
  if (editor.staff) {
    roleKey = 'role.staff';
  }
  const details = [editor.username, translate(roleKey)];
  const main = [
    createElement('span', { text: editor.displayName }),
    createElement('span', { class: 'muted small', text: details.join(' · ') }),
  ];
  if (!editor.twoStep) {
    main.push(createElement('span', { class: 'small editor-no-two-step', text: translate('manage.editor-needs-two-step') }));
  }
  const remove = createElement('button', {
    class: 'btn btn-small btn-quiet',
    type: 'button',
    text: translate('security.remove'),
    'aria-label': translate('manage.editor-remove-named', { name: editor.displayName }),
  });
  remove.addEventListener('click', () => change(remove, { action: 'remove', username: editor.username, staff: editor.staff }));
  return createElement('li', { class: 'item-row' }, [iconNode('user'), createElement('span', { class: 'item-main' }, main), remove]);
}

function render(data) {
  candidates = data.candidates;
  let rows = data.editors.map(editorRow);
  if (rows.length === 0) {
    rows = [createElement('li', { class: 'muted small', text: translate('manage.editors-none') })];
  }
  byId('eventEditorList').replaceChildren(...rows);
}

const box = () => byId('eventEditorUsername');
const optionList = () => byId('eventEditorOptions');

function closeOptions() {
  optionList().hidden = true;
  box().setAttribute('aria-expanded', 'false');
  box().removeAttribute('aria-activedescendant');
  active = -1;
}

// The dropdown: these accounts, or a note (searching, nothing found) when
// there are none.
function showOptions(people, note = '') {
  shown = people;
  active = -1;
  box().removeAttribute('aria-activedescendant');
  const items = people.map((person, place) => {
    let details = `@${person.username}`;
    if (person.staff) {
      details = `${details} · ${translate('role.staff')}`;
    }
    const item = createElement('li', { class: 'editor-option', role: 'option', id: `eventEditorOption${place}`, 'aria-selected': 'false' }, [
      createElement('span', { text: person.displayName }),
      createElement('span', { class: 'muted small', text: details }),
    ]);
    // Picked before the box loses focus.
    item.addEventListener('mousedown', (pressed) => {
      pressed.preventDefault();
      pick(place);
    });
    return item;
  });
  if (items.length === 0 && note) {
    items.push(createElement('li', { class: 'editor-option-note muted small', text: note }));
  }
  optionList().replaceChildren(...items);
  const open = items.length > 0;
  optionList().hidden = !open;
  box().setAttribute('aria-expanded', String(open));
}

function highlight(place) {
  const items = [...optionList().querySelectorAll('.editor-option')];
  if (items.length === 0) {
    return;
  }
  active = (place + items.length) % items.length;
  items.forEach((item, index) => item.setAttribute('aria-selected', String(index === active)));
  box().setAttribute('aria-activedescendant', items[active].id);
  items[active].scrollIntoView({ block: 'nearest' });
}

function pick(place) {
  const person = shown[place];
  if (!person) {
    return;
  }
  chosen = { username: person.username, staff: person.staff };
  box().value = person.username;
  closeOptions();
}

// The accounts for what is in the box: the recently active ones for an empty
// box, otherwise a search (after a pause in the typing).
function search() {
  clearTimeout(searchTimer);
  const typed = box().value.trim();
  if (chosen && chosen.username !== typed) {
    chosen = null;
  }
  if (typed === '') {
    showOptions(candidates.slice(0, 20));
    return;
  }
  showOptions([], translate('manage.editor-searching'));
  const serial = ++searchSerial;
  searchTimer = setTimeout(async () => {
    const event = currentEvent();
    if (!event) {
      return;
    }
    try {
      const data = await api(`/api/manage/event-editors?id=${encodeURIComponent(event.id)}&search=${encodeURIComponent(typed)}`);
      // Only the answer to what is typed now.
      if (serial !== searchSerial || document.activeElement !== box()) {
        return;
      }
      showOptions(data.candidates, translate('manage.editor-no-match'));
    } catch {
      closeOptions();
    }
  }, SEARCH_DELAY_MS);
}

async function change(button, body) {
  await withBusy(button, byId('eventEditorError'), async () => {
    render(await post('/api/manage/event-editors', { id: currentEvent().id, ...body }));
  });
}

// The open event's editors, again (after another event opens).
export async function loadEditors() {
  const event = currentEvent();
  byId('eventEditorError').textContent = '';
  byId('eventEditorAdd').hidden = !event;
  if (!event) {
    byId('eventEditorList').replaceChildren(createElement('li', { class: 'muted small', text: translate('manage.editors-save-first') }));
    return;
  }
  try {
    render(await api(`/api/manage/event-editors?id=${encodeURIComponent(event.id)}`));
  } catch {
    byId('eventEditorList').replaceChildren();
  }
}

// getEvent: the event open in the form ({ id }), or null for a new one.
export function startEditors({ getEvent }) {
  currentEvent = getEvent;
  const add = () => {
    const username = box().value.trim();
    if (!username) {
      return;
    }
    closeOptions();
    const body = { action: 'add', username };
    let picked = null;
    if (chosen && chosen.username === username) {
      picked = chosen;
    } else {
      picked = [...shown, ...candidates].find((person) => person.username === username);
    }
    if (picked) {
      body.staff = picked.staff;
    }
    change(byId('eventEditorAddBtn'), body).then(() => {
      if (!byId('eventEditorError').textContent) {
        box().value = '';
        chosen = null;
      }
    });
  };
  byId('eventEditorAddBtn').addEventListener('click', add);
  box().addEventListener('input', search);
  box().addEventListener('focus', search);
  box().addEventListener('blur', () => {
    clearTimeout(searchTimer);
    closeOptions();
  });
  box().addEventListener('keydown', (pressed) => {
    const open = !optionList().hidden;
    if (pressed.key === 'ArrowDown') {
      pressed.preventDefault();
      if (!open) {
        search();
      }
      highlight(active + 1);
    } else if (pressed.key === 'ArrowUp' && open) {
      pressed.preventDefault();
      highlight(active - 1);
    } else if (pressed.key === 'Escape' && open) {
      pressed.preventDefault();
      closeOptions();
    } else if (pressed.key === 'Enter') {
      pressed.preventDefault();
      // Enter on a highlighted account picks it; otherwise it adds.
      if (open && active >= 0) {
        pick(active);
      } else {
        add();
      }
    }
  });
}
