-- 004_event_form_locations_times.sql
--
-- GFTV HelloEvents, fourth migration (the event form rework). Run once,
-- whole, in the Supabase SQL editor, after 001, 002 and 003.
--
-- 1. description_lang: the language the description is written in, English
--    or Chinese, picked next to the field on the form. The event page marks
--    the text with it (lang="en" / lang="zh").
-- 2. start_time_tbc, end_time_tbc: the date is known but the time is still
--    to be confirmed. The API stores such a start at 00:00 and such an end at
--    23:59 in the event's time zone, so the event counts as over only once
--    its last day has ended (last_at stays coalesce(ends_at, starts_at)), and
--    the pages show the date alone.
-- 3. locations: every place on the event, in the order the editor gave them:
--    [{ label, custom_label, venue_name, venue_address, city, country,
--    maps_url }], label one of event, meeting, custom. The API checks each
--    entry (api/_lib/event-rules.js); the table only holds the list's shape.
--    venue_name, venue_address, city and country stay, as a copy of the main
--    location (the first labelled "event", or else the first), for the feed
--    cards and the notices, which read only those.
--
-- country is now a two-letter ISO 3166 code ("SG") from the form's list; the
-- pages show the country's name in the reader's language. Values typed before
-- this migration are left as they are and still shown as typed.
--
-- RLS is unchanged: the table is service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 005 onwards.

begin;

alter table gftvevents_events
  add column if not exists description_lang text not null default 'en',
  add column if not exists start_time_tbc boolean not null default false,
  add column if not exists end_time_tbc boolean not null default false,
  add column if not exists locations jsonb not null default '[]'::jsonb;

alter table gftvevents_events drop constraint if exists gftvevents_events_description_lang_check;
alter table gftvevents_events
  add constraint gftvevents_events_description_lang_check check (description_lang in ('en', 'zh'));

alter table gftvevents_events drop constraint if exists gftvevents_events_locations_check;
alter table gftvevents_events
  add constraint gftvevents_events_locations_check
    check (jsonb_typeof(locations) = 'array' and jsonb_array_length(locations) <= 10);

-- An event saved before this migration gets its one place as its first
-- location, so the form shows it and the next save keeps it.
update gftvevents_events
   set locations = jsonb_build_array(jsonb_build_object(
         'label', 'event',
         'custom_label', null,
         'venue_name', venue_name,
         'venue_address', venue_address,
         'city', city,
         'country', country,
         'maps_url', null
       ))
 where locations = '[]'::jsonb
   and (venue_name is not null or venue_address is not null or city is not null or country is not null);

commit;

-- Rollback, if this ever has to be undone (the main location's copy in
-- venue_name, venue_address, city and country is kept):
--
-- begin;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_locations_check,
--   drop constraint if exists gftvevents_events_description_lang_check,
--   drop column if exists locations,
--   drop column if exists end_time_tbc,
--   drop column if exists start_time_tbc,
--   drop column if exists description_lang;
-- commit;
