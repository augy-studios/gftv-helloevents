-- 023: asking the people going whether they are fursuiters.
--
-- An editor can tick "Ask people going whether they are fursuiters" on
-- any event. People going then see "I'm a fursuiter" on the event page
-- and at checkout, and can tick it or untick it until the event is over.
-- The editors see who ticked it on the attendee list, with a count, so they
-- can plan changing rooms, handlers and water.
--
-- 1. Events: fursuiters_asked, off by default. While it is off, nobody is
--    asked and the attendee list shows nothing; what people ticked is kept,
--    so ticking it again brings it back.
-- 2. Attendees: fursuiter, whether this person said they are one.
--
-- Run after 022. Safe to run twice.

begin;

alter table gftvevents_events add column if not exists fursuiters_asked boolean not null default false;
alter table gftvevents_attendees add column if not exists fursuiter boolean not null default false;

commit;

-- Rollback:
-- begin;
-- alter table gftvevents_attendees drop column if exists fursuiter;
-- alter table gftvevents_events drop column if exists fursuiters_asked;
-- commit;
