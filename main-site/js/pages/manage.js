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
// and RSVP, Meals, Attendees and notes), so a section is a click away rather
// than a long scroll; the tab holding a field the pill asks about is marked.
// A picture pasted anywhere in the open form (Ctrl+V, or Cmd+V) is used as
// the cover, exactly as if it had been chosen with "Choose a picture".

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { decodeCover, cropToWebp } from '../cover-upload.js';
import { cropCover } from '../cover-crop.js';
import { startTools } from '../manage-tools.js';
import { startTabs } from '../tabs.js';
import { fillTimeZoneSelect, fillCurrencyList, currencyLabel, currencyCodeFrom } from '../choices.js';
import { setLocations, readLocations, startLocations, relabelLocations, LOCATIONS_CHANGED } from '../manage-locations.js';
import { startLangSwitch } from '../lang-switch.js';
import { setMeals, readMeals, startMeals, relabelMeals, mealNameFor, MEALS_CHANGED } from '../manage-meals.js';
import { setTiers, readTiers, startTiers, relabelTiers, addTier, TIERS_CHANGED } from '../manage-tiers.js';
import { mealLabel } from '../format.js';

const byId = (id) => document.getElementById(id);
const form = byId('eventForm');

const PAGE_SIZE = 10;

// The form's plain fields, by the name the server takes. The time zone,
// currency, locations, ticket tiers, meals and the earlier convention a
// volunteer benefit is for have their own handling below.
const TEXT_FIELDS = [
  'title', 'slug', 'kind', 'summary', 'description', 'descriptionZh', 'organiserName', 'externalUrl',
  'startDate', 'startTime', 'endDate', 'endTime', 'onlineUrl',
  'priceType', 'priceMin', 'priceMax', 'priceNote', 'capacity', 'status', 'publishLocal', 'staffNotes',
  'volunteerDiscountType', 'volunteerDiscountValue',
];
const CHECK_FIELDS = ['datesHidden', 'addressAttendeesOnly', 'isOnline', 'priceHidden', 'tiersEnabled', 'rsvpOpen', 'volunteersWanted', 'volunteerDiscountEnabled'];

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
};

let currentUser = null;
let events = [];
let page = 0; // the list page shown, from 0
let editing = null; // { id, slug } of the event in the form, or null for a new one
let attendees = [];
// The meals the open event offers as last saved ([{ id, label }]), for
// naming the meals attendees are coming for.
let savedMeals = [];
let cover = { url: '', has: false };
// The picture last chosen for this event's cover in this visit, and the crop
// it was uploaded with, so "Adjust crop" can crop it again: { bitmap, crop }.
let coverSource = null;
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

function pageCount() {
  return Math.max(1, Math.ceil(events.length / PAGE_SIZE));
}

// The list's current page, and the pager under it while there is more than
// one page.
function renderList() {
  byId('listBox').setAttribute('aria-busy', 'false');
  byId('listEmpty').hidden = events.length > 0;
  const pages = pageCount();
  if (page > pages - 1) {
    page = pages - 1;
  }
  const shown = events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
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
  savedMeals = [];
  if (Array.isArray(values.meals)) {
    savedMeals = values.meals;
  }
  setMeals(savedMeals);
  fillVolunteerSources(values.volunteerDiscountFrom);
  let coverUrl = values.coverImageUrl;
  if (!coverUrl) {
    coverUrl = '';
  }
  cover = { url: coverUrl, has: values.hasCover === true };
  forgetCoverSource();
  renderCover();
  syncDependent();
  lastSaved = JSON.stringify(readForm());
  failed = null;
  refused = '';
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
  byId('coverPasteHint').hidden = !editing;
  byId('coverSaveFirst').hidden = Boolean(editing);
  let canRemove = false;
  if (editing && cover.has) {
    canRemove = true;
  }
  byId('coverRemove').hidden = !canRemove;
  let canAdjust = false;
  if (canRemove && coverSource) {
    canAdjust = true;
  }
  byId('coverAdjust').hidden = !canAdjust;
  byId('coverError').textContent = '';
}

// Lets go of the picture kept for "Adjust crop".
function forgetCoverSource() {
  if (coverSource) {
    coverSource.bitmap.close();
  }
  coverSource = null;
}

