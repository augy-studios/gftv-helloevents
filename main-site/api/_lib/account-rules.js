// What a public account may be: username, display name, email, password.
// Pure functions, so tests/unit.test.js runs them directly.

const USERNAME = /^[a-z0-9_]{3,32}$/;
// Deliberately loose: a real check is a message that arrives, and there is
// no email sender yet. This only refuses what cannot be an address.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Words a public username may not use, so nobody signs up looking official.
const RESERVED = /(^|_)(admin|administrator|staff|mod|moderator|gftv|globalfurry|official|support|helloevents|system|root)(_|$)/;

export const PASSWORD_MIN = 10;
// bcrypt reads at most 72 bytes; anything after that would be ignored, so a
// longer password is refused rather than silently cut.
export const PASSWORD_MAX_BYTES = 72;

export function normaliseUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normaliseEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function cleanDisplayName(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// { ok: true } or { ok: false, error }.
export function checkPassword(password, { username = '', email = '' } = {}) {
  const value = typeof password === 'string' ? password : '';
  if ([...value].length < PASSWORD_MIN) return { ok: false, error: 'password_short' };
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) return { ok: false, error: 'password_long' };
  const lower = value.toLowerCase();
  if ((username && lower === username) || (email && lower === email)) return { ok: false, error: 'password_weak' };
  if (/^(.)\1+$/.test(value) || /^(0123456789|1234567890|password\d*|qwerty\w*)$/i.test(value)) return { ok: false, error: 'password_weak' };
  return { ok: true };
}

// { ok: true, fields } with the cleaned values, or { ok: false, error }.
export function validateSignup(body) {
  const input = body && typeof body === 'object' ? body : {};
  const username = normaliseUsername(input.username);
  if (!USERNAME.test(username)) return { ok: false, error: 'username_invalid' };
  if (RESERVED.test(username)) return { ok: false, error: 'username_reserved' };
  const displayName = cleanDisplayName(input.displayName);
  if (displayName.length < 1 || [...displayName].length > 60) return { ok: false, error: 'display_name_invalid' };
  const email = normaliseEmail(input.email);
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, error: 'email_invalid' };
  const password = checkPassword(input.password, { username, email });
  if (!password.ok) return password;
  if (input.agree !== true) return { ok: false, error: 'terms_required' };
  return { ok: true, fields: { username, displayName, email } };
}
