// One event: /e/<slug>, served from event.html by a rewrite.

import { session } from '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { el, errorText, withBusy, copyText } from '../ui.js';
import { iconNode, icon } from '../icons.js';
import { whenText, placeText, priceText, spacesText } from '../format.js';

const $ = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.replace(/^\/e\//, '').replace(/\/+$/, '')).toLowerCase();
let event = null;
let preview = false;

function renderCover() {
  const box = $('eventCover');
  box.replaceChildren();
  box.classList.toggle('no-image', !event.coverImageUrl);
  if (event.coverImageUrl) {
    const img = el('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { img.remove(); box.classList.add('no-image'); box.append(iconNode('calendar')); }, { once: true });
    img.src = event.coverImageUrl;
    box.append(img);
  } else {
    box.append(iconNode('calendar'));
  }
}

function renderWhere() {
  const dd = $('factWhere');
  const w = event.where;
  const lines = [el('span', { text: placeText(w) })];
  if (w.address) lines.push(el('span', { class: 'muted', text: w.address }));
  if (w.addressForAttendees) lines.push(el('span', { class: 'muted small', text: t('event.address-for-attendees') }));
  if (w.onlineUrl) {
    lines.push(el('a', { class: 'text-link', href: w.onlineUrl, target: '_blank', rel: 'noopener noreferrer', text: t('event.online-link') }));
  }
  if (w.onlineUrlForAttendees) lines.push(el('span', { class: 'muted small', text: t('event.online-for-attendees') }));
  dd.replaceChildren(...lines.map((line) => el('span', { class: 'fact-line' }, [line])));
}

function renderRsvp() {
  const signedIn = event.viewer.signedIn;
  const going = event.viewer.going;
  const canJoin = event.rsvp === 'open';
  $('rsvpStatus').hidden = !going;
  $('rsvpSignIn').hidden = signedIn || !canJoin;
  $('rsvpSignIn').href = `/login?next=${encodeURIComponent(location.pathname)}`;
  const btn = $('rsvpBtn');
  btn.hidden = !signedIn || (!going && !canJoin);
  btn.className = going ? 'btn btn-block' : 'btn btn-primary btn-block';
  btn.innerHTML = `${icon(going ? 'x-circle' : 'check')}<span></span>`;
  btn.querySelector('span').textContent = t(going ? 'event.rsvp-cancel' : 'event.rsvp-going');
  $('rsvpNote').textContent = spacesText(event);
}

function render() {
  document.title = t('event.page-title', { title: event.title });
  renderCover();

  const chips = [el('span', { class: `chip kind-${event.kind}`, text: t(`kind.${event.kind}`) })];
  if (event.cancelled) chips.push(el('span', { class: 'chip chip-danger', text: t('event.state.cancelled') }));
  $('eventChips').replaceChildren(...chips);

  $('eventTitle').textContent = event.title;
  $('eventSummary').hidden = !event.summary;
  $('eventSummary').textContent = event.summary || '';
  $('eventDescription').textContent = event.description || t('event.no-description');
  $('eventOrganiser').hidden = !event.organiserName;
  $('eventOrganiser').textContent = event.organiserName ? t('event.organiser', { name: event.organiserName }) : '';

  $('factWhen').textContent = whenText(event.when);
  renderWhere();
  $('factPrice').textContent = [priceText(event.price), event.price.note].filter(Boolean).join('. ');
  $('factGoing').textContent = event.capacity
    ? t('event.going-of', { count: event.going, capacity: event.capacity })
    : t('event.going', { count: event.going });

  $('externalLink').hidden = !event.externalUrl;
  if (event.externalUrl) $('externalLink').href = event.externalUrl;
  $('manageLink').hidden = !event.viewer.canManage;
  $('manageLink').href = `/manage?slug=${encodeURIComponent(event.slug)}`;
  $('previewNote').hidden = !preview;

  renderRsvp();
}

async function load() {
  try {
    await session;
    const data = await api(`/api/events/detail?slug=${encodeURIComponent(slug)}`);
    event = data.event;
    preview = data.preview === true;
    $('eventLoading').hidden = true;
    $('eventView').hidden = false;
    render();
  } catch (error) {
    $('eventLoading').hidden = true;
    if (error.code === 'not_found') $('eventMissing').hidden = false;
    else $('eventError').textContent = errorText(error);
  }
}

$('rsvpBtn').addEventListener('click', () => {
  withBusy($('rsvpBtn'), $('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: !event.viewer.going });
    event = data.event;
    render();
    $('rsvpBtn').focus();
  });
});

$('shareBtn').addEventListener('click', () => copyText(`${location.origin}/e/${event?.slug ?? slug}`));

onChange(() => { if (event) render(); });

load();
