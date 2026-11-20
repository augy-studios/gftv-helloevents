// The edit form's Editors tab (migrations/018), for admins only: the
// event's own editors, and adding one from the accounts active in the last
// 30 days (api/manage/event-editors.js). Changes save at once, apart from the
// rest of the form.

import { t as translate } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, withBusy } from './ui.js';
import { iconNode } from './icons.js';

const byId = (id) => document.getElementById(id);
let currentEvent = () => null;
let candidates = [];

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
  byId('eventEditorCandidates').replaceChildren(...candidates.map((person) => createElement('option', {
    value: person.username,
    label: person.displayName,
  })));
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
    const username = byId('eventEditorUsername').value.trim();
    if (!username) {
      return;
    }
    const picked = candidates.find((person) => person.username === username);
    const body = { action: 'add', username };
    if (picked) {
      body.staff = picked.staff;
    }
    change(byId('eventEditorAddBtn'), body).then(() => {
      if (!byId('eventEditorError').textContent) {
        byId('eventEditorUsername').value = '';
      }
    });
  };
  byId('eventEditorAddBtn').addEventListener('click', add);
  byId('eventEditorUsername').addEventListener('keydown', (pressed) => {
    if (pressed.key === 'Enter') {
      pressed.preventDefault();
      add();
    }
  });
}
