// Editors: the events in a list, ten to a page, in the Event list tab; one
// form to create or edit an event in the Manage event tab; the staff tools in
// the other tabs (manage-tools.js). The server checks the role on every
// request; hiding things here is only tidiness.
//
// The form saves itself: whenever the editor leaves a field (or picks from a
// list, ticks a box, removes a location or fills one from a link) and the
// form differs from what was last saved, the whole form is sent, one save at
// a time. A new event is created as soon as it has what the server needs (a
// title, both descriptions, and a start date or "to be announced"). The pill
// at the bottom of the form says how it stands; a save the server refuses
// says why there, and is tried again at the next change. The server batches
// the notices a run of saves sends to people going (api/_lib/notify.js).
//
// The form's sections are tabs of their own (Basics, When and where, Price
// and RSVP, Meals, Timetable, Attendees and notes), so a section is a click away rather
// than a long scroll; the tab holding a field the pill asks about is marked.
// The two descriptions are rich text, written in a Word-like editor
// (rich-editor.js); a picture pasted into the editor goes into the gallery
// and in at the cursor. A picture pasted anywhere else in the open form
// (Ctrl+V, or Cmd+V) is added to the gallery, exactly as if it had been chosen with "Add pictures". The
// cover is cut from a gallery picture ("Use as cover"), in the crop dialog.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { cropToWebp, widestCrop, MIN_WIDTH } from '../cover-upload.js';
import { cropCover } from '../cover-crop.js';
import { fetchPicture } from '../gallery-upload.js';
import { startGallery, loadGallery, addGalleryFiles, setGalleryCover, galleryImage, galleryImages, galleryReady, copyGalleryPicture } from '../manage-gallery.js';
import { startRichEditors, showEditor as showDescriptionEditor, setDescription, readDescription, descriptionBlank, insertPictures, focusEditor } from '../rich-editor.js';
import { hydrateRichIcons } from '../rich-icons.js';
import { startPicturePicker, openPicturePicker } from '../picture-picker.js';
import { startEmojiPicker } from '../emoji-picker.js';
import { startTools } from '../manage-tools.js';
import { startEditors, loadEditors } from '../manage-editors.js';
import { startTabs } from '../tabs.js';
import { startTours } from '../tour.js';
import { fillTimeZoneSelect, fillCurrencyList, currencyLabel, currencyCodeFrom, countryName } from '../choices.js';
import { setLocations, readLocations, startLocations, relabelLocations, LOCATIONS_CHANGED } from '../manage-locations.js';
import { startLangSwitch } from '../lang-switch.js';
import { setMeals, readMeals, startMeals, relabelMeals, mealNameFor, MEALS_CHANGED } from '../manage-meals.js';
import { setTiers, readTiers, startTiers, relabelTiers, addTier, syncTierPayment, TIERS_CHANGED } from '../manage-tiers.js';
import { startOrganiser, syncOrganiser, relabelOrganiser } from '../manage-organiser.js';
import { setTimetable, readTimetable, startTimetable, relabelTimetable, TIMETABLE_CHANGED } from '../manage-timetable.js';
import { mealLabel } from '../format.js';
import { setContact, readContact, startContact, relabelContact, CONTACT_CHANGED } from '../manage-contact.js';
import { contactText, contactHref } from '../contact-fields.js';
import { contactLabel } from '../contact-form.js';
import { setRegistration, readRegistration, startRegistration, relabelRegistration, syncRegistration, REGISTRATION_CHANGED } from '../manage-registration.js';
import { questionLabel, answerText } from '../registration-form.js';
import { startPayment, setPayment, readPayment, applySavedPayment, syncPayment, setPaymentProblems, attendeePaymentText, attendeePaymentControls, renderPaymentCounts, proofHref } from '../manage-payment.js';
import { csvText, downloadCsv } from '../attendees-csv.js';

const byId = (id) => document.getElementById(id);
const form = byId('eventForm');

const PAGE_SIZE = 10;

// The form's plain fields, by the name the server takes. The time zone,
// currency, locations, ticket tiers, meals, the earlier convention a
// volunteer benefit is for and the timetable's rooms and items have their
// own handling below.
const TEXT_FIELDS = [
  'title', 'slug', 'kind', 'summary', 'organiserName', 'externalUrl',
  'startDate', 'startTime', 'endDate', 'endTime', 'onlineUrl',
  'priceType', 'priceMin', 'priceMax', 'priceNote', 'capacity', 'status', 'publishLocal', 'staffNotes',
  'volunteerDiscountType', 'volunteerDiscountValue', 'timetableView', 'externalUrlLabel', 'externalUrlCustomLabel',
  'lepakLabel', 'lepakLimit',
];
const CHECK_FIELDS = ['datesHidden', 'addressAttendeesOnly', 'isOnline', 'priceHidden', 'tiersEnabled', 'rsvpOpen', 'fursuitersAsked', 'volunteersWanted', 'volunteerDiscountEnabled', 'crossBorder', 'lepakEnabled'];

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
  locations: [{ label: 'event' }],
  meals: [],
  ticketTiers: [],
  volunteerDiscountType: 'percent',
  timetableView: 'timeline',
  externalUrlLabel: 'tickets_website',
  timetableRooms: [],
  timetableItems: [],
  contactFields: [],
  contactRule: 'any',
  registrationEnabled: false,
  registrationFields: null,
};

let currentUser = null;
let events = [];
let page = 0; // the list page shown, from 0
// Which events the list shows, by status: 'published' (released or
// scheduled), 'draft' or 'cancelled'. Each has its own pages.
const LIST_STATUSES = ['published', 'draft', 'cancelled'];
let listStatus = 'published';
let editing = null; // { id, slug } of the event in the form, or null for a new one
let attendees = [];
// The meals the open event offers as last saved ([{ id, label }]), for
// naming the meals attendees are coming for.
let savedMeals = [];
// Whether the open event is cross-border as last saved (migrations/015): its
// attendee list then says where each person is from.
let savedCrossBorder = false;
// The cover as last saved: its address, whether there is one, the gallery
// picture it was cut from ('' when none is known) and the crop, so "Adjust
// crop" can start from it.
let cover = { url: '', has: false, sourceId: '', crop: null };
let tabs = null;
// The edit form's own section tabs.
let editorTabs = null;
// The list is reloaded when its tab is opened after a save changed it.
let listStale = false;

// Autosave. lastSaved is the form (readForm, as JSON) as it was last saved or
// opened; saving is the save on its way, if any; again is set when another
// change came while it was; failed is the reason the last one was refused,
// and refused the form it was refused for (not sent again unchanged).
let lastSaved = '';
let saving = null;
let again = false;
let againForced = false;
let failed = null;
// The form field the pill's refusal is about, and where it is ({ field,
// detail }), so its tab can be marked; null when the refusal names none.
let problem = null;
let refused = '';

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

// The events with the status the list shows, newest change first.
function listedEvents() {
  return events.filter((row) => row.status === listStatus);
}

function pageCount() {
  return Math.max(1, Math.ceil(listedEvents().length / PAGE_SIZE));
}

// The status buttons, each with its count, the one shown pressed.
function renderListStatus() {
  for (const button of byId('listStatus').querySelectorAll('[data-list-status]')) {
    button.setAttribute('aria-pressed', String(button.dataset.listStatus === listStatus));
  }
  for (const status of LIST_STATUSES) {
    const count = events.filter((row) => row.status === status).length;
    byId('listStatus').querySelector(`[data-list-count="${status}"]`).textContent = String(count);
  }
}

// The list's current page, for the status picked, and the pager under it
// while there is more than one page. With no events at all, "No events
// yet"; with none of this status, a line saying so.
function renderList() {
  byId('listBox').setAttribute('aria-busy', 'false');
  renderListStatus();
  const listed = listedEvents();
  byId('listEmpty').hidden = events.length > 0;
  byId('listStatus').hidden = events.length === 0;
  let noneOfStatus = false;
  if (events.length > 0 && listed.length === 0) {
    noneOfStatus = true;
  }
  byId('listEmptyStatus').hidden = !noneOfStatus;
  byId('listEmptyStatus').textContent = translate(`manage.list-empty-status.${listStatus}`);
  const pages = pageCount();
  if (page > pages - 1) {
    page = pages - 1;
  }
  const shown = listed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  byId('eventList').replaceChildren(...shown.map((row) => eventRow(row)));
  byId('listPager').hidden = pages < 2;
  byId('pageInfo').textContent = translate('manage.page-of', { page: page + 1, pages });
  byId('pagePrev').disabled = page === 0;
  byId('pageNext').disabled = page >= pages - 1;
}

