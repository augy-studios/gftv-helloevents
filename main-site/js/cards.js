// An event card, built with the DOM so every piece of event text goes in
// through textContent and can never become markup.

import { t } from '../assets/i18n/i18n.js';
import { el } from './ui.js';
import { iconNode } from './icons.js';
import { whenText, dateBadge, placeText, priceText } from './format.js';

function cover(event) {
  const wrap = el('div', { class: 'event-cover' });
  if (event.coverImageUrl) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
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
    wrap.append(el('span', { class: 'date-badge', 'aria-hidden': 'true' }, [
      el('span', { class: 'date-badge-day', text: badge.day }),
      el('span', { class: 'date-badge-month', text: badge.month }),
    ]));
  }
  return wrap;
}

function meta(iconName, text) {
  return el('li', {}, [iconNode(iconName), el('span', { text })]);
}

export function eventCard(event) {
  const chips = [el('span', { class: `chip kind-${event.kind}`, text: t(`kind.${event.kind}`) })];
  if (event.cancelled) chips.push(el('span', { class: 'chip chip-danger', text: t('event.state.cancelled') }));
  else if (event.rsvp === 'full') chips.push(el('span', { class: 'chip', text: t('event.state.full') }));

  const going = event.going > 0 ? t('event.going', { count: event.going }) : null;

  return el('a', { class: 'event-card glass-card', href: `/e/${encodeURIComponent(event.slug)}` }, [
    cover(event),
    el('div', { class: 'event-card-body' }, [
      el('div', { class: 'chips' }, chips),
      el('h3', { class: 'event-card-title', text: event.title }),
      event.summary ? el('p', { class: 'event-card-summary', text: event.summary }) : null,
      el('ul', { class: 'event-meta' }, [
        meta('calendar', whenText(event.when)),
        meta('map', placeText(event.where)),
        meta('ticket', priceText(event.price)),
        going ? meta('users', going) : null,
      ]),
    ]),
  ]);
}
