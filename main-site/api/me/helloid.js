// HelloID, this site's own free ID check (migrations/027, helloid.js), for
// the signed-in person, from /helloid (js/pages/helloid.js).
//
// GET                -> { helloid }  where they stand, and the country to
//                       start the document list on (the connection's)
// GET ?challenge=1   -> { challenge }  the turns and flashes to do, signed
// POST { action: "read", country, type, front, back? } -> { read, zone }
//        reads the ID's machine-readable zone before the challenge, so the
//        page can show the name and date of birth to confirm: read is
//        { name, birth } or null (none found). zone: "clear" (found, every
//        check digit right, its number certain), "unclear" (found, but not
//        all of that) or "none" (not found, or the document has none); the
//        page asks for a clearer photo when it is not clear
// POST { action: "submit", consent: true, country, type, front, back?,
//        name?, birth?, challenge, faceHistory?, neutral, turns, flashes,
//        device }
//        -> { helloid, user }, or { retry: { reason, tries, of, history } }
//        the whole check. name and birth: the legal name and date of birth
//        it is for, as confirmed or typed; only for an account without them
//        (an account's own are locked and used as they are).
//        When the face part does not pass (one face, the turns, the
//        flashes, the same person), or it did but the face did not match
//        the ID photo (glasses or headwear, most often; asked once), and fewer than
//        MAX_FACE_TRIES goes were made, nothing is kept and retry says why
//        ("face", "turns", "flashes" or "match"), for the page to have them
//        do the face part again. history: the earlier goes' reasons,
//        signed, which the page sends back as faceHistory; a missing,
//        changed or old one counts as no earlier goes, as starting over
//        would. The last go is decided as always, and keeps how many goes
//        it took (findings.faceTries) for the admins.
//
// helloid: { verified, pending, latest: null or { status, reason, failure },
// country, personal: { legalName, dateOfBirth } }.

import { route, guard, readJson, ok, fail, query } from '../_lib/http.js';
import { limited, audit } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { loadAccount, ensureStaffAccount } from '../_lib/users.js';
import { selfView } from '../_lib/serialize.js';
import { countryCode } from '../_lib/countries.js';
import { identityHashOf } from '../_lib/id-checks.js';
import { keyedHash, safeEqual } from '../_lib/crypto.js';
import { latestHelloid, helloidView, otherTemplates, sealTemplate, documentUsedElsewhere, deviceSeenElsewhere, saveHelloid } from '../_lib/helloid-checks.js';
import { storeHelloidPicture } from '../_lib/payments.js';
import { database, TABLES } from '../_lib/supabase.js';
import { documentOf } from '../../js/helloid-documents.js';
import { personName, birthDate } from '../../js/registration-fields.js';

// Everything a submission carries (photos and frames), with room to spare
// under Vercel's 4.5 MB request limit.
const MAX_SUBMISSION_BYTES = 4_400_000;

// Goes at the face part before a check that does not pass it goes to the
// admins. Asking again keeps nothing that starting over would not.
export const MAX_FACE_TRIES = 3;
const FACE_PART = ['live', 'samePerson', 'turns', 'flashes'];

// How long a record of earlier goes holds: a person redoing the face part.
const HISTORY_SECONDS = 1800;
const RETRY_REASONS = ['face', 'turns', 'flashes', 'match'];

// The earlier goes' reasons, signed for this account: "<payload>.<signature>".
export function signHistory(accountId, reasons, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ a: accountId, r: reasons, t: now })).toString('base64url');
  return `${payload}.${keyedHash('helloid-face-history', payload).slice(0, 22)}`;
}

// The reasons in a record from signHistory, or [] when there is none, or it
// is another account's, changed, or old.
export function readHistory(token, accountId, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 600) {
    return [];
  }
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, keyedHash('helloid-face-history', payload).slice(0, 22))) {
    return [];
  }
  let record;
  try {
    record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return [];
  }
  if (!record || record.a !== accountId || !Array.isArray(record.r) || typeof record.t !== 'number') {
    return [];
  }
  if (now - record.t > HISTORY_SECONDS * 1000 || record.t > now + 60_000) {
    return [];
  }
  return record.r.filter((reason) => RETRY_REASONS.includes(reason)).slice(0, MAX_FACE_TRIES);
}

// Why the face part did not pass, for the page's advice: "face" (not one
// face, or not the same person throughout: stay in view), "turns" (turn
// further), "flashes" (more screen brightness).
function retryReason(failed) {
  if (failed.includes('live') || failed.includes('samePerson')) {
    return 'face';
  }
  if (failed.includes('turns')) {
    return 'turns';
  }
  return 'flashes';
}

