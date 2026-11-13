// Event queries. Public reads always go through releasedFilter, so a draft
// or an event whose release time has not come never leaves the database for
// a public request; the serializers then pick the fields each caller may see.

import { database, TABLES } from './supabase.js';
import { releasedFilter, isSlug } from './event-rules.js';

// The feed needs no description, address, online link, price note or staff
// notes, so it does not even fetch them.
export const CARD_COLUMNS =
  'id, slug, title, kind, summary, status, publish_at, starts_at, ends_at, timezone, dates_hidden, ' +
  'is_online, venue_name, city, country, cover_image_path, price_type, price_min, price_max, currency, ' +
  'price_hidden, capacity, rsvp_open, gftvevents_attendees(count)';

export const DETAIL_COLUMNS =
  `${CARD_COLUMNS}, price_note, description, venue_address, address_attendees_only, online_url, organiser_name, external_url`;

// The edit form's columns (serialize.js managedEvent). No stored timestamps:
// the form shows none, and nothing here reads them.
export const MANAGE_COLUMNS = `${DETAIL_COLUMNS}, staff_notes`;

export const FEED_PAGE = 24;

// One page of the public feed.
// when: "upcoming" (not over yet, soonest first), "past" (most recent first),
// "tba" (dates not announced yet). kind: a KINDS value or "" for all.
export async function releasedFeed({ when = 'upcoming', kind = '', offset = 0 } = {}) {
  const now = new Date().toISOString();
  let query = releasedFilter(database().from(TABLES.events).select(CARD_COLUMNS), now);
  if (kind) {
    query = query.eq('kind', kind);
  }
  if (when === 'tba') {
    // A table check makes starts_at required unless dates_hidden is set, so
    // this one filter covers every event without announced dates. (One .or()
    // per query: releasedFilter already uses it.)
    query = query.eq('dates_hidden', true).order('created_at', { ascending: false });
  } else {
    query = query.eq('dates_hidden', false);
    if (when === 'past') {
      query = query.lt('last_at', now).order('last_at', { ascending: false });
    } else {
      query = query.gte('last_at', now).order('starts_at', { ascending: true });
    }
  }
  const { data, error } = await query.range(offset, offset + FEED_PAGE - 1);
  if (error) {
    throw error;
  }
  if (data === null || data === undefined) {
    return [];
  }
  return data;
}

export async function releasedEventBySlug(slug) {
  if (!isSlug(slug)) {
    return null;
  }
  const query = releasedFilter(database().from(TABLES.events).select(DETAIL_COLUMNS).eq('slug', slug));
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// For editors: any event, released or not.
export async function anyEventBySlug(slug, columns = MANAGE_COLUMNS) {
  if (!isSlug(slug)) {
    return null;
  }
  const { data, error } = await database().from(TABLES.events).select(columns).eq('slug', slug).maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

export async function isGoing(eventId, userId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select('event_id')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return Boolean(data);
}
