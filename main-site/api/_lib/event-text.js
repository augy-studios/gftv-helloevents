// An event's when and where as one short line each, from public fields
// only: what notices (notify.js) and link previews (api/events/page.js) say
// about an event. Each takes the language to write in (bot-text.js), English
// when none is given; dates, times and country names are written by Intl the
// way that language writes them in Singapore.

import { datesAnnounced } from './event-rules.js';
import { botT, intlTag, DEFAULT_LOCALE } from './bot-text.js';

// A moment in the event's own time zone: "Fri, 6 Aug, 10:00 am SGT", or the
// date alone when its time is to be confirmed.
function momentText(iso, timezone, timeTbc, locale) {
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (!timeTbc) {
    Object.assign(options, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  const text = formatIn(iso, timezone, options, locale);
  if (timeTbc) {
    return botT(locale, 'when.time-tbc', { when: text });
  }
  return text;
}

// When the event starts, in its own time zone, or "Dates to be announced".
// A start whose time is still to be confirmed shows its date alone.
export function whenText(row, locale = DEFAULT_LOCALE) {
  if (!datesAnnounced(row)) {
    return botT(locale, 'when.dates-tba');
  }
  return momentText(row.starts_at, row.timezone, row.start_time_tbc === true, locale);
}

// The start's date and its time apart, for a notice that gives each a line
// of its own: "Fri, 6 Aug" and "10:00 am SGT". Dates to be announced: the
// date says so and there is no time (''); a time to be confirmed says so.
function formatIn(iso, timezone, options, locale) {
  try {
    return new Intl.DateTimeFormat(intlTag(locale), { timeZone: timezone, ...options }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

export function startDateText(row, locale = DEFAULT_LOCALE) {
  if (!datesAnnounced(row)) {
    return botT(locale, 'when.to-be-announced');
  }
  return formatIn(row.starts_at, row.timezone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, locale);
}

export function startTimeText(row, locale = DEFAULT_LOCALE) {
  if (!datesAnnounced(row)) {
    return '';
  }
  if (row.start_time_tbc === true) {
    return botT(locale, 'when.to-be-confirmed');
  }
  return formatIn(row.starts_at, row.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, locale);
}

// When the event ends, the same way, or '' when it has no end or its dates
// are to be announced.
export function endText(row, locale = DEFAULT_LOCALE) {
  if (!datesAnnounced(row) || !row.ends_at) {
    return '';
  }
  return momentText(row.ends_at, row.timezone, row.end_time_tbc === true, locale);
}

// A country by name: a two-letter code from the form's list ("SG"), or what
// was typed before the list existed, as typed.
export function countryText(country, locale = DEFAULT_LOCALE) {
  if (!country) {
    return '';
  }
  if (/^[A-Za-z]{2}$/.test(country)) {
    try {
      const name = new Intl.DisplayNames([intlTag(locale), 'en'], { type: 'region' }).of(country.toUpperCase());
      if (name) {
        return name;
      }
    } catch {
      /* an unknown code: shown as it is */
    }
  }
  return country;
}

// How long until a moment, roughly, for a reminder's heading: "45 minutes",
// "1 hour", "3 hours", "1 day", "2 days", "1 week".
export function untilText(ms, locale = DEFAULT_LOCALE) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return botT(locale, 'until.minutes', { count: minutes });
  }
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) {
    return botT(locale, 'until.hours', { count: hours });
  }
  const days = Math.round(ms / 86_400_000);
  if (days === 7) {
    return botT(locale, 'until.week');
  }
  return botT(locale, 'until.days', { count: days });
}

// The place name and city, and "online" for an online event.
export function placeText(row, locale = DEFAULT_LOCALE) {
  const parts = [row.venue_name, row.city].filter(Boolean);
  if (row.is_online) {
    parts.push(botT(locale, 'where.online'));
  }
  return parts.join(', ');
}
