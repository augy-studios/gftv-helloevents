// The staff tools on /manage beside the events (help desk #7, round 4).
//
// GET -> { allowances, here, filters?, builtIn?, flagged? }
//
// Editors and admins:
//   POST { action: "allowance-grant", hours, perHour, label? }
//        "Venue mode": raise the sign-up limit for the connection this staff
//        member is on right now (its salted IP hash, never the address), for
//        1 to 12 hours, to 20 to 500 sign-ups an hour. For a con or meet
//        where everyone shares the venue's Wi-Fi. Nothing to hand out: the
//        allowance belongs to the connection, and ends by itself.
//   POST { action: "allowance-revoke", id }
//
// Admins only:
//   POST { action: "filter-add", term }      a word public names may not use
//   POST { action: "filter-remove", id }
//   POST { action: "reset-issue", username } a one-time password reset code
//        for a public account, shown once, valid 24 hours, for someone with
//        neither Telegram nor 2FA whose identity was checked another way.
//        Making a new one cancels the last. -> { code, expiresAt }
//
// Every write is in the audit log. Answers carry no IP hash, email or id of
// a person; flagged names are a username and a display name.

import { route, guard, readJson, ok, fail, clientIp } from '../_lib/http.js';
import { db, T } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { isAdmin } from '../_lib/users.js';
import { hashIp, randomBytesCode, sha256 } from '../_lib/crypto.js';
import { fold, blockedTerm, customTerms, forgetNameFilters, BUILT_IN_TERMS } from '../_lib/name-filter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESET_HOURS = 24;

async function allowances(req) {
  const here = hashIp(clientIp(req));
  const { data, error } = await db()
    .from(T.signupAllowances)
    .select(`id, ip_hash, max_per_hour, label, expires_at, created_at, by:${T.accounts} ( kind, username, staff:${T.users} ( username ) )`)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    perHour: row.max_per_hour,
    label: row.label || null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    by: row.by?.kind === 'staff' ? row.by?.staff?.username ?? null : row.by?.username ?? null,
    // Whether it is for the connection the viewer is on, not which one.
    here: row.ip_hash === here,
  }));
}

async function filters() {
  const { data, error } = await db().from(T.nameFilters).select('id, term, created_at').order('term', { ascending: true }).limit(2000);
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, term: r.term, createdAt: r.created_at }));
}

// Public accounts whose username or display name now matches a listed word:
// names chosen before the word was listed are left as they are, and shown
// here so an admin can follow up.
async function flagged() {
  const custom = await customTerms();
  const { data, error } = await db()
    .from(T.accounts)
    .select('username, display_name, created_at')
    .eq('kind', 'public')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  const out = [];
  for (const row of data ?? []) {
    const term = blockedTerm(row.display_name, custom) || blockedTerm(row.username, custom);
    if (term) out.push({ username: row.username, displayName: row.display_name, term });
    if (out.length >= 200) break;
  }
  return out;
}

export default route('manage/admin', async (req, res) => {
  if (guard(req, res, ['GET', 'POST'])) return;
  const session = await requireUser(req, res, { manage: true });
  if (!session) return;
  const user = session.user;
  const admin = isAdmin(user);

  if (req.method === 'GET') {
    const list = await allowances(req);
    return ok(res, {
      allowances: list,
      here: list.some((a) => a.here),
      ...(admin ? { filters: await filters(), builtIn: BUILT_IN_TERMS, flagged: await flagged() } : {}),
    });
  }

  const body = await readJson(req, res);
  if (!body) return;
  if (await limited(req, res, 'manageWrite', [`u:${user.id}`])) return;

  if (body.action === 'allowance-grant') {
    const hours = Number(body.hours);
    const perHour = Number(body.perHour);
    if (!Number.isInteger(hours) || hours < 1 || hours > 12) return fail(res, 400, 'invalid_field', { field: 'hours' });
    if (!Number.isInteger(perHour) || perHour < 20 || perHour > 500) return fail(res, 400, 'invalid_field', { field: 'perHour' });
    const label = String(body.label ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || null;
    const { data, error } = await db()
      .from(T.signupAllowances)
      .insert({ ip_hash: hashIp(clientIp(req)), max_per_hour: perHour, label, created_by: user.id, expires_at: new Date(Date.now() + hours * 3600_000).toISOString() })
      .select('id')
      .single();
    if (error) throw error;
    await audit(req, { action: 'admin.signup_allowance_granted', actorId: user.id, details: { id: data.id, hours, perHour, label } });
    return ok(res, { allowances: await allowances(req), here: true });
  }

  if (body.action === 'allowance-revoke') {
    if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');
    const { error } = await db().from(T.signupAllowances).update({ revoked_at: new Date().toISOString() }).eq('id', body.id).is('revoked_at', null);
    if (error) throw error;
    await audit(req, { action: 'admin.signup_allowance_revoked', actorId: user.id, details: { id: body.id } });
    const list = await allowances(req);
    return ok(res, { allowances: list, here: list.some((a) => a.here) });
  }

  if (!admin) return fail(res, 403, 'admin_only');

  if (body.action === 'filter-add') {
    const term = fold(String(body.term ?? '').slice(0, 80));
    if (term.length < 3 || term.length > 40) return fail(res, 400, 'filter_invalid');
    const { error } = await db().from(T.nameFilters).insert({ term, created_by: user.id });
    if (error && error.code !== '23505') throw error;
    forgetNameFilters();
    await audit(req, { action: 'admin.name_filter_added', actorId: user.id, details: { term } });
    return ok(res, { filters: await filters(), flagged: await flagged() });
  }

  if (body.action === 'filter-remove') {
    if (!UUID.test(String(body.id ?? ''))) return fail(res, 400, 'bad_request');
    const { data, error } = await db().from(T.nameFilters).delete().eq('id', body.id).select('term');
    if (error) throw error;
    forgetNameFilters();
    await audit(req, { action: 'admin.name_filter_removed', actorId: user.id, details: { term: data?.[0]?.term ?? null } });
    return ok(res, { filters: await filters(), flagged: await flagged() });
  }

  if (body.action === 'reset-issue') {
    const username = String(body.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return fail(res, 400, 'bad_request');
    const { data: account, error } = await db().from(T.accounts).select('id, status').eq('kind', 'public').eq('username', username).maybeSingle();
    if (error) throw error;
    if (!account) return fail(res, 404, 'account_not_found');
    // One live code per account: a new one cancels the last.
    await db().from(T.passwordResets).delete().eq('account_id', account.id).is('used_at', null);
    const code = randomBytesCode();
    const expiresAt = new Date(Date.now() + RESET_HOURS * 3600_000).toISOString();
    const { error: saveError } = await db()
      .from(T.passwordResets)
      .insert({ account_id: account.id, code_hash: sha256(code.replace(/-/g, '')), created_by: user.id, expires_at: expiresAt });
    if (saveError) throw saveError;
    await audit(req, { action: 'admin.password_reset_issued', actorId: user.id, details: { username } });
    return ok(res, { code, expiresAt });
  }

  fail(res, 400, 'bad_request');
});
