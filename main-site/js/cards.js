// An event card, built with the DOM so every piece of event text goes in
// through textContent and can never become markup.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';
import { whenText, dateBadge, placeText, priceText } from './format.js';

// The cover picture with the date badge on it; a calendar tile when there
// is no picture.
function cover(event) {
  const wrapper = createElement('div', { class: 'event-cover' });
  if (event.coverImageUrl) {
    const image = createElement('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    // A broken picture falls back to the plain tile rather than an empty box.
    image.addEventListener('error', () => {
      image.remove();
      wrapper.classList.add('no-image');
      wrapper.append(iconNode('calendar'));
    }, { once: true });
    image.src = event.coverImageUrl;
    wrapper.append(image);
  } else {
    wrapper.classList.add('no-image');
    wrapper.append(iconNode('calendar'));
  }
  const badge = dateBadge(event.when);
  if (badge) {
    wrapper.append(createElement('span', { class: 'date-badge', 'aria-hidden': 'true' }, [
      createElement('span', { class: 'date-badge-day', text: badge.day }),
      createElement('span', { class: 'date-badge-month', text: badge.month }),
    ]));
  }
  return wrapper;
}

// One line of the card's details: an icon and its text.
function metaItem(iconName, text) {
  return createElement('li', {}, [iconNode(iconName), createElement('span', { text })]);
}

// The pill with someone's number for an event: "VIP #12" for a paid tier
// (ticketName), else "RSVP #12" (migrations/013), or the long form ("Your
// VIP number: #12") on the event page. Coloured by their payment
// (migrations/016): yellow while it is still to make, blue while the
// organisers check it, green once it is confirmed.
export function numberChip({ rsvpNumber, ticketName = null, paymentStatus = 'none' }, { long = false } = {}) {
  let key = 'event.rsvp-number-chip';
  if (ticketName && long) {
    key = 'event.tier-number';
  } else if (ticketName) {
    key = 'event.tier-number-chip';
  } else if (long) {
    key = 'event.rsvp-number';
  }
  const classes = ['chip', 'chip-rsvp-number'];
  if (paymentStatus === 'awaiting') {
    classes.push('chip-warn');
  } else if (paymentStatus === 'submitted') {
    classes.push('chip-info');
  } else if (paymentStatus === 'paid') {
    classes.push('chip-ok');
  }
  return createElement('span', { class: classes.join(' '), text: translate(key, { number: rsvpNumber, tier: ticketName }) });
}

// The card links to the event page and shows the cover, the kind (and
// "cancelled" or "full"), the title, the summary when there is one, and the
// when, where, price and how many are going (when anyone is). For someone
// going (the account page's My events, and the feed when signed in),
// rsvpNumber adds their number for it (numberChip, by the tier in
// ticketName), and paymentStatus colours it and adds a chip while their
// payment is still to make or to be checked (migrations/016).
export function eventCard(event, { rsvpNumber = null, ticketName = null, paymentStatus = 'none' } = {}) {
  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
  if (rsvpNumber !== null) {
    chips.push(numberChip({ rsvpNumber, ticketName, paymentStatus }));
  }
  if (paymentStatus === 'awaiting' || paymentStatus === 'submitted') {
    chips.push(createElement('span', { class: 'chip chip-warn', text: translate(`event.payment-chip.${paymentStatus}`) }));
  }
  if (event.cancelled) {
    chips.push(createElement('span', { class: 'chip chip-danger', text: translate('event.state.cancelled') }));
  } else if (event.rsvp === 'full') {
    chips.push(createElement('span', { class: 'chip', text: translate('event.state.full') }));
  }

  let goingText = null;
  if (event.going > 0) {
    goingText = translate('event.going', { count: event.going });
  }

  const coverBox = cover(event);

  let summary = null;
  if (event.summary) {
    summary = createElement('p', { class: 'event-card-summary', text: event.summary });
  }

  let goingItem = null;
  if (goingText) {
    goingItem = metaItem('users', goingText);
  }

  return createElement('a', { class: 'event-card glass-card', href: `/e/${encodeURIComponent(event.slug)}` }, [
    coverBox,
    createElement('div', { class: 'event-card-body' }, [
      createElement('div', { class: 'chips' }, chips),
      createElement('h3', { class: 'event-card-title', text: event.title }),
      summary,
      createElement('ul', { class: 'event-meta' }, [
        metaItem('calendar', whenText(event.when)),
        metaItem('map', placeText(event.where)),
        metaItem('ticket', priceText(event.price)),
        goingItem,
      ]),
    ]),
  ]);
}
