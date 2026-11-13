// Tokens, hashes and the TOTP secret envelope.
//
//   Passwords and backup codes  bcrypt. Low entropy, so a slow hash.
//   Session, challenge and      SHA-256. 32 random bytes each, so a fast hash
//   Telegram link tokens        is enough and lookups stay a single index hit.
//   TOTP secrets set up here    AES-256-GCM with TOTP_ENCRYPTION_KEY, because
//                               the server has to read them back. Secrets set
//                               up on gftv.asia live in gftvhello_users as
//                               plain base32 and are read as they are, the
//                               same as gftv-linktree does.
//   Addresses                   salted SHA-256, for rate limits and the audit
//                               log.
//
// The same formats as gftv-linktree's api/_lib/crypto.js, so a staff account
// and its shared backup codes work the same on both sites.

import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { requiredEnv, optionalEnv } from './env.js';
import { errorDetail } from './http.js';

const PASSWORD_ROUNDS = 12;
// Ten codes are compared one by one at sign in, so a lower cost keeps that
// under a second. Each code still carries about 50 bits of entropy.
const CODE_ROUNDS = 10;

// A real bcrypt hash of a discarded value. Comparing against it on the
// unknown-account branch makes that branch cost what a wrong password costs.
const DUMMY_HASH = '$2a$12$9S.9kxE/etBNq4UBisxl7ORP75tDZWrG9w7T9znqxqiW15PvNmdI6';

// The value as a string, with null and undefined read as ''.
function stringOrEmpty(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Compares two strings in constant time, so the time taken does not reveal
// how much of a secret was right.
export function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left), 'utf8');
  const rightBytes = Buffer.from(String(right), 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function hashPassword(plain) {
  return bcrypt.hash(String(plain), PASSWORD_ROUNDS);
}

// One bcrypt comparison always runs, against the dummy hash when there is no
// real one, so an unknown account takes as long as a wrong password.
export async function verifyPassword(plain, hash) {
  let isRealHash = false;
  if (typeof hash === 'string' && hash.startsWith('$2')) {
    isRealHash = true;
  }
  let hashToCompare = DUMMY_HASH;
  if (isRealHash) {
    hashToCompare = hash;
  }
  const matched = await bcrypt.compare(stringOrEmpty(plain), hashToCompare);
  if (!isRealHash) {
    return false;
  }
  return matched;
}

export function hashCode(plain) {
  return bcrypt.hash(normaliseCode(plain), CODE_ROUNDS);
}

// Codes are matched in a normalised form, so spaces, capitals and a missing
// hyphen still match what was issued.
export function normaliseCode(input) {
  return stringOrEmpty(input).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// No 0, o, 1, l or i, so a code read off paper is not mistyped.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

// Backup codes look like "abcde-fghij": ten characters from CODE_ALPHABET,
// with a hyphen after the fifth.
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let codeNumber = 0; codeNumber < count; codeNumber += 1) {
    const bytes = randomBytes(10);
    let code = '';
    for (let characterIndex = 0; characterIndex < 10; characterIndex += 1) {
      if (characterIndex === 5) {
        code += '-';
      }
      code += CODE_ALPHABET[bytes[characterIndex] % CODE_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

// A one-time password reset code an admin hands to a member: three groups
// of five from the same unambiguous alphabet, about 74 bits.
export function randomBytesCode() {
  const bytes = randomBytes(15);
  let code = '';
  for (let characterIndex = 0; characterIndex < 15; characterIndex += 1) {
    if (characterIndex === 5 || characterIndex === 10) {
      code += '-';
    }
    code += CODE_ALPHABET[bytes[characterIndex] % CODE_ALPHABET.length];
  }
  return code;
}

// Six digits, uniform, for Telegram codes. 4,294,000,000 is the largest
// multiple of a million below 2^32; values from there up are drawn again, so
// every six-digit result is equally likely.
export function randomDigits() {
  let value;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= 4294000000);
  return String(value % 1000000).padStart(6, '0');
}

// Compare a typed code against every stored hash, without stopping at the
// first match, so timing does not reveal which code it was.
export async function findMatchingCode(typed, rows) {
  const normalised = normaliseCode(typed);
  if (normalised.length < 6) {
    return null;
  }
  let matched = null;
  for (const row of rows) {
    const isMatch = await bcrypt.compare(normalised, row.code_hash);
    if (isMatch && matched === null) {
      matched = row;
    }
  }
  return matched;
}

// TOTP_ENCRYPTION_KEY is 32 random bytes, written either as base64 (44
// characters, from `openssl rand -base64 32`) or as hex (64 characters, from
// `openssl rand -hex 32`). Anything that does not come to exactly 32 bytes is
// refused rather than stretched, and the error says what it got.
export function parseEncryptionKey(raw) {
  // Surrounding quotes, as pasted from a shell, are dropped.
  const value = stringOrEmpty(raw).trim().replace(/^(['"])(.*)\1$/, '$2');
  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must be 32 bytes: 44 characters of base64 or 64 of hex. ` +
        `The value set is ${value.length} characters (${key.length} bytes). Make one with: openssl rand -base64 32`
    );
  }
  return key;
}

function secretKey() {
  return parseEncryptionKey(requiredEnv('TOTP_ENCRYPTION_KEY'));
}

// The envelope is "v1:<initialisation vector>:<authentication tag>:<encrypted
// secret>", each part base64url.
export function encryptSecret(plain) {
  const initialisationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), initialisationVector);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return `v1:${initialisationVector.toString('base64url')}:${authenticationTag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

// The plain secret from an encryptSecret envelope, or null when it is not one
// or does not decrypt (a changed key, or a damaged value).
export function decryptSecret(envelope) {
  if (typeof envelope !== 'string' || !envelope.startsWith('v1:')) {
    return null;
  }
  try {
    const [, initialisationVector, authenticationTag, encrypted] = envelope.split(':');
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(initialisationVector, 'base64url'));
    decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
    return plain.toString('utf8');
  } catch (cause) {
    console.error('[helloevents] could not decrypt a TOTP secret:', errorDetail(cause));
    return null;
  }
}

export function hashIp(ipAddress) {
  return sha256(`${optionalEnv('IP_HASH_SALT', 'helloevents')}:${ipAddress}`);
}
