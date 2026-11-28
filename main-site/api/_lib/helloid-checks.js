// HelloID checks as stored (migrations/027, gftvevents_helloid_checks): one
// row per try, once per account. The checks themselves are in helloid.js,
// which loads the face models; this file is the light part the pages and
// /manage need.
//
// status: pending (waiting for GFTV's admins), approved (by the checks or
// an admin) or declined (by an admin, with a reason, or by the checks when
// the document already verified another account; they can try again).
// The photos are kept only while it is pending. An approved check keeps
// its face template (encrypted), document hash and device hash, so the same
// person cannot verify a second account.

import { database, TABLES } from './supabase.js';
import { deletePaymentFiles } from './payments.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { alertIdVerified } from './admin-chats.js';

const COLUMNS =
  'id, account_id, status, decided_auto, reviewed_by, id_photo_path, selfie_path, findings, verified_name, verified_birth, ' +
  'identity_hash, device_hash, decline_reason, failure, submitted_at, decided_at';

function rowsOf(data) {
  if (Array.isArray(data)) {
    return data;
  }
  return [];
}

export async function helloidById(checkId) {
  const { data, error } = await database().from(TABLES.helloidChecks).select(COLUMNS).eq('id', checkId).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// The account's latest try, or null.
export async function latestHelloid(accountId) {
  const { data, error } = await database()
    .from(TABLES.helloidChecks)
    .select(COLUMNS)
    .eq('account_id', accountId)
    .order('submitted_at', { ascending: false })
    .limit(1);
  if (error) {
    throw error;
  }
  const rows = rowsOf(data);
  if (rows.length === 0) {
    return null;
  }
  return rows[0];
}

// What the person sees of their latest try: its status, and why it was
// declined. null when they have none.
export function helloidView(check) {
  if (!check) {
    return null;
  }
  let reason = null;
  if (check.status === 'declined' && check.decline_reason) {
    reason = check.decline_reason;
  }
  let failure = null;
  if (check.failure) {
    failure = check.failure;
  }
  return { status: check.status, reason, failure };
}

// The face templates of the other accounts HelloID approved, decrypted:
// [{ accountId, template, model }]. model: the face model that made it
// (helloid.js FACE_MODELS); a template kept as a bare list was FaceRes's.
export async function otherTemplates(accountId) {
  const { data, error } = await database()
    .from(TABLES.helloidChecks)
    .select('account_id, face_template')
    .eq('status', 'approved')
    .neq('account_id', accountId)
    .limit(20000);
  if (error) {
    throw error;
  }
  const templates = [];
  for (const row of rowsOf(data)) {
    if (!row.face_template) {
      continue;
    }
    const plain = decryptSecret(row.face_template);
    if (!plain) {
      continue;
    }
    const opened = openTemplate(plain);
    if (opened) {
      templates.push({ accountId: row.account_id, ...opened });
    }
  }
  return templates;
}

// A face template, rounded, with the model that made it, encrypted; null
// when there is none (no single face on the first frame).
export function sealTemplate(template, model = 'faceres') {
  if (!Array.isArray(template)) {
    return null;
  }
  return encryptSecret(JSON.stringify({ model, values: template.map((value) => Math.round(value * 10000) / 10000) }));
}

// A decrypted template: { template, model }, or null when it is neither
// shape.
export function openTemplate(plain) {
  let parsed;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    return { template: parsed, model: 'faceres' };
  }
  if (parsed && typeof parsed.model === 'string' && Array.isArray(parsed.values)) {
    return { template: parsed.values, model: parsed.model };
  }
  return null;
}

// Whether a document already verified another account, with HelloID or an
// outside provider (id-checks.js keeps the same keyed hash).
export async function documentUsedElsewhere(identityHash, accountId) {
  if (!identityHash) {
    return false;
  }
  for (const table of [TABLES.helloidChecks, TABLES.idChecks]) {
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
    if (rowsOf(data).length > 0) {
      return true;
    }
  }
  return false;
}

// The other accounts a device verified with HelloID.
export async function deviceSeenElsewhere(deviceHash, accountId) {
  if (!deviceHash) {
    return false;
  }
  const { data, error } = await database()
    .from(TABLES.helloidChecks)
    .select('account_id')
    .eq('device_hash', deviceHash)
    .eq('status', 'approved')
    .neq('account_id', accountId)
    .limit(1);
  if (error) {
    throw error;
  }
  return rowsOf(data).length > 0;
}

