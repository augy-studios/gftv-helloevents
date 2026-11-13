// What a public account may be: username, display name, email, password.
// Pure functions, so tests/unit.test.js runs them directly.

const USERNAME = /^[a-z0-9_]{3,32}$/;
// Deliberately loose: a real check is a message that arrives, and there is
// no email sender yet. This only refuses what cannot be an address.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Words a name may not contain (staff, official, GFTV, ...) are checked by
// name-filter.js, which needs the admins' list from the database, so the
// sign-up and profile routes call it after these checks.

export const PASSWORD_MIN = 10;
// bcrypt reads at most 72 bytes; anything after that would be ignored, so a
// longer password is refused rather than silently cut.
export const PASSWORD_MAX_BYTES = 72;

// The value as a string, with null and undefined read as ''.
function stringOrEmpty(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function normaliseUsername(value) {
  return stringOrEmpty(value).trim().toLowerCase();
}

export function normaliseEmail(value) {
  return stringOrEmpty(value).trim().toLowerCase();
}

// Drops control characters and the invisible zero-width and text-direction
// characters (which can make one name look like another), and collapses
// runs of spaces.
export function cleanDisplayName(value) {
  return stringOrEmpty(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// { ok: true } or { ok: false, error }.
export function checkPassword(password, { username = '', email = '' } = {}) {
  let value = '';
  if (typeof password === 'string') {
    value = password;
  }
  if ([...value].length < PASSWORD_MIN) {
    return { ok: false, error: 'password_short' };
  }
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) {
    return { ok: false, error: 'password_long' };
  }
  const lowercased = value.toLowerCase();
  if ((username && lowercased === username) || (email && lowercased === email)) {
    return { ok: false, error: 'password_weak' };
  }
  // One character repeated, or a well-known sequence or keyboard run.
  if (/^(.)\1+$/.test(value) || /^(0123456789|1234567890|password\d*|qwerty\w*)$/i.test(value)) {
    return { ok: false, error: 'password_weak' };
  }
  return { ok: true };
}

// { ok: true, fields } with the cleaned values, or { ok: false, error }.
export function validateSignup(body) {
  let input = {};
  if (body && typeof body === 'object') {
    input = body;
  }

  const username = normaliseUsername(input.username);
  if (!USERNAME.test(username)) {
    return { ok: false, error: 'username_invalid' };
  }

  const displayName = cleanDisplayName(input.displayName);
  if (displayName.length < 1 || [...displayName].length > 60) {
    return { ok: false, error: 'display_name_invalid' };
  }

  const email = normaliseEmail(input.email);
  if (email.length > 254 || !EMAIL.test(email)) {
    return { ok: false, error: 'email_invalid' };
  }

  const passwordCheck = checkPassword(input.password, { username, email });
  if (!passwordCheck.ok) {
    return passwordCheck;
  }

  if (input.agree !== true) {
    return { ok: false, error: 'terms_required' };
  }
  return { ok: true, fields: { username, displayName, email } };
}
