// The bot's structured messages, each built as { markdown, fallback } for
// sendRichTelegram. One-line notices are not here; they go out as plain text.
// Every piece of data goes through escapeMd or a richTable cell.

import { escapeMd, richTable } from './telegram.js';
import { siteHost } from './env.js';

// A six digit code. purpose: "sign-in" (a sign in with Telegram as the second
// factor) or "reset" (resetting a forgotten password). The code is set on a
// line of its own as inline code, so Telegram offers to copy it in one tap,
// with a table of the site, account and expiry under it.
export function codeMessage({ purpose, username, code, minutes }) {
  const site = siteHost();
  let reason;
  let heading;
  let action;
  if (purpose === 'reset') {
    reason = `Someone asked to reset the password of the account ${username} on ${site}.`;
    heading = 'Password reset code';
    action = 'Type this code on the reset page.';
  } else {
    reason = `Someone is signing in to ${site} as ${username}.`;
    heading = 'Sign-in code';
    action = 'Type this code on the sign-in page.';
  }

  const markdown = [
    `## ${heading}`,
    '',
    escapeMd(reason),
    '',
    // Inline code, so the client offers to copy it in one tap.
    `# \`${code}\``,
    '',
    escapeMd(action),
    '',
    richTable(['Detail'], [
      ['Site', site],
      ['Account', username],
      ['Expires', `in ${minutes} minutes`],
    ]),
    '',
    '*If this was not you, do not share the code, and change your password.*',
  ].join('\n');

  const fallback =
    `${reason}\n\nCode: ${code}\n\n${action} It expires in ${minutes} minutes.\n\n` +
    'If this was not you, do not share the code, and change your password.';
  return { markdown, fallback, skipEntities: true };
}

// The bot's help: what it is for, its two commands, and how to link an
// account from the site.
export function helpMessage() {
  const site = siteHost();
  const markdown = [
    '# GFTV HelloEvents',
    '',
    escapeMd(`This bot sends sign-in codes for ${site}, the GFTV calendar of furmeets and furry conventions.`),
    '',
    '## Commands',
    '',
    richTable(['What it does'], [
      ['/start', 'Link this chat, from the link on the sign-in or account page'],
      ['/unlink', 'Stop receiving codes in this chat'],
    ]),
    '',
    '## Link your account',
    '',
    escapeMd(`1. Sign in at ${site}`),
    '2. Open **Account**, then **Security**, and choose **Link Telegram**',
    '3. Press Start here when Telegram opens',
  ].join('\n');

  const fallback =
    `This bot sends sign-in codes for ${site}, the GFTV calendar of furmeets and furry conventions.\n\n` +
    'To link your account, sign in, open Account, then Security, and choose Link Telegram. ' +
    'Send /unlink here to stop receiving codes.';
  return { markdown, fallback };
}

// An event notice, for people who switched Telegram notices on. notice is
// built by notify.js noticeFor from public event fields only: { heading,
// title, intro, details: [[label, value]], url, image }.
//
//   ## New event
//   **Title**
//   (intro: "This event will not go ahead.", for a cancelled one)
//   **Date:** Fri, 6 Aug 2032
//   **Time:** 6:00 pm SGT
//   **Location:** Hall, Singapore
//   the event page link
//   the cover picture
//
// Rich Markdown joins lines that touch into one paragraph, so every line is
// a paragraph of its own. The cover is a media block (a JPEG address on this
// site, so it needs no escaping); if Telegram cannot fetch it, the rich send
// fails and the plain fallback goes instead.
export function eventNoticeMessage(notice) {
  const markdown = [`## ${escapeMd(notice.heading)}`, '', `**${escapeMd(notice.title)}**`];
  const fallback = [notice.heading, '', notice.title];
  if (notice.intro) {
    markdown.push('', escapeMd(notice.intro));
    fallback.push('', notice.intro);
  }
  fallback.push('');
  for (const [label, value] of notice.details) {
    markdown.push('', `**${escapeMd(label)}:** ${escapeMd(value)}`);
    fallback.push(`${label}: ${value}`);
  }
  markdown.push('', escapeMd(notice.url));
  fallback.push('', notice.url);
  if (notice.image) {
    markdown.push('', `![](${notice.image})`);
  }
  return { markdown: markdown.join('\n'), fallback: fallback.join('\n') };
}

