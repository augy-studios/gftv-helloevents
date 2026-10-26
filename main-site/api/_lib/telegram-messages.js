// The bot's structured messages, each built as { markdown, fallback } for
// sendRichTelegram. One-line notices are not here; they go out as plain text.
// Every piece of data goes through escapeMd or a richTable cell.

import { escapeMd, richTable } from './telegram.js';
import { siteHost } from './env.js';

// A six digit code. purpose: "sign-in" (a sign in with Telegram as the second
// factor) or "confirm" (linking this chat while setting up a first factor).
export function codeMessage({ purpose, username, code, minutes }) {
  const site = siteHost();
  const why = purpose === 'confirm'
    ? `Someone is setting up Telegram as the second step for the GFTV account ${username} on ${site}.`
    : `Someone is signing in to ${site} as ${username}.`;
  const heading = purpose === 'confirm' ? 'Confirm this chat' : 'Sign-in code';
  const action = purpose === 'confirm' ? 'Type this code on the set-up page.' : 'Type this code on the sign-in page.';

  const markdown = [
    `## ${heading}`,
    '',
    escapeMd(why),
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
    '*If this was not you, do not share the code, and change your GFTV password.*',
  ].join('\n');

  const fallback =
    `${why}\n\nCode: ${code}\n\n${action} It expires in ${minutes} minutes.\n\n` +
    'If this was not you, do not share the code, and change your GFTV password.';
  return { markdown, fallback, skipEntities: true };
}

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