// The checks themselves load the face models, so only when needed.
function checks() {
  return import('../_lib/helloid.js');
}

function textOf(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function connectionCountry(request) {
  return countryCode(textOf(request.headers['x-vercel-ip-country']));
}

async function standing(user, request) {
  let country = connectionCountry(request);
  if (!country && user.country) {
    country = user.country;
  }
  if (!country) {
    country = 'SG';
  }
  return {
    verified: user.idVerified.includes('helloid'),
    pending: user.helloidPending === true,
    latest: helloidView(await latestHelloid(user.id)),
    country,
    personal: { legalName: user.personal.legalName, dateOfBirth: user.personal.dateOfBirth },
  };
}

// The document picked, when the country issues it.
function pickedDocument(body) {
  const country = countryCode(textOf(body.country));
  if (!country) {
    return null;
  }
  const document = documentOf(country, textOf(body.type));
  if (!document) {
    return null;
  }
  return { ...document, country };
}

// The legal name and date of birth a check is for: the account's own when
// set (locked), else what was confirmed or typed. -> { ok, legalName,
// dateOfBirth } or { ok: false, error }.
function personalFor(user, body) {
  let legalName = user.personal.legalName;
  let dateOfBirth = user.personal.dateOfBirth;
  if (!legalName) {
    const name = personName(body.name);
    if (!name.ok || !name.value) {
      return { ok: false, error: 'legal_name_invalid' };
    }
    legalName = name.value;
  }
  if (!dateOfBirth) {
    const date = birthDate(body.birth);
    if (!date.ok || !date.value) {
      return { ok: false, error: 'date_of_birth_invalid' };
    }
    dateOfBirth = date.value;
  }
  return { ok: true, legalName, dateOfBirth };
}

async function readDocument(response, body) {
  const document = pickedDocument(body);
  if (!document) {
    return fail(response, 400, 'helloid_document_invalid');
  }
  const { readDocumentPictures, readMrz } = await checks();
  const pictures = readDocumentPictures(body, document);
  if (!pictures.ok) {
    return fail(response, 400, 'helloid_pictures_invalid');
  }
  let side = null;
  if (document.mrz === 'front') {
    side = pictures.front;
  } else if (document.mrz === 'back') {
    side = pictures.back;
  }
  let read = null;
  let zone = 'none';
  if (side) {
    try {
      const mrz = await readMrz(side);
      if (mrz.found) {
        zone = 'unclear';
        if ([mrz.birthChecked, mrz.expiryChecked, mrz.documentChecked].every(Boolean)) {
          zone = 'clear';
        }
      }
      if (mrz.found && mrz.birthChecked) {
        read = { name: titleCase(mrz.name), birth: mrz.birth };
      }
    } catch (cause) {
      console.error('[helloevents] helloid read:', String(cause));
    }
  }
  return ok(response, { read, zone });
}

// "ANNA MARIA ERIKSSON" as "Anna Maria Eriksson".
function titleCase(text) {
  return String(text)
    .toLowerCase()
    .replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toUpperCase())
    .trim();
}

