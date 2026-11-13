// GET /api/events/feed?when=upcoming|past|tba&kind=furmeet|convention|other&offset=0
//
// The public event feed. No sign-in needed and nothing personal in it, so
// the CDN may cache it for a minute. Released events only, as cards
// (serialize.js publicEventCard).

import { route, guard, ok, query } from '../_lib/http.js';
import { releasedFeed, FEED_PAGE } from '../_lib/events.js';
import { publicEventCard } from '../_lib/serialize.js';
import { KINDS } from '../_lib/event-rules.js';

const WHEN = ['upcoming', 'past', 'tba'];

export default route('events/feed', async (request, response) => {
  if (guard(request, response, ['GET'])) return;
  const when = WHEN.includes(query(request, 'when')) ? query(request, 'when') : 'upcoming';
  const kind = KINDS.includes(query(request, 'kind')) ? query(request, 'kind') : '';
  const n = Number.parseInt(query(request, 'offset'), 10);
  const offset = Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000) : 0;

  const rows = await releasedFeed({ when, kind, offset });
  const now = Date.now();
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  ok(response, {
    events: rows.map((row) => publicEventCard(row, now)),
    nextOffset: rows.length === FEED_PAGE ? offset + FEED_PAGE : null,
  });
});
