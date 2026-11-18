-- 006_batched_change_notices.sql
--
-- GFTV HelloEvents, sixth migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 005, and before deploying the release that autosaves
-- the edit form.
--
-- The edit form on /manage now saves each field the moment the editor leaves
-- it, so one change of when or where an event happens (a new date, then a new
-- start time, then a new venue) arrives as several saves. People going should
-- hear about it once, not once per field.
--
-- The first save that moves a released event keeps how the event was in
-- notice_base, and sets notice_due_at a short wait ahead; each further save
-- pushes the wait on. When it runs out with no newer save, the people going
-- are told once, comparing notice_base with the event as it is then (so a
-- change that is put back tells nobody), and both columns are cleared
-- (api/_lib/notify.js). The hourly cron sends any that were left over.
--
-- This file is never edited after it has been run. Changes go in 007 onwards.

begin;

alter table gftvevents_events
  add column if not exists notice_base jsonb,
  add column if not exists notice_due_at timestamptz;

-- The hourly cron looks for notices that are due.
create index if not exists gftvevents_events_notice_due_idx
  on gftvevents_events (notice_due_at)
  where notice_due_at is not null;

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before autosave):
--
-- begin;
-- drop index if exists gftvevents_events_notice_due_idx;
-- alter table gftvevents_events
--   drop column if exists notice_due_at,
--   drop column if exists notice_base;
-- commit;