// Opens the crop dialog for a picture (at start, an earlier crop, or the
// middle), then uploads the part chosen. Closing the dialog uploads nothing.
async function cropAndUpload(bitmap, start = null) {
  const crop = await cropCover(bitmap, start);
  if (!crop || !editing) {
    return false;
  }
  const done = await withBusy(byId('coverPick'), byId('coverError'), async () => {
    const { dataUrl } = await cropToWebp(bitmap, crop);
    const data = await post('/api/manage/cover', { id: editing.id, image: dataUrl });
    cover = { url: data.event.coverImageUrl, has: data.event.hasCover };
    if (coverSource && coverSource.bitmap !== bitmap) {
      forgetCoverSource();
    }
    coverSource = { bitmap, crop };
    renderCover();
    byId('manageNotice').textContent = translate('manage.cover-saved');
    return true;
  });
  return done === true;
}

byId('coverAdjust').addEventListener('click', () => {
  if (coverSource) {
    cropAndUpload(coverSource.bitmap, coverSource.crop);
  }
});

// A picture chosen or pasted is read, then cropped to the cards' 16:9 in the
// crop dialog (starting on its middle), then uploaded.
async function useCoverFile(file) {
  if (!file || !editing) {
    return;
  }
  const bitmap = await withBusy(byId('coverPick'), byId('coverError'), () => decodeCover(file));
  if (!bitmap) {
    return;
  }
  const uploaded = await cropAndUpload(bitmap);
  if (!uploaded && (!coverSource || coverSource.bitmap !== bitmap)) {
    bitmap.close();
  }
}

