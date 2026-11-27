-- 026: Telegram alerts for the admins and an event's organisers.
--
-- The bot tells chats about what is happening: the admins' chats (the
-- ADMIN_CHAT_IDS environment variable, any number of user or group ids)
-- hear about new attendees, payments reported and confirmed, and each new
-- event once it is published. An event's organisers' chats, which an admin
-- sets on the event, hear about its new attendees once each has given
-- everything the event asks for, and its payments once confirmed.
--
-- 1. Events: organiser_chat_ids, the organisers' Telegram chat ids (a user
--    id, or a group's, which starts with "-"), as text, empty by default.
--    admin_told_at: when the admins were told the event was published.
--    admin_notice_due_at: when that is to go, set at each save of a
--    published event the admins have not heard about, so the notice goes
--    once the editor stops saving (the same wait as change notices).
-- 2. Attendees: organisers_told_at, when the organisers were told about
--    this person, once their details were complete.
--
-- Every event already published counts as told, so nothing is announced
-- to the admins the day this runs. Likewise every attendee already going.
--
-- Run after 025. Safe to run twice.

begin;

alter table gftvevents_events add column if not exists organiser_chat_ids text[] not null default '{}';
alter table gftvevents_events add column if not exists admin_told_at timestamptz;
alter table gftvevents_events add column if not exists admin_notice_due_at timestamptz;
alter table gftvevents_attendees add column if not exists organisers_told_at timestamptz;

update gftvevents_events set admin_told_at = now() where status <> 'draft' and admin_told_at is null;
update gftvevents_attendees set organisers_told_at = now() where organisers_told_at is null;

create index if not exists gftvevents_events_admin_notice_due on gftvevents_events (admin_notice_due_at) where admin_notice_due_at is not null;

commit;

-- Rollback:
-- begin;
-- drop index if exists gftvevents_events_admin_notice_due;
-- alter table gftvevents_attendees drop column if exists organisers_told_at;
-- alter table gftvevents_events drop column if exists admin_notice_due_at;
-- alter table gftvevents_events drop column if exists admin_told_at;
-- alter table gftvevents_events drop column if exists organiser_chat_ids;
-- commit;