function turnPage(step) {
  page += step;
  renderList();
  byId('listBox').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

byId('pagePrev').addEventListener('click', () => turnPage(-1));
byId('pageNext').addEventListener('click', () => turnPage(1));

// Picking a status shows its events from their first page.
function showListStatus(status) {
  if (!LIST_STATUSES.includes(status)) {
    return;
  }
  if (status !== listStatus) {
    page = 0;
  }
  listStatus = status;
  renderList();
}

byId('listStatus').addEventListener('click', (event) => {
  const button = event.target.closest('[data-list-status]');
  if (button) {
    showListStatus(button.dataset.listStatus);
  }
});

async function loadList() {
  const data = await api('/api/manage/events');
  events = data.events;
  listStale = false;
  renderList();
  // The earlier conventions a volunteer benefit can be for come from it.
  if (!form.hidden && document.activeElement !== byId('f-volunteerDiscountFrom')) {
    fillVolunteerSources(byId('f-volunteerDiscountFrom').value);
  }
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
  syncOrganiser({ reset: true });
  setDescription('en', values.description);
  setDescription('zh', values.descriptionZh);
  descriptionSwitch.select('en');
  markMissingDescriptions();
  showSlugTaken(null);
  fillTimeZoneSelect(byId('f-timezone'), values.timezone);
  byId('f-currency').value = currencyLabel(values.currency);
  let locations = values.locations;
  if (!Array.isArray(locations)) {
    locations = [];
  }
  setLocations(locations);
  let tiers = values.ticketTiers;
  if (!Array.isArray(tiers)) {
    tiers = [];
  }
  setTiers(tiers);
  savedCrossBorder = values.crossBorder === true;
  savedMeals = [];
  if (Array.isArray(values.meals)) {
    savedMeals = values.meals;
  }
  setMeals(savedMeals);
  let rooms = values.timetableRooms;
  if (!Array.isArray(rooms)) {
    rooms = [];
  }
  let items = values.timetableItems;
  if (!Array.isArray(items)) {
    items = [];
  }
  setTimetable(rooms, items);
  setPayment(values);
  setContact(values);
  setRegistration(values);
  fillVolunteerSources(values.volunteerDiscountFrom);
  setCover(values);
  syncDependent();
  lastSaved = JSON.stringify(readForm());
  failed = null;
  refused = '';
}

// The cover from an answer (the edit form's, or api/manage/cover.js's).
function setCover(values) {
  let url = values.coverImageUrl;
  if (!url) {
    url = '';
  }
  let sourceId = values.coverSourceId;
  if (!sourceId) {
    sourceId = '';
  }
  let crop = values.coverCrop;
  if (!crop) {
    crop = null;
  }
  cover = { url, has: values.hasCover === true, sourceId, crop };
  renderCover();
  setGalleryCover(sourceId);
}

// The cover is uploaded on its own (api/manage/cover.js), cut from a gallery
// picture, so a new event is saved first. "Adjust crop" shows while the
// picture it was cut from is still in the gallery.
function renderCover() {
  const box = byId('coverPreview');
  box.replaceChildren();
  box.classList.toggle('no-image', !cover.has);
  if (cover.has && cover.url) {
    box.append(createElement('img', { src: cover.url, alt: '', referrerpolicy: 'no-referrer' }));
  } else {
    box.append(iconNode('image'));
  }
  let canRemove = false;
  if (editing && cover.has) {
    canRemove = true;
  }
  byId('coverRemove').hidden = !canRemove;
  let canAdjust = false;
  if (canRemove && cover.sourceId) {
    canAdjust = true;
  }
  byId('coverAdjust').hidden = !canAdjust;
  byId('coverError').textContent = '';
}

// "Use as cover" on a gallery picture: it is fetched and decoded, the crop
// dialog opens on it (on the earlier crop when the cover was cut from this
// picture, otherwise on its middle), and the part chosen is uploaded as the
// cover, with the picture and crop it came from. Closing the dialog uploads
// nothing.
async function useAsCover(image, button) {
  if (!editing || !image) {
    return;
  }
  const errorBox = byId('galleryError');
  const bitmap = await withBusy(button, errorBox, async () => {
    const decoded = await fetchPicture(image.url);
    if (widestCrop(decoded.width, decoded.height).width < MIN_WIDTH) {
      decoded.close();
      throw Object.assign(new Error('gallery_too_small_for_cover'), { code: 'gallery_too_small_for_cover' });
    }
    return decoded;
  });
  if (!bitmap) {
    return;
  }
  let start = null;
  if (cover.sourceId === image.id && cover.crop) {
    start = cover.crop;
  }
  try {
    const crop = await cropCover(bitmap, start);
    if (!crop || !editing) {
      return;
    }
    const done = await withBusy(button, errorBox, async () => {
      const { dataUrl } = await cropToWebp(bitmap, crop);
      const data = await post('/api/manage/cover', { id: editing.id, image: dataUrl, sourceImageId: image.id, crop });
      setCover(data.event);
      return true;
    });
    if (done) {
      byId('manageNotice').textContent = translate('manage.cover-saved');
    }
  } finally {
    bitmap.close();
  }
}

byId('coverAdjust').addEventListener('click', () => {
  useAsCover(galleryImage(cover.sourceId), byId('coverAdjust'));
});

// The picture on the clipboard of a paste, as a File, or null. Pasting into
// a text field keeps its text: a picture there is taken only when the
// clipboard has no text with it (an image copied from a web page often
// carries its address as text too, and is then left alone in a field).
function pastedPicture(event) {
  const data = event.clipboardData;
  if (!data) {
    return null;
  }
  const item = [...data.items].find((each) => {
    if (each.kind !== 'file') {
      return false;
    }
    return each.type.startsWith('image/');
  });
  if (!item) {
    return null;
  }
  let inField = false;
  if (event.target instanceof HTMLElement) {
    inField = event.target.matches('input, textarea, select, [contenteditable="true"]');
  }
  if (inField && data.types.includes('text/plain')) {
    return null;
  }
  return item.getAsFile();
}

// Ctrl+V (or Cmd+V) with a picture on the clipboard, anywhere in the open
// form, does what "Add pictures" does with it. Basics opens, so the gallery
// can be seen; before the event has saved, it says a picture can be added
// once it has. Not while a dialog (the crop dialog) is open.
document.addEventListener('paste', (event) => {
  // The description editor takes its own pastes.
  if (event.defaultPrevented) {
    return;
  }
  if (form.hidden || byId('panel-editor').hidden || document.querySelector('.modal-backdrop:not(.hidden)')) {
    return;
  }
  const file = pastedPicture(event);
  if (!file) {
    return;
  }
  event.preventDefault();
  editorTabs.open('basics');
  if (!editing) {
    byId('galleryError').textContent = translate('manage.hint.cover-save-first');
    byId('gallerySaveFirst').scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  byId('galleryError').textContent = '';
  addGalleryFiles([file]);
  byId('galleryList').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

byId('coverRemove').addEventListener('click', () => {
  withBusy(byId('coverRemove'), byId('coverError'), async () => {
    const data = await post('/api/manage/cover', { id: editing.id, remove: true });
    setCover(data.event);
  });
});

startGallery({
  useAsCover,
  // Taking out the picture the cover was cut from keeps the cover and
  // forgets where it came from.
  onCoverChange: (saved) => setCover(saved),
});

function readForm() {
  const values = {};
  for (const name of TEXT_FIELDS) {
    values[name] = byId(`f-${name}`).value;
  }
  for (const name of CHECK_FIELDS) {
    values[name] = byId(`f-${name}`).checked;
  }
  values.description = readDescription('en');
  values.descriptionZh = readDescription('zh');
  values.timezone = byId('f-timezone').value;
  values.currency = currencyCodeFrom(byId('f-currency').value);
  values.locations = readLocations();
  values.ticketTiers = readTiers();
  values.meals = readMeals();
  values.volunteerDiscountFrom = byId('f-volunteerDiscountFrom').value;
  Object.assign(values, readTimetable());
  Object.assign(values, readPayment());
  Object.assign(values, readContact());
  Object.assign(values, readRegistration());
  return values;
}

// The earlier conventions a volunteer benefit can be for: every other
// convention in the event list, the latest first, each with its start date.
// A convention picked that the list does not have (one made since it
// loaded) stays picked, under a plain name. selected: the id picked, or ''.
function fillVolunteerSources(selected) {
  const select = byId('f-volunteerDiscountFrom');
  let picked = selected;
  if (!picked) {
    picked = '';
  }
  const startTime = (row) => {
    if (row.datesHidden || !row.startsAt) {
      return -Infinity;
    }
    return new Date(row.startsAt).getTime();
  };
  const conventions = events
    .filter((row) => {
      if (row.kind !== 'convention') {
        return false;
      }
      if (!editing) {
        return true;
      }
      return row.id !== editing.id;
    })
    .sort((first, second) => startTime(second) - startTime(first));
  const options = [createElement('option', { value: '', text: translate('manage.volunteer-source-pick') })];
  for (const row of conventions) {
    let date = translate('event.dates-tba');
    if (!row.datesHidden && row.startsAt) {
      date = formatDate(row.startsAt);
    }
    options.push(createElement('option', { value: row.id, text: translate('manage.volunteer-source', { title: row.title, date }) }));
  }
  if (picked && !conventions.some((row) => row.id === picked)) {
    options.push(createElement('option', { value: picked, text: translate('manage.volunteer-source-other') }));
  }
  select.replaceChildren(...options);
  select.value = picked;
  byId('volunteerSourcesNone').hidden = conventions.length > 0;
}

// Fields that only mean something with another one switched on. Tiers are
// for a paid event, and while they are on the price range comes from them.
function syncDependent() {
  const paid = byId('f-priceType').value === 'paid';
  byId('f-currency').disabled = !paid;
  byId('f-tiersEnabled').disabled = !paid;
  let tiersOn = false;
  if (paid && byId('f-tiersEnabled').checked) {
    tiersOn = true;
  }
  for (const name of ['priceMin', 'priceMax']) {
    let rangeOff = tiersOn;
    if (!paid) {
      rangeOff = true;
    }
    byId(`f-${name}`).disabled = rangeOff;
  }
  byId('tierSection').hidden = !tiersOn;
  // The registration form's questions go with a ticket: a paid event's
  // Questions tab, its tier pickers listing the tiers as they are now.
  const questionsTab = byId('etab-questions');
  if (questionsTab.hidden === paid) {
    questionsTab.hidden = !paid;
    if (editorTabs) {
      editorTabs.refresh();
    }
  }
  syncRegistration();
  byId('f-onlineUrl').disabled = !byId('f-isOnline').checked;
  // The editor's own words for the link button, only for "My own words".
  byId('externalUrlCustomField').hidden = byId('f-externalUrlLabel').value !== 'custom';
  // An itinerary's steps have a time only: no rooms, ends or rooms per item.
  byId('epanel-timetable').classList.toggle('is-itinerary', byId('f-timetableView').value === 'timeline');
  // Only a convention takes volunteers; the benefit's fields mean something
  // only while it is switched on, and a percentage goes up to 100.
  const convention = byId('f-kind').value === 'convention';
  byId('volunteersConventionOnly').hidden = convention;
  byId('volunteerFields').hidden = !convention;
  let discountOn = false;
  if (convention && byId('f-volunteerDiscountEnabled').checked) {
    discountOn = true;
  }
  for (const name of ['volunteerDiscountFrom', 'volunteerDiscountType', 'volunteerDiscountValue']) {
    byId(`f-${name}`).disabled = !discountOn;
  }
  if (byId('f-volunteerDiscountType').value === 'percent') {
    byId('f-volunteerDiscountValue').max = '100';
  } else {
    byId('f-volunteerDiscountValue').removeAttribute('max');
  }
  // "Just Lepak Only" is for a paid event; its words and places mean
  // something only while it is on.
  // What the event's status means, and its colour on the Publishing box.
  const status = byId('f-status').value;
  byId('publishBox').dataset.status = status;
  byId('statusMeaning').textContent = translate(`manage.status-meaning.${status}`);
  byId('lepakNotPaid').hidden = paid;
  byId('lepakFields').hidden = !paid;
  for (const name of ['lepakLabel', 'lepakLimit']) {
    byId(`f-${name}`).disabled = !byId('f-lepakEnabled').checked;
  }
  syncPayment();
}

// The two descriptions, both required: [language, form field]. The switcher
// shows one editor at a time, and marks a language still blank.
const DESCRIPTIONS = [
  ['en', 'description'],
  ['zh', 'descriptionZh'],
];
const descriptionSwitch = startLangSwitch(byId('descriptionSwitch'), (lang) => showDescriptionEditor(lang));

function markMissingDescriptions() {
  for (const [lang] of DESCRIPTIONS) {
    const button = descriptionSwitch.buttons.find((each) => each.dataset.lang === lang);
    button.querySelector('.missing-mark').hidden = !descriptionBlank(lang);
  }
}

// The editor's pictures go into this event's gallery.
hydrateRichIcons(byId('richToolbar'));
startRichEditors({ en: byId('f-description'), zh: byId('f-descriptionZh') }, {
  onChange: markMissingDescriptions,
  openPicturePicker,
  uploadFiles: (files) => addGalleryFiles(files),
  copyPicture: (address) => copyGalleryPicture(address),
  canAddPictures: () => galleryReady(),
});
startPicturePicker({
  galleryImages,
  canAddPictures: () => galleryReady(),
  uploadFiles: (files) => addGalleryFiles(files),
  insert: (pictures) => {
    insertPictures(pictures);
    autosave({ force: true });
  },
});
byId('descriptionLabel').addEventListener('click', focusEditor);
startEmojiPicker();
// A picture copied into the gallery after a paste changes the description
// without the editor being left: it is saved when it lands.
form.addEventListener('rich-pictures-settled', () => autosave({ force: true }));

// The first field the server needs that is still blank (a title, both
// descriptions, and a start date unless the dates are to be announced), or
// null. A new event is created once there is none; an existing one is not
// sent while there is one, and the pill names it instead.
function missingField(values) {
  for (const name of ['title', 'description', 'descriptionZh']) {
    if (values[name].trim() === '') {
      return name;
    }
  }
  if (!values.datesHidden && values.startDate === '') {
    return 'startDate';
  }
  return null;
}

// Inputs that save as soon as they change: a pick from a list, a box ticked.
// Text, dates, times and numbers save when the editor leaves them.
function savesOnChange(element) {
  if (element.tagName === 'SELECT') {
    return true;
  }
  if (element.type === 'checkbox' || element.type === 'radio') {
    return true;
  }
  return false;
}

// The cards saved only once they are left: a ticket tier, a timetable room
// and a timetable item.
const DRAFT_CARDS = '.tier-edit-card, .room-row, .timetable-item-card';

form.addEventListener('change', (event) => {
  if (['f-priceType', 'f-isOnline', 'f-tiersEnabled', 'f-kind', 'f-volunteerDiscountEnabled', 'f-volunteerDiscountType', 'f-timetableView', 'f-externalUrlLabel', 'f-lepakEnabled', 'f-status'].includes(event.target.id)
    || event.target.hasAttribute('data-payment-method')) {
    syncDependent();
  }
  // The attendee list's Volunteered and Paid boxes save on their own, and
  // the QR code uploads on its own.
  if (event.target.closest('#attendeeList') || event.target.closest('#epanel-editors') || event.target.id === 'payQrFile') {
    return;
  }
  // A convention draws people from everywhere, so Kind set to Convention
  // ticks "Cross-border event" (the editor can untick it). Saved with it.
  if (event.target.id === 'f-kind' && event.target.value === 'convention') {
    byId('f-crossBorder').checked = true;
    // And a convention registers its people (migrations/024), with the
    // ready-made questions to start from (the editor can untick it).
    byId('f-registrationEnabled').checked = true;
    syncRegistration();
  }
  // Tiers switched on with none yet: a first card to fill in.
  if (event.target.id === 'f-tiersEnabled' && event.target.checked && readTiers().length === 0) {
    addTier();
  }
  // A link typed with capitals, spaces or other signs is tidied into one
  // the server takes before it is saved; a new one clears the "taken" note.
  if (event.target.id === 'f-slug') {
    event.target.value = tidySlug(event.target.value);
    showSlugTaken(null);
  }
  // A currency typed as a code or a name shows as "SGD — Singapore Dollar"
  // (the event's, or a tier's own).
  if (event.target.id === 'f-currency' || (event.target.dataset.key === 'currency' && event.target.closest('.tier-edit-card'))) {
    const code = currencyCodeFrom(event.target.value);
    const label = currencyLabel(code);
    if (label !== code) {
      event.target.value = label;
    }
  }
  if (savesOnChange(event.target)) {
    // A box ticked or a choice made in a tier card saves even while the
    // card is still being filled in. A room picked in a timetable item waits
    // for the card to be left, like its other fields: its start time may
    // not be in yet.
    autosave({ force: event.target.closest('.tier-edit-card') !== null });
  }
});

// Whether the editor is in one of those cards (focus is in it, or moving
// into it), so it is not refused for its price or start time while its name
// is still being typed.
function inDraftCard(element) {
  if (!element || typeof element.closest !== 'function') {
    return false;
  }
  return element.closest(DRAFT_CARDS) !== null;
}

// Leaving a field saves it, unless focus moves into one of those cards (it
// is saved when that card is left). Gallery pictures are uploaded on their
// own.
form.addEventListener('focusout', (event) => {
  if (event.target.id === 'galleryFile') {
    return;
  }
  if (inDraftCard(event.relatedTarget)) {
    return;
  }
  autosave();
});
form.addEventListener(LOCATIONS_CHANGED, () => autosave());
form.addEventListener(MEALS_CHANGED, () => autosave());
form.addEventListener(CONTACT_CHANGED, () => autosave());
form.addEventListener(REGISTRATION_CHANGED, () => autosave());
form.addEventListener(TIERS_CHANGED, () => autosave({ force: true }));
form.addEventListener(TIMETABLE_CHANGED, () => autosave({ force: true }));

// Enter in a text field saves at once, rather than sending the form.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  autosave();
});

// The event link as the server takes it: lowercase letters, numbers and
// single hyphens, at most 60 characters ('' to make it from the title).
function tidySlug(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// The length of the random ending "Add eight random characters" puts on a
// taken link, and the letters it is made of.
const SLUG_ENDING = 8;
const SLUG_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomEnding() {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_ENDING));
  return [...bytes].map((byte) => SLUG_LETTERS[byte % SLUG_LETTERS.length]).join('');
}

// The note under the link field when another event already uses it (slug:
// the link that was refused), with its two ways on; null hides it.
function showSlugTaken(slug) {
  byId('slugTaken').hidden = slug === null;
  if (slug !== null) {
    byId('slugTakenText').textContent = translate('manage.slug-taken', { link: `events.globalfurry.tv/e/${slug}` });
  }
}

// The taken link with a random ending ("riverside-meet-k3x9q2ab"), cut so it
// still fits in 60 characters, then saved.
byId('slugRandom').addEventListener('click', () => {
  const field = byId('f-slug');
  let base = tidySlug(field.value);
  if (!base) {
    base = tidySlug(byId('f-title').value);
  }
  base = base.slice(0, 60 - SLUG_ENDING - 1).replace(/-+$/g, '');
  let slug = randomEnding();
  if (base) {
    slug = `${base}-${slug}`;
  }
  field.value = slug;
  showSlugTaken(null);
  autosave();
  field.focus();
});

// Back to the link field to try another; it is checked and saved when the
// field is left.
byId('slugEdit').addEventListener('click', () => {
  byId('f-slug').focus();
  byId('f-slug').select();
});

// The pill at the bottom of the form: saving, saved, why a save was refused,
// or what a new event still needs before it can be saved.
function renderStatus() {
  let shownProblem = null;
  if (failed) {
    shownProblem = problem;
  }
  markProblemTab(shownProblem);
  const box = byId('autosaveStatus');
  box.className = 'autosave-status';
  box.replaceChildren();
  if (form.hidden) {
    return;
  }
  if (saving) {
    box.append(createElement('span', { class: 'spinner' }), createElement('span', { text: translate('manage.autosave.saving') }));
    return;
  }
  if (failed) {
    box.classList.add('is-failed');
    box.append(iconNode('alert'), createElement('span', { text: translate('manage.autosave.failed', { reason: failed }) }));
    return;
  }
  if (!editing) {
    box.append(createElement('span', { text: translate('manage.autosave.new') }));
    return;
  }
  if (isDirty()) {
    box.append(createElement('span', { text: translate('manage.autosave.unsaved') }));
    return;
  }
  box.classList.add('is-saved');
  box.append(iconNode('check'), createElement('span', { text: translate('manage.autosave.saved') }));
}

// Fields that are not one input of their own, by the section tab they are in.
const FIELD_TABS = {
  locations: 'when', locationLabel: 'when', customLabel: 'when', venueName: 'when', venueAddress: 'when', city: 'when', country: 'when', mapsUrl: 'when',
  ticketTiers: 'price', tierName: 'price', tierPrice: 'price', tierBenefits: 'price', tierMaxPerPerson: 'price', tierLimit: 'price', tierCurrency: 'price',
  meals: 'meals', mealLabel: 'meals', mealLimit: 'meals', mealLocations: 'meals',
  contactFields: 'price', contactLabel: 'price',
  registrationFields: 'questions', registrationLabel: 'questions', registrationHint: 'questions', registrationOptions: 'questions', registrationLink: 'questions', registrationTiers: 'questions',
  tierClosesLocal: 'price',
  timetableRooms: 'timetable', roomName: 'timetable', roomTag: 'timetable',
  timetableItems: 'timetable', itemTitle: 'timetable', itemDate: 'timetable', itemStart: 'timetable', itemEnd: 'timetable', itemNote: 'timetable',
};

// The section tab a refused field is in: a meal's place is under Meals, a
// ticket tier's field under Price, a location's under When and where, a
// timetable room's or item's under Timetable, and any other field wherever
// its input is.
function tabOfField({ field, detail }) {
  if (typeof detail.meal === 'string') {
    return 'meals';
  }
  if (Number.isInteger(detail.room) || Number.isInteger(detail.item)) {
    return 'timetable';
  }
  if (Number.isInteger(detail.tier)) {
    return 'price';
  }
  if (Number.isInteger(detail.location)) {
    return 'when';
  }
  const input = byId(`f-${field}`);
  if (input && input.closest('.editor-panel')) {
    return input.closest('.editor-panel').id.replace(/^epanel-/, '');
  }
  if (FIELD_TABS[field]) {
    return FIELD_TABS[field];
  }
  return null;
}

// Marks the tab with the field the pill asks about (none: no marks).
function markProblemTab(shown) {
  let name = null;
  if (shown) {
    name = tabOfField(shown);
  }
  for (const tab of byId('editorTabs').querySelectorAll('[role="tab"]')) {
    tab.querySelector('.tab-mark').hidden = tab.dataset.tab !== name;
  }
}

function isDirty() {
  return JSON.stringify(readForm()) !== lastSaved;
}

// After a save, the server's tidied values (a trimmed title, an end date
// filled in from the start date) go into the fields the editor has not
// touched since it was sent and is not in. The locations are left as they
// are, so a card being filled in is never redrawn under the editor.
function applySaved(saved, sent) {
  const now = readForm();
  for (const name of TEXT_FIELDS) {
    const field = byId(`f-${name}`);
    let value = saved[name];
    if (value === null || value === undefined) {
      value = '';
    }
    value = String(value);
    if (now[name] === sent[name] && document.activeElement !== field && field.value !== value) {
      field.value = value;
    }
  }
  for (const name of CHECK_FIELDS) {
    if (now[name] === sent[name]) {
      byId(`f-${name}`).checked = saved[name] === true;
    }
  }
  if (now.currency === sent.currency && document.activeElement !== byId('f-currency')) {
    byId('f-currency').value = currencyLabel(saved.currency);
  }
  if (now.volunteerDiscountFrom === sent.volunteerDiscountFrom && document.activeElement !== byId('f-volunteerDiscountFrom')) {
    fillVolunteerSources(saved.volunteerDiscountFrom);
  }
  applySavedPayment(saved, now, sent);
  syncOrganiser();
  syncTierPayment();
  syncDependent();
  markMissingDescriptions();
}

// Saves the form if it changed since the last save, one save at a time: a
// change while one is on its way is saved straight after it. Resolves once
// nothing is left to save (or a save was refused). While the editor is in a
// tier card, timetable room or item, it waits for that to be left, unless
// force says not to (a change made in the card itself, or leaving or hiding
// the page).
function autosave({ force = false } = {}) {
  if (form.hidden) {
    return Promise.resolve();
  }
  if (!force && !saving && inDraftCard(document.activeElement)) {
    renderStatus();
    return Promise.resolve();
  }
  if (saving) {
    again = true;
    if (force) {
      againForced = true;
    }
    return saving;
  }
  const sent = readForm();
  const body = JSON.stringify(sent);
  // Nothing new: unchanged since the last save (a refused change undone
  // counts), or the very change that was just refused.
  if (body === lastSaved) {
    failed = null;
    renderStatus();
    return Promise.resolve();
  }
  if (body === refused) {
    renderStatus();
    return Promise.resolve();
  }
  const missing = missingField(sent);
  if (missing && !editing) {
    failed = null;
    renderStatus();
    return Promise.resolve();
  }
  if (missing) {
    failed = translate('error.invalid_field', { field: translate(`manage.field.${missing}`) });
    problem = { field: missing, detail: {} };
    refused = body;
    renderStatus();
    return Promise.resolve();
  }
  saving = saveForm(sent, body).finally(() => {
    saving = null;
    renderStatus();
    if (again) {
      again = false;
      const forced = againForced;
      againForced = false;
      return autosave({ force: forced });
    }
    return undefined;
  });
  renderStatus();
  return saving;
}

async function saveForm(sent, body) {
  // A link the editor typed is checked first, so a taken one is told about
  // (with its two ways on) without trying to save it.
  if (sent.slug && (!editing || sent.slug !== editing.slug)) {
    let check = { free: true };
    try {
      let query = `checkSlug=${encodeURIComponent(sent.slug)}`;
      if (editing) {
        query = `${query}&id=${encodeURIComponent(editing.id)}`;
      }
      check = await api(`/api/manage/events?${query}`);
    } catch {
      // Saving tells the same thing, if the check could not.
    }
    if (!check.free) {
      failed = translate('error.slug_taken');
      problem = { field: 'slug', detail: {} };
      refused = body;
      showSlugTaken(sent.slug);
      return;
    }
  }
  let request;
  if (editing) {
    request = { action: 'update', id: editing.id, event: sent };
  } else {
    request = { action: 'create', event: sent };
  }
  let data;
  try {
    data = await post('/api/manage/events', request);
  } catch (error) {
    // A refused field in one of a meal's places is said with the meal's name.
    if (error.detail && typeof error.detail.meal === 'string') {
      error.detail.mealName = mealNameFor(error.detail.meal);
    }
    failed = errorText(error);
    problem = null;
    if (error.detail && error.detail.field) {
      problem = { field: error.detail.field, detail: error.detail };
    }
    refused = body;
    if (error.code === 'slug_taken') {
      showSlugTaken(sent.slug);
    }
    return;
  }
  failed = null;
  refused = '';
  showSlugTaken(null);
  const created = !editing;
  let moved = false;
  if (editing && editing.slug !== data.event.slug) {
    moved = true;
  }
  editing = { id: data.event.id, slug: data.event.slug };
  savedMeals = data.event.meals;
  const untouched = JSON.stringify(readForm()) === body;
  applySaved(data.event, sent);
  // Untouched since it was sent, the form now is what is saved, tidied by
  // the server. Otherwise what was sent is; the editor's newer change is
  // saved when they leave that field.
  if (untouched) {
    lastSaved = JSON.stringify(readForm());
  } else {
    lastSaved = body;
  }
  byId('editorTitle').textContent = translate('manage.edit-title', { title: data.event.title });
  listStale = true;
  // Made cross-border (or not): the attendee list comes again, with (or
  // without) everyone's country.
  if (!created && data.event.crossBorder !== savedCrossBorder) {
    savedCrossBorder = data.event.crossBorder;
    try {
      attendees = (await api(`/api/manage/events?id=${encodeURIComponent(data.event.id)}`)).attendees;
    } catch {
      // The list as it was; reopening the event brings the countries.
    }
  }
  renderAttendees();
  if (created || moved) {
    showSavedControls();
    rememberOpenEvent();
  }
}

// Once an event exists: its page link, the cover picture, the gallery and
// attendee list, and Delete for admins.
function showSavedControls() {
  let canDelete = false;
  if (editing && currentUser.role === 'admin') {
    canDelete = true;
  }
  byId('editorDelete').hidden = !canDelete;
  byId('editorView').hidden = !editing;
  if (editing) {
    byId('editorView').href = `/e/${encodeURIComponent(editing.slug)}`;
  }
  // The Editors tab (admins only) for the event open.
  if (currentUser.role === 'admin') {
    loadEditors();
  }
  renderCover();
  loadGallery(editing);
  renderAttendees();
}

// The open event is kept in the address (/manage?slug=...#editor), so a
// reload opens it again.
function rememberOpenEvent() {
  let search = '';
  if (editing) {
    search = `?slug=${encodeURIComponent(editing.slug)}`;
  }
  history.replaceState(null, '', `${location.pathname}${search}${location.hash}`);
}

// Before the form is closed or another event is opened: anything unsaved is
// saved, and a change the server refused is only dropped if the editor says
// so. Resolves true when it is fine to go on.
async function readyToLeave() {
  if (form.hidden) {
    return true;
  }
  await autosave({ force: true });
  if (saving) {
    await saving;
  }
  if (!isDirty()) {
    return true;
  }
  if (failed) {
    return window.confirm(translate('manage.autosave.leave-failed', { reason: failed }));
  }
  // A new event without enough to be saved yet.
  return window.confirm(translate('manage.autosave.leave-new'));
}

// Leaving the page with a change not saved (one the server refused, or one
// still on its way) asks first. Hiding the page (switching apps on a phone)
// saves what is there.
window.addEventListener('beforeunload', (event) => {
  if (form.hidden) {
    return;
  }
  if (saving || isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    autosave({ force: true });
  }
});

// The meals an attendee is coming for that the event still offers, named
// ("Lunch, Dinner"); '' for the whole event.
function attendeeMealsText(attendee) {
  let chosen = [];
  if (Array.isArray(attendee.meals)) {
    chosen = attendee.meals;
  }
  return savedMeals
    .filter((meal) => chosen.includes(meal.id))
    .map((meal) => mealLabel(meal))
    .join(', ');
}

// Whether the open event is a convention, which takes volunteers.
function isConvention() {
  return byId('f-kind').value === 'convention';
}

// One attendee: the name (the username when there is no display name), their
// RSVP ID for this event (migrations/013), the username, staff or member, the meals when they are coming only for those,
// when they said they are going, and a Remove button. At a convention, also
// whether they signed up to volunteer and whether they get the volunteer
// benefit for having volunteered at the earlier convention, and a
// Volunteered box an editor ticks for the ones who really did.
// The contact details someone gave (migrations/021), each named, a phone
// number, email or Telegram username as a link to reach them; null for
// none.
function attendeeContact(attendee) {
  if (!Array.isArray(attendee.contact) || attendee.contact.length === 0) {
    return null;
  }
  const parts = [];
  for (const entry of attendee.contact) {
    if (parts.length > 0) {
      parts.push(' · ');
    }
    const text = contactText(entry.type, entry.value);
    const href = contactHref(entry.type, entry.value);
    let value = createElement('span', { text });
    if (href) {
      value = createElement('a', { class: 'text-link', href, text, target: '_blank', rel: 'noopener noreferrer' });
    }
    parts.push(`${contactLabel(entry)}: `, value);
  }
  return createElement('span', { class: 'small attendee-contact' }, parts);
}

// The registration answers someone gave and the account details the form
// asks for (migrations/024), folded away under "Registration details";
// null for none. A photo opens in a new tab.
function attendeeRegistration(attendee) {
  const rows = [];
  const personal = attendee.personal;
  if (personal) {
    if ('legalName' in personal) {
      rows.push([translate('registration.preset.legalName'), personal.legalName]);
    }
    if ('age' in personal) {
      let ageText = null;
      if (personal.age !== null) {
        ageText = translate('manage.attendee-age', { age: personal.age });
        if (personal.under18) {
          ageText = translate('manage.attendee-under18', { age: personal.age });
        }
      }
      if (personal.dateOfBirth) {
        ageText = `${personal.dateOfBirth} (${ageText})`;
      }
      rows.push([translate('registration.preset.dateOfBirth'), ageText]);
    }
    if ('emergencyName' in personal) {
      let emergency = null;
      if (personal.emergencyName || personal.emergencyPhone) {
        emergency = [personal.emergencyName, personal.emergencyPhone].filter(Boolean).join(', ');
      }
      rows.push([translate('registration.preset.emergencyContact'), emergency]);
    }
  }
  if (!Array.isArray(attendee.registration)) {
    return null;
  }
  for (const entry of attendee.registration) {
    if (entry.type === 'photo') {
      rows.push([questionLabel(entry), createElement('a', { class: 'text-link', href: entry.photoUrl, target: '_blank', rel: 'noopener', text: translate('manage.attendee-photo') })]);
    } else {
      rows.push([questionLabel(entry), answerText(entry, entry.value, attendeeCurrency(attendee))]);
    }
  }
  if (rows.length === 0) {
    return null;
  }
  return createElement('details', { class: 'attendee-registration small' }, [
    createElement('summary', { text: translate('registration.card-title') }),
    createElement('dl', { class: 'order-lines' }, rows.map(([label, value]) => {
      let shown = value;
      if (shown === null || shown === undefined || shown === '') {
        shown = translate('manage.attendee-not-given');
      }
      return createElement('div', {}, [createElement('dt', { text: label }), createElement('dd', {}, [shown])]);
    })),
  ]);
}

function attendeeRow(attendee) {
  let name = attendee.displayName;
  if (!name) {
    name = attendee.username;
  }
  let roleKey = 'role.member';
  if (attendee.staff) {
    roleKey = 'role.staff';
  }
  const details = [attendee.username, translate(roleKey)];
  if (attendee.rsvpNumber !== null) {
    details.unshift(translate('manage.attendee-number', { number: attendee.rsvpNumber }));
  }
  if (attendee.lepak) {
    details.push(lepakLabelShown());
  }
  const meals = attendeeMealsText(attendee);
  if (meals) {
    details.push(translate('manage.attendee-meals', { meals }));
  }
  const convention = isConvention();
  if (convention && attendee.volunteer) {
    details.push(translate('manage.attendee-volunteer'));
  }
  if (convention && attendee.pastVolunteer) {
    details.push(translate('manage.attendee-past-volunteer'));
  }
  if (attendee.fursuiter) {
    details.push(translate('manage.attendee-fursuiter'));
  }
  if (savedCrossBorder) {
    details.push(attendeeCountryText(attendee));
  }
  const paymentText = attendeePaymentText(attendee);
  if (paymentText) {
    details.push(paymentText);
  }
  details.push(formatDate(attendee.rsvpAt));
  const controls = attendeePaymentControls(attendee, name, (list) => {
    attendees = list;
    renderAttendees();
  }, byId('editorError'));
  if (convention) {
    const box = createElement('input', { type: 'checkbox' });
    box.checked = attendee.volunteered;
    box.addEventListener('change', () => confirmVolunteer(attendee, box));
    controls.push(createElement('label', { class: 'check attendee-volunteered' }, [
      box,
      createElement('span', { text: translate('manage.attendee-volunteered') }),
      createElement('span', { class: 'visually-hidden', text: translate('manage.attendee-volunteered-named', { name }) }),
    ]));
  }
  return createElement('li', { class: 'item-row attendee-row' }, [
    iconNode('user'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: name }),
      createElement('span', { class: 'muted small', text: details.join(' · ') }),
      attendeeContact(attendee),
      attendeeRegistration(attendee),
    ]),
    ...controls,
    createElement('button', {
      class: 'btn btn-small btn-quiet',
      type: 'button',
      text: translate('security.remove'),
      'aria-label': translate('manage.attendee-remove', { name }),
      onclick: () => removeAttendee(attendee.username, attendee.staff),
    }),
  ]);
}