async function setPending(accountId, pending) {
  const { error } = await database().from(TABLES.accounts).update({ helloid_pending: pending }).eq('id', accountId);
  if (error) {
    throw error;
  }
}

// An approved check on the account: HelloID joins its ways, and the name
// and date of birth it was for become its legal name and date of birth.
async function applyApproval(check) {
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
  let ways = [];
  if (Array.isArray(account.id_verified_providers)) {
    ways = account.id_verified_providers.filter((name) => name !== 'helloid');
  }
  const changes = {
    id_verified_providers: [...ways, 'helloid'],
    id_verified_at: new Date().toISOString(),
    helloid_pending: false,
  };
  if (check.verified_name) {
    changes.legal_name = check.verified_name;
  }
  if (check.verified_birth) {
    changes.date_of_birth = check.verified_birth;
  }
  const { error: saveError } = await database().from(TABLES.accounts).update(changes).eq('id', account.id);
  if (saveError) {
    throw saveError;
  }
  // Approved by the checks at once or by an admin's review: the admins hear
  // either way.
  await alertIdVerified(account.id, 'helloid');
}

// Stores a new try. Any try of this account still pending is dropped, with
// its photos. fields: the row's columns (status, findings, ...). An
// approved try is applied to the account at once.
export async function saveHelloid(accountId, fields) {
  const { data: waiting, error: waitingError } = await database()
    .from(TABLES.helloidChecks)
    .select('id, id_photo_path, selfie_path')
    .eq('account_id', accountId)
    .eq('status', 'pending');
  if (waitingError) {
    throw waitingError;
  }
  for (const old of rowsOf(waiting)) {
    await database().from(TABLES.helloidChecks).delete().eq('id', old.id);
    await deletePaymentFiles([old.id_photo_path, old.selfie_path]);
  }
  const row = { account_id: accountId, ...fields };
  if (row.status !== 'pending') {
    row.decided_at = new Date().toISOString();
  }
  const { data, error } = await database().from(TABLES.helloidChecks).insert(row).select(COLUMNS).single();
  if (error) {
    throw error;
  }
  if (data.status === 'approved') {
    await applyApproval(data);
  } else {
    await setPending(accountId, data.status === 'pending');
  }
  return data;
}

// An admin's decision on a pending try; its photos go either way, and a
// declined one's face template too. Returns the try as it now is, or null
// when it was not pending (decided meanwhile).
export async function decideHelloid(check, { approved, reviewerId, reason }) {
  const changes = {
    status: 'declined',
    reviewed_by: reviewerId,
    decided_at: new Date().toISOString(),
    id_photo_path: null,
    selfie_path: null,
    decline_reason: reason,
    face_template: null,
  };
  if (approved) {
    changes.status = 'approved';
    changes.decline_reason = null;
    delete changes.face_template;
  }
  const { data, error } = await database()
    .from(TABLES.helloidChecks)
    .update(changes)
    .eq('id', check.id)
    .eq('status', 'pending')
    .select(COLUMNS);
  if (error) {
    throw error;
  }
  await deletePaymentFiles([check.id_photo_path, check.selfie_path]);
  const rows = rowsOf(data);
  if (rows.length === 0) {
    return null;
  }
  if (approved) {
    await applyApproval(rows[0]);
  } else {
    await setPending(check.account_id, false);
  }
  return rows[0];
}

// The tries waiting for the admins, oldest first, with whose they are.
export async function pendingHelloids() {
  const { data, error } = await database()
    .from(TABLES.helloidChecks)
    .select(`${COLUMNS}, account:${TABLES.accounts}!account_id ( kind, username, display_name, legal_name, date_of_birth, country, staff:${TABLES.users} ( username, display_name ) )`)
    .eq('status', 'pending')
    .order('submitted_at', { ascending: true })
    .limit(200);
  if (error) {
    throw error;
  }
  return rowsOf(data);
}

// The photos of an account's tries, for deleting with the account.
export async function helloidPhotoPaths(accountId) {
  const { data, error } = await database().from(TABLES.helloidChecks).select('id_photo_path, selfie_path').eq('account_id', accountId);
  if (error) {
    throw error;
  }
  return rowsOf(data)
    .flatMap((row) => [row.id_photo_path, row.selfie_path])
    .filter((value) => typeof value === 'string');
}
