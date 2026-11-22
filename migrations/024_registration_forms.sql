-- 024: registration forms, personal details on the account, tier closing
-- times and tier upgrades.
--
-- An event's editor can switch on a registration form (any kind of event;
-- setting Kind to Convention switches it on in the edit form): ready-made
-- questions (badge name, NFC website on the con badge, fursuiting, handler
-- names, con badge photo, T-shirt size, accompanying a minor, a donation,
-- the Code of Conduct, and the account's legal name, date of birth and
-- emergency contact), each on or off and required or not, plus up to ten of
-- the editor's own. js/registration-fields.js holds the rules; the API
-- checks every answer. Someone going sees their answers as a "Registration
-- details" card on the event page and can change them, or upgrade their
-- tier, until RSVPs close for the event or their tier closes.
--
-- 1. Events: registration_enabled, and registration_fields, the questions
--    as a list of { id, type, label, hint, required, options, link,
--    fullDate } (label null for a ready-made one). null means it was never
--    set up: the ready-made defaults.
-- 2. Attendees: registration, { question id: answer }, seen only by the
--    person and the event's editors; payment_credit, what they had already
--    paid when they upgraded their tier, so only the difference is owed.
-- 3. Accounts: legal_name, date_of_birth, emergency_name, emergency_phone.
--    The person fills in the legal name, date of birth (and country) once;
--    after that only an admin can change them. Editors see them only for an
--    event whose form asks for them (a date of birth as the age at the
--    event unless the form asks for the full date).
-- 4. Ticket tiers (ticket_tiers, jsonb) gain closes_at, a UTC time after
--    which the tier is not sold, and its holders can no longer change their
--    answers or upgrade. No column is needed for it.
-- 5. Badge photos are kept in the private gftvevents_payments bucket, under
--    reg/<event id>/<account id>/, and deleted with the RSVP.
--
-- Run after 023. Safe to run twice.

begin;

-- 1. Events ---------------------------------------------------------------

alter table gftvevents_events add column if not exists registration_enabled boolean not null default false;
alter table gftvevents_events add column if not exists registration_fields jsonb;

alter table gftvevents_events drop constraint if exists gftvevents_events_registration_fields_check;
alter table gftvevents_events add constraint gftvevents_events_registration_fields_check
  check (registration_fields is null or (jsonb_typeof(registration_fields) = 'array' and jsonb_array_length(registration_fields) <= 30));

-- 2. Attendees ------------------------------------------------------------

alter table gftvevents_attendees add column if not exists registration jsonb not null default '{}'::jsonb;
alter table gftvevents_attendees add column if not exists payment_credit numeric(12, 2);

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_registration_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_registration_check
  check (jsonb_typeof(registration) = 'object' and pg_column_size(registration) <= 20000);
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_credit_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_credit_check
  check (payment_credit is null or payment_credit >= 0);

-- 3. Accounts -------------------------------------------------------------

alter table gftvevents_accounts add column if not exists legal_name text;
alter table gftvevents_accounts add column if not exists date_of_birth date;
alter table gftvevents_accounts add column if not exists emergency_name text;
alter table gftvevents_accounts add column if not exists emergency_phone text;

alter table gftvevents_accounts drop constraint if exists gftvevents_accounts_personal_check;
alter table gftvevents_accounts add constraint gftvevents_accounts_personal_check
  check (
    (legal_name is null or char_length(legal_name) between 1 and 100)
    and (date_of_birth is null or date_of_birth >= date '1900-01-01')
    and (emergency_name is null or char_length(emergency_name) between 1 and 100)
    and (emergency_phone is null or char_length(emergency_phone) between 6 and 30)
  );

commit;

-- Rollback:
-- begin;
-- alter table gftvevents_accounts drop constraint if exists gftvevents_accounts_personal_check,
--   drop column if exists legal_name, drop column if exists date_of_birth,
--   drop column if exists emergency_name, drop column if exists emergency_phone;
-- alter table gftvevents_attendees drop column if exists registration,
--   drop column if exists payment_credit;
-- alter table gftvevents_events drop column if exists registration_enabled,
--   drop column if exists registration_fields;
-- commit;
