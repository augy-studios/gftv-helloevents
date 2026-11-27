// The check-in page (/checkin?id=<event id>, migrations/027), for the
// event's editors at the door.
//
// It works with no connection once it has opened: the attendee list (with
// each person's code fingerprint, the SHA-256 of their check-in code) is
// kept on this device until a day after the event, so a scanned code or a
// typed RSVP ID or username is found here. Check-ins, door ID ticks and
// undos made here go into a queue, saved too, and are sent
// (api/manage/checkin.js "sync") as soon as there is a connection; the list
// is fetched again every so often to see the other doors' check-ins.
//
// Scanning uses the browser's BarcodeDetector where it has one (Chrome,
// Edge, Android), and the vendored jsQR elsewhere (Safari, Firefox), loaded
// only then.
//
// Self check-in: while it is on, the beacon tab shows a QR code that changes
// every 30 seconds, from codes made a few hours ahead (also kept here), so
// it keeps changing with no connection.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, errorText, openModal, closeModal, wireModals, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { qrSvg } from '../qr.js';
import { startTabs } from '../tabs.js';

const byId = (id) => document.getElementById(id);
function eventIdOfPage() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    return '';
  }
  return id.toLowerCase();
}

const eventId = eventIdOfPage();
const STORE_KEY = `ghe.checkin.${eventId}`;
const REFRESH_MS = 20_000;
const SAME_CODE_MS = 4000;

let state = null; // { event, attendees, counts, queue, beacon, savedAt }
let scanning = false;
let scanStream = null;
let detector = null;
let lastCode = { text: '', at: 0 };
let doorPending = null;
let beaconTimer = null;
let syncing = false;

// ---------------------------------------------------------------------------
// The copy on this device
// ---------------------------------------------------------------------------

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the page still works while it stays open.
  }
}

function loadSaved() {
  try {
    const text = localStorage.getItem(STORE_KEY);
    if (text) {
      return JSON.parse(text);
    }
  } catch {
    return null;
  }
  return null;
}

// Every check-in list on this device whose event is long over goes.
function forgetOld() {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith('ghe.checkin.')) {
        continue;
      }
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved && saved.event && saved.event.keepUntil && new Date(saved.event.keepUntil).getTime() < Date.now()) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Nothing to tidy.
  }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function personName(person) {
  if (person.displayName) {
    return person.displayName;
  }
  return person.username;
}

function counts() {
  const checkedIn = state.attendees.filter((person) => person.checkedInAt).length;
  return { going: state.attendees.length, checkedIn };
}

function renderHead() {
  byId('checkinTitle').textContent = state.event.title;
  const now = counts();
  byId('checkinCount').textContent = translate('checkin.count', { checkedIn: now.checkedIn, going: now.going });
  let net = translate('checkin.online');
  if (!navigator.onLine) {
    net = translate('checkin.offline');
  }
  if (state.queue.length > 0) {
    net += ` · ${translate('checkin.waiting', { count: state.queue.length })}`;
  }
  byId('checkinNet').textContent = net;
  byId('checkinNet').classList.toggle('is-offline', !navigator.onLine);
  byId('checkinBack').href = `/manage?slug=${encodeURIComponent(state.event.slug)}#editor`;
}

// The lines that say who someone is and what the door should know.
function personFacts(person) {
  const facts = [];
  if (person.rsvpNumber !== null) {
    facts.push(translate('manage.attendee-number', { number: person.rsvpNumber }));
  }
  if (person.username) {
    facts.push(`@${person.username}`);
  }
  if (person.comingFor === 'meals') {
    facts.push(translate('checkin.for-meals'));
  } else if (person.comingFor === 'lepak') {
    facts.push(translate('checkin.for-lepak'));
  }
  if (person.ticket) {
    facts.push(person.ticket);
  }
  return facts;
}

function warnings(person) {
  const list = [];
  if (['awaiting', 'submitted'].includes(person.paymentStatus)) {
    list.push(translate('checkin.not-paid'));
  }
  if (person.idCheck && person.idCheck.state === 'pending') {
    list.push(translate('checkin.id-pending'));
  }
  if (person.idCheck && person.idCheck.state === 'none') {
    list.push(translate('checkin.id-none'));
  }
  return list;
}

function resultIcon(kind) {
  if (kind === 'ok') {
    return 'check';
  }
  return 'alert';
}