// The currency an attendee's answers (a donation) are in: their ticket's
// (each tier can have its own), else the event's.
function attendeeCurrency(attendee) {
  if (attendee.payment && attendee.payment.currency) {
    return attendee.payment.currency;
  }
  return currencyCodeFrom(byId('f-currency').value);
}

// The account details the form asks for, as plain text for the CSV: legal
// name, date of birth (or age) and emergency contact, each only when the
// attendee list shows it.
function personalCells(personal) {
  const cells = {};
  if (!personal) {
    return cells;
  }
  if ('legalName' in personal) {
    cells.legalName = personal.legalName;
  }
  if ('age' in personal) {
    let shown = '';
    if (personal.age !== null) {
      shown = String(personal.age);
    }
    if (personal.dateOfBirth) {
      shown = personal.dateOfBirth;
    }
    cells.dateOfBirth = shown;
  }
  if ('emergencyName' in personal) {
    cells.emergencyContact = [personal.emergencyName, personal.emergencyPhone].filter(Boolean).join(', ');
  }
  return cells;
}

// What someone is coming for, in words: the whole event, lepak, or meals.
function comingForText(attendee) {
  const meals = attendeeMealsText(attendee);
  if (attendee.lepak && meals) {
    return `${lepakLabelShown()} · ${meals}`;
  }
  if (attendee.lepak) {
    return lepakLabelShown();
  }
  if (meals) {
    return translate('manage.attendee-meals', { meals });
  }
  return translate('manage.csv.whole-event');
}

