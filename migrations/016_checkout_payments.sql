-- 016: checkout and payment methods.
--
-- An editor picks how people pay for a paid event, any one or more of:
--   onsite  pay on the day: a plain RSVP, no payment page;
--   link    a payment link the editor pastes (opened from the checkout page);
--   qr      a QR code picture the editor uploads, of any shape.
-- With link or qr on, the event page sends someone to /checkout to get a
-- ticket: one ticket, for themselves, for the whole event (a tier, when the
-- event sells tiers). Choosing link or qr reserves their place at once (it
-- takes one of the event's spaces, with no expiry) and asks for a payment
-- reference and, if they like, a screenshot of the payment. An editor checks
-- it and ticks Paid on the attendee list. People coming just for a meal pay
-- nothing here: meals have no price.
--
-- 1. Events: the methods, the link, the QR code's Storage path and the
--    instructions shown with them.
-- 2. Attendees: what each person chose and where their payment stands.
--    payment_status:
--      none       nothing to pay online (a free event, a meal, or onsite)
--      awaiting   place reserved, payment not reported yet
--      submitted  reported paid (reference, maybe a screenshot), to check
--      paid       an editor confirmed it
--    The amount, currency and tier are copied at checkout, so a later price
--    change does not change what someone was asked to pay.
-- 3. A private Storage bucket, gftvevents_payments, for the QR codes
--    ("qr/<event id>/<name>.png") and the screenshots
--    ("proof/<event id>/<account id>/<name>.webp"). Not public: the API
--    serves QR codes to signed-in people and screenshots to editors only.
--
-- Run after 015. Safe to run twice.

begin;

-- 1. Events --------------------------------------------------------------

alter table gftvevents_events add column if not exists payment_methods text[] not null default '{}';
alter table gftvevents_events add column if not exists payment_link text;
alter table gftvevents_events add column if not exists payment_qr_path text;
alter table gftvevents_events add column if not exists payment_instructions text;

alter table gftvevents_events drop constraint if exists gftvevents_events_payment_methods_check;
alter table gftvevents_events add constraint gftvevents_events_payment_methods_check
  check (payment_methods <@ array['onsite', 'link', 'qr']::text[]);
alter table gftvevents_events drop constraint if exists gftvevents_events_payment_link_check;
alter table gftvevents_events add constraint gftvevents_events_payment_link_check
  check (payment_link is null or (payment_link like 'https://%' and char_length(payment_link) <= 500));
alter table gftvevents_events drop constraint if exists gftvevents_events_payment_instructions_check;
alter table gftvevents_events add constraint gftvevents_events_payment_instructions_check
  check (payment_instructions is null or char_length(payment_instructions) <= 1000);

-- 2. Attendees -------------------------------------------------------------

alter table gftvevents_attendees add column if not exists payment_method text;
alter table gftvevents_attendees add column if not exists payment_status text not null default 'none';
alter table gftvevents_attendees add column if not exists payment_tier text;
alter table gftvevents_attendees add column if not exists payment_amount numeric(12, 2);
alter table gftvevents_attendees add column if not exists payment_currency text;
alter table gftvevents_attendees add column if not exists payment_reference text;
alter table gftvevents_attendees add column if not exists payment_proof_path text;
alter table gftvevents_attendees add column if not exists payment_submitted_at timestamptz;
alter table gftvevents_attendees add column if not exists paid_at timestamptz;
alter table gftvevents_attendees add column if not exists paid_by uuid references gftvevents_accounts (id) on delete set null;

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_method_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_method_check
  check (payment_method is null or payment_method in ('onsite', 'link', 'qr'));
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_status_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_status_check
  check (payment_status in ('none', 'awaiting', 'submitted', 'paid'));
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_reference_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_reference_check
  check (payment_reference is null or char_length(payment_reference) <= 120);
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_amount_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_amount_check
  check (payment_amount is null or payment_amount >= 0);

-- 3. The private bucket ------------------------------------------------------
-- No storage policies, as for the covers: only the API (service role key)
-- reads or writes. PNG for QR codes (kept lossless, so they still scan),
-- WebP for screenshots; 2 MB, a second line behind the API's own checks.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gftvevents_payments', 'gftvevents_payments', false, 2097152, array['image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;

-- Rollback (empty the gftvevents_payments bucket first in the Storage
-- dashboard):
--
-- begin;
-- delete from storage.buckets where id = 'gftvevents_payments';
-- alter table gftvevents_attendees
--   drop column if exists payment_method, drop column if exists payment_status,
--   drop column if exists payment_tier, drop column if exists payment_amount,
--   drop column if exists payment_currency, drop column if exists payment_reference,
--   drop column if exists payment_proof_path, drop column if exists payment_submitted_at,
--   drop column if exists paid_at, drop column if exists paid_by;
-- alter table gftvevents_events
--   drop column if exists payment_methods, drop column if exists payment_link,
--   drop column if exists payment_qr_path, drop column if exists payment_instructions;
-- commit;
