// The signed-in person's second factors on this site, and (public accounts)
// deleting the account.
//
// GET                                           -> summary (below)
// POST { action: "totp-start", password }       -> { setup, secret, uri }
// POST { action: "totp-finish", setup, code }   the first code proves it
// POST { action: "totp-remove", password }
// POST { action: "passkey-options", password }  -> { options }
// POST { action: "passkey-finish", response, label? }
// POST { action: "passkey-remove", id, password }
// POST { action: "telegram-link" }              -> { url }
// POST { action: "telegram-unlink", password }
// POST { action: "backup-regenerate", password } -> { codes }
// POST { action: "delete-account", password }   public accounts only
//
// The password is asked for again before anything that adds or removes a way
// in. For staff, removing the last second factor is refused (staff must
// always have one). For public accounts 2FA is optional, so they may.
//
// The authenticator app set up on gftv.asia is shown but not changed here;
// it lives with the shared staff account.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { verifyPassword, encryptSecret, decryptSecret } from '../_lib/crypto.js';
import { limited, audit } from '../_lib/guards.js';
import { database, TABLES } from '../_lib/supabase.js';
import { requireUser, createChallenge, findChallenge, updateChallenge, failChallengeAttempt, deleteChallenge, endSession } from '../_lib/session.js';
import { loadAccount, secondFactorRequired } from '../_lib/users.js';
import { listPasskeys, registrationOptions, finishRegistration, removePasskey } from '../_lib/webauthn.js';
import { methodsFor, hasSecondFactor, issueBackupCodes, localBackupCount, hasLocalTotp, saveEventsTotp, backupCodesForNewFactor } from '../_lib/factors.js';
import { createLinkToken, linkedChat, telegramConfigured } from '../_lib/telegram.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../_lib/totp.js';
import { forgetAllSubscriptions } from '../_lib/push.js';
import { passkeyView } from '../_lib/serialize.js';
import { LIMITS } from '../_lib/event-rules.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What the Security section of the account page shows, and the passkey ids
// its Remove buttons send.
async function summary(userId) {
  const user = await loadAccount(userId, { withSecrets: true });
  const [passkeys, chat, backupLeft, localTotp] = await Promise.all([
    listPasskeys(userId),
    linkedChat(userId),
    localBackupCount(userId),
    hasLocalTotp(userId),
  ]);
  // The handle, so the person can tell which chat it is. Never the chat id.
  let telegramUsername = null;
  if (chat !== null && chat !== undefined && chat.telegram_username) {
    telegramUsername = chat.telegram_username;
  }
  return {
    required: secondFactorRequired(user),
    totp: { shared: Boolean(user.totp_secret), local: localTotp },
    passkeys: passkeys.map(passkeyView),
    telegram: {
      available: telegramConfigured(),
      linked: Boolean(chat),
      username: telegramUsername,
    },
    backupCodesLeft: backupLeft,
  };
}

// Whether the account would still have a second factor without
// factorToRemove.
async function wouldKeepAFactor(user, factorToRemove) {
  const methods = await methodsFor(user);
  if (factorToRemove === 'telegram') {
    methods.telegram = false;
  }
  if (factorToRemove === 'totp') {
    methods.totp = Boolean(user.totp_secret);
  }
  if (factorToRemove === 'passkey') {
    const passkeys = await listPasskeys(user.id);
    methods.passkey = passkeys.length - 1 > 0;
  }
  return hasSecondFactor(methods, user);
}

// Whether a second factor may go: always for a public account (2FA is
// optional), and for staff only while another would be left.
async function mayRemove(user, factor) {
  if (!secondFactorRequired(user)) {
    return true;
  }
  return wouldKeepAFactor(user, factor);
}

// Asks for the password again, under its own rate limit. True when it is
// right; otherwise false or null, after answering 401 or 429, and the step
// stops.
async function passwordConfirmed({ request, response, body, userId, user }) {
  if (await limited(request, response, 'reauth', [`u:${userId}`])) {
    return null;
  }
  const right = await verifyPassword(body.password, user.password_hash);
  if (!right) {
    fail(response, 401, 'password_wrong');
  }
  return right;
}

// The steps below each take one change's context:
// { request, response, body, userId, user }, where user is the account
// loaded with its secrets.

// "totp-start": a new authenticator secret, which waits until the first
// code proves it. -> { setup, secret, uri }
async function startTotp(context) {
  const { response, userId, user } = context;
  if (user.totp_secret || (await hasLocalTotp(userId))) {
    return fail(response, 409, 'totp_exists');
  }
  if (!(await passwordConfirmed(context))) {
    return;
  }
  const secret = generateTotpSecret();
  const setup = await createChallenge({ purpose: 'totp-setup', userId });
  // The pending secret waits, encrypted, on the challenge row.
  const setupChallenge = await findChallenge(setup, 'totp-setup');
  await updateChallenge(setupChallenge, { pending_totp_secret: encryptSecret(secret) });
  const uri = otpauthUri({ account: user.username, secret });
  return ok(response, { setup, secret, uri });
}

// "totp-finish": the first code from the new authenticator saves it, with
// backup codes if the account has none yet.
async function finishTotp({ request, response, body, userId, user }) {
  const challenge = await findChallenge(body.setup, 'totp-setup');
  let secret = null;
  if (challenge && challenge.user_id === userId) {
    secret = decryptSecret(challenge.pending_totp_secret);
  }
  if (!secret) {
    return fail(response, 400, 'setup_not_started');
  }
  if (!verifyTotp(body.code, secret)) {
    await failChallengeAttempt(challenge);
    return fail(response, 401, 'code_wrong');
  }
  await saveEventsTotp(userId, secret);
  await deleteChallenge(challenge);
  const codes = await backupCodesForNewFactor(user);
  await audit(request, { action: 'security.totp_added', actorId: userId });
  const current = await summary(userId);
  return ok(response, { ...current, codes });
}

