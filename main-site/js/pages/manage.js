// Editors: every event in a list, and one form to create or edit. The server
// checks the role on every request; hiding things here is only tidiness.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { coverToWebp } from '../cover-upload.js';
import { startTools } from '../manage-tools.js';

const byId = (id) => document.getElementById(id);
const form = byId('eventForm');

const TEXT_FIELDS = [
  'title', 'slug', 'kind', 'summary', 'description', 'organiserName', 'externalUrl',
  'timezone', 'startsLocal', 'endsLocal', 'venueName', 'city', 'venueAddress', 'country', 'onlineUrl',
  'priceType', 'currency', 'priceMin', 'priceMax', 'priceNote', 'capacity', 'status', 'publishLocal', 'staffNotes',
];
const CHECK_FIELDS = ['datesHidden', 'addressAttendeesOnly', 'isOnline', 'priceHidden', 'rsvpOpen'];

const BLANK = {
  kind: 'furmeet',
  status: 'draft',
  priceType: 'free',
  rsvpOpen: true,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore',
};

let me = null;
let events = [];
let editing = null; // { id, slug } of the event in the form, or null for a new one
let attendees = [];
let cover = { url: '', has: false };

function fillTimeZones() {
  const list = byId('tzList');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Asia/Singapore']; }
  list.replaceChildren(...zones.map((z) => createElement('option', { value: z })));
}

function statusLabel(row) {
  if (row.status === 'published' && !row.released) return translate('status.scheduled');
  return translate(`status.${row.status}`);
}

function renderList() {
  byId('listBox').setAttribute('aria-busy', 'false');
  byId('listEmpty').hidden = events.length > 0;
  byId('eventList').replaceChildren(...events.map((row) => createElement('li', { class: 'item-row' }, [
    iconNode('calendar'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { class: 'item-title', text: row.title }),
      createElement('span', { class: 'muted small', text: [
        statusLabel(row),
        translate(`kind.${row.kind}`),
        row.datesHidden || !row.startsAt ? translate('event.dates-tba') : formatDate(row.startsAt),
        row.capacity ? translate('event.going-of', { count: row.going, capacity: row.capacity }) : translate('event.going', { count: row.going }),
      ].join(' · ') }),
    ]),
    createElement('span', { class: `chip status-${row.status}${row.released ? '' : ' unreleased'}`, text: statusLabel(row) }),
    createElement('button', { class: 'btn btn-small', type: 'button', text: translate('manage.edit'), 'aria-label': translate('manage.edit-named', { title: row.title }), onclick: () => openEditor(row.id) }),
  ])));
}

async function loadList() {
  const data = await api('/api/manage/events');
  events = data.events;
  renderList();
}

function setForm(values) {
  for (const name of TEXT_FIELDS) byId(`f-${name}`).value = values[name] ?? '';
  for (const name of CHECK_FIELDS) byId(`f-${name}`).checked = values[name] === true;
  cover = { url: values.coverImageUrl || '', has: values.hasCover === true };
  renderCover();
  syncDependent();
}

// The cover picture is uploaded on its own (api/manage/cover.js), so a new
// event is saved first.
function renderCover() {
  const box = byId('coverPreview');
  box.replaceChildren();
  box.classList.toggle('no-image', !cover.has);
  if (cover.has && cover.url) {
    box.append(createElement('img', { src: cover.url, alt: '', referrerpolicy: 'no-referrer' }));
  } else {
    box.append(iconNode('image'));
  }
  byId('coverPick').hidden = !editing;
  byId('coverSaveFirst').hidden = Boolean(editing);
  byId('coverRemove').hidden = !(editing && cover.has);
  byId('coverError').textContent = '';
}

byId('coverFile').addEventListener('change', () => {
  const file = byId('coverFile').files?.[0];
  byId('coverFile').value = '';
  if (!file || !editing) return;
  withBusy(byId('coverPick'), byId('coverError'), async () => {
    const { dataUrl } = await coverToWebp(file);
    const data = await post('/api/manage/cover', { id: editing.id, image: dataUrl });
    cover = { url: data.event.coverImageUrl, has: data.event.hasCover };
    renderCover();
    byId('manageNotice').textContent = translate('manage.cover-saved');
  });
});

byId('coverRemove').addEventListener('click', () => {
  withBusy(byId('coverRemove'), byId('coverError'), async () => {
    const data = await post('/api/manage/cover', { id: editing.id, remove: true });
    cover = { url: '', has: data.event.hasCover };
    renderCover();
  });
});

function readForm() {
  const out = {};
  for (const name of TEXT_FIELDS) out[name] = byId(`f-${name}`).value;
  for (const name of CHECK_FIELDS) out[name] = byId(`f-${name}`).checked;
  return out;
}

