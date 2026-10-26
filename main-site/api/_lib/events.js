// Event queries. Public reads always go through releasedFilter, so a draft
// or an event whose release time has not come never leaves the database for
// a public request; the serializers then pick the fields each caller may see.

import { db, T } from './supabase.js';
import { releasedFilter, isSlug } from './event-rules.js';

// The feed needs no description, address, online link or staff notes, so it
// does not even fetch them.
export const CARD_COLUMNS =
  'id, slug, title, kind, summary, status, publish_at, starts_at, ends_at, timezone, dates_hidden, ' +
  'is_online, venue_name, city, country, cover_image_url, price_type, price_min, price_max, currency, ' +
  'price_note, price_hidden, capacity, rsvp_open, gftvevents_attendees(count)';

export const DETAIL_COLUMNS =
  `${CARD_COLUMNS}, description, venue_address, address_attendees_only, online_url, organiser_name, external_url`;

export const MANAGE_COLUMNS = `${DETAIL_COLUMNS}, staff_notes, created_at, updated_at`;

export const FEED_PAGE = 24;

// when: "upcoming" (not over yet, soonest first), "past" (most recent first),
// "tba" (dates not announced yet). kind: a KINDS value or "" for all.
export async function releasedFeed({ when = 'upcoming', kind = '', offset = 0 } = {}) {
  const now = new Date().toISOString();
  let q = releasedFilter(db().from(T.events).select(CARD_COLUMNS), now);
  if (kind) q = q.eq('kind', kind);
  if (when === 'tba') {
    // A table check makes starts_at required unless dates_hidden is set, so
    // this one filter covers every event without announced dates. (One .or()
    // per query: releasedFilter already uses it.)
    q = q.eq('dates_hidden', true).order('created_at', { ascending: false });
  } else {
    q = q.eq('dates_hidden', false);
    q = when === 'past'
      ? q.lt('last_at', now).order('last_at', { ascending: false })
      : q.gte('last_at', now).order('starts_at', { ascending: true });
  }
  const { data, error } = await q.range(offset, offset + FEED_PAGE - 1);
  if (error) throw error;
  return data ?? [];
}

export async function releasedEventBySlug(slug) {
  if (!isSlug(slug)) return null;
  const q = releasedFilter(db().from(T.events).select(DETAIL_COLUMNS).eq('slug', slug));
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data;
}

// For editors: any event, released or not.
export async function anyEventBySlug(slug, columns = MANAGE_COLUMNS) {
  if (!isSlug(slug)) return null;
  const { data, error } = await db().from(T.events).select(columns).eq('slug', slug).maybeSingle();
  if (error) throw error;
  return data;
}

export async function isGoing(eventId, userId) {
  const { data, error } = await db()
    .from(T.attendees)
    .select('event_id')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
