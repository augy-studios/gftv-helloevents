-- 011_reminder_times.sql
--
-- GFTV HelloEvents, eleventh migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 010, and before deploying the release with reminder
-- times.
--
-- Reminders used to come once, a day before an event someone is going to.
-- Now each account picks when, as many as it likes: 1, 2 or 3 hours before,
-- a day before, a week before (the account page's Notifications tab).
--
-- 1. gftvevents_accounts.reminder_hours: the times picked, as hours before
--    the start: some of 1, 2, 3, 24 and 168. Empty means no reminders.
--    Accounts start with a day before, as before; an account that had
--    reminders switched off starts with none. notify_reminders stays, kept
--    by the API as "any picked", for anything still reading it.
-- 2. gftvevents_attendees.reminders_sent: the times (hours) already dealt
--    with for this RSVP, so each goes at most once. The cron
--    (api/_lib/notify.js sendReminders) marks a time before sending it. An
--    RSVP whose day-before reminder already went (reminded_at, from 002)
--    starts with 24. reminded_at is no longer written.
--
-- RLS is unchanged: both tables are service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 012 onwards.

begin;

alter table gftvevents_accounts
  add column if not exists reminder_hours smallint[] not null default '{24}';

alter table gftvevents_accounts drop constraint if exists gftvevents_accounts_reminder_hours_check;
alter table gftvevents_accounts
  add constraint gftvevents_accounts_reminder_hours_check
    check (reminder_hours <@ '{1,2,3,24,168}'::smallint[] and cardinality(reminder_hours) <= 5);

update gftvevents_accounts set reminder_hours = '{}' where notify_reminders = false;

alter table gftvevents_attendees
  add column if not exists reminders_sent smallint[] not null default '{}';

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_reminders_sent_check;
alter table gftvevents_attendees
  add constraint gftvevents_attendees_reminders_sent_check
    check (reminders_sent <@ '{1,2,3,24,168}'::smallint[]);

update gftvevents_attendees set reminders_sent = '{24}' where reminded_at is not null and reminders_sent = '{}';

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before reminder times; day-before reminders then follow reminded_at again):
--
-- begin;
-- alter table gftvevents_attendees
--   drop constraint if exists gftvevents_attendees_reminders_sent_check,
--   drop column if exists reminders_sent;
-- alter table gftvevents_accounts
--   drop constraint if exists gftvevents_accounts_reminder_hours_check,
--   drop column if exists reminder_hours;
-- commit;
