// Editors: every event in a list, and one form to create or edit. The server
// checks the role on every request; hiding things here is only tidiness.

import { session } from '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { el, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { coverToWebp } from '../cover-upload.js';

const $ = (id) => document.getElementById(id);
const form = $('eventForm');

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
  const list = $('tzList');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Asia/Singapore']; }
  list.replaceChildren(...zones.map((z) => el('option', { value: z })));
}

function statusLabel(row) {
  if (row.status === 'published' && !row.released) return t('status.scheduled');
  return t(`status.${row.status}`);
}

function renderList() {
  $('listBox').setAttribute('aria-busy', 'false');
  $('listEmpty').hidden = events.length > 0;
  $('eventList').replaceChildren(...events.map((row) => el('li', { class: 'item-row' }, [
    iconNode('calendar'),
    el('span', { class: 'item-main' }, [
      el('span', { class: 'item-title', text: row.title }),
      el('span', { class: 'muted small', text: [
        statusLabel(row),
        t(`kind.${row.kind}`),
        row.datesHidden || !row.startsAt ? t('event.dates-tba') : formatDate(row.startsAt),
        row.capacity ? t('event.going-of', { count: row.going, capacity: row.capacity }) : t('event.going', { count: row.going }),
      ].join(' · ') }),
    ]),
    el('span', { class: `chip status-${row.status}${row.released ? '' : ' unreleased'}`, text: statusLabel(row) }),
    el('button', { class: 'btn btn-small', type: 'button', text: t('manage.edit'), 'aria-label': t('manage.edit-named', { title: row.title }), onclick: () => openEditor(row.id) }),
  ])));
}

async function loadList() {
  const data = await api('/api/manage/events');
  events = data.events;
  renderList();
}

function setForm(values) {
  for (const name of TEXT_FIELDS) $(`f-${name}`).value = values[name] ?? '';
  for (const name of CHECK_FIELDS) $(`f-${name}`).checked = values[name] === true;
  cover = { url: values.coverImageUrl || '', has: values.hasCover === true };
  renderCover();
  syncDependent();
}

// The cover picture is uploaded on its own (api/manage/cover.js), so a new
// event is saved first.
function renderCover() {
  const box = $('coverPreview');
  box.replaceChildren();
  box.classList.toggle('no-image', !cover.has);
  if (cover.has && cover.url) {
    box.append(el('img', { src: cover.url, alt: '', referrerpolicy: 'no-referrer' }));
  } else {
    box.append(iconNode('image'));
  }
  $('coverPick').hidden = !editing;
  $('coverSaveFirst').hidden = Boolean(editing);
  $('coverRemove').hidden = !(editing && cover.has);
  $('coverError').textContent = '';
}

$('coverFile').addEventListener('change', () => {
  const file = $('coverFile').files?.[0];
  $('coverFile').value = '';
  if (!file || !editing) return;
  withBusy($('coverPick'), $('coverError'), async () => {
    const { dataUrl } = await coverToWebp(file);
    const data = await post('/api/manage/cover', { id: editing.id, image: dataUrl });
    cover = { url: data.event.coverImageUrl, has: data.event.hasCover };
    renderCover();
    $('manageNotice').textContent = t('manage.cover-saved');
  });
});

$('coverRemove').addEventListener('click', () => {
  withBusy($('coverRemove'), $('coverError'), async () => {
    const data = await post('/api/manage/cover', { id: editing.id, remove: true });
    cover = { url: '', has: data.event.hasCover };
    renderCover();
  });
});

function readForm() {
  const out = {};
  for (const name of TEXT_FIELDS) out[name] = $(`f-${name}`).value;
  for (const name of CHECK_FIELDS) out[name] = $(`f-${name}`).checked;
  return out;
}

// Fields that only mean something with another one switched on.
function syncDependent() {
  const paid = $('f-priceType').value === 'paid';
  for (const name of ['currency', 'priceMin', 'priceMax']) $(`f-${name}`).disabled = !paid;
  $('f-onlineUrl').disabled = !$('f-isOnline').checked;
}

