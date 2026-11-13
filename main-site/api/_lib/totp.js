// RFC 6238 TOTP, SHA-1, six digits, 30 second steps: what Google
// Authenticator and every other app expects. One step either side is
// accepted for clock drift. No dependency. The same code as OneLink GFTV (gftv-linktree), so a
// secret set up on any GFTV site gives the same codes here.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;
// How many steps either side of now are accepted, for clock drift.
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// The value as a string, with null or undefined read as ''.
function asText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// The secret's bytes, or null when it is empty or not base32. Spaces,
// hyphens, lower case and "=" padding are allowed, as apps show them.
export function decodeBase32(secret) {
  const cleaned = asText(secret).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (cleaned === '') {
    return null;
  }
  // Each character carries 5 bits; a byte is taken off the top whenever 8
  // have built up.
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index < 0) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length > 0) {
    return Buffer.from(bytes);
  }
  return null;
}

// A new secret: 20 random bytes as 32 base32 characters.
export function generateTotpSecret() {
  const randomData = randomBytes(20);
  // Each byte adds 8 bits; a character is taken off the top for every 5.
  let bits = 0;
  let value = 0;
  let secret = '';
  for (const byte of randomData) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      secret += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    secret += BASE32[(value << (5 - bits)) & 31];
  }
  return secret;
}

// RFC 4226 HOTP: the six digit code for one counter value.
function hotpCode(key, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buffer).digest();
  // Dynamic truncation: four bytes from an offset the digest itself picks.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function verifyTotp(code, secret, at = Date.now()) {
  const digits = asText(code).replace(/\D/g, '');
  if (digits.length !== DIGITS) {
    return false;
  }
  const key = decodeBase32(secret);
  if (!key) {
    return false;
  }
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  // Every step in the window is compared, in constant time, so the answer
  // takes as long whichever one matched.
  let matched = false;
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const candidate = Buffer.from(hotpCode(key, counter + offset));
    if (timingSafeEqual(candidate, Buffer.from(digits))) {
      matched = true;
    }
  }
  return matched;
}

// Exposed for the tests, which need a code for a known secret and time.
export function totpAt(secret, at = Date.now()) {
  return hotpCode(decodeBase32(secret), Math.floor(at / 1000 / STEP_SECONDS));
}

export function otpauthUri({ account, secret }) {
  const issuer = 'GFTV HelloEvents';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}
