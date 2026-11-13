// One event: /e/<slug>, served from event.html by a rewrite.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, errorText, withBusy, copyText } from '../ui.js';
import { iconNode, icon } from '../icons.js';
import { whenText, placeText, priceText, spacesText } from '../format.js';

const byId = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.replace(/^\/e\//, '').replace(/\/+$/, '')).toLowerCase();
let event = null;
let preview = false;

function renderCover() {
  const box = byId('eventCover');
  box.replaceChildren();
  box.classList.toggle('no-image', !event.coverImageUrl);
  if (event.coverImageUrl) {
    const img = createElement('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { img.remove(); box.classList.add('no-image'); box.append(iconNode('calendar')); }, { once: true });
    img.src = event.coverImageUrl;
    box.append(img);
  } else {
    box.append(iconNode('calendar'));
  }
}

function renderWhere() {
  const dd = byId('factWhere');
  const w = event.where;
  const lines = [createElement('span', { text: placeText(w) })];
  if (w.address) lines.push(createElement('span', { class: 'muted', text: w.address }));
  if (w.addressForAttendees) lines.push(createElement('span', { class: 'muted small', text: translate('event.address-for-attendees') }));
  if (w.onlineUrl) {
    lines.push(createElement('a', { class: 'text-link', href: w.onlineUrl, target: '_blank', rel: 'noopener noreferrer', text: translate('event.online-link') }));
  }
  if (w.onlineUrlForAttendees) lines.push(createElement('span', { class: 'muted small', text: translate('event.online-for-attendees') }));
  dd.replaceChildren(...lines.map((line) => createElement('span', { class: 'fact-line' }, [line])));
}

function renderRsvp() {
  const signedIn = event.viewer.signedIn;
  const going = event.viewer.going;
  const canJoin = event.rsvp === 'open';
  byId('rsvpStatus').hidden = !going;
  byId('rsvpSignIn').hidden = signedIn || !canJoin;
  byId('rsvpSignIn').href = `/login?next=${encodeURIComponent(location.pathname)}`;
  const btn = byId('rsvpBtn');
  btn.hidden = !signedIn || (!going && !canJoin);
  btn.className = going ? 'btn btn-block' : 'btn btn-primary btn-block';
  btn.innerHTML = `${icon(going ? 'x-circle' : 'check')}<span></span>`;
  btn.querySelector('span').textContent = translate(going ? 'event.rsvp-cancel' : 'event.rsvp-going');
  byId('rsvpNote').textContent = spacesText(event);
}

function render() {
  document.title = translate('event.page-title', { title: event.title });
  renderCover();

  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
  if (event.cancelled) chips.push(createElement('span', { class: 'chip chip-danger', text: translate('event.state.cancelled') }));
  byId('eventChips').replaceChildren(...chips);

  byId('eventTitle').textContent = event.title;
  byId('eventSummary').hidden = !event.summary;
  byId('eventSummary').textContent = event.summary || '';
  byId('eventDescription').textContent = event.description || translate('event.no-description');
  byId('eventOrganiser').hidden = !event.organiserName;
  byId('eventOrganiser').textContent = event.organiserName ? translate('event.organiser', { name: event.organiserName }) : '';

  byId('factWhen').textContent = whenText(event.when);
  renderWhere();
  byId('factPrice').textContent = [priceText(event.price), event.price.note].filter(Boolean).join('. ');
  byId('factGoing').textContent = event.capacity
    ? translate('event.going-of', { count: event.going, capacity: event.capacity })
    : translate('event.going', { count: event.going });

  byId('externalLink').hidden = !event.externalUrl;
  if (event.externalUrl) byId('externalLink').href = event.externalUrl;
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
    if (error.code === 'not_found') byId('eventMissing').hidden = false;
    else byId('eventError').textContent = errorText(error);
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

byId('shareBtn').addEventListener('click', () => copyText(`${location.origin}/e/${event?.slug ?? slug}`));

onChange(() => { if (event) render(); });

load();