// Yes or No, for a column of ticks.
function yesNo(value) {
  if (value) {
    return translate('manage.csv.yes');
  }
  return translate('manage.csv.no');
}

// An attendee's ticket payment, or null for none (not a ticket bought at
// checkout).
function heldPayment(attendee) {
  if (!attendee.payment || !attendee.payment.method) {
    return null;
  }
  return attendee.payment;
}

// The payment columns: one cell each from an attendee's payment.
function paymentColumns() {
  const cellOf = (read) => (attendee) => {
    const payment = heldPayment(attendee);
    if (payment === null) {
      return null;
    }
    return read(payment, attendee);
  };
  return [
    [translate('manage.csv.tickets'), cellOf((payment) => payment.tier)],
    [translate('manage.csv.payment-method'), cellOf((payment) => translate(`payment.method.${payment.method}`))],
    [translate('manage.csv.payment-status'), cellOf((payment) => {
      if (payment.method === 'onsite') {
        return null;
      }
      return translate(`manage.payment-status.${payment.status}`);
    })],
    [translate('manage.csv.amount'), cellOf((payment) => payment.amount)],
    [translate('manage.csv.currency'), cellOf((payment) => payment.currency)],
    [translate('manage.csv.credit'), cellOf((payment) => {
      if (payment.credit > 0) {
        return payment.credit;
      }
      return null;
    })],
    [translate('manage.csv.reference'), cellOf((payment) => payment.reference)],
    [translate('manage.csv.screenshot'), cellOf((payment, attendee) => {
      if (!payment.hasProof) {
        return null;
      }
      return new URL(proofHref(editing.id, attendee), location.origin).href;
    })],
    [translate('manage.csv.reported-at'), cellOf((payment) => payment.submittedAt)],
    [translate('manage.csv.paid-at'), cellOf((payment) => payment.paidAt)],
  ];
}

