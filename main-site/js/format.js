// Formatting an event for display. Times are shown in the event's own time
// zone, with the zone's short name, since "2pm" means the venue's 2pm.

import { t, getLocale } from '../assets/i18n/i18n.js';

function fmt(iso, tz, options) {
  try {
    return new Intl.DateTimeFormat(getLocale(), { timeZone: tz, ...options }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(getLocale(), options).format(new Date(iso));
  }
}

function sameDay(a, b, tz) {
  const day = { year: 'numeric', month: '2-digit', day: '2-digit' };
  return fmt(a, tz, day) === fmt(b, tz, day);
}

// "Sat, 14 Nov 2026, 2:00 pm SGT", or a range.
export function whenText(when) {
  if (!when || when.tba) return t('event.dates-tba');
  const tz = when.timezone;
  const dateTime = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' };
  const start = fmt(when.startsAt, tz, { ...dateTime, timeZoneName: when.endsAt ? undefined : 'short' });
  if (!when.endsAt) return start;
  const end = sameDay(when.startsAt, when.endsAt, tz)
    ? fmt(when.endsAt, tz, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : fmt(when.endsAt, tz, { ...dateTime, timeZoneName: 'short' });
  return t('event.range', { start, end });
}

// The day and month for the date badge on a card: { day: "14", month: "Nov" }.
export function dateBadge(when) {
  if (!when || when.tba) return null;
  return {
    day: fmt(when.startsAt, when.timezone, { day: 'numeric' }),
    month: fmt(when.startsAt, when.timezone, { month: 'short' }),
  };
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: currency || 'SGD' }).format(amount);
  } catch {
    return `${currency || ''} ${amount}`.trim();
  }
}

export function priceText(price) {
  if (!price || price.type === 'tba') return t('event.price-tba');
  if (price.type === 'free') return t('event.price-free');
  if (price.min === null) return t('event.price-tba');
  if (price.max !== null && price.max !== price.min) {
    return t('event.price-range', { min: money(price.min, price.currency), max: money(price.max, price.currency) });
  }
  return money(price.min, price.currency);
}

export function placeText(where) {
  if (!where) return '';
  const parts = [where.venueName, where.city, where.country].filter(Boolean);
  if (where.online && parts.length === 0) return t('event.online');
  if (where.online) return t('event.online-and', { place: parts.join(', ') });
  return parts.join(', ') || t('event.place-tba');
}

// The line under the RSVP button: spaces left, or why it is closed.
export function spacesText(event) {
  if (event.rsvp === 'cancelled') return t('event.state.cancelled');
  if (event.rsvp === 'over') return t('event.state.over');
  if (event.rsvp === 'closed') return t('event.state.closed');
  if (event.rsvp === 'full') return t('event.state.full');
  if (event.capacity) return t('event.spaces-left', { count: event.left });
  return '';
}