// "totp-remove": this site's authenticator.
async function removeTotp(context) {
  const { request, response, userId, user } = context;
  if (!(await passwordConfirmed(context))) {
    return;
  }
  if (!(await mayRemove(user, 'totp'))) {
    return fail(response, 409, 'last_factor');
  }
  const { error } = await database().from(TABLES.totp).delete().eq('user_id', userId);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'security.totp_removed', actorId: userId });
  return ok(response, await summary(userId));
}

// "passkey-options": the browser's passkey registration ceremony.
async function passkeyOptions(context) {
  const { response, user } = context;
  if (!(await passwordConfirmed(context))) {
    return;
  }
  const options = await registrationOptions(user);
  return ok(response, { options });
}

// "passkey-finish": saves the new passkey under the name typed (control
// characters stripped), with backup codes if the account has none yet.
async function finishPasskey({ request, response, body, userId, user }) {
  let typedLabel = '';
  if (body.label !== null && body.label !== undefined) {
    typedLabel = body.label;
  }
  const cleanedLabel = String(typedLabel)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, LIMITS.label);
  let label = null;
  if (cleanedLabel) {
    label = cleanedLabel;
  }
  const result = await finishRegistration(userId, body.response, label);
  if (!result.ok) {
    return fail(response, 400, result.error);
  }
  await audit(request, { action: 'security.passkey_added', actorId: userId });
  const codes = await backupCodesForNewFactor(user);
  const current = await summary(userId);
  return ok(response, { ...current, codes });
}

// "passkey-remove": one passkey, by the id its Remove button sends.
async function removeOnePasskey(context) {
  const { request, response, body, userId, user } = context;
  let typedId = '';
  if (body.id !== null && body.id !== undefined) {
    typedId = body.id;
  }
  if (!UUID_PATTERN.test(String(typedId))) {
    return fail(response, 400, 'bad_request');
  }
  if (!(await passwordConfirmed(context))) {
    return;
  }
  if (!(await mayRemove(user, 'passkey'))) {
    return fail(response, 409, 'last_factor');
  }
  await removePasskey(userId, body.id);
  await audit(request, { action: 'security.passkey_removed', actorId: userId });
  return ok(response, await summary(userId));
}

// "telegram-link": a link that opens the bot with a one-time token.
async function linkTelegram({ response, userId }) {
  if (!telegramConfigured()) {
    return fail(response, 400, 'telegram_off');
  }
  // Only the link: the page opens it and shows no expiry.
  const linkToken = await createLinkToken(userId, null);
  return ok(response, { url: linkToken.url });
}

// "telegram-unlink": forgets the linked chat.
async function unlinkTelegram(context) {
  const { request, response, userId, user } = context;
  if (!(await passwordConfirmed(context))) {
    return;
  }
  if (!(await mayRemove(user, 'telegram'))) {
    return fail(response, 409, 'last_factor');
  }
  const { error } = await database().from(TABLES.telegram).delete().eq('user_id', userId);
  if (error) {
    throw error;
  }
  await audit(request, { action: 'security.telegram_unlinked', actorId: userId, details: { via: 'site' } });
  return ok(response, await summary(userId));
}

// "backup-regenerate": ten new backup codes, replacing the old ones, shown once.
async function regenerateBackupCodes(context) {
  const { request, response, userId } = context;
  if (!(await passwordConfirmed(context))) {
    return;
  }
  const codes = await issueBackupCodes(userId);
  await audit(request, { action: 'security.backup_codes_issued', actorId: userId });
  return ok(response, { codes });
}

// "delete-account": a public account deletes itself and is signed out.
async function deleteAccount(context) {
  const { request, response, userId, user } = context;
  if (user.kind !== 'public') {
    return fail(response, 403, 'staff_account');
  }
  if (!(await passwordConfirmed(context))) {
    return;
  }
  // Cascades to sessions, factors, Telegram link and RSVPs; the audit
  // log keeps its rows with the actor set to null.
  await forgetAllSubscriptions(userId);
  const { error } = await database().from(TABLES.accounts).delete().eq('id', userId).eq('kind', 'public');
  if (error) {
    throw error;
  }
  await endSession(request, response);
  return ok(response, { deleted: true });
}

// Each POST action and its step.
const STEPS = new Map([
  ['totp-start', startTotp],
  ['totp-finish', finishTotp],
  ['totp-remove', removeTotp],
  ['passkey-options', passkeyOptions],
  ['passkey-finish', finishPasskey],
  ['passkey-remove', removeOnePasskey],
  ['telegram-link', linkTelegram],
  ['telegram-unlink', unlinkTelegram],
  ['backup-regenerate', regenerateBackupCodes],
  ['delete-account', deleteAccount],
]);

// GET answers with the summary. POST runs one change: every change counts
// against the securityWrite limit, and the account is loaded with its
// secrets before the action is looked up, whatever it is.
export default route('me/security', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const userId = session.user.id;

  if (request.method === 'GET') {
    return ok(response, await summary(userId));
  }

  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'securityWrite', [`u:${userId}`])) {
    return;
  }

  const user = await loadAccount(userId, { withSecrets: true });
  const step = STEPS.get(body.action);
  if (!step) {
    return fail(response, 400, 'bad_request');
  }
  await step({ request, response, body, userId, user });
});
