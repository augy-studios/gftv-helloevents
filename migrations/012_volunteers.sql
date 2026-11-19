-- 012_volunteers.sql
--
-- GFTV HelloEvents, twelfth migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 011, and before deploying the release with
-- volunteers.
--
-- A convention can take volunteers. Someone going ticks "I'd like to
-- volunteer" on the event page; after (or during) the convention an editor
-- ticks "Volunteered" next to the ones who really did, in the attendee list
-- on /manage. Only those confirmed count. A later convention can then give
-- the people who volunteered at one earlier convention a benefit: a
-- percentage or a fixed amount off. For now the event page only tells them
-- they have it; applying it (discount codes) comes later.
--
-- 1. gftvevents_events:
--    volunteers_wanted          the event takes volunteer sign-ups. Only a
--                               convention does (the API sets it false for
--                               any other kind).
--    volunteer_discount_enabled the benefit is on. Like tiers_enabled, the
--                               settings below are kept while it is off.
--    volunteer_discount_from    the earlier convention whose confirmed
--                               volunteers get it. Emptied if that event is
--                               deleted. Never the event itself.
--    volunteer_discount_type    'percent' or 'amount' (in the event's
--                               currency).
--    volunteer_discount_value   how much: up to 100 for a percentage.
--    The benefit is in effect only for a convention with it on, a source
--    picked and a value above 0 (api/_lib/event-rules.js
--    volunteerDiscountActive).
-- 2. gftvevents_attendees.volunteer: this person signed up to volunteer.
--    Kept if the editor stops taking volunteers, but no longer shown.
-- 3. gftvevents_volunteers: who an editor confirmed really volunteered at a
--    convention, and who confirmed it. Its own table, not a column on the
--    attendee row, so it stays if the person later takes back their RSVP to
--    an event that is over: they still volunteered. An editor removing
--    someone from the attendee list removes it too.
--
-- RLS: on, no policies, service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 013 onwards.

begin;

alter table gftvevents_events
  add column if not exists volunteers_wanted boolean not null default false,
  add column if not exists volunteer_discount_enabled boolean not null default false,
  add column if not exists volunteer_discount_from uuid references gftvevents_events (id) on delete set null,
  add column if not exists volunteer_discount_type text not null default 'percent',
  add column if not exists volunteer_discount_value numeric(10, 2);

alter table gftvevents_events drop constraint if exists gftvevents_events_volunteer_discount_check;
alter table gftvevents_events
  add constraint gftvevents_events_volunteer_discount_check check (
    volunteer_discount_type in ('percent', 'amount')
    and (volunteer_discount_value is null or volunteer_discount_value >= 0)
    and (volunteer_discount_type <> 'percent' or volunteer_discount_value is null or volunteer_discount_value <= 100)
    and (volunteer_discount_from is null or volunteer_discount_from <> id)
  );

alter table gftvevents_attendees
  add column if not exists volunteer boolean not null default false;

create table if not exists gftvevents_volunteers (
  event_id      uuid not null references gftvevents_events (id) on delete cascade,
  user_id       uuid not null references gftvevents_accounts (id) on delete cascade,
  confirmed_by  uuid references gftvevents_accounts (id) on delete set null,
  confirmed_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists gftvevents_volunteers_user_idx on gftvevents_volunteers (user_id);

alter table gftvevents_volunteers enable row level security;
revoke all on gftvevents_volunteers from anon, authenticated;

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before volunteers; who volunteered where is lost):
--
-- begin;
-- drop table if exists gftvevents_volunteers;
-- alter table gftvevents_attendees drop column if exists volunteer;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_volunteer_discount_check,
--   drop column if exists volunteer_discount_value,
--   drop column if exists volunteer_discount_type,
--   drop column if exists volunteer_discount_from,
--   drop column if exists volunteer_discount_enabled,
--   drop column if exists volunteers_wanted;
-- commit;
