// ID checks with an outside provider (migrations/027): a person proves who
// they are once, and every event that requires a check and accepts that
// provider takes their RSVP. Two providers, each optional, each switched on
// by its environment variables (.env.example):
//
//   didit    Didit (didit.me), a passport or ID card and a selfie. Hosted
//            page; POST /v3/session/, GET /v3/session/{id}/decision/.
//   veriff   Veriff (veriff.com), its hosted page. POST /v1/sessions,
//            GET /v1/sessions/{id}/decision (signed with the shared secret).
//
// GFTV's own check (gftv) is another thing: done for one event at a time,
// on this site, and decided by its face check or the event's organisers
// (face-check.js, id-reviews.js). eventIdProviders and idCheckPassed below
// cover the outside providers; id-reviews.js adds the event's own.
//
// The flow: the account page asks to start (api/me/idcheck.js), a row goes
// in gftvevents_id_checks with the provider's session id, and the person is
// sent to the provider's page. They come back through
// /api/idcheck/return?id=<our check id>, which reads the result from the
// provider; the provider's webhook (api/idcheck/webhook.js) does the same
// for a decision that comes later (a manual review). Neither trusts what it
// is sent: both only say which check to read again, and the result always
// comes from the provider's own API, asked with our secret key.
//
// An approved check sets the account's legal name (and date of birth, when
// the document gives one), which then stay locked (migrations/024), and adds
// the provider to id_verified_providers. Nothing else from the document is
// kept: not its number, not a picture. identity_hash, a keyed hash of the
// document's country and number, only stops one document checking several
// accounts (the second is refused, failure 'document_used').

import { createHmac, randomUUID } from 'node:crypto';
import { database, TABLES } from './supabase.js';
import { optionalEnv, siteUrl } from './env.js';
import { keyedHash, safeEqual } from './crypto.js';
import { errorDetail } from './http.js';
import { ensureStaffAccount } from './users.js';
import { audit } from './guards.js';
import { alertIdVerified } from './admin-chats.js';
import { ID_CHECK_PROVIDERS } from './event-rules.js';
import { personName, birthDate } from '../../js/registration-fields.js';

// The outside providers. Events can accept these and HelloID
// (event-rules.js ID_CHECK_PROVIDERS).
export const ID_PROVIDERS = Object.freeze(ID_CHECK_PROVIDERS.filter((name) => name !== 'helloid'));

// How long a provider has to answer, and how old a signed webhook may be.
const PROVIDER_TIMEOUT_MS = 10000;
const WEBHOOK_TOLERANCE_SECONDS = 300;

// What each status means here. Final ones are never read again.
export const FINAL_STATUSES = Object.freeze(['approved', 'declined', 'failed']);
const OPEN_STATUSES = Object.freeze(['started', 'pending', 'review']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function textOrEmpty(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

// value[key], or undefined when value is not an object.
function field(value, key) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return undefined;
  }
  return value[key];
}

// A provider's answer as JSON, or an error naming the provider and status.
async function callProvider(provider, url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(`${provider} answered ${response.status}`);
  }
  if (body === null) {
    throw new Error(`${provider} answered something that is not JSON`);
  }
  return body;
}

// Whether every one of these environment variables is set.
function allSet(names) {
  return names.every((name) => optionalEnv(name) !== '');
}

// A lowercase hex HMAC-SHA256, as all three providers sign with.
function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// One name from its parts, tidied the way the account page tidies one.
function joinName(parts) {
  const joined = parts.map((part) => textOrEmpty(part)).filter((part) => part !== '').join(' ');
  const name = personName(joined);
  if (!name.ok || !name.value) {
    return null;
  }
  return name.value;
}

function cleanBirth(value) {
  const date = birthDate(textOrEmpty(value).slice(0, 10));
  if (!date.ok || !date.value) {
    return null;
  }
  return date.value;
}

// ---------------------------------------------------------------------------
// Didit
// ---------------------------------------------------------------------------

