-- 021: contact details an event asks the people going for.
--
-- An editor can ask the people going for a way to reach them: a phone
-- number, a Telegram username, a Discord username, and fields of their own
-- (each with a label, and typed as a phone number, an email address, a
-- username or any text). A rule says what they must give: at least one of
-- them ('any', the default), every one ('all'), or none ('optional').
-- js/contact-fields.js holds the rules; the API checks every value.
--
-- 1. Events: contact_fields, a list of { id, type, label } (label null for
--    a ready-made field), and contact_rule.
-- 2. Attendees: contact, { field id: value }. Only the event's editors see
--    it, on the attendee list. It goes with the RSVP.
--
-- Run after 020. Safe to run twice.

begin;

-- 1. Events ---------------------------------------------------------------

alter table gftvevents_events add column if not exists contact_fields jsonb not null default '[]'::jsonb;
alter table gftvevents_events add column if not exists contact_rule text not null default 'any';

alter table gftvevents_events drop constraint if exists gftvevents_events_contact_fields_check;
alter table gftvevents_events add constraint gftvevents_events_contact_fields_check
  check (jsonb_typeof(contact_fields) = 'array' and jsonb_array_length(contact_fields) <= 8);
alter table gftvevents_events drop constraint if exists gftvevents_events_contact_rule_check;
alter table gftvevents_events add constraint gftvevents_events_contact_rule_check
  check (contact_rule in ('any', 'all', 'optional'));

-- 2. Attendees ------------------------------------------------------------

alter table gftvevents_attendees add column if not exists contact jsonb not null default '{}'::jsonb;

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_contact_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_contact_check
  check (jsonb_typeof(contact) = 'object' and pg_column_size(contact) <= 4000);

commit;

-- Rollback:
-- begin;
-- alter table gftvevents_attendees drop column if exists contact;
-- alter table gftvevents_events drop column if exists contact_fields,
--   drop column if exists contact_rule;
-- commit;
