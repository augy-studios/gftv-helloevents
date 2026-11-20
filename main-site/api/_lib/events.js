// Event queries. Public reads always go through releasedFilter, so a draft
// or an event whose release time has not come never leaves the database for
// a public request; the serializers then pick the fields each caller may see.

import { database, TABLES } from './supabase.js';
import { releasedFilter, isSlug, storedMeals, volunteerDiscountActive, lepakOffered, searchGroups } from './event-rules.js';

// "going" on cards and pages counts the people coming to the whole event,
// who take its spaces (gftvevents_full_attendees, migrations/009); people
// coming only for a meal are counted per meal on the event page.
//
// The feed needs no description, address, online link, price note or staff
// notes, so it does not even fetch them.
export const CARD_COLUMNS =
  'id, slug, title, kind, summary, status, publish_at, starts_at, ends_at, start_time_tbc, end_time_tbc, timezone, dates_hidden, ' +
  'is_online, venue_name, city, country, cover_image_path, price_type, price_min, price_max, currency, ' +
  'price_hidden, capacity, rsvp_open, gftvevents_full_attendees(count)';

export const DETAIL_COLUMNS =
  `${CARD_COLUMNS}, price_note, description, description_zh, venue_address, locations, address_attendees_only, online_url, ` +
  'organiser_name, external_url, meal_options, tiers_enabled, ticket_tiers, ' +
  'volunteers_wanted, volunteer_discount_enabled, volunteer_discount_from, volunteer_discount_type, volunteer_discount_value, ' +
  'timetable_view, timetable_rooms, timetable_items, external_url_label, external_url_custom_label, cross_border, ' +
  'payment_methods, payment_link, payment_qr_path, payment_instructions, lepak_enabled, lepak_limit, lepak_label';

// The edit form's columns (serialize.js managedEvent). No stored timestamps:
// the form shows none, and nothing here reads them.
export const MANAGE_COLUMNS = `${DETAIL_COLUMNS}, staff_notes`;

export const FEED_PAGE = 24;

// One page of the public feed.
// when: "upcoming" (not over yet, soonest first), "past" (most recent first),
// "tba" (dates not announced yet). kind: a KINDS value or "" for all.
// words: a search's words (event-rules.js searchWords), each to be found in
// the title, summary, venue, city, country or organiser; [] for no search.
export async function releasedFeed({ when = 'upcoming', kind = '', offset = 0, words = [] } = {}) {
  const now = new Date().toISOString();
  let query = releasedFilter(database().from(TABLES.events).select(CARD_COLUMNS), now, searchGroups(words));
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

// Adds to an event row how many people are coming for each of its meals
// (row.meal_taken: { lunch: 3 }) and how many are lepak (row.lepak_taken,
// migrations/017), for the places left the event page shows. Nothing is
// asked for an event with no meals, or that takes no lepak RSVPs.
export async function withMealCounts(row) {
  if (!row) {
    return row;
  }
  row.meal_taken = {};
  row.lepak_taken = 0;
  if (lepakOffered(row)) {
    const { count, error } = await database()
      .from(TABLES.attendees)
      .select('user_id', { count: 'exact', head: true })
      .eq('event_id', row.id)
      .eq('lepak', true);
    if (error) {
      throw error;
    }
    if (Number.isInteger(count)) {
      row.lepak_taken = count;
    }
  }
  if (storedMeals(row).length === 0) {
    return row;
  }
  const { data, error } = await database().rpc('gftvevents_meal_counts', { p_event_id: row.id });
  if (error) {
    throw error;
  }
  let counts = [];
  if (Array.isArray(data)) {
    counts = data;
  }
  for (const count of counts) {
    row.meal_taken[count.meal] = Number(count.taken);
  }
  return row;
}

// The attendee columns that say where someone's payment stands
// (migrations/016), read by attendance and the attendee list.
export const PAYMENT_COLUMNS =
  'payment_method, payment_status, payment_tier, payment_amount, payment_currency, payment_reference, payment_proof_path, payment_submitted_at, paid_at';

// Whether someone is going, the meals they are coming for (empty for the
// whole event, migrations/007), whether they signed up to volunteer
// (migrations/012), their RSVP ID for this event (migrations/013) and their
// payment (migrations/016, the stored row's payment columns, or null when
// not going): { going, meals, volunteer, rsvpNumber, payment }.
export async function attendance(eventId, userId) {
  const { data, error } = await database()
    .from(TABLES.attendees)
    .select(`meals, volunteer, rsvp_number, lepak, ${PAYMENT_COLUMNS}`)
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return { going: false, meals: [], volunteer: false, rsvpNumber: null, payment: null, lepak: false };
  }
  let meals = [];
  if (Array.isArray(data.meals)) {
    meals = data.meals;
  }
  let rsvpNumber = null;
  if (Number.isInteger(data.rsvp_number)) {
    rsvpNumber = data.rsvp_number;
  }
  return { going: true, meals, volunteer: data.volunteer === true, rsvpNumber, payment: data, lepak: data.lepak === true };
}

// Adds to an event row the earlier convention whose volunteers get its
// volunteer benefit (row.volunteer_source: { id, slug, title, status,
// publish_at }, or null), for the event page to name. Nothing is asked
// while the benefit is not in effect.
export async function withVolunteerSource(row) {
  if (!row) {
    return row;
  }
  row.volunteer_source = null;
  if (!volunteerDiscountActive(row)) {
    return row;
  }
  const { data, error } = await database()
    .from(TABLES.events)
    .select('id, slug, title, status, publish_at')
    .eq('id', row.volunteer_discount_from)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (data !== null && data !== undefined) {
    row.volunteer_source = data;
  }
  return row;
}

// The confirmed volunteers (migrations/012) among userIds at one event, as
// a Set of their ids. eventId null or no one asked about: an empty Set.
// The event's volunteers are read whole and matched here, since there are
// far fewer of them than attendees, and a filter naming every attendee
// would make a very long request.
export async function confirmedVolunteers(eventId, userIds) {
  if (!eventId || userIds.length === 0) {
    return new Set();
  }
  const { data, error } = await database()
    .from(TABLES.volunteers)
    .select('user_id')
    .eq('event_id', eventId)
    .limit(5000);
  if (error) {
    throw error;
  }
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  }
  const wanted = new Set(userIds);
  return new Set(rows.map((each) => each.user_id).filter((id) => wanted.has(id)));
}

// One person's volunteering as it touches this event: whether an editor
// confirmed they volunteered at it, and whether they volunteered at the
// earlier convention its benefit is for (so they get it):
// { volunteered, discount }. row: the event, after withVolunteerSource.
export async function volunteerStanding(row, userId) {
  const ids = [row.id];
  if (row.volunteer_source) {
    ids.push(row.volunteer_source.id);
  }
  const { data, error } = await database()
    .from(TABLES.volunteers)
    .select('event_id')
    .eq('user_id', userId)
    .in('event_id', ids);
  if (error) {
    throw error;
  }
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  }
  const at = new Set(rows.map((each) => each.event_id));
  let discount = false;
  if (row.volunteer_source && at.has(row.volunteer_source.id)) {
    discount = true;
  }
  return { volunteered: at.has(row.id), discount };
}
