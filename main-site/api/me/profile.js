// POST /api/me/profile { displayName?, country?, legalName?, dateOfBirth?,
//                        emergencyName?, emergencyPhone? }  change the profile:
//   displayName  a public account's display name. Staff names come from
//                gftv.asia and are changed there. The same rules as sign-up:
//                up to 60 characters, and no listed word (name-filter.js).
//   country      the country of origin (migrations/015), a two-letter code
//                from the pages' country list. Any account, staff included;
//                a cross-border event needs one to RSVP. Since
//                migrations/024 it is set once, like the legal name.
//   legalName, dateOfBirth  (migrations/024) the person's legal name and
//                date of birth ('YYYY-MM-DD'), which an event's registration
//                form can ask for. Like the country, each is filled in once:
//                after that only an admin can change it (/manage, staff
//                tools), so nobody swaps who they are between events.
//   emergencyName, emergencyPhone  an emergency contact, changed at any time
//                (blank takes it away).
// -> { user }

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { database, TABLES } from '../_lib/supabase.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount, ensureStaffAccount } from '../_lib/users.js';
import { cleanDisplayName } from '../_lib/account-rules.js';
import { countryCode } from '../_lib/countries.js';
import { refusedName } from '../_lib/name-filter.js';
import { personName, birthDate, emergencyPhone } from '../../js/registration-fields.js';
import { selfView } from '../_lib/serialize.js';

// The new display name, checked like sign-up does: { ok: true, value } or
// { ok: false, response sent }.
async function checkedDisplayName(response, user, typed) {
  if (user.kind !== 'public') {
    fail(response, 403, 'staff_account');
    return { ok: false };
  }
  const displayName = cleanDisplayName(typed);
  // The 60 is counted in Unicode code points, not UTF-16 units.
  if (displayName.length < 1 || [...displayName].length > 60) {
    fail(response, 400, 'display_name_invalid');
    return { ok: false };
  }
  if (await refusedName(displayName)) {
    fail(response, 400, 'display_name_reserved');
    return { ok: false };
  }
  return { ok: true, value: displayName };
}

// Checks what was sent, saves it, and answers with the account as the page
// shows it.
export default route('me/profile', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const user = session.user;
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'securityWrite', [`u:${user.id}`])) {
    return;
  }
  const personalKeys = ['legalName', 'dateOfBirth', 'emergencyName', 'emergencyPhone'];
  if (body.displayName === undefined && body.country === undefined && personalKeys.every((key) => body[key] === undefined)) {
    return fail(response, 400, 'bad_request');
  }

  const changes = {};
  if (body.displayName !== undefined) {
    const name = await checkedDisplayName(response, user, body.displayName);
    if (!name.ok) {
      return;
    }
    changes.display_name = name.value;
  }
  if (body.country !== undefined) {
    const country = countryCode(body.country);
    if (!country) {
      return fail(response, 400, 'country_required');
    }
    // Set once (migrations/024); sending the same one again is fine.
    if (user.country && user.country !== country) {
      return fail(response, 409, 'personal_locked', { field: 'country' });
    }
    changes.country = country;
  }
  let personal = {};
  if (user.personal) {
    personal = user.personal;
  }
  if (body.legalName !== undefined) {
    const name = personName(body.legalName);
    if (!name.ok || name.value === '') {
      return fail(response, 400, 'legal_name_invalid');
    }
    if (personal.legalName && personal.legalName !== name.value) {
      return fail(response, 409, 'personal_locked', { field: 'legalName' });
    }
    changes.legal_name = name.value;
  }
  if (body.dateOfBirth !== undefined) {
    const date = birthDate(body.dateOfBirth);
    if (!date.ok || date.value === '') {
      return fail(response, 400, 'date_of_birth_invalid');
    }
    if (personal.dateOfBirth && personal.dateOfBirth !== date.value) {
      return fail(response, 409, 'personal_locked', { field: 'dateOfBirth' });
    }
    changes.date_of_birth = date.value;
  }
  if (body.emergencyName !== undefined) {
    const name = personName(body.emergencyName);
    if (!name.ok) {
      return fail(response, 400, 'emergency_name_invalid');
    }
    changes.emergency_name = null;
    if (name.value) {
      changes.emergency_name = name.value;
    }
  }
  if (body.emergencyPhone !== undefined) {
    const phone = emergencyPhone(body.emergencyPhone);
    if (!phone.ok) {
      return fail(response, 400, 'emergency_phone_invalid');
    }
    changes.emergency_phone = null;
    if (phone.value) {
      changes.emergency_phone = phone.value;
    }
  }

  // A staff member's accounts row may not exist yet; it is made first.
  if (user.kind === 'staff') {
    await ensureStaffAccount(user.id);
  }
  const { error } = await database()
    .from(TABLES.accounts)
    .update(changes)
    .eq('id', user.id)
    .eq('kind', user.kind);
  if (error) {
    throw error;
  }
  if (changes.display_name) {
    await audit(request, { action: 'account.display_name_changed', actorId: user.id });
  }
  if (changes.country && changes.country !== user.country) {
    await audit(request, { action: 'account.country_changed', actorId: user.id, details: { country: changes.country } });
  }
  // Which details changed, never what they are.
  const personalChanged = ['legal_name', 'date_of_birth', 'emergency_name', 'emergency_phone'].filter((column) => column in changes);
  if (personalChanged.length > 0) {
    await audit(request, { action: 'account.personal_changed', actorId: user.id, details: { fields: personalChanged } });
  }
  const account = await loadAccount(user.id);
  ok(response, { user: selfView(account) });
});
