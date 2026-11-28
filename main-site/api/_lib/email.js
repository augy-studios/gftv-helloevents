// Sending email (migrations/028), through Resend's HTTP API with fetch: no
// package. On Resend's free plan, about 100 emails a day; past that Resend
// refuses (429), the send fails with email_send_failed, and nobody is
// billed. Neither Vercel nor Supabase sends email for this site.
//
//   RESEND_API_KEY  the API key (Resend > API Keys), sending access only
//   EMAIL_FROM      the sender, on a domain verified in Resend, for example
//                   "GFTV HelloEvents <no-reply@events.globalfurry.tv>"
//
// With either blank, emailConfigured() is false and nothing offers email.
// Every email is in the account's language, as the Telegram messages are
// (bot-text.js, migrations/029), and carries a plain text part with the
// same content as the HTML.

import { optionalEnv, siteHost } from './env.js';
import { translator, botLocale } from './bot-text.js';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10000;

export function emailConfigured() {
  if (optionalEnv('RESEND_API_KEY') === '' || optionalEnv('EMAIL_FROM') === '') {
    return false;
  }
  return true;
}

// The address is checked by the caller; this only sends. Throws when Resend
// refuses or does not answer in time.
export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) {
    throw new Error('email is not set up');
  }
  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${optionalEnv('RESEND_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: optionalEnv('EMAIL_FROM'), to: [to], subject, html, text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`resend answered ${response.status}`);
  }
}

const HTML_SPECIAL = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => HTML_SPECIAL[character]);
}

// The HTML around every email: plain, inline styles only (mail clients
// drop style sheets), readable in a dark mail client too, marked with the
// language it is written in.
function wrapHtml(heading, inner, locale) {
  return [
    `<!doctype html><html lang="${escapeHtml(botLocale(locale))}"><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">`,
    '<div style="max-width:480px;margin:0 auto">',
    `<h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    inner,
    `<p style="font-size:13px;color:#777;margin-top:32px">GFTV HelloEvents, ${escapeHtml(siteHost())}</p>`,
    '</div></body></html>',
  ].join('');
}

// Each purpose's words, as bot-text.js keys.
const PURPOSES = {
  'sign-in': { subject: 'email.sign-in-subject', heading: 'code.sign-in-heading', reason: 'code.sign-in-reason', button: 'email.sign-in-button' },
  reset: { subject: 'email.reset-subject', heading: 'code.reset-heading', reason: 'code.reset-reason', button: 'email.reset-button' },
  confirm: { subject: 'email.confirm-subject', heading: 'email.confirm-heading', reason: 'email.confirm-reason', button: 'email.confirm-button' },
};

// A code email: the six digit code, a link that does the same in the
// browser that asked, and when both expire. purpose: "sign-in", "reset" or
// "confirm". locale: the account's language (bot-text.js), English when
// none.
export function codeEmail({ purpose, username, code, link, minutes, locale }) {
  const say = translator(locale);
  const keys = PURPOSES[purpose];
  const site = siteHost();
  const reason = say(keys.reason, { username, site });
  const button = say(keys.button);
  const sameDevice = `${say('email.same-device')} ${say('email.expires', { count: minutes })}`;
  const warning = say('email.not-you');
  const inner = [
    `<p>${escapeHtml(reason)}</p>`,
    `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:24px 0;font-family:'Courier New',monospace">${escapeHtml(code)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#e8590c;color:#ffffff;text-decoration:none;font-weight:bold">${escapeHtml(button)}</a></p>`,
    `<p style="font-size:14px">${escapeHtml(sameDevice)}</p>`,
    `<p style="font-size:14px;color:#777">${escapeHtml(warning)}</p>`,
  ].join('');
  const text = [
    reason,
    '',
    say('code.code', { code }),
    '',
    say('email.button-link', { button, link }),
    sameDevice,
    '',
    warning,
  ].join('\n');
  return { subject: say('email.subject-code', { subject: say(keys.subject), code }), html: wrapHtml(say(keys.heading), inner, locale), text };
}

// After a password reset: a notice to the confirmed address, in the
// account's language.
export function resetNoticeEmail({ username, locale }) {
  const say = translator(locale);
  const body = say('email.reset-notice', { username });
  return {
    subject: say('email.reset-notice-subject'),
    html: wrapHtml(say('email.reset-notice-heading'), `<p>${escapeHtml(body)}</p>`, locale),
    text: body,
  };
}
