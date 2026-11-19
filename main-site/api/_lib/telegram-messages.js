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
// built by notify.js from public event fields only: { heading, title, lines,
// url }.
export function eventNoticeMessage(notice) {
  const markdown = [
    `## ${escapeMd(notice.heading)}`,
    '',
    `**${escapeMd(notice.title)}**`,
    '',
    ...notice.lines.map((line) => escapeMd(line)),
    '',
    escapeMd(notice.url),
  ].join('\n');
  const fallback = [notice.heading, '', notice.title, ...notice.lines, '', notice.url].join('\n');
  return { markdown, fallback };
}

// A reminder before an event, for someone going (notify.js reminderNotice):
//
//   ## Starting in 1 hour
//   **Title**
//   | | Detail |      When, Ends, Coming for, Online link
//   ## Where
//   ### Event location
//   | | Detail |      Venue, Address, City, Country, Map
//   ### Meeting location
//   ...
//   ## Meals held elsewhere (or "Your meals", for someone coming just for
//   ### Dinner                some meals)
//   ...
//   the event page link
//
// notice: { heading, title, url, details: [[label, value]], places and
// mealPlaces: [{ heading, rows: [[label, value]] }], online (an online-only
// event, with no places), mealsHeading }.
export function reminderMessage(notice) {
  const markdown = [`## ${escapeMd(notice.heading)}`, '', `**${escapeMd(notice.title)}**`, '', richTable(['Detail'], notice.details)];
  const fallback = [notice.heading, '', notice.title, '', ...notice.details.map(([label, value]) => `${label}: ${value}`)];

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
