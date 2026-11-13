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

// A new event starts in the browser's own time zone, or Singapore's when the
// browser names none.
let browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (!browserTimeZone) {
  browserTimeZone = 'Asia/Singapore';
}

const BLANK = {
  kind: 'furmeet',
  status: 'draft',
  priceType: 'free',
  rsvpOpen: true,
  timezone: browserTimeZone,
};

let currentUser = null;
let events = [];
let editing = null; // { id, slug } of the event in the form, or null for a new one
let attendees = [];
let cover = { url: '', has: false };

function fillTimeZones() {
  const list = byId('tzList');
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['Asia/Singapore'];
  }
  list.replaceChildren(...zones.map((zone) => createElement('option', { value: zone })));
}

function statusLabel(row) {
  if (row.status === 'published' && !row.released) {
    return translate('status.scheduled');
  }
  return translate(`status.${row.status}`);
}

// One event in the list: its title; its status, kind, date and how many are
// going; a status chip (marked while it is not yet released); and an Edit
// button.
function eventRow(row) {
  let dateText;
  if (row.datesHidden || !row.startsAt) {
    dateText = translate('event.dates-tba');
  } else {
    dateText = formatDate(row.startsAt);
  }
  let goingText;
  if (row.capacity) {
    goingText = translate('event.going-of', { count: row.going, capacity: row.capacity });
  } else {
    goingText = translate('event.going', { count: row.going });
  }
  const details = [statusLabel(row), translate(`kind.${row.kind}`), dateText, goingText].join(' · ');
  let chipClass = `chip status-${row.status}`;
  if (!row.released) {
    chipClass = `${chipClass} unreleased`;
  }
  return createElement('li', { class: 'item-row' }, [
    iconNode('calendar'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { class: 'item-title', text: row.title }),
      createElement('span', { class: 'muted small', text: details }),
    ]),
    createElement('span', { class: chipClass, text: statusLabel(row) }),
    createElement('button', { class: 'btn btn-small', type: 'button', text: translate('manage.edit'), 'aria-label': translate('manage.edit-named', { title: row.title }), onclick: () => openEditor(row.id) }),
  ]);
}

function renderList() {
  byId('listBox').setAttribute('aria-busy', 'false');
  byId('listEmpty').hidden = events.length > 0;
  byId('eventList').replaceChildren(...events.map((row) => eventRow(row)));
}

async function loadList() {
  const data = await api('/api/manage/events');
  events = data.events;
  renderList();
}

function setForm(values) {
  for (const name of TEXT_FIELDS) {
    let value = values[name];
    if (value === null || value === undefined) {
      value = '';
    }
    byId(`f-${name}`).value = value;
  }
  for (const name of CHECK_FIELDS) {
    byId(`f-${name}`).checked = values[name] === true;
  }
  let coverUrl = values.coverImageUrl;
  if (!coverUrl) {
    coverUrl = '';
  }
  cover = { url: coverUrl, has: values.hasCover === true };
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
  let canRemove = false;
  if (editing && cover.has) {
    canRemove = true;
  }
  byId('coverRemove').hidden = !canRemove;
  byId('coverError').textContent = '';
}

byId('coverFile').addEventListener('change', () => {
  const files = byId('coverFile').files;
  let file;
  if (files !== null && files !== undefined) {
    file = files[0];
  }
  byId('coverFile').value = '';
  if (!file || !editing) {
    return;
  }
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
  const values = {};
  for (const name of TEXT_FIELDS) {
    values[name] = byId(`f-${name}`).value;
  }
  for (const name of CHECK_FIELDS) {
    values[name] = byId(`f-${name}`).checked;
  }
  return values;
}

// Fields that only mean something with another one switched on.
function syncDependent() {
  const paid = byId('f-priceType').value === 'paid';
  for (const name of ['currency', 'priceMin', 'priceMax']) {
    byId(`f-${name}`).disabled = !paid;
  }
  byId('f-onlineUrl').disabled = !byId('f-isOnline').checked;
}

form.addEventListener('change', (event) => {
  if (event.target.id === 'f-priceType' || event.target.id === 'f-isOnline') {
    syncDependent();
  }
});

// One attendee: the name (the username when there is no display name), the
// username, staff or member, when they said they are going, and a Remove
// button.
function attendeeRow(attendee) {
  let name = attendee.displayName;
  if (!name) {
    name = attendee.username;
  }
  let roleKey = 'role.member';
  if (attendee.staff) {
    roleKey = 'role.staff';
  }
  return createElement('li', { class: 'item-row' }, [
    iconNode('user'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: name }),
      createElement('span', { class: 'muted small', text: `${attendee.username} · ${translate(roleKey)} · ${formatDate(attendee.rsvpAt)}` }),
    ]),
    createElement('button', {
      class: 'btn btn-small btn-quiet',
      type: 'button',
      text: translate('security.remove'),
      'aria-label': translate('manage.attendee-remove', { name }),
      onclick: () => removeAttendee(attendee.username, attendee.staff),
    }),
  ]);
}

function renderAttendees() {
  const box = byId('attendeesBox');
  box.hidden = !editing;
  if (!editing) {
    return;
  }
  byId('attendeesTitle').textContent = translate('manage.attendees', { count: attendees.length });
  let attendeeRows;
  if (attendees.length === 0) {
    attendeeRows = [createElement('li', { class: 'muted small', text: translate('manage.attendees-none') })];
  } else {
    attendeeRows = attendees.map((attendee) => attendeeRow(attendee));
  }
  byId('attendeeList').replaceChildren(...attendeeRows);
}

function showEditor(title) {
  byId('editorTitle').textContent = title;
  byId('editorError').textContent = '';
  // Only admins delete, and only an event that has been saved.
  let canDelete = false;
  if (editing && currentUser.role === 'admin') {
    canDelete = true;
  }
  byId('editorDelete').hidden = !canDelete;
  byId('editorView').hidden = !editing;
  if (editing) {
    byId('editorView').href = `/e/${encodeURIComponent(editing.slug)}`;
  }
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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('editorSave'), byId('editorError'), async () => {
    let body;
    if (editing) {
      body = { action: 'update', id: editing.id, event: readForm() };
    } else {
      body = { action: 'create', event: readForm() };
    }
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

// Signed out: off to sign in, then back here. Signed in without the right to
// manage: a message instead of the list. Otherwise the list and the staff
// tools load, and /manage?slug=... opens that event in the form.
async function start() {
  const currentSession = await session;
  if (!currentSession.signedIn) {
    location.replace(`/login?next=${encodeURIComponent('/manage')}`);
    return;
  }
  currentUser = currentSession.user;
  if (!currentUser.canManage) {
    byId('manageError').textContent = translate('error.manage_only');
    byId('listBox').hidden = true;
    return;
  }
  byId('newEvent').hidden = false;
  fillTimeZones();
  startTools(currentUser);
  try {
    await loadList();
  } catch (error) {
    byId('manageError').textContent = errorText(error);
    return;
  }
  // /manage?slug=... from an event page's "Edit this event".
  const slug = new URLSearchParams(location.search).get('slug');
  let match = null;
  if (slug) {
    match = events.find((row) => row.slug === slug);
  }
  if (match) {
    openEditor(match.id);
  }
}

onChange(() => {
  if (events.length) {
    renderList();
  }
  if (!form.hidden) {
    renderAttendees();
  }
});

start();
