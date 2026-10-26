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

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db, T } from './supabase.js';
import { siteUrl, optionalEnv } from './env.js';

const CHALLENGE_MINUTES = 5;
const RP_NAME = 'GFTV HelloEvents';

export function relyingParty() {
  const url = new URL(siteUrl());
  return {
    id: optionalEnv('WEBAUTHN_RP_ID', url.hostname),
    origin: optionalEnv('WEBAUTHN_ORIGIN', url.origin).replace(/\/+$/, ''),
  };
}

export async function listPasskeys(userId) {
  const { data, error } = await db()
    .from(T.passkeys)
    .select('id, credential_id, transports, label, created_at, last_used_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function countPasskeys(userId) {
  const { count, error } = await db().from(T.passkeys).select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (error) throw error;
  return count ?? 0;
}

async function storeChallenge(purpose, userId, challenge) {
  await db().from(T.webauthn).delete().eq('purpose', purpose).eq('user_id', userId);
  const { error } = await db().from(T.webauthn).insert({
    purpose,
    user_id: userId,
    challenge,
    expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
  });
  if (error) throw error;
}

// Single use: the row is deleted whether or not it is still valid.
async function takeChallenge(purpose, userId) {
  const { data, error } = await db()
    .from(T.webauthn)
    .select('id, challenge, expires_at')
    .eq('purpose', purpose)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  await db().from(T.webauthn).delete().eq('id', data.id);
  return new Date(data.expires_at).getTime() > Date.now() ? data.challenge : null;
}

export async function registrationOptions(user) {
  const rp = relyingParty();
  const existing = await listPasskeys(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.id,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: row.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await storeChallenge('register', user.id, options.challenge);
  return options;
}

// { ok: true, passkey } or { ok: false, error }.
export async function finishRegistration(userId, response, label) {
  const rp = relyingParty();
  const expectedChallenge = await takeChallenge('register', userId);
  if (!expectedChallenge) return { ok: false, error: 'passkey_expired' };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch (cause) {
    console.warn('[helloevents] passkey registration rejected:', cause?.message ?? cause);
    return { ok: false, error: 'passkey_failed' };
  }
  if (!verification.verified) return { ok: false, error: 'passkey_failed' };

  const { credential } = verification.registrationInfo;
  const { data, error } = await db()
    .from(T.passkeys)
    .insert({
      user_id: userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter ?? 0,
      transports: credential.transports ?? response?.response?.transports ?? null,
      label: label || null,
    })
    .select('id, label, created_at, last_used_at')
    .single();
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'passkey_exists' };
    throw error;
  }
  return { ok: true, passkey: data };
}

// Options for signing in, or null when the account has no passkeys.
export async function authenticationOptions(userId) {
  const rp = relyingParty();
  const existing = await listPasskeys(userId);
  if (existing.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: existing.map((row) => ({ id: row.credential_id, transports: row.transports ?? undefined })),
    userVerification: 'preferred',
  });
  await storeChallenge('authenticate', userId, options.challenge);
  return options;
}

export async function finishAuthentication(userId, response) {
  const rp = relyingParty();
  const expectedChallenge = await takeChallenge('authenticate', userId);
  if (!expectedChallenge) return false;

  const credentialId = typeof response?.id === 'string' ? response.id : '';
  if (!credentialId || credentialId.length > 1024) return false;
  const { data: row, error } = await db()
    .from(T.passkeys)
    .select('id, credential_id, public_key, counter, transports')
    .eq('user_id', userId)
    .eq('credential_id', credentialId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return false;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: Number(row.counter) || 0,
        transports: row.transports ?? undefined,
      },
      requireUserVerification: false,
    });
  } catch (cause) {
    // Includes a counter that went backwards, the sign of a cloned key.
    console.warn('[helloevents] passkey assertion rejected:', cause?.message ?? cause);
    return false;
  }
  if (!verification.verified) return false;

  await db()
    .from(T.passkeys)
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq('id', row.id);
  return true;
}

export async function removePasskey(userId, passkeyId) {
  const { data, error } = await db().from(T.passkeys).delete().eq('user_id', userId).eq('id', passkeyId).select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}
