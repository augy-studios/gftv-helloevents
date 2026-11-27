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
// Every email is English, as the Telegram messages are, and carries a plain
// text part with the same content as the HTML.

import { optionalEnv, siteHost } from './env.js';

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
// drop style sheets), readable in a dark mail client too.
function wrapHtml(heading, inner) {
  return [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">',
    '<div style="max-width:480px;margin:0 auto">',
    `<h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    inner,
    `<p style="font-size:13px;color:#777;margin-top:32px">GFTV HelloEvents, ${escapeHtml(siteHost())}</p>`,
    '</div></body></html>',
  ].join('');
}

const PURPOSES = {
  'sign-in': {
    subject: 'Your sign-in code',
    heading: 'Sign-in code',
    reason: (username, site) => `Someone is signing in to ${site} as ${username}.`,
    button: 'Sign in',
  },
  reset: {
    subject: 'Your password reset code',
    heading: 'Password reset code',
    reason: (username, site) => `Someone asked to reset the password of the account ${username} on ${site}.`,
    button: 'Reset my password',
  },
  confirm: {
    subject: 'Confirm your email address',
    heading: 'Confirm your email',
    reason: (username, site) => `Someone asked to use this address for sign-in codes on ${site}, for the account ${username}.`,
    button: 'Confirm my email',
  },
};

// A code email: the six digit code, a link that does the same in the
// browser that asked, and when both expire. purpose: "sign-in", "reset" or
// "confirm".
export function codeEmail({ purpose, username, code, link, minutes }) {
  const words = PURPOSES[purpose];
  const site = siteHost();
  const reason = words.reason(username, site);
  const sameDevice = 'The button works only in the browser where you asked for this email. On any other device, type the code.';
  const warning = 'If this was not you, ignore this email and do not share the code. If you did not try to sign in, change your password.';
  const inner = [
    `<p>${escapeHtml(reason)}</p>`,
    `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:24px 0;font-family:'Courier New',monospace">${escapeHtml(code)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#e8590c;color:#ffffff;text-decoration:none;font-weight:bold">${escapeHtml(words.button)}</a></p>`,
    `<p style="font-size:14px">${escapeHtml(sameDevice)} Both expire in ${minutes} minutes.</p>`,
    `<p style="font-size:14px;color:#777">${escapeHtml(warning)}</p>`,
  ].join('');
  const text = [
    reason,
    '',
    `Code: ${code}`,
    '',
    `${words.button}: ${link}`,
    `${sameDevice} Both expire in ${minutes} minutes.`,
    '',
    warning,
  ].join('\n');
  return { subject: `${words.subject}: ${code}`, html: wrapHtml(words.heading, inner), text };
}

// After a password reset: a notice to the confirmed address.
export function resetNoticeEmail({ username }) {
  const body = `The password for your GFTV HelloEvents account ${username} was just reset, and every other device was signed out. If this was not you, reset it again now and check your second step.`;
  return { subject: 'Your password was reset', html: wrapHtml('Password reset', `<p>${escapeHtml(body)}</p>`), text: body };
}
