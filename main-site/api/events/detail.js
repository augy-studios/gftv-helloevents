// GET /api/events/detail?slug=<slug>
//
// One event page. Anyone may read a released event. What they see depends on
// who they are (serialize.js publicEventDetail): the online link and an
// attendees-only address go to people going and to editors. Editors may also
// open an unreleased event, to preview it; everyone else gets 404 for it,
// exactly as for an event that does not exist.
//
// Never cached by the CDN, since the answer differs per person.

import { route, guard, ok, fail, query } from '../_lib/http.js';
import { currentSession } from '../_lib/session.js';
import { canEditEvent } from '../_lib/event-editors.js';
import { releasedEventBySlug, anyEventBySlug, attendance, withMealCounts, withVolunteerSource, volunteerStanding, contactSuggestion, eventAsksContact, DETAIL_COLUMNS } from '../_lib/events.js';
import { publicEventDetail } from '../_lib/serialize.js';
import { attendeeCode } from '../_lib/checkin.js';
import { entryForViewer } from '../_lib/entry-codes.js';
import { withGallery } from '../_lib/gallery.js';
import { withDescriptionPictures } from '../_lib/description-pictures.js';

// The signed-in person's country of origin (migrations/015), or null.
function countryOfSession(session) {
  if (session && session.user.country) {
    return session.user.country;
  }
  return null;
}

// Finds the event (any status for an editor, released ones for everyone
// else) and answers with what this viewer may see of it.
// The ID check providers the signed-in person passed with (migrations/027).
function idVerifiedOfSession(session) {
  if (!session) {
    return [];
  }
  return session.user.idVerified;
}

function helloidPendingOfSession(session) {
  if (!session) {
    return false;
  }
  return session.user.helloidPending;
}

// The organisers' entry QR code for them, while going (migrations/027).
async function entryOf(row, session, mine) {
  if (!session || !mine.going) {
    return null;
  }
  return entryForViewer(row, session.user.id, mine.payment);
}

// Their check-in code for this event, while going (migrations/027).
function checkinCodeOf(row, session, mine) {
  if (!session || !mine.going) {
    return null;
  }
  return attendeeCode(row.id, session.user.id, mine.rsvpNumber);
}

// The signed-in person's personal details (migrations/024), or none.
function personalOfSession(session) {
  if (!session) {
    return null;
  }
  return session.user.personal;
}

export default route('events/detail', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  const session = await currentSession(request);
  // Anyone who edits this event (staff editors and admins, or an editor of
  // this one, migrations/018) sees it released or not, as a preview.
  let row = await releasedEventBySlug(slug);
  let isManager = false;
  if (session) {
    let any = row;
    if (!any) {
      any = await anyEventBySlug(slug, DETAIL_COLUMNS);
    }
    if (any && (await canEditEvent(session.user, any.id))) {
      isManager = true;
      row = any;
    }
  }
  if (!row) {
    return fail(response, 404, 'not_found');
  }

  await withMealCounts(row);
  await withVolunteerSource(row);
  await withGallery(row);
  await withDescriptionPictures(row);
  let mine = { going: false, meals: [], volunteer: false, fursuiter: false, rsvpNumber: null, payment: null, lepak: false, contact: {}, registration: {}, checkedInAt: null };
  let standing = { volunteered: false, discount: false };
  let contactSuggest = {};
  if (session) {
    mine = await attendance(row.id, session.user.id);
    standing = await volunteerStanding(row, session.user.id);
    if (!mine.going && eventAsksContact(row)) {
      contactSuggest = await contactSuggestion(session.user.id);
    }
  }
  const event = publicEventDetail(row, {
    signedIn: Boolean(session),
    going: mine.going,
    meals: mine.meals,
    lepak: mine.lepak,
    rsvpNumber: mine.rsvpNumber,
    canManage: isManager,
    volunteer: mine.volunteer,
    fursuiter: mine.fursuiter,
    volunteered: standing.volunteered,
    discount: standing.discount,
    country: countryOfSession(session),
    payment: mine.payment,
    contact: mine.contact,
    contactSuggest,
    registration: mine.registration,
    personal: personalOfSession(session),
    idVerified: idVerifiedOfSession(session),
    helloidPending: helloidPendingOfSession(session),
    checkinCode: checkinCodeOf(row, session, mine),
    checkedInAt: mine.checkedInAt,
    entry: await entryOf(row, session, mine),
  });
  // Only an editor ever sees an unreleased event, and is told so: a draft,
  // or one whose release time is still to come.
  let preview = false;
  if (isManager) {
    if (row.status === 'draft') {
      preview = true;
    } else if (row.publish_at && new Date(row.publish_at) > new Date()) {
      preview = true;
    }
  }
  ok(response, { event, preview });
});
