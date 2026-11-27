// The event page's pass for someone going (migrations/027): their check-in
// QR code (from event.viewer.checkinCode, scanned by the organisers on
// /checkin) and the organisers' own entry QR code when there is one for
// them (event.viewer.entry). Both are saved on the device, the entry code
// as a picture, so the pass still opens with no connection (showOfflinePass).
//
// Self check-in: the organisers' beacon QR code opens the event page with
// ?checkin=<code>; checkInFromBeacon sends it (api/events/checkin.js), or
// says to show the pass to an organiser when there is no connection.

import { t as translate } from '../assets/i18n/i18n.js';
import { post } from './api.js';
import { createElement, errorText, formatDate } from './ui.js';
import { numberChip } from './cards.js';
import { iconNode } from './icons.js';
import { qrSvg } from './qr.js';

const byId = (id) => document.getElementById(id);
const KEY_PREFIX = 'ghe.pass.';

function storedPass(slug) {
  try {
    const text = localStorage.getItem(KEY_PREFIX + slug);
    if (text) {
      return JSON.parse(text);
    }
  } catch {
    return null;
  }
  return null;
}

function storePass(slug, pass) {
  try {
    if (pass) {
      localStorage.setItem(KEY_PREFIX + slug, JSON.stringify(pass));
    } else {
      localStorage.removeItem(KEY_PREFIX + slug);
    }
  } catch {
    // Storage full or blocked: the pass shows while the page is open.
  }
}

// The entry code's picture as a data address, to keep.
async function pictureData(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error('entry code');
  }
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function checkinCard(pass) {
  const children = [
    createElement('h3', { class: 'section-label', text: translate('pass.checkin-title') }),
    createElement('div', { class: 'qr-code pass-qr' }),
    createElement('p', { class: 'rsvp-number' }, [numberChip(pass, { long: true })]),
  ];
  children[1].innerHTML = qrSvg(pass.checkinCode, translate('pass.checkin-label'));
  if (pass.checkedInAt) {
    children.push(createElement('p', { class: 'callout ok small' }, [iconNode('check'), createElement('span', { text: translate('pass.checked-in', { time: formatDate(pass.checkedInAt) }) })]));
  } else {
    children.push(createElement('p', { class: 'muted small', text: translate('pass.checkin-hint') }));
  }
  return createElement('div', { class: 'pass-card' }, children);
}

function entryCard(entry) {
  const children = [createElement('h3', { class: 'section-label', text: translate('pass.entry-title') })];
  if (entry.state === 'ready' && entry.picture) {
    children.push(createElement('img', { class: 'pass-entry', src: entry.picture, alt: translate('pass.entry-alt') }));
    children.push(createElement('p', { class: 'muted small', text: translate('pass.entry-hint') }));
  } else if (entry.state === 'later') {
    children.push(createElement('p', { class: 'muted small', text: translate('pass.entry-later', { time: formatDate(entry.from) }) }));
  } else {
    children.push(createElement('p', { class: 'muted small', text: translate(`pass.entry-${entry.state}`) }));
  }
  return createElement('div', { class: 'pass-card' }, children);
}

function cardsFor(pass) {
  const cards = [];
  if (pass.checkinCode) {
    cards.push(checkinCard(pass));
  }
  if (pass.entry) {
    cards.push(entryCard(pass.entry));
  }
  return cards;
}

// Draws the pass for someone going, and saves it; forgets it otherwise.
export async function renderPass(event) {
  const box = byId('passBox');
  const viewer = event.viewer;
  if (!viewer.going || !viewer.checkinCode || event.cancelled) {
    box.hidden = true;
    storePass(event.slug, null);
    return;
  }
  const before = storedPass(event.slug);
  const pass = { title: event.title, rsvpNumber: viewer.rsvpNumber, ticketName: viewer.ticketName, paymentStatus: viewer.payment.status, checkinCode: viewer.checkinCode, checkedInAt: viewer.checkedInAt, entry: null };
  if (viewer.entry) {
    pass.entry = { state: viewer.entry.state, from: viewer.entry.from, url: viewer.entry.url, picture: null };
    if (viewer.entry.state === 'ready') {
      // The picture kept before, when it is the same code; else fetched.
      if (before && before.entry && before.entry.url === viewer.entry.url && before.entry.picture) {
        pass.entry.picture = before.entry.picture;
      } else {
        try {
          pass.entry.picture = await pictureData(viewer.entry.url);
        } catch {
          pass.entry.picture = viewer.entry.url;
        }
      }
    }
  }
  storePass(event.slug, pass);
  byId('passCards').replaceChildren(...cardsFor(pass));
  box.hidden = false;
}

// With no connection: the pass saved for this event, if there is one.
// Returns whether it was shown.
export function showOfflinePass(slug) {
  const pass = storedPass(slug);
  if (!pass) {
    return false;
  }
  byId('offlineTitle').textContent = pass.title;
  byId('offlinePassCards').replaceChildren(...cardsFor(pass));
  byId('offlinePass').hidden = false;
  return true;
}

function notice(kind, text) {
  const box = byId('checkinNotice');
  box.className = `callout ${kind}`;
  box.textContent = text;
  box.hidden = false;
}

// The beacon's code from the address, taken out of it so a reload does not
// send it again.
export function beaconCodeFromAddress() {
  const params = new URLSearchParams(location.search);
  const code = params.get('checkin');
  if (!code) {
    return null;
  }
  params.delete('checkin');
  let search = params.toString();
  if (search) {
    search = `?${search}`;
  }
  history.replaceState(null, '', `${location.pathname}${search}${location.hash}`);
  return code;
}

// Self check-in with the beacon's code. onDone(checkedInAt) after it went
// through.
export async function checkInFromBeacon(event, code, onDone) {
  if (!event.viewer.signedIn) {
    const next = `${location.pathname}?checkin=${encodeURIComponent(code)}`;
    const box = byId('checkinNotice');
    box.className = 'callout warn';
    box.replaceChildren(
      createElement('span', { text: translate('pass.sign-in-to-check-in') }),
      createElement('a', { class: 'btn btn-small u-mt-1', href: `/login?next=${encodeURIComponent(next)}`, text: translate('event.sign-in-to-rsvp') }),
    );
    box.hidden = false;
    return;
  }
  if (!event.viewer.going) {
    notice('warn', translate('pass.not-going'));
    return;
  }
  if (!navigator.onLine) {
    notice('warn', translate('pass.offline-show'));
    return;
  }
  try {
    const data = await post('/api/events/checkin', { slug: event.slug, code });
    let text = translate('pass.self-done');
    if (data.already) {
      text = translate('pass.checked-in', { time: formatDate(data.checkedInAt) });
    }
    notice('ok', text);
    onDone(data.checkedInAt);
  } catch (error) {
    if (error.code === 'offline') {
      notice('warn', translate('pass.offline-show'));
      return;
    }
    notice('warn', errorText(error));
  }
  byId('checkinNotice').scrollIntoView({ block: 'center' });
}