// A full notice for someone going: a reminder before an event, a change of
// when or where, or joining (notify.js reminderNotice, updateNotice,
// joinNotice):
//
//   ## Starting in 1 hour       (or "Meeting location changed", "You're going")
//   **Title**
//   ## What changed             (a change only)
//   ### Meeting location changed
//   | | Before | Now |          Venue, Address, City, Country, Map
//   ## Event details            (a change only)
//   | | Detail |                When, Ends, Coming for, Online link
//   ## Where
//   ### Event location
//   | | Detail |                Venue, Address, City, Country, Map
//   ### Meeting location
//   ...
//   ## Meals held elsewhere (or "Your meals", for someone coming just for
//   ### Dinner                some meals)
//   ...
//   the event page link
//
// notice: { heading, title, url, details: [[label, value]], places and
// mealPlaces: [{ heading, rows: [[label, value]] }], online (an online-only
// event, with no places), mealsHeading, and for a change, changes:
// [{ heading, before, after }] (before and after: [[label, value]] rows, or
// null for something added or removed) }.
export function fullNoticeMessage(notice) {
  const markdown = [`## ${escapeMd(notice.heading)}`, '', `**${escapeMd(notice.title)}**`];
  const fallback = [notice.heading, '', notice.title];

  let changes = [];
  if (Array.isArray(notice.changes)) {
    changes = notice.changes;
  }
  if (changes.length) {
    markdown.push('', '## What changed');
    fallback.push('', 'WHAT CHANGED');
    for (const change of changes) {
      markdown.push('', `### ${escapeMd(change.heading)}`);
      fallback.push('', change.heading);
      const rows = beforeAndNow(change.before, change.after);
      if (rows.length) {
        markdown.push('', richTable(['Before', 'Now'], rows));
        fallback.push(...rows.map(([label, was, now]) => `${label}: ${was} → ${now}`));
      }
    }
    markdown.push('', '## Event details');
    fallback.push('', 'EVENT DETAILS');
  }
  markdown.push('', richTable(['Detail'], notice.details));
  if (!changes.length) {
    fallback.push('');
  }
  fallback.push(...notice.details.map(([label, value]) => `${label}: ${value}`));

  // One section of places: its heading, then each place's own heading and
  // details.
  const section = (heading, places) => {
    markdown.push('', `## ${escapeMd(heading)}`);
    fallback.push('', heading.toUpperCase());
    for (const place of places) {
      markdown.push('', `### ${escapeMd(place.heading)}`, '', richTable(['Detail'], place.rows));
      fallback.push('', place.heading, ...place.rows.map(([label, value]) => `${label}: ${value}`));
    }
  };
  if (notice.places.length) {
    section('Where', notice.places);
  } else if (notice.online) {
    markdown.push('', '## Where', '', 'Online');
    fallback.push('', 'WHERE', 'Online');
  }
  if (notice.mealPlaces.length) {
    section(notice.mealsHeading, notice.mealPlaces);
  }

  markdown.push('', escapeMd(notice.url));
  fallback.push('', notice.url);
  return { markdown: markdown.join('\n'), fallback: fallback.join('\n') };
}

// A change's rows side by side, [label, before, now]: each label whose value
// differs (the rest are in the event's own tables below), a missing value
// shown as "—"; empty when neither has any.
function beforeAndNow(before, after) {
  const rowsOrNone = (rows) => {
    if (Array.isArray(rows)) {
      return rows;
    }
    return [];
  };
  const was = new Map(rowsOrNone(before));
  const now = new Map(rowsOrNone(after));
  const shown = (values, label) => {
    if (values.has(label)) {
      return values.get(label);
    }
    return '—';
  };
  const labels = [...new Set([...now.keys(), ...was.keys()])];
  return labels
    .map((label) => [label, shown(was, label), shown(now, label)])
    .filter(([, before, after]) => before !== after);
}

// An alert for the admins' or an event's organisers' chats
// (staff-alerts.js):
//
//   ## New attendee        (or "Payment reported", "New event published")
//   **Event title**
//   | | Detail |           Name, Username, RSVP ID, Coming for, Ticket, ...
//   ## Contact details     (when they gave any)
//   | | Detail |
//   the event page link
//
// notice: { heading, title, details: [[label, value]], contact:
// [[label, value]], url }.
export function staffAlertMessage(notice) {
  const markdown = [`## ${escapeMd(notice.heading)}`, '', `**${escapeMd(notice.title)}**`, '', richTable(['Detail'], notice.details)];
  const fallback = [notice.heading, '', notice.title, '', ...notice.details.map(([label, value]) => `${label}: ${value}`)];
  if (notice.contact.length) {
    markdown.push('', '## Contact details', '', richTable(['Detail'], notice.contact));
    fallback.push('', 'CONTACT DETAILS', ...notice.contact.map(([label, value]) => `${label}: ${value}`));
  }
  markdown.push('', escapeMd(notice.url));
  fallback.push('', notice.url);
  return { markdown: markdown.join('\n'), fallback: fallback.join('\n') };
}