async function submit(request, response, user, body) {
  if (user.idVerified.includes('helloid')) {
    return fail(response, 409, 'helloid_already');
  }
  if (body.consent !== true) {
    return fail(response, 400, 'helloid_consent_required');
  }
  const document = pickedDocument(body);
  if (!document) {
    return fail(response, 400, 'helloid_document_invalid');
  }
  const personal = personalFor(user, body);
  if (!personal.ok) {
    return fail(response, 400, personal.error);
  }
  const helloid = await checks();
  const challenge = helloid.readChallenge(body.challenge, 'account', user.id);
  if (!challenge) {
    return fail(response, 400, 'helloid_challenge_expired');
  }
  const submission = helloid.readSubmission(body, document);
  if (!submission.ok) {
    return fail(response, 400, submission.error);
  }
  if (user.kind === 'staff') {
    await ensureStaffAccount(user.id);
  }

  const result = await helloid.analyse(submission, challenge, personal, document);
  const findings = result.findings;
  findings.document = { country: document.country, type: document.type };
  const device = helloid.analyseDevice(body.device, request, document.country);
  findings.device = device.findings;
  const flags = [...device.flags];

  // One person, one account: the document, the face, the device.
  const identityHash = identityHashOf({ documentNumber: result.documentNumber, documentCountry: result.documentCountry });
  let documentUsed = false;
  if (identityHash) {
    documentUsed = await documentUsedElsewhere(identityHash, user.id);
  }
  let closest = { accountId: null, score: 0 };
  for (const other of await otherTemplates(user.id)) {
    // Templates from another face model are on another scale.
    if (other.model !== result.faceModel) {
      continue;
    }
    const score = helloid.templateSimilarity(result.template, other.template);
    if (score > closest.score) {
      closest = { accountId: other.accountId, score };
    }
  }
  if (closest.score >= helloid.SAME_FACE) {
    flags.push('face_seen_elsewhere');
    findings.faceSeenElsewhere = { account: await usernameOf(closest.accountId), score: Math.round(closest.score * 100) / 100 };
  }
  if (await deviceSeenElsewhere(device.hash, user.id)) {
    flags.push('device_seen_elsewhere');
  }
  findings.flags = flags;

  // The face part did not pass, or the face did not match the ID photo:
  // once more, with advice, before the admins. A weak match is asked about
  // once (headwear and glasses off), and not when the ID photo shows no
  // face at all.
  const history = readHistory(body.faceHistory, user.id);
  const goes = history.length + 1;
  let failed = FACE_PART.filter((check) => findings.checks[check] === false);
  let reason = null;
  if (failed.length > 0) {
    reason = retryReason(failed);
  } else if (findings.checks.faceMatch === false && !findings.notes.includes('id_no_face') && !history.includes('match')) {
    failed = ['faceMatch'];
    reason = 'match';
  }
  if (!documentUsed && reason !== null && goes < MAX_FACE_TRIES) {
    await audit(request, { action: 'helloid.face_retry', actorId: user.id, details: { failed, try: goes } });
    return ok(response, { retry: { reason, tries: goes, of: MAX_FACE_TRIES, history: signHistory(user.id, [...history, reason]) } });
  }
  findings.faceTries = { count: goes, earlier: history };

  const fields = {
    findings,
    verified_name: personal.legalName,
    verified_birth: personal.dateOfBirth,
    identity_hash: identityHash,
    device_hash: device.hash,
    face_template: sealTemplate(result.template, result.faceModel),
  };
  if (documentUsed) {
    fields.status = 'declined';
    fields.failure = 'document_used';
    fields.decided_auto = true;
    fields.face_template = null;
  } else if (result.approve && flags.length === 0) {
    fields.status = 'approved';
    fields.decided_auto = true;
  } else {
    fields.status = 'pending';
    const pictures = await helloid.storedPictures(submission);
    fields.id_photo_path = await storeHelloidPicture(user.id, pictures.idPhoto);
    fields.selfie_path = await storeHelloidPicture(user.id, pictures.selfie);
  }
  const saved = await saveHelloid(user.id, fields);
  await audit(request, { action: `helloid.${saved.status}`, actorId: user.id, details: { country: document.country, type: document.type, auto: saved.decided_auto === true } });

  const fresh = await loadAccount(user.id);
  let shown = user;
  if (fresh) {
    shown = fresh;
  }
  return ok(response, { helloid: await standing(shown, request), user: selfView(shown) });
}

async function usernameOf(accountId) {
  const { data, error } = await database()
    .from(TABLES.accounts)
    .select(`kind, username, staff:${TABLES.users} ( username )`)
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  if (data.kind === 'staff') {
    if (data.staff) {
      return data.staff.username;
    }
    return null;
  }
  return data.username;
}

export default route('me/helloid', async (request, response) => {
  if (guard(request, response, ['GET', 'POST'])) {
    return;
  }
  const session = await requireUser(request, response);
  if (!session) {
    return;
  }
  const user = session.user;
  if (request.method === 'GET') {
    if (query(request, 'challenge') === '1') {
      if (await limited(request, response, 'idCheckRead', [`u:${user.id}`])) {
        return;
      }
      const { issueChallenge } = await checks();
      return ok(response, { challenge: issueChallenge('account', user.id) });
    }
    return ok(response, { helloid: await standing(user, request) });
  }
  const body = await readJson(request, response, { maxBytes: MAX_SUBMISSION_BYTES });
  if (!body) {
    return;
  }
  if (body.action === 'read') {
    if (await limited(request, response, 'idCheckRead', [`u:${user.id}`])) {
      return;
    }
    return readDocument(response, body);
  }
  if (body.action === 'submit') {
    if (await limited(request, response, 'idCheck', [`u:${user.id}`])) {
      return;
    }
    return submit(request, response, user, body);
  }
  return fail(response, 400, 'bad_request');
});