byId('coverFile').addEventListener('change', () => {
  const files = byId('coverFile').files;
  let file;
  if (files !== null && files !== undefined) {
    file = files[0];
  }
  byId('coverFile').value = '';
  useCoverFile(file);
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
// form, does what "Choose a picture" does with it. Basics opens, so the
// cover can be seen; before the event has saved, it says a picture can be
// added once it has. Not while a dialog (the crop dialog) is open.
document.addEventListener('paste', (event) => {
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
    byId('coverError').textContent = translate('manage.hint.cover-save-first');
    byId('coverSaveFirst').scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  byId('coverError').textContent = '';
  useCoverFile(file);
});

byId('coverRemove').addEventListener('click', () => {
  withBusy(byId('coverRemove'), byId('coverError'), async () => {
    const data = await post('/api/manage/cover', { id: editing.id, remove: true });
    cover = { url: '', has: data.event.hasCover };
    forgetCoverSource();
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
  values.timezone = byId('f-timezone').value;
  values.currency = currencyCodeFrom(byId('f-currency').value);
  values.locations = readLocations();
  values.ticketTiers = readTiers();
  values.meals = readMeals();
  values.volunteerDiscountFrom = byId('f-volunteerDiscountFrom').value;
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
  byId('f-onlineUrl').disabled = !byId('f-isOnline').checked;
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
}

// The two descriptions, both required: [language, text box, form field].
// The switcher shows one at a time, and marks a language still blank.
const DESCRIPTIONS = [
  ['en', byId('f-description'), 'description'],
  ['zh', byId('f-descriptionZh'), 'descriptionZh'],
];
const descriptionSwitch = startLangSwitch(byId('descriptionSwitch'), (lang) => {
  for (const [boxLang, box] of DESCRIPTIONS) {
    box.hidden = boxLang !== lang;
    if (boxLang === lang) {
      byId('descriptionLabel').htmlFor = box.id;
    }
  }
});

function markMissingDescriptions() {
  for (const [lang, box] of DESCRIPTIONS) {
    const button = descriptionSwitch.buttons.find((each) => each.dataset.lang === lang);
    button.querySelector('.missing-mark').hidden = box.value.trim() !== '';
  }
}

for (const [, box] of DESCRIPTIONS) {
  box.addEventListener('input', markMissingDescriptions);
}

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

form.addEventListener('change', (event) => {
  if (['f-priceType', 'f-isOnline', 'f-tiersEnabled', 'f-kind', 'f-volunteerDiscountEnabled', 'f-volunteerDiscountType'].includes(event.target.id)) {
    syncDependent();
  }
  // The attendee list's Volunteered boxes save on their own.
  if (event.target.closest('#attendeeList')) {
    return;
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
  // A currency typed as a code or a name shows as "SGD — Singapore Dollar".
  if (event.target.id === 'f-currency') {
    const code = currencyCodeFrom(event.target.value);
    const label = currencyLabel(code);
    if (label !== code) {
      event.target.value = label;
    }
  }
  if (savesOnChange(event.target)) {
    // A box ticked or a choice made in a tier card saves even while the
    // card is still being filled in.
    autosave({ force: event.target.closest('.tier-edit-card') !== null });
  }
});

// Whether the editor is in a ticket tier card (focus is in it, or moving
// into it): a tier is saved once its card is left, so it is not refused for
// its price while its name is still being typed.
function inTierCard(element) {
  if (!element || typeof element.closest !== 'function') {
    return false;
  }
  return element.closest('.tier-edit-card') !== null;
}

// Leaving a field saves it, unless focus moves into a tier card (it is saved
// when that card is left). The cover picture is uploaded on its own.
form.addEventListener('focusout', (event) => {
  if (event.target.id === 'coverFile') {
    return;
  }
  if (inTierCard(event.relatedTarget)) {
    return;
  }
  autosave();
});
form.addEventListener(LOCATIONS_CHANGED, () => autosave());
form.addEventListener(MEALS_CHANGED, () => autosave());
form.addEventListener(TIERS_CHANGED, () => autosave({ force: true }));

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
  ticketTiers: 'price', tierName: 'price', tierPrice: 'price', tierBenefits: 'price',
  meals: 'meals', mealLabel: 'meals', mealLimit: 'meals', mealLocations: 'meals',
};

// The section tab a refused field is in: a meal's place is under Meals, a
// ticket tier's field under Price, a location's under When and where, and
// any other field wherever its input is.
function tabOfField({ field, detail }) {
  if (typeof detail.meal === 'string') {
    return 'meals';
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
  syncDependent();
  markMissingDescriptions();
}

// Saves the form if it changed since the last save, one save at a time: a
// change while one is on its way is saved straight after it. Resolves once
// nothing is left to save (or a save was refused). While the editor is in a
// tier card it waits for the card to be left, unless force says not to (a
// change made in the card itself, or leaving or hiding the page).
function autosave({ force = false } = {}) {
  if (form.hidden) {
    return Promise.resolve();
  }
  if (!force && !saving && inTierCard(document.activeElement)) {
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
  renderAttendees();
  if (created || moved) {
    showSavedControls();
    rememberOpenEvent();
  }
}

// Once an event exists: its page link, the cover picture and attendee
// list, and Delete for admins.
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
  renderCover();
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
  details.push(formatDate(attendee.rsvpAt));
  const controls = [];
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

function renderAttendees() {
  const box = byId('attendeesBox');
  box.hidden = !editing;
  if (!editing) {
    return;
  }
  byId('attendeesTitle').textContent = translate('manage.attendees', { count: attendees.length });
  renderMealCounts();
  renderVolunteerCounts();
  let attendeeRows;
  if (attendees.length === 0) {
    attendeeRows = [createElement('li', { class: 'muted small', text: translate('manage.attendees-none') })];
  } else {
    attendeeRows = attendees.map((attendee) => attendeeRow(attendee));
  }
  byId('attendeeList').replaceChildren(...attendeeRows);
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
  editorTabs.open('price');
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
startTiers();

// The edit form's section tabs, kept out of the address (it already says
// #editor). A tab picked with the tab bar stuck under the page header (the
// form scrolled down) starts at its top, not partway down.
editorTabs = startTabs(byId('editorTabs'), {
  useHash: false,
  onSelect(name) {
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
  if (!currentUser.canManage) {
    byId('manageError').textContent = translate('error.manage_only');
    byId('panel-events').hidden = true;
    return;
  }
  byId('newEvent').hidden = false;
  byId('tab-editor').hidden = false;
  fillCurrencyList(byId('currencyList'));
  tabs = startTabs(byId('manageTabs'), {
    onSelect(name) {
      if (name === 'events' && listStale) {
        loadList().catch((error) => {
          byId('manageError').textContent = errorText(error);
        });
      }
    },
  });
  startTools(currentUser).then(() => tabs.refresh());
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
    renderStatus();
    relabelLocations();
    relabelMeals();
    relabelTiers();
    fillVolunteerSources(byId('f-volunteerDiscountFrom').value);
    fillTimeZoneSelect(byId('f-timezone'), byId('f-timezone').value);
    fillCurrencyList(byId('currencyList'));
  }
});

start();
