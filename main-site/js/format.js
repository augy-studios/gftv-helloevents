// Formatting an event for display. Times are shown in the event's own time
// zone, with the zone's short name, since "2pm" means the venue's 2pm.

import { t as translate, getLocale } from '../assets/i18n/i18n.js';
import { countryName } from './choices.js';

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

const DATE_ONLY = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const DATE_TIME = { ...DATE_ONLY, hour: 'numeric', minute: '2-digit' };

// "Sat, 14 Nov 2026, 2:00 pm SGT", or a range. The zone's name goes on the
// last time shown; an end on the same day shows only its time. A start or
// end whose time is still to be confirmed shows its date alone, and a start
// like that adds "(time to be confirmed)".
export function whenText(when) {
  if (!when || when.tba) {
    return translate('event.dates-tba');
  }
  const timeZone = when.timezone;
  const startTbc = when.startTimeTbc === true;
  const endTbc = when.endTimeTbc === true;
  let oneDay = false;
  if (when.endsAt && sameDay(when.startsAt, when.endsAt, timeZone)) {
    oneDay = true;
  }
  let endShowsTime = false;
  if (when.endsAt && !endTbc) {
    endShowsTime = true;
  }

  let start;
  if (startTbc) {
    start = formatInZone(when.startsAt, timeZone, DATE_ONLY);
  } else {
    let startZoneName = 'short';
    if (endShowsTime) {
      startZoneName = undefined;
    }
    start = formatInZone(when.startsAt, timeZone, { ...DATE_TIME, timeZoneName: startZoneName });
  }

  let text = start;
  if (when.endsAt && oneDay && endShowsTime) {
    const end = formatInZone(when.endsAt, timeZone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    text = translate('event.range', { start, end });
  } else if (when.endsAt && !oneDay) {
    let end;
    if (endTbc) {
      end = formatInZone(when.endsAt, timeZone, DATE_ONLY);
    } else {
      end = formatInZone(when.endsAt, timeZone, { ...DATE_TIME, timeZoneName: 'short' });
    }
    text = translate('event.range', { start, end });
  }
  if (startTbc) {
    return translate('event.time-tbc', { when: text });
  }
  return text;
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

// "Venue, City, Country" for a place (an event's main place, or one of its
// locations), the country by name.
export function locationText(place) {
  return [place.venueName, place.city, countryName(place.country)].filter(Boolean).join(', ');
}

// What a location is, as the event page heads it: "Event location",
// "Meeting location", or the editor's own label.
export function locationLabel(location) {
  if (location.label === 'custom' && location.customLabel) {
    return location.customLabel;
  }
  let label = location.label;
  if (!['event', 'meeting'].includes(label)) {
    label = 'event';
  }
  return translate(`location.${label}`);
}

export function placeText(where) {
  if (!where) {
    return '';
  }
  const parts = [where.venueName, where.city, countryName(where.country)].filter(Boolean);
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
