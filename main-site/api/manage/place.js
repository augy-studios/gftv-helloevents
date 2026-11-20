// POST /api/manage/place { link }   read a Google Maps link for a location
//
// Editors and admins only. link is what the editor pasted into a location on
// the edit form: a Google Maps link, alone or in the text Google Maps shares.
// -> { place: { venueName, venueAddress, city, country, mapsUrl } }, which
// the form fills in for the editor to check (maps-link.js). A link that is
// not Google Maps, or cannot be placed, is answered 422 with its error code.
//
// Nothing is stored: the place is saved with the event, as the editor left
// it.

import { route, guard, readJson, ok, fail } from '../_lib/http.js';
import { limited } from '../_lib/guards.js';
import { requireUser } from '../_lib/session.js';
import { findMapsLink, placeFromMapsLink, MapsLinkError } from '../_lib/maps-link.js';

const MAX_LINK_LENGTH = 2000;

export default route('manage/place', async (request, response) => {
  if (guard(request, response, ['POST'])) {
    return;
  }
  const session = await requireUser(request, response, { manage: true, eventEditor: true });
  if (!session) {
    return;
  }
  const body = await readJson(request, response);
  if (!body) {
    return;
  }
  if (await limited(request, response, 'placeLookup', [`u:${session.user.id}`])) {
    return;
  }
  let typed = '';
  if (typeof body.link === 'string') {
    typed = body.link.trim();
  }
  if (!typed || typed.length > MAX_LINK_LENGTH) {
    return fail(response, 400, 'bad_request');
  }
  const link = findMapsLink(typed);
  if (!link) {
    return fail(response, 422, 'maps_link_bad');
  }
  try {
    const place = await placeFromMapsLink(link);
    return ok(response, { place });
  } catch (cause) {
    if (cause instanceof MapsLinkError) {
      return fail(response, 422, cause.code);
    }
    throw cause;
  }
});