form.addEventListener('change', (e) => {
  if (e.target.id === 'f-priceType' || e.target.id === 'f-isOnline') syncDependent();
});

function renderAttendees() {
  const box = $('attendeesBox');
  box.hidden = !editing;
  if (!editing) return;
  $('attendeesTitle').textContent = t('manage.attendees', { count: attendees.length });
  $('attendeeList').replaceChildren(
    ...(attendees.length === 0
      ? [el('li', { class: 'muted small', text: t('manage.attendees-none') })]
      : attendees.map((a) => el('li', { class: 'item-row' }, [
        iconNode('user'),
        el('span', { class: 'item-main' }, [
          el('span', { text: a.displayName || a.username }),
          el('span', { class: 'muted small', text: `${a.username} · ${t(a.staff ? 'role.staff' : 'role.member')} · ${formatDate(a.rsvpAt)}` }),
        ]),
        el('button', {
          class: 'btn btn-small btn-quiet',
          type: 'button',
          text: t('security.remove'),
          'aria-label': t('manage.attendee-remove', { name: a.displayName || a.username }),
          onclick: () => removeAttendee(a.username, a.staff),
        }),
      ])))
  );
}

function showEditor(title) {
  $('editorTitle').textContent = title;
  $('editorError').textContent = '';
  $('editorDelete').hidden = !(editing && me.role === 'admin');
  $('editorView').hidden = !editing;
  if (editing) $('editorView').href = `/e/${encodeURIComponent(editing.slug)}`;
  form.hidden = false;
  renderCover();
  renderAttendees();
  $('editorTitle').tabIndex = -1;
  $('editorTitle').focus();
}

async function openEditor(id) {
  $('manageNotice').textContent = '';
  try {
    const data = await api(`/api/manage/events?id=${encodeURIComponent(id)}`);
    editing = { id: data.event.id, slug: data.event.slug };
    attendees = data.attendees;
    setForm(data.event);
    showEditor(t('manage.edit-title', { title: data.event.title }));
  } catch (error) {
    $('manageError').textContent = errorText(error);
  }
}

function openNew() {
  editing = null;
  attendees = [];
  $('manageNotice').textContent = '';
  setForm(BLANK);
  showEditor(t('manage.new-title'));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('editorSave'), $('editorError'), async () => {
    const body = editing
      ? { action: 'update', id: editing.id, event: readForm() }
      : { action: 'create', event: readForm() };
    const data = await post('/api/manage/events', body);
    editing = { id: data.event.id, slug: data.event.slug };
    setForm(data.event);
    showEditor(t('manage.edit-title', { title: data.event.title }));
    $('manageNotice').textContent = t('manage.saved');
    await loadList();
  });
});

async function removeAttendee(username, staff) {
  await withBusy(null, $('editorError'), async () => {
    const data = await post('/api/manage/events', { action: 'remove-attendee', id: editing.id, username, staff });
    attendees = data.attendees;
    renderAttendees();
    await loadList();
  });
}

$('editorDelete').addEventListener('click', () => openModal('deleteModal'));
$('deleteConfirm').addEventListener('click', () => {
  withBusy($('deleteConfirm'), $('editorError'), async () => {
    await post('/api/manage/events', { action: 'delete', id: editing.id });
    closeModal('deleteModal');
    editing = null;
    form.hidden = true;
    $('manageNotice').textContent = t('manage.deleted');
    await loadList();
  });
});

$('editorClose').addEventListener('click', () => {
  form.hidden = true;
  editing = null;
  $('newEvent').focus();
});
$('newEvent').addEventListener('click', openNew);

async function start() {
  const s = await session;
  if (!s.signedIn) {
    location.replace(`/login?next=${encodeURIComponent('/manage')}`);
    return;
  }
  me = s.user;
  if (!me.canManage) {
    $('manageError').textContent = t('error.manage_only');
    $('listBox').hidden = true;
    return;
  }
  $('newEvent').hidden = false;
  fillTimeZones();
  try {
    await loadList();
  } catch (error) {
    $('manageError').textContent = errorText(error);
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
