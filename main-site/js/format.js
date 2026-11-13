// Formatting an event for display. Times are shown in the event's own time
// zone, with the zone's short name, since "2pm" means the venue's 2pm.

import { t as translate, getLocale } from '../assets/i18n/i18n.js';

// A time in the given zone; in the browser's own zone if the zone is not
// one the browser knows.
function formatInZone(isoTime, timeZone, options) {
  try {
    return new Intl.DateTimeFormat(getLocale(), { timeZone, ...options }).format(new Date(isoTime));
  } catch {
    return new Intl.DateTimeFormat(getLocale(), options).format(new Date(isoTime));
  }
}

function sameDay(firstTime, secondTime, timeZone) {
  const dayOnly = { year: 'numeric', month: '2-digit', day: '2-digit' };
  return formatInZone(firstTime, timeZone, dayOnly) === formatInZone(secondTime, timeZone, dayOnly);
}

// "Sat, 14 Nov 2026, 2:00 pm SGT", or a range. The zone's name goes on the
// last time shown; an end on the same day shows only its time.
export function whenText(when) {
  if (!when || when.tba) {
    return translate('event.dates-tba');
  }
  const timeZone = when.timezone;
  const dateTime = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' };
  let startZoneName = 'short';
  if (when.endsAt) {
    startZoneName = undefined;
  }
  const start = formatInZone(when.startsAt, timeZone, { ...dateTime, timeZoneName: startZoneName });
  if (!when.endsAt) {
    return start;
  }
  let end;
  if (sameDay(when.startsAt, when.endsAt, timeZone)) {
    end = formatInZone(when.endsAt, timeZone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } else {
    end = formatInZone(when.endsAt, timeZone, { ...dateTime, timeZoneName: 'short' });
  }
  return translate('event.range', { start, end });
}

// The day and month for the date badge on a card: { day: "14", month: "Nov" }.
export function dateBadge(when) {
  if (!when || when.tba) {
    return null;
  }
  return {
    day: formatInZone(when.startsAt, when.timezone, { day: 'numeric' }),
    month: formatInZone(when.startsAt, when.timezone, { month: 'short' }),
  };
}

// An amount in its currency (SGD when none is given); "CODE amount" if the
// browser does not know the currency.
function formatMoney(amount, currency) {
  try {
    let currencyCode = currency;
    if (!currencyCode) {
      currencyCode = 'SGD';
    }
    return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: currencyCode }).format(amount);
  } catch {
    let currencyPrefix = currency;
    if (!currencyPrefix) {
      currencyPrefix = '';
    }
    return `${currencyPrefix} ${amount}`.trim();
  }
}

export function priceText(price) {
  if (!price || price.type === 'tba') {
    return translate('event.price-tba');
  }
  if (price.type === 'free') {
    return translate('event.price-free');
  }
  if (price.min === null) {
    return translate('event.price-tba');
  }
  if (price.max !== null && price.max !== price.min) {
    return translate('event.price-range', { min: formatMoney(price.min, price.currency), max: formatMoney(price.max, price.currency) });
  }
  return formatMoney(price.min, price.currency);
}

export function placeText(where) {
  if (!where) {
    return '';
  }
  const parts = [where.venueName, where.city, where.country].filter(Boolean);
  if (where.online && parts.length === 0) {
    return translate('event.online');
  }
  if (where.online) {
    return translate('event.online-and', { place: parts.join(', ') });
  }
  const place = parts.join(', ');
  if (place) {
    return place;
  }
  return translate('event.place-tba');
}

// The line under the RSVP button: spaces left, or why it is closed.
export function spacesText(event) {
  if (event.rsvp === 'cancelled') {
    return translate('event.state.cancelled');
  }
  if (event.rsvp === 'over') {
    return translate('event.state.over');
  }
  if (event.rsvp === 'closed') {
    return translate('event.state.closed');
  }
  if (event.rsvp === 'full') {
    return translate('event.state.full');
  }
  if (event.capacity) {
    return translate('event.spaces-left', { count: event.left });
  }
  return '';
}