// Fields that only mean something with another one switched on.
function syncDependent() {
  const paid = byId('f-priceType').value === 'paid';
  for (const name of ['currency', 'priceMin', 'priceMax']) byId(`f-${name}`).disabled = !paid;
  byId('f-onlineUrl').disabled = !byId('f-isOnline').checked;
}

form.addEventListener('change', (e) => {
  if (e.target.id === 'f-priceType' || e.target.id === 'f-isOnline') syncDependent();
});

function renderAttendees() {
  const box = byId('attendeesBox');
  box.hidden = !editing;
  if (!editing) return;
  byId('attendeesTitle').textContent = translate('manage.attendees', { count: attendees.length });
  byId('attendeeList').replaceChildren(
    ...(attendees.length === 0
      ? [createElement('li', { class: 'muted small', text: translate('manage.attendees-none') })]
      : attendees.map((a) => createElement('li', { class: 'item-row' }, [
        iconNode('user'),
        createElement('span', { class: 'item-main' }, [
          createElement('span', { text: a.displayName || a.username }),
          createElement('span', { class: 'muted small', text: `${a.username} · ${translate(a.staff ? 'role.staff' : 'role.member')} · ${formatDate(a.rsvpAt)}` }),
        ]),
        createElement('button', {
          class: 'btn btn-small btn-quiet',
          type: 'button',
          text: translate('security.remove'),
          'aria-label': translate('manage.attendee-remove', { name: a.displayName || a.username }),
          onclick: () => removeAttendee(a.username, a.staff),
        }),
      ])))
  );
}

function showEditor(title) {
  byId('editorTitle').textContent = title;
  byId('editorError').textContent = '';
  byId('editorDelete').hidden = !(editing && me.role === 'admin');
  byId('editorView').hidden = !editing;
  if (editing) byId('editorView').href = `/e/${encodeURIComponent(editing.slug)}`;
  form.hidden = false;
  renderCover();
  renderAttendees();
  byId('editorTitle').tabIndex = -1;
  byId('editorTitle').focus();
}

async function openEditor(id) {
  byId('manageNotice').textContent = '';
  try {
    const data = await api(`/api/manage/events?id=${encodeURIComponent(id)}`);
    editing = { id: data.event.id, slug: data.event.slug };
    attendees = data.attendees;
    setForm(data.event);
    showEditor(translate('manage.edit-title', { title: data.event.title }));
  } catch (error) {
    byId('manageError').textContent = errorText(error);
  }
}

function openNew() {
  editing = null;
  attendees = [];
  byId('manageNotice').textContent = '';
  setForm(BLANK);
  showEditor(translate('manage.new-title'));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('editorSave'), byId('editorError'), async () => {
    const body = editing
      ? { action: 'update', id: editing.id, event: readForm() }
      : { action: 'create', event: readForm() };
    const data = await post('/api/manage/events', body);
    editing = { id: data.event.id, slug: data.event.slug };
    setForm(data.event);
    showEditor(translate('manage.edit-title', { title: data.event.title }));
    byId('manageNotice').textContent = translate('manage.saved');
    await loadList();
  });
});

async function removeAttendee(username, staff) {
  await withBusy(null, byId('editorError'), async () => {
    const data = await post('/api/manage/events', { action: 'remove-attendee', id: editing.id, username, staff });
    attendees = data.attendees;
    renderAttendees();
    await loadList();
  });
}

byId('editorDelete').addEventListener('click', () => openModal('deleteModal'));
byId('deleteConfirm').addEventListener('click', () => {
  withBusy(byId('deleteConfirm'), byId('editorError'), async () => {
    await post('/api/manage/events', { action: 'delete', id: editing.id });
    closeModal('deleteModal');
    editing = null;
    form.hidden = true;
    byId('manageNotice').textContent = translate('manage.deleted');
    await loadList();
  });
});

byId('editorClose').addEventListener('click', () => {
  form.hidden = true;
  editing = null;
  byId('newEvent').focus();
});
byId('newEvent').addEventListener('click', openNew);

async function start() {
  const s = await session;
  if (!s.signedIn) {
    location.replace(`/login?next=${encodeURIComponent('/manage')}`);
    return;
  }
  me = s.user;
  if (!me.canManage) {
    byId('manageError').textContent = translate('error.manage_only');
    byId('listBox').hidden = true;
    return;
  }
  byId('newEvent').hidden = false;
  fillTimeZones();
  startTools(me);
  try {
    await loadList();
  } catch (error) {
    byId('manageError').textContent = errorText(error);
    return;
  }
  // /manage?slug=... from an event page's "Edit this event".
  const slug = new URLSearchParams(location.search).get('slug');
  const match = slug && events.find((row) => row.slug === slug);
  if (match) openEditor(match.id);
}

onChange(() => {
  if (events.length) renderList();
  if (!form.hidden) renderAttendees();
});

start();
