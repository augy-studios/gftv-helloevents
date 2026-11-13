// An event card, built with the DOM so every piece of event text goes in
// through textContent and can never become markup.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';
import { whenText, dateBadge, placeText, priceText } from './format.js';

function cover(event) {
  const wrap = createElement('div', { class: 'event-cover' });
  if (event.coverImageUrl) {
    const img = createElement('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    // A broken picture falls back to the plain tile rather than an empty box.
    img.addEventListener('error', () => { img.remove(); wrap.classList.add('no-image'); wrap.append(iconNode('calendar')); }, { once: true });
    img.src = event.coverImageUrl;
    wrap.append(img);
  } else {
    wrap.classList.add('no-image');
    wrap.append(iconNode('calendar'));
  }
  const badge = dateBadge(event.when);
  if (badge) {
    wrap.append(createElement('span', { class: 'date-badge', 'aria-hidden': 'true' }, [
      createElement('span', { class: 'date-badge-day', text: badge.day }),
      createElement('span', { class: 'date-badge-month', text: badge.month }),
    ]));
  }
  return wrap;
}

function meta(iconName, text) {
  return createElement('li', {}, [iconNode(iconName), createElement('span', { text })]);
}

export function eventCard(event) {
  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
  if (event.cancelled) chips.push(createElement('span', { class: 'chip chip-danger', text: translate('event.state.cancelled') }));
  else if (event.rsvp === 'full') chips.push(createElement('span', { class: 'chip', text: translate('event.state.full') }));

  const going = event.going > 0 ? translate('event.going', { count: event.going }) : null;

  return createElement('a', { class: 'event-card glass-card', href: `/e/${encodeURIComponent(event.slug)}` }, [
    cover(event),
    createElement('div', { class: 'event-card-body' }, [
      createElement('div', { class: 'chips' }, chips),
      createElement('h3', { class: 'event-card-title', text: event.title }),
      event.summary ? createElement('p', { class: 'event-card-summary', text: event.summary }) : null,
      createElement('ul', { class: 'event-meta' }, [
        meta('calendar', whenText(event.when)),
        meta('map', placeText(event.where)),
        meta('ticket', priceText(event.price)),
        going ? meta('users', going) : null,
      ]),
    ]),
  ]);
}
