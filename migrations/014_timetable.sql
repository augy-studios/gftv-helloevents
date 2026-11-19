-- 014_timetable.sql
--
-- GFTV HelloEvents, fourteenth migration. Run once, whole, in the Supabase
-- SQL editor, after 001 to 013, and before deploying the release with
-- timetables.
--
-- Any event (a furmeet or a convention) can carry a timetable: what happens
-- when, and where. The editor fills it in under the edit form's Timetable
-- tab, and the event page shows it to everyone who can see the event,
-- except while the dates are to be announced (it would give them away).
--
-- 1. timetable_view: how the event page shows it, as the editor picked:
--    'timeline' (a list in time order, day by day) or 'grid' (a table with
--    a column per room and a row per half hour, like a con's printed
--    schedule). There is no switch on the page.
-- 2. timetable_rooms: the grid's columns, in order: [{ id, name, tag }].
--    id is "r-" and a few letters and digits, made by the edit form when the
--    room is added and kept from then on, so the items in a room stay with
--    it when it is renamed. tag is a short label such as "Level G" (or
--    null).
-- 3. timetable_items: what happens: [{ title, date, start, end, room,
--    note }]. date ("2026-12-11"), start and end ("14:30") are wall-clock
--    times in the event's own time zone, like the edit form shows them, so
--    the timetable stays put if the time zone is changed. end is null when
--    there is none; an end earlier than the start is the next day (a dance
--    night from 21:00 to 01:00). room is one of the rooms' ids, or null.
--    The API checks each entry (api/_lib/event-rules.js readTimetable) and
--    keeps them in time order; the table only holds the lists' shape.
--
-- A change to the timetable of a released event tells the people going, once
-- for a run of autosaves, like a change of time or place (migrations/006):
-- notify.js keeps these columns in notice_base too. No new column is needed
-- for that.
--
-- RLS is unchanged: the table is service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 015 onwards.

begin;

alter table gftvevents_events
  add column if not exists timetable_view text not null default 'timeline',
  add column if not exists timetable_rooms jsonb not null default '[]'::jsonb,
  add column if not exists timetable_items jsonb not null default '[]'::jsonb;

alter table gftvevents_events drop constraint if exists gftvevents_events_timetable_check;
alter table gftvevents_events
  add constraint gftvevents_events_timetable_check check (
    timetable_view in ('timeline', 'grid')
    and jsonb_typeof(timetable_rooms) = 'array' and jsonb_array_length(timetable_rooms) <= 20
    and jsonb_typeof(timetable_items) = 'array' and jsonb_array_length(timetable_items) <= 300
  );

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before timetables):
--
-- begin;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_timetable_check,
--   drop column if exists timetable_items,
--   drop column if exists timetable_rooms,
--   drop column if exists timetable_view;
-- commit;
