// An event's when and where as one short line each, in English, from public
// fields only: what notices (notify.js) and link previews (api/events/page.js)
// say about an event.

import { datesAnnounced } from './event-rules.js';

// A moment in the event's own time zone: "Fri, 6 Aug, 10:00 am SGT", or the
// date alone when its time is to be confirmed.
function momentText(iso, timezone, timeTbc) {
  const options = { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' };
  if (!timeTbc) {
    Object.assign(options, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  let text;
  try {
    text = new Intl.DateTimeFormat('en-SG', options).format(new Date(iso));
  } catch {
    text = new Date(iso).toUTCString();
  }
  if (timeTbc) {
    return `${text}, time to be confirmed`;
  }
  return text;
}

// When the event starts, in its own time zone, or "Dates to be announced".
// A start whose time is still to be confirmed shows its date alone.
export function whenText(row) {
  if (!datesAnnounced(row)) {
    return 'Dates to be announced';
  }
  return momentText(row.starts_at, row.timezone, row.start_time_tbc === true);
}

// When the event ends, the same way, or '' when it has no end or its dates
// are to be announced.
export function endText(row) {
  if (!datesAnnounced(row) || !row.ends_at) {
    return '';
  }
  return momentText(row.ends_at, row.timezone, row.end_time_tbc === true);
}

// A country by name: a two-letter code from the form's list ("SG") in
// English, or what was typed before the list existed, as typed.
export function countryText(country) {
  if (!country) {
    return '';
  }
  if (/^[A-Za-z]{2}$/.test(country)) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase());
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
export function untilText(ms) {
  const plural = (count, unit) => {
    if (count === 1) {
      return `1 ${unit}`;
    }
    return `${count} ${unit}s`;
  };
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return plural(minutes, 'minute');
  }
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) {
    return plural(hours, 'hour');
  }
  const days = Math.round(ms / 86_400_000);
  if (days === 7) {
    return '1 week';
  }
  return plural(days, 'day');
}

// The place name and city, and "online" for an online event.
export function placeText(row) {
  const parts = [row.venue_name, row.city].filter(Boolean);
  if (row.is_online) {
    parts.push('online');
  }
  return parts.join(', ');
}