const didit = {
  configured() {
    return allSet(['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID']);
  },

  async start(accountId, returnUrl) {
    const body = await callProvider('didit', 'https://verification.didit.me/v3/session/', {
      method: 'POST',
      headers: { 'x-api-key': optionalEnv('DIDIT_API_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_id: optionalEnv('DIDIT_WORKFLOW_ID'), vendor_data: accountId, callback: returnUrl }),
    });
    return { sessionId: textOrEmpty(body.session_id), url: textOrEmpty(body.url) };
  },

  async result(sessionId, accountId) {
    const body = await callProvider('didit', `https://verification.didit.me/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
      headers: { 'x-api-key': optionalEnv('DIDIT_API_KEY') },
    });
    if (textOrEmpty(body.vendor_data) !== accountId) {
      return { status: 'failed' };
    }
    const status = textOrEmpty(body.status).toLowerCase();
    if (status === 'approved') {
      let document = {};
      if (Array.isArray(body.id_verifications) && body.id_verifications.length > 0) {
        document = body.id_verifications[0];
      } else if (body.id_verification && typeof body.id_verification === 'object') {
        document = body.id_verification;
      }
      let name = joinName([field(document, 'full_name')]);
      if (!name) {
        name = joinName([field(document, 'first_name'), field(document, 'last_name')]);
      }
      return {
        status: 'approved',
        name,
        birth: cleanBirth(field(document, 'date_of_birth')),
        documentCountry: textOrEmpty(field(document, 'issuing_state')),
        documentNumber: textOrEmpty(field(document, 'document_number')),
      };
    }
    if (status === 'declined') {
      return { status: 'declined' };
    }
    if (status === 'in review') {
      return { status: 'review' };
    }
    if (['expired', 'abandoned', 'kyc expired'].includes(status)) {
      return { status: 'failed' };
    }
    return { status: 'pending' };
  },

  // X-Signature: the HMAC of the exact bytes sent; X-Signature-V2: of the
  // JSON with sorted keys, which still works once the body has been parsed.
  // Either, or their -Previous copies after a secret rotation, will do.
  webhookSessionId(headers, raw, parsed) {
    const secret = optionalEnv('DIDIT_WEBHOOK_SECRET');
    if (!secret) {
      return { ok: false };
    }
    const sentAt = Number(headers['x-timestamp']);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
      return { ok: false };
    }
    const candidates = [];
    if (raw !== null) {
      const expected = hmacHex(secret, raw);
      candidates.push([headers['x-signature'], expected], [headers['x-signature-previous'], expected]);
    }
    if (parsed !== null) {
      const expected = hmacHex(secret, canonicalJson(parsed));
      candidates.push([headers['x-signature-v2'], expected], [headers['x-signature-v2-previous'], expected]);
    }
    const signed = candidates.some(([given, expected]) => {
      if (typeof given !== 'string') {
        return false;
      }
      return safeEqual(given.toLowerCase(), expected);
    });
    if (!signed || parsed === null) {
      return { ok: false };
    }
    return { ok: true, sessionId: textOrEmpty(parsed.session_id) };
  },
};

// Didit's canonical JSON for X-Signature-V2: keys sorted at every level, no
// spaces, Unicode as it is, and whole-valued numbers without a fraction.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return String(value);
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Veriff
// ---------------------------------------------------------------------------

function veriffBase() {
  return optionalEnv('VERIFF_BASE_URL', 'https://stationapi.veriff.com').replace(/\/+$/, '');
}

const veriff = {
  configured() {
    return allSet(['VERIFF_API_KEY', 'VERIFF_SHARED_SECRET']);
  },

  async start(accountId, returnUrl) {
    const body = await callProvider('veriff', `${veriffBase()}/v1/sessions`, {
      method: 'POST',
      headers: { 'x-auth-client': optionalEnv('VERIFF_API_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify({ verification: { callback: returnUrl, vendorData: accountId } }),
    });
    const verification = field(body, 'verification');
    return { sessionId: textOrEmpty(field(verification, 'id')), url: textOrEmpty(field(verification, 'url')) };
  },

  async result(sessionId, accountId) {
    const body = await callProvider('veriff', `${veriffBase()}/v1/sessions/${encodeURIComponent(sessionId)}/decision`, {
      headers: {
        'x-auth-client': optionalEnv('VERIFF_API_KEY'),
        'x-hmac-signature': hmacHex(optionalEnv('VERIFF_SHARED_SECRET'), sessionId),
        'content-type': 'application/json',
      },
    });
    const verification = field(body, 'verification');
    // No decision yet.
    if (!verification || typeof verification !== 'object') {
      return { status: 'pending' };
    }
    if (textOrEmpty(verification.vendorData) !== accountId) {
      return { status: 'failed' };
    }
    const code = Number(verification.code);
    if (code === 9001) {
      const person = field(verification, 'person');
      const document = field(verification, 'document');
      return {
        status: 'approved',
        name: joinName([field(person, 'firstName'), field(person, 'lastName')]),
        birth: cleanBirth(field(person, 'dateOfBirth')),
        documentCountry: textOrEmpty(field(document, 'country')),
        documentNumber: textOrEmpty(field(document, 'number')),
      };
    }
    if (code === 9102) {
      return { status: 'declined' };
    }
    if (code === 9104 || code === 9121) {
      return { status: 'failed' };
    }
    if (textOrEmpty(verification.status).toLowerCase() === 'review') {
      return { status: 'review' };
    }
    // 9103, resubmission requested: the person goes through again.
    return { status: 'pending' };
  },

  // X-HMAC-SIGNATURE: the HMAC of the exact body sent, with the shared
  // secret; X-AUTH-CLIENT: the API key. Needs the raw body.
  webhookSessionId(headers, raw, parsed) {
    const secret = optionalEnv('VERIFF_SHARED_SECRET');
    const given = textOrEmpty(headers['x-hmac-signature']).toLowerCase();
    if (!secret || !given || raw === null || parsed === null) {
      return { ok: false };
    }
    if (!safeEqual(textOrEmpty(headers['x-auth-client']), optionalEnv('VERIFF_API_KEY')) || !safeEqual(given, hmacHex(secret, raw))) {
      return { ok: false };
    }
    // A decision carries verification.id; an event webhook, id.
    let sessionId = textOrEmpty(field(field(parsed, 'verification'), 'id'));
    if (!sessionId) {
      sessionId = textOrEmpty(field(parsed, 'id'));
    }
    return { ok: true, sessionId };
  },
};

const PROVIDERS = { didit, veriff };

// ---------------------------------------------------------------------------
// The rest of the site's view
// ---------------------------------------------------------------------------

export function isProvider(name) {
  return ID_PROVIDERS.includes(name);
}

// The providers this deploy has keys for, in the usual order.
export function configuredProviders() {
  return ID_PROVIDERS.filter((name) => PROVIDERS[name].configured());
}

export function providerWebhook(name) {
  return PROVIDERS[name];
}

// Where the provider sends the person back: our return route, with the
// event page to go on to. next comes first, and the id is read from the
// start of its value, in case a provider adds its own "?..." to the end.
function returnUrl(checkId, next) {
  let url = `${siteUrl()}/api/idcheck/return?`;
  if (next) {
    url += `next=${encodeURIComponent(next)}&`;
  }
  return `${url}id=${checkId}`;
}

// Starts a check for an account with a provider: a row, then the
// provider's session. -> { url } to send the person to.
export async function startCheck(account, provider, next) {
  if (account.kind === 'staff') {
    await ensureStaffAccount(account.id);
  }
  const { data, error } = await database()
    .from(TABLES.idChecks)
    .insert({ account_id: account.id, provider, provider_session_id: `pending-${randomUUID()}` })
    .select('id')
    .single();
  if (error) {
    throw error;
  }
  let session;
  try {
    session = await PROVIDERS[provider].start(account.id, returnUrl(data.id, next));
  } catch (cause) {
    await database().from(TABLES.idChecks).delete().eq('id', data.id);
    throw cause;
  }
  if (!session.sessionId || !/^https:\/\//.test(session.url)) {
    await database().from(TABLES.idChecks).delete().eq('id', data.id);
    throw new Error(`${provider} gave no session`);
  }
  const { error: saveError } = await database()
    .from(TABLES.idChecks)
    .update({ provider_session_id: session.sessionId, updated_at: new Date().toISOString() })
    .eq('id', data.id);
  if (saveError) {
    throw saveError;
  }
  return { url: session.url };
}

const CHECK_COLUMNS = 'id, account_id, provider, provider_session_id, status, failure, created_at';

export async function checkById(checkId) {
  const { data, error } = await database().from(TABLES.idChecks).select(CHECK_COLUMNS).eq('id', checkId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

export async function checkBySession(provider, sessionId) {
  const { data, error } = await database()
    .from(TABLES.idChecks)
    .select(CHECK_COLUMNS)
    .eq('provider', provider)
    .eq('provider_session_id', sessionId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The account's latest check, for the account page.
export async function latestCheck(accountId) {
  const { data, error } = await database()
    .from(TABLES.idChecks)
    .select(CHECK_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  return data[0];
}

// Whether another account already holds an approved check of this
// document, with an outside provider or HelloID.
async function documentUsedElsewhere(identityHash, accountId) {
  for (const table of [TABLES.idChecks, TABLES.helloidChecks]) {
    const { data, error } = await database()
      .from(table)
      .select('account_id')
      .eq('identity_hash', identityHash)
      .eq('status', 'approved')
      .neq('account_id', accountId)
      .limit(1);
    if (error) {
      throw error;
    }
    if (Array.isArray(data) && data.length > 0) {
      return true;
    }
  }
  return false;
}

// The document's country and number, folded, as a keyed hash; null when
// the provider gave no number.
export function identityHashOf(outcome) {
  const number = textOrEmpty(outcome.documentNumber).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!number) {
    return null;
  }
  const country = textOrEmpty(outcome.documentCountry).toUpperCase();
  return keyedHash('id-document', `${country}:${number}`);
}

// Takes an approved check for the account: the provider joins its list, and
// the name and date of birth on the document become its legal name and date
// of birth ("becomes the legal name", locked from then on).
async function applyApproved(check, outcome) {
  const { data: account, error } = await database()
    .from(TABLES.accounts)
    .select('id, id_verified_providers')
    .eq('id', check.account_id)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!account) {
    return;
  }
  let providers = [];
  if (Array.isArray(account.id_verified_providers)) {
    providers = account.id_verified_providers.filter((name) => isProvider(name));
  }
  if (!providers.includes(check.provider)) {
    providers.push(check.provider);
  }
  const changes = {
    id_verified_providers: ID_PROVIDERS.filter((name) => providers.includes(name)),
    id_verified_at: new Date().toISOString(),
  };
  if (outcome.name) {
    changes.legal_name = outcome.name;
  }
  if (outcome.birth) {
    changes.date_of_birth = outcome.birth;
  }
  const { error: saveError } = await database().from(TABLES.accounts).update(changes).eq('id', account.id);
  if (saveError) {
    throw saveError;
  }
}

// Reads a check's result from its provider and stores it; an approved one
// is applied to the account once. Returns the check as it now is. A check
// already final is returned as it is, unread.
export async function refreshCheck(check) {
  if (FINAL_STATUSES.includes(check.status) || check.provider_session_id.startsWith('pending-')) {
    return check;
  }
  const provider = PROVIDERS[check.provider];
  if (!provider || !provider.configured()) {
    return check;
  }
  let outcome;
  try {
    outcome = await provider.result(check.provider_session_id, check.account_id);
  } catch (cause) {
    console.error('[helloevents] id check result:', check.provider, errorDetail(cause));
    return check;
  }
  const now = new Date().toISOString();
  const changes = { status: outcome.status, updated_at: now };
  if (FINAL_STATUSES.includes(outcome.status)) {
    changes.decided_at = now;
  }
  if (outcome.status === 'approved') {
    const identityHash = identityHashOf(outcome);
    if (identityHash && (await documentUsedElsewhere(identityHash, check.account_id))) {
      changes.status = 'declined';
      changes.failure = 'document_used';
    } else {
      changes.identity_hash = identityHash;
      changes.verified_name = outcome.name;
      changes.verified_birth = outcome.birth;
    }
  }
  // Only the first reader of a decision applies it (the return and the
  // webhook can arrive together).
  const { data, error } = await database()
    .from(TABLES.idChecks)
    .update(changes)
    .eq('id', check.id)
    .in('status', OPEN_STATUSES)
    .select(CHECK_COLUMNS);
  if (error) {
    throw error;
  }
  if (!Array.isArray(data) || data.length === 0) {
    const stored = await checkById(check.id);
    if (stored) {
      return stored;
    }
    return check;
  }
  if (changes.status === 'approved') {
    await applyApproved(check, outcome);
    await audit(null, { action: 'idcheck.approved', actorId: check.account_id, details: { provider: check.provider } });
    await alertIdVerified(check.account_id, check.provider);
  } else if (changes.failure === 'document_used') {
    await audit(null, { action: 'idcheck.document_used', actorId: check.account_id, details: { provider: check.provider } });
  }
  return data[0];
}

// What the account page shows of a check: its provider and how it stands.
export function checkView(check) {
  if (!check) {
    return null;
  }
  let failure = null;
  if (check.failure) {
    failure = check.failure;
  }
  return { provider: check.provider, status: check.status, failure };
}

// ---------------------------------------------------------------------------
// Events' side
// ---------------------------------------------------------------------------

// The ways an event accepts an ID check (events.id_check_providers): the
// outside providers and helloid. Empty when it requires none.
export function eventIdProviders(row) {
  if (!row || !Array.isArray(row.id_check_providers)) {
    return [];
  }
  return ID_CHECK_PROVIDERS.filter((name) => row.id_check_providers.includes(name));
}

// Where someone stands with an event's ID check: { state, via }.
//   verified  passed with a way the event accepts (via: which)
//   pending   their HelloID check waits for the admins, and the event
//             accepts HelloID
//   none      neither
// verified: the account's id_verified_providers; pending: its
// helloid_pending.
export function idStanding(row, verified, pending = false) {
  const accepted = eventIdProviders(row);
  let passed = [];
  if (Array.isArray(verified)) {
    passed = verified;
  }
  const via = accepted.find((name) => passed.includes(name));
  if (via) {
    return { state: 'verified', via };
  }
  if (accepted.includes('helloid') && pending === true) {
    return { state: 'pending', via: 'helloid' };
  }
  return { state: 'none', via: null };
}

// Whether someone may RSVP as far as an event's ID check goes: it requires
// none, they passed, or their HelloID check is waiting (they may RSVP
// meanwhile).
export function idCheckPassed(row, verified, pending = false) {
  if (eventIdProviders(row).length === 0) {
    return true;
  }
  return idStanding(row, verified, pending).state !== 'none';
}
