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

// The card links to the event page and shows the cover, the kind (and
// "cancelled" or "full"), the title, the summary when there is one, and the
// when, where, price and how many are going (when anyone is).
export function eventCard(event) {
  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
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