function showResult(person, kind, note) {
  const box = byId('checkinResult');
  box.hidden = false;
  box.className = `checkin-result is-${kind}`;
  const children = [
    createElement('p', { class: 'checkin-result-head' }, [iconNode(resultIcon(kind)), createElement('strong', { text: note })]),
  ];
  if (person) {
    children.push(createElement('p', { class: 'checkin-name', text: personName(person) }));
    children.push(createElement('p', { class: 'muted', text: personFacts(person).join(' · ') }));
    if (person.idCheck && person.idCheck.state === 'verified') {
      children.push(createElement('p', { class: 'small' }, [iconNode('badge-check'), createElement('span', { text: translate('checkin.id-verified', { name: person.legalName }) })]));
    }
    for (const warning of warnings(person)) {
      children.push(createElement('p', { class: 'callout warn small', text: warning }));
    }
    if (person.checkedInAt) {
      children.push(createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => undo(person) }, [iconNode('refresh'), createElement('span', { text: translate('checkin.undo') })]));
    }
  }
  box.replaceChildren(...children);
}

function listRow(person) {
  let status = translate('checkin.not-in');
  if (person.checkedInAt) {
    status = translate('checkin.in-at', { time: formatDate(person.checkedInAt) });
  }
  let action;
  if (person.checkedInAt) {
    action = createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => undo(person), text: translate('checkin.undo') });
  } else {
    action = createElement('button', { class: 'btn btn-small', type: 'button', onclick: () => checkIn(person, 'manual'), text: translate('checkin.check-in') });
  }
  let rowClass = 'item-row';
  let rowIcon = 'user';
  if (person.checkedInAt) {
    rowClass = 'item-row is-in';
    rowIcon = 'check';
  }
  return createElement('li', { class: rowClass }, [
    iconNode(rowIcon),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: personName(person) }),
      createElement('span', { class: 'muted small', text: [...personFacts(person), status].join(' · ') }),
    ]),
    action,
  ]);
}

