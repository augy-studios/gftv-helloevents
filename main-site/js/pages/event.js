// One event: /e/<slug>, served from event.html by a rewrite.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, errorText, withBusy, copyText } from '../ui.js';
import { iconNode, icon } from '../icons.js';
import { whenText, placeText, priceText, spacesText, locationText, locationLabel } from '../format.js';

const byId = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.replace(/^\/e\//, '').replace(/\/+$/, '')).toLowerCase();
let event = null;
let preview = false;

function renderCover() {
  const box = byId('eventCover');
  box.replaceChildren();
  box.classList.toggle('no-image', !event.coverImageUrl);
  if (event.coverImageUrl) {
    const image = createElement('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    // A broken picture falls back to the plain tile rather than an empty box.
    image.addEventListener('error', () => {
      image.remove();
      box.classList.add('no-image');
      box.append(iconNode('calendar'));
    }, { once: true });
    image.src = event.coverImageUrl;
    box.append(image);
  } else {
    box.append(iconNode('calendar'));
  }
}

// The street address and map link of one location, when this viewer may
// see them.
function addressLines(location) {
  const lines = [];
  if (location.address) {
    lines.push(createElement('span', { class: 'muted', text: location.address }));
  }
  if (location.mapsUrl) {
    lines.push(createElement('a', { class: 'text-link', href: location.mapsUrl, target: '_blank', rel: 'noopener noreferrer', text: translate('event.open-map') }));
  }
  return lines;
}

// The place lines: one place on its own reads as before ("Venue, City,
// Country", and online); several, or one labelled other than the event's
// location, each get their label, then "Online too" when it is.
function placeLines(where) {
  const locations = where.locations;
  if (locations.length === 0) {
    return [createElement('span', { text: placeText(where) })];
  }
  if (locations.length === 1 && locations[0].label === 'event') {
    return [createElement('span', { text: placeText(where) }), ...addressLines(locations[0])];
  }
  const lines = [];
  for (const location of locations) {
    lines.push(createElement('span', { class: 'location-heading', text: locationLabel(location) }));
    let name = locationText(location);
    if (!name) {
      name = translate('event.place-tba');
    }
    lines.push(createElement('span', { text: name }), ...addressLines(location));
  }
  if (where.online) {
    lines.push(createElement('span', { text: translate('event.online-too') }));
  }
  return lines;
}

// The places, their addresses and the online link when this viewer may see
// them, and a note when they are kept for attendees.
function renderWhere() {
  const whereElement = byId('factWhere');
  const where = event.where;
  const lines = placeLines(where);
  if (where.addressForAttendees) {
    lines.push(createElement('span', { class: 'muted small', text: translate('event.address-for-attendees') }));
  }
  if (where.onlineUrl) {
    lines.push(createElement('a', { class: 'text-link', href: where.onlineUrl, target: '_blank', rel: 'noopener noreferrer', text: translate('event.online-link') }));
  }
  if (where.onlineUrlForAttendees) {
    lines.push(createElement('span', { class: 'muted small', text: translate('event.online-for-attendees') }));
  }
  whereElement.replaceChildren(...lines.map((line) => createElement('span', { class: 'fact-line' }, [line])));
}

// The RSVP box: "you're going", a sign-in link for visitors while RSVPs are
// open, and one button that says Going or Cancel, plus the spaces line.
function renderRsvp() {
  const signedIn = event.viewer.signedIn;
  const going = event.viewer.going;
  const canJoin = event.rsvp === 'open';
  byId('rsvpStatus').hidden = !going;

  let signInHidden = false;
  if (signedIn || !canJoin) {
    signInHidden = true;
  }
  byId('rsvpSignIn').hidden = signInHidden;
  byId('rsvpSignIn').href = `/login?next=${encodeURIComponent(location.pathname)}`;

  const rsvpButton = byId('rsvpBtn');
  let rsvpButtonHidden = false;
  if (!signedIn || (!going && !canJoin)) {
    rsvpButtonHidden = true;
  }
  rsvpButton.hidden = rsvpButtonHidden;
  let buttonClass = 'btn btn-primary btn-block';
  let iconName = 'check';
  let labelKey = 'event.rsvp-going';
  if (going) {
    buttonClass = 'btn btn-block';
    iconName = 'x-circle';
    labelKey = 'event.rsvp-cancel';
  }
  rsvpButton.className = buttonClass;
  rsvpButton.innerHTML = `${icon(iconName)}<span></span>`;
  rsvpButton.querySelector('span').textContent = translate(labelKey);
  byId('rsvpNote').textContent = spacesText(event);
}

// Draws the whole event: title, chips, cover, summary, description,
// organiser, the facts (when, where, price, going), the outside and manage
// links, the preview note, and the RSVP box.
function render() {
  document.title = translate('event.page-title', { title: event.title });
  renderCover();

  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
  if (event.cancelled) {
    chips.push(createElement('span', { class: 'chip chip-danger', text: translate('event.state.cancelled') }));
  }
  byId('eventChips').replaceChildren(...chips);

  byId('eventTitle').textContent = event.title;
  byId('eventSummary').hidden = !event.summary;
  let summary = event.summary;
  if (!summary) {
    summary = '';
  }
  byId('eventSummary').textContent = summary;
  // The description is marked with the language it is written in, so the
  // right font and screen reader voice are used; the placeholder is the
  // page's own language.
  let description = event.description;
  if (description) {
    byId('eventDescription').lang = event.descriptionLang;
  } else {
    description = translate('event.no-description');
    byId('eventDescription').removeAttribute('lang');
  }
  byId('eventDescription').textContent = description;
  byId('eventOrganiser').hidden = !event.organiserName;
  let organiserText = '';
  if (event.organiserName) {
    organiserText = translate('event.organiser', { name: event.organiserName });
  }
  byId('eventOrganiser').textContent = organiserText;

  byId('factWhen').textContent = whenText(event.when);
  renderWhere();
  byId('factPrice').textContent = [priceText(event.price), event.price.note].filter(Boolean).join('. ');
  let goingText;
  if (event.capacity) {
    goingText = translate('event.going-of', { count: event.going, capacity: event.capacity });
  } else {
    goingText = translate('event.going', { count: event.going });
  }
  byId('factGoing').textContent = goingText;

  byId('externalLink').hidden = !event.externalUrl;
  if (event.externalUrl) {
    byId('externalLink').href = event.externalUrl;
  }
  byId('manageLink').hidden = !event.viewer.canManage;
  byId('manageLink').href = `/manage?slug=${encodeURIComponent(event.slug)}`;
  byId('previewNote').hidden = !preview;

  renderRsvp();
}

async function load() {
  try {
    await session;
    const data = await api(`/api/events/detail?slug=${encodeURIComponent(slug)}`);
    event = data.event;
    preview = data.preview === true;
    byId('eventLoading').hidden = true;
    byId('eventView').hidden = false;
    render();
  } catch (error) {
    byId('eventLoading').hidden = true;
    if (error.code === 'not_found') {
      byId('eventMissing').hidden = false;
    } else {
      byId('eventError').textContent = errorText(error);
    }
  }
}

byId('rsvpBtn').addEventListener('click', () => {
  withBusy(byId('rsvpBtn'), byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: !event.viewer.going });
    event = data.event;
    render();
    byId('rsvpBtn').focus();
  });
});

byId('shareBtn').addEventListener('click', () => {
  // The event's own slug once it has loaded; until then, the one in the address.
  let shareSlug;
  if (event !== null && event !== undefined) {
    shareSlug = event.slug;
  }
  if (shareSlug === null || shareSlug === undefined) {
    shareSlug = slug;
  }
  copyText(`${location.origin}/e/${shareSlug}`);
});

onChange(() => {
  if (event) {
    render();
  }
});

load();
