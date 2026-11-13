// Passkeys as a second factor, with @simplewebauthn/server, the same library
// and the same storage format as gftv-linktree (base64url credential id and
// COSE public key, a signature counter, transports).
//
// A passkey is bound to its relying party ID. By default that is the
// hostname in SITE_URL (events.globalfurry.tv), so a passkey made here works
// here only, and passkeys made on links.gftv.asia do not work here: each site
// keeps its own credential table. WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN override
// the default; see .env.example before changing them, since every passkey
// already registered stops working when the RP ID changes.
//
// On a Vercel preview URL the browser refuses passkeys, which is expected;
// the authenticator app and Telegram still work there.
//
// The option names passed to SimpleWebAuthn (rpName, rpID, expectedRPID and
// the rest) are the library's own, and stay as it spells them.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { database, TABLES } from './supabase.js';
import { siteUrl, optionalEnv } from './env.js';

const CHALLENGE_MINUTES = 5;
const RELYING_PARTY_NAME = 'GFTV HelloEvents';

// What to log for a failure: its message, or the thrown value itself when
// it has none.
function describeCause(cause) {
  if (cause === null || cause === undefined) {
    return cause;
  }
  const message = cause.message;
  if (message === null || message === undefined) {
    return cause;
  }
  return message;
}

// A stored passkey's transports in the form SimpleWebAuthn takes: the list,
// or undefined (never null) when none were stored.
function transportsOf(passkey) {
  const transports = passkey.transports;
  if (transports === null || transports === undefined) {
    return undefined;
  }
  return transports;
}

// The relying party: { id, origin }.
export function relyingParty() {
  const url = new URL(siteUrl());
  return {
    id: optionalEnv('WEBAUTHN_RP_ID', url.hostname),
    origin: optionalEnv('WEBAUTHN_ORIGIN', url.origin).replace(/\/+$/, ''),
  };
}

export async function listPasskeys(userId) {
  const { data, error } = await database()
    .from(TABLES.passkeys)
    .select('id, credential_id, transports, label, created_at, last_used_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  if (data === null || data === undefined) {
    return [];
  }
  return data;
}

export async function countPasskeys(userId) {
  const { count, error } = await database().from(TABLES.passkeys).select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (error) {
    throw error;
  }
  if (count === null || count === undefined) {
    return 0;
  }
  return count;
}

// One open challenge per account and purpose: storing a new one replaces it.
async function storeChallenge(purpose, userId, challenge) {
  await database().from(TABLES.webauthn).delete().eq('purpose', purpose).eq('user_id', userId);
  const { error } = await database().from(TABLES.webauthn).insert({
    purpose,
    user_id: userId,
    challenge,
    expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
  });
  if (error) {
    throw error;
  }
}

// Single use: the row is deleted whether or not it is still valid.
async function takeChallenge(purpose, userId) {
  const { data, error } = await database()
    .from(TABLES.webauthn)
    .select('id, challenge, expires_at')
    .eq('purpose', purpose)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  await database().from(TABLES.webauthn).delete().eq('id', data.id);
  if (new Date(data.expires_at).getTime() > Date.now()) {
    return data.challenge;
  }
  return null;
}