function renderList() {
  const filter = byId('listFilter').value.trim().toLowerCase().replace(/^[#@]/, '');
  const rows = state.attendees
    .filter((person) => {
      if (!filter) {
        return true;
      }
      const haystack = [person.displayName, person.username, String(person.rsvpNumber)].join(' ').toLowerCase();
      return haystack.includes(filter);
    })
    .map(listRow);
  byId('checkinList').replaceChildren(...rows);
}

function render() {
  renderHead();
  renderList();
}

// ---------------------------------------------------------------------------
// Checking in, here first, then on the server
// ---------------------------------------------------------------------------

function needsDoorCheck(person) {
  if (!state.event.idDoor) {
    return false;
  }
  if (person.idDoorCheckedAt || person.checkedInAt) {
    return false;
  }
  return true;
}

function askDoorCheck(person, how) {
  doorPending = { person, how };
  const details = [
    [translate('field.legal-name'), person.legalName],
    [translate('field.date-of-birth'), person.dateOfBirth],
  ];
  if (person.idCheck) {
    let state2 = translate('checkin.id-none');
    if (person.idCheck.state === 'verified') {
      state2 = translate('checkin.id-verified-short');
    } else if (person.idCheck.state === 'pending') {
      state2 = translate('checkin.id-pending');
    }
    details.push([translate('checkin.id-online'), state2]);
  }
  byId('doorDetails').replaceChildren(...details.flatMap(([label, value]) => {
    let shown = value;
    if (!shown) {
      shown = translate('checkin.not-given');
    }
    return [createElement('dt', { text: label }), createElement('dd', { text: shown })];
  }));
  openModal('doorModal', { initialFocus: byId('doorConfirm') });
}

function checkIn(person, how, idChecked = false) {
  if (state.event.cancelled) {
    showResult(person, 'warn', translate('error.event_cancelled'));
    return;
  }
  if (needsDoorCheck(person) && !idChecked) {
    askDoorCheck(person, how);
    return;
  }
  if (person.checkedInAt) {
    showResult(person, 'warn', translate('checkin.already', { time: formatDate(person.checkedInAt) }));
    return;
  }
  const at = new Date().toISOString();
  person.checkedInAt = at;
  person.checkedInHow = how;
  if (idChecked) {
    person.idDoorCheckedAt = at;
  }
  state.queue.push({ rsvpNumber: person.rsvpNumber, at, how, idChecked });
  save();
  showResult(person, 'ok', translate('checkin.done'));
  render();
  sync();
}

function undo(person) {
  person.checkedInAt = null;
  person.checkedInHow = null;
  person.idDoorCheckedAt = null;
  state.queue.push({ rsvpNumber: person.rsvpNumber, undo: true });
  save();
  showResult(person, 'warn', translate('checkin.undone'));
  render();
  sync();
}

// Sends the queue; the server's own count and the list come back after.
async function sync() {
  if (syncing || state.queue.length === 0 || !navigator.onLine) {
    renderHead();
    return;
  }
  syncing = true;
  const entries = state.queue.slice(0, 400);
  try {
    await post('/api/manage/checkin', { action: 'sync', id: eventId, entries });
    state.queue = state.queue.slice(entries.length);
    save();
    await refresh();
  } catch {
    // Kept for the next try.
  } finally {
    syncing = false;
    renderHead();
  }
}

// The list again from the server, keeping what is still to send.
async function refresh() {
  const data = await api(`/api/manage/checkin?id=${encodeURIComponent(eventId)}`);
  let queue = [];
  let beacon = null;
  if (state) {
    queue = state.queue;
    beacon = state.beacon;
  }
  state = { event: data.event, attendees: data.attendees, queue, beacon, savedAt: new Date().toISOString() };
  // What is still to send stays shown as done.
  for (const entry of queue) {
    const person = state.attendees.find((each) => each.rsvpNumber === entry.rsvpNumber);
    if (!person) {
      continue;
    }
    if (entry.undo) {
      person.checkedInAt = null;
    } else {
      person.checkedInAt = entry.at;
    }
  }
  save();
  render();
  renderBeacon();
}

// A scanned code: found on this device by its fingerprint, or, with a
// connection, asked of the server (someone who joined since the list came).
async function handleCode(text) {
  const now = Date.now();
  if (text === lastCode.text && now - lastCode.at < SAME_CODE_MS) {
    return;
  }
  lastCode = { text, at: now };
  if (!text.startsWith('ghe1.')) {
    showResult(null, 'warn', translate('error.checkin_code_invalid'));
    return;
  }
  if (!text.startsWith(`ghe1.${eventId}.`)) {
    showResult(null, 'warn', translate('error.checkin_other_event'));
    return;
  }
  if (navigator.vibrate) {
    navigator.vibrate(80);
  }
  const fingerprint = await sha256(text);
  const person = state.attendees.find((each) => each.fingerprint === fingerprint);
  if (person) {
    checkIn(person, 'scan');
    return;
  }
  await askServer({ code: text });
}

async function askServer(lookup, idChecked = false) {
  if (!navigator.onLine) {
    showResult(null, 'warn', translate('checkin.not-on-device'));
    return;
  }
  try {
    const data = await post('/api/manage/checkin', { action: 'checkin', id: eventId, idChecked, ...lookup });
    await refresh();
    let note = translate('checkin.done');
    if (data.already) {
      note = translate('checkin.already', { time: formatDate(data.person.checkedInAt) });
    }
    let kind = 'ok';
    if (data.already) {
      kind = 'warn';
    }
    showResult(data.person, kind, note);
  } catch (error) {
    if (error.code === 'id_door_check_needed' && error.detail.person) {
      doorPending = { person: error.detail.person, how: 'manual', lookup };
      askDoorCheck(error.detail.person, 'manual');
      return;
    }
    showResult(null, 'warn', errorText(error));
  }
}

function lookup(typed) {
  const text = typed.trim();
  if (!text) {
    return;
  }
  const number = /^#?(\d{1,9})$/.exec(text);
  let person;
  if (number) {
    person = state.attendees.find((each) => each.rsvpNumber === Number(number[1]));
  } else {
    const username = text.replace(/^@/, '').toLowerCase();
    person = state.attendees.find((each) => {
      if (!each.username) {
        return false;
      }
      return each.username.toLowerCase() === username;
    });
  }
  if (person) {
    checkIn(person, 'manual');
    return;
  }
  askServer({ query: text });
}

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

function loadJsQr() {
  if (window.jsQR) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/js/vendor/jsqr.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const native = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const found = await native.detect(video);
          if (found.length > 0) {
            return found[0].rawValue;
          }
          return null;
        };
      }
    } catch {
      // Fall through to jsQR.
    }
  }
  await loadJsQr();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const found = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    if (found) {
      return found.data;
    }
    return null;
  };
}

async function scanLoop() {
  const video = byId('scanVideo');
  while (scanning) {
    if (video.readyState >= 2 && !doorPending) {
      try {
        const text = await detector(video);
        if (text) {
          await handleCode(text);
        }
      } catch {
        // One frame that could not be read.
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 220);
    });
  }
}

async function startScan() {
  byId('scanError').textContent = '';
  try {
    if (!detector) {
      detector = await makeDetector();
    }
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = byId('scanVideo');
    video.srcObject = scanStream;
    await video.play();
  } catch {
    byId('scanError').textContent = translate('checkin.camera-blocked');
    return;
  }
  scanning = true;
  byId('scanIdle').hidden = true;
  byId('scanStart').hidden = true;
  byId('scanStop').hidden = false;
  scanLoop();
}

function stopScan() {
  scanning = false;
  if (scanStream) {
    for (const track of scanStream.getTracks()) {
      track.stop();
    }
  }
  scanStream = null;
  byId('scanIdle').hidden = false;
  byId('scanStart').hidden = false;
  byId('scanStop').hidden = true;
}