// A list on an attendee (contact or registration), or an empty one.
function listOf(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

// The contact detail columns: one per detail asked, in the order first seen.
function contactColumns() {
  const labels = [];
  for (const attendee of attendees) {
    for (const entry of listOf(attendee.contact)) {
      const label = contactLabel(entry);
      if (!labels.includes(label)) {
        labels.push(label);
      }
    }
  }
  return labels.map((label) => [label, (attendee) => {
    const entry = listOf(attendee.contact).find((each) => contactLabel(each) === label);
    if (!entry) {
      return null;
    }
    return entry.value;
  }]);
}

// The registration answer columns: one per question, in the order first
// seen; a photo as the address editors open it at.
function registrationColumns() {
  const questions = [];
  for (const attendee of attendees) {
    for (const entry of listOf(attendee.registration)) {
      if (!questions.some((question) => question.id === entry.id)) {
        questions.push(entry);
      }
    }
  }
  return questions.map((question) => [questionLabel(question), (attendee) => {
    const entry = listOf(attendee.registration).find((each) => each.id === question.id);
    if (!entry) {
      return null;
    }
    if (entry.type === 'photo') {
      if (!entry.photoUrl) {
        return null;
      }
      return new URL(entry.photoUrl, location.origin).href;
    }
    return answerText(entry, entry.value, attendeeCurrency(attendee));
  }]);
}

// The attendee list as CSV rows: a heading row, then one row per person,
// with the columns this event's list has (volunteering only at a
// convention, country only when cross-border, payment, contact details,
// account details and registration answers only when someone has them).
function attendeeCsvRows() {
  const columns = [
    [translate('manage.csv.rsvp-id'), (attendee) => attendee.rsvpNumber],
    [translate('manage.csv.name'), (attendee) => {
      if (attendee.displayName) {
        return attendee.displayName;
      }
      return attendee.username;
    }],
    [translate('manage.csv.username'), (attendee) => attendee.username],
    [translate('manage.csv.account'), (attendee) => {
      if (attendee.staff) {
        return translate('role.staff');
      }
      return translate('role.member');
    }],
    [translate('manage.csv.rsvp-at'), (attendee) => attendee.rsvpAt],
    [translate('manage.csv.coming-for'), comingForText],
  ];
  if (savedCrossBorder) {
    columns.push([translate('manage.csv.country'), attendeeCountryText]);
  }
  if (isConvention()) {
    columns.push(
      [translate('manage.attendee-volunteer'), (attendee) => yesNo(attendee.volunteer)],
      [translate('manage.attendee-past-volunteer'), (attendee) => yesNo(attendee.pastVolunteer)],
      [translate('manage.attendee-volunteered'), (attendee) => yesNo(attendee.volunteered)],
    );
  }
  if (attendees.some((attendee) => attendee.fursuiter)) {
    columns.push([translate('manage.attendee-fursuiter'), (attendee) => yesNo(attendee.fursuiter)]);
  }
  if (attendees.some((attendee) => heldPayment(attendee) !== null)) {
    columns.push(...paymentColumns());
  }
  columns.push(...contactColumns());
  // Account details the form asks for.
  const personalKeys = [
    ['legalName', translate('registration.preset.legalName')],
    ['dateOfBirth', translate('registration.preset.dateOfBirth')],
    ['emergencyContact', translate('registration.preset.emergencyContact')],
  ];
  for (const [key, label] of personalKeys) {
    if (attendees.some((attendee) => key in personalCells(attendee.personal))) {
      columns.push([label, (attendee) => personalCells(attendee.personal)[key]]);
    }
  }
  columns.push(...registrationColumns());
  return [
    columns.map(([heading]) => heading),
    ...attendees.map((attendee) => columns.map(([, cell]) => cell(attendee))),
  ];
}

// "Download CSV": the attendee list as a file named after the event's link
// and today's date.
function downloadAttendees() {
  if (!editing) {
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  downloadCsv(`${editing.slug}-attendees-${day}.csv`, csvText(attendeeCsvRows()));
}

function renderAttendees() {
  const box = byId('attendeesBox');
  box.hidden = !editing;
  if (!editing) {
    return;
  }
  byId('attendeesCsv').hidden = attendees.length === 0;
  byId('attendeesTitle').textContent = translate('manage.attendees', { count: attendees.length });
  renderMealCounts();
  renderVolunteerCounts();
  renderFursuiterCount();
  renderCountryCounts();
  renderPaymentCounts(attendees);
  renderLepakCount();
  let attendeeRows;
  if (attendees.length === 0) {
    attendeeRows = [createElement('li', { class: 'muted small', text: translate('manage.attendees-none') })];
  } else {
    attendeeRows = attendees.map((attendee) => attendeeRow(attendee));
  }
  byId('attendeeList').replaceChildren(...attendeeRows);
}

// Where an attendee of a cross-border event is from, or that they have not
// said (they RSVPed before it was made cross-border).
function attendeeCountryText(attendee) {
  if (attendee.country) {
    return countryName(attendee.country);
  }
  return translate('manage.attendee-no-country');
}

// Under the attendee count of a cross-border event, how many come from each
// country, the most first ("From: Singapore 40 · Malaysia 12 · Not given 1").
// Hidden for any other event, or while nobody is going.
function renderCountryCounts() {
  const box = byId('attendeesCountries');
  const counts = new Map();
  for (const attendee of attendees) {
    const name = attendeeCountryText(attendee);
    let count = counts.get(name);
    if (!count) {
      count = 0;
    }
    counts.set(name, count + 1);
  }
  const parts = [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(([country, count]) => translate('manage.country-count', { country, count }));
  let shown = false;
  if (savedCrossBorder && parts.length > 0) {
    shown = true;
  }
  box.hidden = !shown;
  box.textContent = translate('manage.attendees-countries', { counts: parts.join(' · ') });
}

// Under the attendee count, how many are coming only for each meal
// ("Just for a meal: Lunch 3 · Dinner 1"), for whoever orders the food.
// Hidden while nobody is.
function renderMealCounts() {
  const parts = [];
  for (const meal of savedMeals) {
    const count = attendees.filter((attendee) => {
      if (!Array.isArray(attendee.meals)) {
        return false;
      }
      return attendee.meals.includes(meal.id);
    }).length;
    if (count > 0) {
      if (meal.limit) {
        parts.push(translate('manage.meal-count-of', { meal: mealLabel(meal), count, limit: meal.limit }));
      } else {
        parts.push(translate('manage.meal-count', { meal: mealLabel(meal), count }));
      }
    }
  }
  const box = byId('attendeesMeals');
  box.hidden = parts.length === 0;
  box.textContent = translate('manage.attendees-meals', { counts: parts.join(' · ') });
}

// What the lepak choice says for this event: the editor's words, or "Just
// Lepak Only".
function lepakLabelShown() {
  const typed = byId('f-lepakLabel').value.trim();
  if (typed) {
    return typed;
  }
  return translate('manage.lepak-default');
}

// Under the attendee count, how many are lepak, of the places when capped
// ("Just Lepak Only: 4 of 10"). Hidden while nobody is.
function renderLepakCount() {
  const box = byId('attendeesLepak');
  const count = attendees.filter((attendee) => attendee.lepak).length;
  box.hidden = count === 0;
  const limit = byId('f-lepakLimit').value.trim();
  if (limit) {
    box.textContent = translate('manage.attendees-lepak-of', { label: lepakLabelShown(), count, limit });
  } else {
    box.textContent = translate('manage.attendees-lepak', { label: lepakLabelShown(), count });
  }
}

// Under the attendee count at a convention, how many signed up to
// volunteer, how many an editor ticked as having volunteered, and how many
// get the volunteer benefit ("Volunteers: 4 signed up · 2 volunteered · 1
// gets the benefit"). Hidden while all are none.
function renderVolunteerCounts() {
  const box = byId('attendeesVolunteers');
  const counts = [
    ['manage.volunteers-signed-up', attendees.filter((attendee) => attendee.volunteer).length],
    ['manage.volunteers-confirmed', attendees.filter((attendee) => attendee.volunteered).length],
    ['manage.volunteers-benefit', attendees.filter((attendee) => attendee.pastVolunteer).length],
  ];
  const parts = counts.filter(([, count]) => count > 0).map(([key, count]) => translate(key, { count }));
  let shown = false;
  if (isConvention() && parts.length > 0) {
    shown = true;
  }
  box.hidden = !shown;
  box.textContent = translate('manage.attendees-volunteers', { counts: parts.join(' · ') });
}

// Under the attendee count, how many said they are fursuiters
// (migrations/023), while the event asks. Hidden while nobody did.
function renderFursuiterCount() {
  const box = byId('attendeesFursuiters');
  const count = attendees.filter((attendee) => attendee.fursuiter).length;
  box.hidden = count === 0;
  box.textContent = translate('manage.attendees-fursuiters', { count });
}

// The form opens in the Manage event tab, in place of its "No event open"
// note.
function showEditor(title) {
  byId('editorTitle').textContent = title;
  byId('editorError').textContent = '';
  tabs.open('editor');
  form.hidden = false;
  byId('editorEmpty').hidden = true;
  showSavedControls();
  rememberOpenEvent();
  renderStatus();
  byId('editorTitle').tabIndex = -1;
  byId('editorTitle').focus();
}

function hideEditor() {
  form.hidden = true;
  editing = null;
  failed = null;
  byId('editorEmpty').hidden = false;
  rememberOpenEvent();
  renderStatus();
}

async function openEditor(id) {
  if (!(await readyToLeave())) {
    tabs.open('editor');
    return;
  }
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

async function openNew() {
  if (!(await readyToLeave())) {
    tabs.open('editor');
    return;
  }
  editing = null;
  attendees = [];
  byId('manageNotice').textContent = '';
  setForm(BLANK);
  editorTabs.open('basics');
  showEditor(translate('manage.new-title'));
}

// Ticks (or unticks) that an attendee really volunteered at this
// convention, saved at once; if that fails, the box goes back.
async function confirmVolunteer(attendee, box) {
  box.disabled = true;
  const done = await withBusy(null, byId('editorError'), async () => {
    const data = await post('/api/manage/events', {
      action: 'volunteer-confirm',
      id: editing.id,
      username: attendee.username,
      staff: attendee.staff,
      volunteered: box.checked,
    });
    attendees = data.attendees;
    renderAttendees();
    return true;
  });
  if (!done) {
    box.checked = attendee.volunteered;
    box.disabled = false;
  }
}

async function removeAttendee(username, staff) {
  await withBusy(null, byId('editorError'), async () => {
    const data = await post('/api/manage/events', { action: 'remove-attendee', id: editing.id, username, staff });
    attendees = data.attendees;
    renderAttendees();
    listStale = true;
  });
}

// Delete asks first, and offers to cancel the event instead (unless it is
// already cancelled), which keeps it and its RSVPs and tells the people
// going.
byId('editorDelete').addEventListener('click', () => {
  const cancelled = byId('f-status').value === 'cancelled';
  byId('cancelInstead').hidden = cancelled;
  byId('cancelInsteadHint').hidden = cancelled;
  openModal('deleteModal');
});
byId('cancelInstead').addEventListener('click', async () => {
  closeModal('deleteModal');
  byId('manageNotice').textContent = '';
  byId('f-status').value = 'cancelled';
  syncDependent();
  editorTabs.open('basics');
  await autosave({ force: true });
  // A save already on its way when this was asked saves this straight after.
  while (saving) {
    await saving;
  }
  if (!failed && !isDirty()) {
    byId('manageNotice').textContent = translate('manage.cancelled-instead');
  }
});
byId('deleteConfirm').addEventListener('click', () => {
  withBusy(byId('deleteConfirm'), byId('editorError'), async () => {
    await post('/api/manage/events', { action: 'delete', id: editing.id });
    closeModal('deleteModal');
    hideEditor();
    tabs.open('events');
    byId('manageNotice').textContent = translate('manage.deleted');
    await loadList();
  });
});

byId('editorClose').addEventListener('click', async () => {
  if (!(await readyToLeave())) {
    return;
  }
  hideEditor();
  // Opening the list reloads it when a save changed it.
  tabs.open('events');
  byId('newEvent').focus();
});
byId('newEvent').addEventListener('click', openNew);
byId('editorEmptyNew').addEventListener('click', openNew);
byId('editorToList').addEventListener('click', () => tabs.open('events'));
startLocations();
startMeals();
startTiers({ getEvent: () => editing, onProblems: setPaymentProblems });
startOrganiser();
startTimetable();
startPayment({ getEvent: () => editing });
startContact();
// The tiers the registration questions can be for: those in the Price and
// RSVP tab now, while the event is paid and sells tiers.
startRegistration({
  getTiers() {
    let on = false;
    if (byId('f-priceType').value === 'paid' && byId('f-tiersEnabled').checked) {
      on = true;
    }
    const tiers = readTiers().map((tier) => ({ id: tier.id, name: tier.name.trim() }));
    return { on, tiers };
  },
});
startEditors({ getEvent: () => editing });
byId('attendeesCsv').addEventListener('click', downloadAttendees);

// The edit form's section tabs, kept out of the address (it already says
// #editor). A tab picked with the tab bar stuck under the page header (the
// form scrolled down) starts at its top, not partway down.
editorTabs = startTabs(byId('editorTabs'), {
  useHash: false,
  onSelect(name) {
    // The tiers' names may have changed under Price and RSVP.
    if (name === 'questions') {
      syncRegistration();
    }
    const bar = byId('editorTabs');
    if (form.hidden) {
      return;
    }
    const stuckAt = parseFloat(getComputedStyle(bar).top);
    if (!(bar.getBoundingClientRect().top <= stuckAt + 1)) {
      return;
    }
    const panel = byId(`epanel-${name}`);
    const top = window.scrollY + panel.getBoundingClientRect().top - stuckAt - bar.offsetHeight - 8;
    window.scrollTo({ top: Math.max(0, top) });
  },
});

// The page header's height, for the tab bar to stick just under it.
const header = document.querySelector('.site-header');
if (header) {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
  }).observe(header);
}

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
  if (!currentUser.canManage && !currentUser.editsEvents) {
    byId('manageError').textContent = translate('error.manage_only');
    byId('panel-events').hidden = true;
    return;
  }
  // An editor of one event (migrations/018): their events only, no New
  // event, no staff tools, and the Status and release time left to staff.
  const eventEditorOnly = !currentUser.canManage;
  byId('newEvent').hidden = eventEditorOnly;
  byId('tab-editor').hidden = false;
  byId('statusStaffOnly').hidden = !eventEditorOnly;
  byId('f-status').disabled = eventEditorOnly;
  byId('f-publishLocal').disabled = eventEditorOnly;
  // An event's own editors are an admin's to choose.
  byId('etab-editors').hidden = currentUser.role !== 'admin';
  editorTabs.refresh();
  fillCurrencyList(byId('currencyList'));
  tabs = startTabs(byId('manageTabs'), {
    onSelect(name) {
      // Back from the form: the list opens on the status of the event that
      // was open, so a new draft is found under Drafts.
      if (name === 'events' && editing) {
        showListStatus(byId('f-status').value);
      }
      if (name === 'events' && listStale) {
        loadList().catch((error) => {
          byId('manageError').textContent = errorText(error);
        });
      }
    },
  });
  let toolsReady = Promise.resolve();
  if (!eventEditorOnly) {
    toolsReady = startTools(currentUser).then(() => tabs.refresh());
  }
  try {
    await loadList();
  } catch (error) {
    byId('manageError').textContent = errorText(error);
    return;
  }
  // The tours once the list is drawn and the staff tools' tabs are settled,
  // so the page's tour finds every tab this role has.
  toolsReady.finally(() => startTours('manage'));
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
    renderStatus();
    relabelLocations();
    relabelMeals();
    relabelContact();
    relabelRegistration();
    relabelTiers();
    relabelOrganiser();
    relabelTimetable();
    fillVolunteerSources(byId('f-volunteerDiscountFrom').value);
    fillTimeZoneSelect(byId('f-timezone'), byId('f-timezone').value);
    fillCurrencyList(byId('currencyList'));
  }
});

start();