// Options for adding a passkey, excluding the ones the account already has.
export async function registrationOptions(user) {
  const party = relyingParty();
  const existing = await listPasskeys(user.id);
  let userDisplayName = user.display_name;
  if (!userDisplayName) {
    userDisplayName = user.username;
  }
  const options = await generateRegistrationOptions({
    rpName: RELYING_PARTY_NAME,
    rpID: party.id,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName,
    attestationType: 'none',
    excludeCredentials: existing.map((passkey) => ({ id: passkey.credential_id, transports: transportsOf(passkey) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await storeChallenge('register', user.id, options.challenge);
  return options;
}

// { ok: true, passkey } or { ok: false, error }. Takes the registration
// challenge (single use), verifies what the browser sent with SimpleWebAuthn,
// and stores the new passkey: its credential id, public key, counter,
// transports and label. A passkey already stored answers passkey_exists.
export async function finishRegistration(userId, browserResponse, label) {
  const party = relyingParty();
  const expectedChallenge = await takeChallenge('register', userId);
  if (!expectedChallenge) {
    return { ok: false, error: 'passkey_expired' };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: browserResponse,
      expectedChallenge,
      expectedOrigin: party.origin,
      expectedRPID: party.id,
      requireUserVerification: false,
    });
  } catch (cause) {
    console.warn('[helloevents] passkey registration rejected:', describeCause(cause));
    return { ok: false, error: 'passkey_failed' };
  }
  if (!verification.verified) {
    return { ok: false, error: 'passkey_failed' };
  }

  const { credential } = verification.registrationInfo;
  let counter = credential.counter;
  if (counter === null || counter === undefined) {
    counter = 0;
  }
  // The transports SimpleWebAuthn read, else the ones the browser listed in
  // its response, else none (null).
  let transports = credential.transports;
  if (transports === null || transports === undefined) {
    transports = undefined;
    if (browserResponse !== null && browserResponse !== undefined) {
      const inner = browserResponse.response;
      if (inner !== null && inner !== undefined) {
        transports = inner.transports;
      }
    }
  }
  if (transports === null || transports === undefined) {
    transports = null;
  }
  let storedLabel = null;
  if (label) {
    storedLabel = label;
  }
  const { data, error } = await database()
    .from(TABLES.passkeys)
    .insert({
      user_id: userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter,
      transports,
      label: storedLabel,
    })
    .select('id, label, created_at, last_used_at')
    .single();
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'passkey_exists' };
    }
    throw error;
  }
  return { ok: true, passkey: data };
}

// Options for signing in, or null when the account has no passkeys.
export async function authenticationOptions(userId) {
  const party = relyingParty();
  const existing = await listPasskeys(userId);
  if (existing.length === 0) {
    return null;
  }
  const options = await generateAuthenticationOptions({
    rpID: party.id,
    allowCredentials: existing.map((passkey) => ({ id: passkey.credential_id, transports: transportsOf(passkey) })),
    userVerification: 'preferred',
  });
  await storeChallenge('authenticate', userId, options.challenge);
  return options;
}

// A passkey sign-in: true or false. Takes the sign-in challenge (single use),
// finds the passkey by its credential id among this account's own, verifies
// the signature with SimpleWebAuthn, then stores the new signature counter
// and when the passkey was last used.
export async function finishAuthentication(userId, browserResponse) {
  const party = relyingParty();
  const expectedChallenge = await takeChallenge('authenticate', userId);
  if (!expectedChallenge) {
    return false;
  }

  let credentialId = '';
  if (browserResponse !== null && browserResponse !== undefined && typeof browserResponse.id === 'string') {
    credentialId = browserResponse.id;
  }
  if (!credentialId || credentialId.length > 1024) {
    return false;
  }
  const { data: passkey, error } = await database()
    .from(TABLES.passkeys)
    .select('id, credential_id, public_key, counter, transports')
    .eq('user_id', userId)
    .eq('credential_id', credentialId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!passkey) {
    return false;
  }

  let verification;
  try {
    let storedCounter = Number(passkey.counter);
    if (!storedCounter) {
      storedCounter = 0;
    }
    verification = await verifyAuthenticationResponse({
      response: browserResponse,
      expectedChallenge,
      expectedOrigin: party.origin,
      expectedRPID: party.id,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64url')),
        counter: storedCounter,
        transports: transportsOf(passkey),
      },
      requireUserVerification: false,
    });
  } catch (cause) {
    // Includes a counter that went backwards, the sign of a cloned key.
    console.warn('[helloevents] passkey assertion rejected:', describeCause(cause));
    return false;
  }
  if (!verification.verified) {
    return false;
  }

  await database()
    .from(TABLES.passkeys)
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq('id', passkey.id);
  return true;
}

export async function removePasskey(userId, passkeyId) {
  const { data, error } = await database().from(TABLES.passkeys).delete().eq('user_id', userId).eq('id', passkeyId).select('id');
  if (error) {
    throw error;
  }
  if (data === null || data === undefined) {
    return false;
  }
  return data.length > 0;
}