// ---------------------------------------------------------------------------
// The beacon
// ---------------------------------------------------------------------------

function currentBeaconCode() {
  if (!state.beacon || !Array.isArray(state.beacon.codes)) {
    return null;
  }
  const now = Date.now();
  return state.beacon.codes.find((code) => [new Date(code.from).getTime() <= now, now < new Date(code.until).getTime()].every(Boolean));
}

function renderBeacon() {
  clearTimeout(beaconTimer);
  byId('beaconOn').checked = state.event.selfCheckin;
  const code = currentBeaconCode();
  byId('beaconBox').hidden = true;
  if (!state.event.selfCheckin || !code) {
    return;
  }
  byId('beaconBox').hidden = false;
  byId('beaconQr').innerHTML = qrSvg(code.url, translate('checkin.beacon-label'));
  const wait = Math.max(500, new Date(code.until).getTime() - Date.now());
  beaconTimer = setTimeout(renderBeacon, wait);
  // Running low on codes made ahead: more, when there is a connection.
  const last = state.beacon.codes[state.beacon.codes.length - 1];
  if (navigator.onLine && new Date(last.until).getTime() - Date.now() < 3600_000) {
    loadBeaconCodes();
  }
}

async function loadBeaconCodes() {
  try {
    const data = await api(`/api/manage/checkin?id=${encodeURIComponent(eventId)}&beacon=1`);
    state.beacon = data.beacon;
    save();
  } catch {
    // The codes already here go on.
  }
}

async function setBeacon(on) {
  byId('beaconError').textContent = '';
  try {
    await post('/api/manage/checkin', { action: 'beacon', id: eventId, on });
    state.event.selfCheckin = on;
    if (on) {
      await loadBeaconCodes();
    }
    save();
  } catch (error) {
    byId('beaconError').textContent = errorText(error);
  }
  renderBeacon();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function wire() {
  wireModals();
  startTabs(byId('checkinTabs'), { useHash: false });
  byId('scanStart').addEventListener('click', startScan);
  byId('scanStop').addEventListener('click', stopScan);
  byId('lookupForm').addEventListener('submit', (event) => {
    event.preventDefault();
    lookup(byId('lookupInput').value);
    byId('lookupInput').value = '';
  });
  byId('listFilter').addEventListener('input', renderList);
  byId('beaconOn').addEventListener('change', () => setBeacon(byId('beaconOn').checked));
  byId('beaconFull').addEventListener('click', () => {
    const box = byId('beaconQr');
    if (box.requestFullscreen) {
      box.requestFullscreen();
    }
  });
  byId('doorConfirm').addEventListener('click', () => {
    const pendingDoor = doorPending;
    doorPending = null;
    closeModal('doorModal');
    if (!pendingDoor) {
      return;
    }
    if (pendingDoor.lookup) {
      askServer(pendingDoor.lookup, true);
      return;
    }
    const person = state.attendees.find((each) => each.rsvpNumber === pendingDoor.person.rsvpNumber);
    if (person) {
      checkIn(person, pendingDoor.how, true);
    }
  });
  byId('doorModal').addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) {
      doorPending = null;
    }
  });
  byId('clearDevice').addEventListener('click', () => {
    if (state.queue.length > 0 && !confirm(translate('checkin.clear-waiting', { count: state.queue.length }))) {
      return;
    }
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // Nothing kept.
    }
    location.assign('/manage');
  });
  window.addEventListener('online', () => {
    sync();
    renderHead();
  });
  window.addEventListener('offline', renderHead);
  setInterval(() => {
    if (navigator.onLine && state.queue.length === 0 && !syncing) {
      refresh().catch(() => {});
    } else {
      sync();
    }
  }, REFRESH_MS);
}

async function start() {
  if (!/^[0-9a-f-]{36}$/.test(eventId)) {
    location.replace('/manage');
    return;
  }
  forgetOld();
  const saved = loadSaved();
  const currentSession = await session;
  if (!currentSession.signedIn && !saved) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  wire();
  if (saved) {
    state = saved;
  }
  try {
    await refresh();
  } catch (error) {
    if (!state) {
      byId('checkinLoading').hidden = true;
      byId('checkinView').hidden = false;
      byId('checkinView').replaceChildren(createElement('div', { class: 'callout danger', text: errorText(error) }));
      return;
    }
    render();
    renderBeacon();
  }
  byId('checkinLoading').hidden = true;
  byId('checkinView').hidden = false;
  if (state.event.selfCheckin && !currentBeaconCode() && navigator.onLine) {
    await loadBeaconCodes();
    renderBeacon();
  }
  sync();
}

onChange(() => {
  if (state) {
    render();
  }
});

start();
