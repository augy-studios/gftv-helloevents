// An event's when and where as one short line each, in English, from public
// fields only: what notices (notify.js) and link previews (api/events/page.js)
// say about an event.

import { datesAnnounced } from './event-rules.js';

// When the event starts, in its own time zone, or "Dates to be announced".
// A start whose time is still to be confirmed shows its date alone.
export function whenText(row) {
  if (!datesAnnounced(row)) {
    return 'Dates to be announced';
  }
  const options = { timeZone: row.timezone, weekday: 'short', day: 'numeric', month: 'short' };
  if (!row.start_time_tbc) {
    Object.assign(options, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  let text;
  try {
    text = new Intl.DateTimeFormat('en-SG', options).format(new Date(row.starts_at));
  } catch {
    text = new Date(row.starts_at).toUTCString();
  }
  if (row.start_time_tbc) {
    return `${text}, time to be confirmed`;
  }
  return text;
}

// The place name and city, and "online" for an online event.
export function placeText(row) {
  const parts = [row.venue_name, row.city].filter(Boolean);
  if (row.is_online) {
    parts.push('online');
  }
  return parts.join(', ');
}
