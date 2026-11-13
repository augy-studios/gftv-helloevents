// GET /api/events/feed?when=upcoming|past|tba&kind=furmeet|convention|other&offset=0
//
// The public event feed. No sign-in needed and nothing personal in it, so
// the CDN may cache it for a minute. Released events only, as cards
// (serialize.js publicEventCard).

import { route, guard, ok, query } from '../_lib/http.js';
import { releasedFeed, FEED_PAGE } from '../_lib/events.js';
import { publicEventCard } from '../_lib/serialize.js';
import { KINDS } from '../_lib/event-rules.js';

const WHEN_CHOICES = ['upcoming', 'past', 'tba'];
// The furthest a feed can be paged, so a crafted offset stays cheap.
const MAX_OFFSET = 10_000;

// Reads the filters (anything unknown falls back to the default), and
// answers with one page of cards and where the next page starts, or null
// when this is the last.
export default route('events/feed', async (request, response) => {
  if (guard(request, response, ['GET'])) {
    return;
  }
  const requestedWhen = query(request, 'when');
  let when = 'upcoming';
  if (WHEN_CHOICES.includes(requestedWhen)) {
    when = requestedWhen;
  }
  const requestedKind = query(request, 'kind');
  let kind = '';
  if (KINDS.includes(requestedKind)) {
    kind = requestedKind;
  }
  const requestedOffset = Number.parseInt(query(request, 'offset'), 10);
  let offset = 0;
  if (Number.isFinite(requestedOffset) && requestedOffset >= 0) {
    offset = Math.min(requestedOffset, MAX_OFFSET);
  }

  const rows = await releasedFeed({ when, kind, offset });
  const now = Date.now();
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  // A full page may have more after it; a shorter one is the last.
  let nextOffset = null;
  if (rows.length === FEED_PAGE) {
    nextOffset = offset + FEED_PAGE;
  }
  ok(response, {
    events: rows.map((row) => publicEventCard(row, now)),
    nextOffset,
  });
});
