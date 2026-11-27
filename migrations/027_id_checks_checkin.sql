-- 027: ID checks, check-in at the door, entry QR codes, and no more venue
-- sign-ups.
--
-- 1. Venue sign-ups go. New accounts are no longer limited per connection
--    (Turnstile and the per-email limit stay), so the allowances staff
--    raised for a venue's Wi-Fi (migrations/003) have nothing left to do:
--    gftvevents_signup_allowances is dropped.
--
-- 2. ID checks. An event can require the people going to pass an ID check,
--    on the editor's ID verification tab: events.id_check_providers, the
--    ways it accepts, empty for none.
--    Every way is done once per account, on the account page, and counts
--    for every event that accepts it; one document (or, for HelloID, one
--    face) verifies one account only.
--    - didit, veriff: outside providers (api/_lib/id-checks.js), paid per
--      check. gftvevents_id_checks holds
--      each check started, with the provider's session id and its status;
--      once approved, the name and date of birth on the document. Never the
--      document's number or a picture: identity_hash, a keyed hash of its
--      country and number, only stops one document checking several
--      accounts (failure 'document_used'). accounts.id_verified_providers:
--      the providers the account passed with; id_verified_at, the latest.
--      An approved check sets the account's legal name (and date of birth),
--      which stay locked (migrations/024).
--    - helloid: HelloID, this site's own, free check (api/_lib/helloid.js),
--      also once per account. The person takes a photo of their ID (a
--      passport's machine-readable zone, when it has one, gives the name
--      and date of birth, which they confirm), then follows a challenge on
--      camera (turn left, right, up and down; the screen flashes colours).
--      The server checks the document, that the face is live and matches
--      the ID, the device and connection, and that neither the document
--      nor the face already verified another account. All clear: approved
--      at once. Otherwise GFTV's admins decide in /manage, with the photos
--      and findings. gftvevents_helloid_checks: one row per try; the photos
--      (private payments bucket) are deleted once it is decided. An
--      approved check keeps a face template (numbers, not a picture,
--      encrypted) and a keyed hash of the document number, so the same
--      person cannot verify a second account; both go with the account.
--      Someone whose check waits for the admins can RSVP meanwhile.
--    events.id_check_door: the organisers check each person's ID at the
--    door; the check-in page asks for it before checking them in.
--    attendees.id_door_checked_at, id_door_checked_by.
--
-- 3. Check-in. attendees.checked_in_at, checked_in_by (the organiser, or
--    null when they checked themselves in) and checked_in_how ('scan',
--    'manual' or 'self'). events.self_checkin_on: the organisers' beacon,
--    a QR code on the check-in page, changing every 30 seconds, that the
--    people going scan to check themselves in.
--
-- 4. Entry QR codes: the organisers' own (a cinema's tickets, a venue's
--    pass), shown on the event page to the people going.
--    events.entry_qr_mode: 'off', 'shared' (one code for everyone) or
--    'each' (one per person, handed out in RSVP order; organisers can
--    reassign them). entry_qr_audience: 'all' going, or only 'paid' (a
--    confirmed payment). entry_qr_show: 'always', 'before' (from
--    entry_qr_hours before the start) or 'checked_in'.
--    gftvevents_entry_codes: each code's picture (a PNG in the private
--    payments bucket), its place in the list, and who it is handed to.
--
-- RLS on, no policies, service role only, as everywhere else.
-- Run after 026. Safe to run twice.

begin;

drop table if exists gftvevents_signup_allowances;

-- ID checks with an outside provider ----------------------------------------

create table if not exists gftvevents_id_checks (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references gftvevents_accounts (id) on delete cascade,
  provider            text not null check (provider in ('didit', 'veriff')),
  provider_session_id text not null check (char_length(provider_session_id) between 1 and 200),
  status              text not null default 'started'
                      check (status in ('started', 'pending', 'review', 'approved', 'declined', 'failed')),
  verified_name       text check (verified_name is null or char_length(verified_name) between 1 and 100),
  verified_birth      date,
  identity_hash       text,
  -- Why a check that passed at the provider was not taken here.
  failure             text check (failure is null or failure in ('document_used')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  decided_at          timestamptz,
  unique (provider, provider_session_id)
);

create index if not exists gftvevents_id_checks_account on gftvevents_id_checks (account_id, created_at desc);
create index if not exists gftvevents_id_checks_identity on gftvevents_id_checks (identity_hash) where identity_hash is not null and status = 'approved';
alter table gftvevents_id_checks enable row level security;

alter table gftvevents_accounts add column if not exists id_verified_providers text[] not null default '{}';
alter table gftvevents_accounts add column if not exists id_verified_at timestamptz;
-- A HelloID check of this account waits for the admins (it may RSVP to
-- events accepting HelloID meanwhile).
alter table gftvevents_accounts add column if not exists helloid_pending boolean not null default false;

-- HelloID ---------------------------------------------------------------------

create table if not exists gftvevents_helloid_checks (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references gftvevents_accounts (id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  -- Decided by the checks themselves, or by an admin (reviewed_by).
  decided_auto     boolean not null default false,
  reviewed_by      uuid references gftvevents_accounts (id) on delete set null,
  -- Kept only until it is decided.
  id_photo_path    text,
  selfie_path      text,
  -- What the checks found, for the admins: each check's outcome and score,
  -- the passport's name and date of birth, and the device flags.
  findings         jsonb not null default '{}',
  -- The legal name and date of birth it is for (confirmed by the person, or
  -- already on the account), set on the account when approved.
  verified_name    text check (verified_name is null or char_length(verified_name) between 1 and 100),
  verified_birth   date,
  -- Recognising the same person on another account: a keyed hash of the
  -- document's country and number (when read), the face template
  -- (crypto.js encryptSecret), and a keyed hash of the device.
  identity_hash    text,
  face_template    text,
  device_hash      text,
  decline_reason   text check (decline_reason is null or char_length(decline_reason) <= 200),
  -- Why it was declined without an admin: 'document_used'.
  failure          text check (failure is null or failure in ('document_used')),
  submitted_at     timestamptz not null default now(),
  decided_at       timestamptz
);

create index if not exists gftvevents_helloid_checks_account on gftvevents_helloid_checks (account_id, submitted_at desc);
create index if not exists gftvevents_helloid_checks_pending on gftvevents_helloid_checks (submitted_at) where status = 'pending';
create index if not exists gftvevents_helloid_checks_identity on gftvevents_helloid_checks (identity_hash) where identity_hash is not null and status = 'approved';
alter table gftvevents_helloid_checks enable row level security;

-- Events ----------------------------------------------------------------------

alter table gftvevents_events add column if not exists id_check_providers text[] not null default '{}';
alter table gftvevents_events add column if not exists id_check_door boolean not null default false;
alter table gftvevents_events add column if not exists self_checkin_on boolean not null default false;
alter table gftvevents_events add column if not exists entry_qr_mode text not null default 'off';
alter table gftvevents_events add column if not exists entry_qr_audience text not null default 'all';
alter table gftvevents_events add column if not exists entry_qr_show text not null default 'always';
alter table gftvevents_events add column if not exists entry_qr_hours integer;

alter table gftvevents_events drop constraint if exists gftvevents_events_id_check_providers;
alter table gftvevents_events add constraint gftvevents_events_id_check_providers
  check (id_check_providers <@ array['didit', 'veriff', 'helloid']::text[]);
alter table gftvevents_events drop constraint if exists gftvevents_events_entry_qr;
alter table gftvevents_events add constraint gftvevents_events_entry_qr check (
  entry_qr_mode in ('off', 'shared', 'each')
  and entry_qr_audience in ('all', 'paid')
  and entry_qr_show in ('always', 'before', 'checked_in')
  and (entry_qr_hours is null or entry_qr_hours between 1 and 168)
);

-- Attendees -------------------------------------------------------------------

alter table gftvevents_attendees add column if not exists checked_in_at timestamptz;
alter table gftvevents_attendees add column if not exists checked_in_by uuid references gftvevents_accounts (id) on delete set null;
alter table gftvevents_attendees add column if not exists checked_in_how text;
alter table gftvevents_attendees add column if not exists id_door_checked_at timestamptz;
alter table gftvevents_attendees add column if not exists id_door_checked_by uuid references gftvevents_accounts (id) on delete set null;

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_checked_in_how;
alter table gftvevents_attendees add constraint gftvevents_attendees_checked_in_how
  check (checked_in_how is null or checked_in_how in ('scan', 'manual', 'self'));

-- Entry QR codes --------------------------------------------------------------

create table if not exists gftvevents_entry_codes (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references gftvevents_events (id) on delete cascade,
  path         text not null unique,
  position     integer not null default 0,
  assigned_to  uuid references gftvevents_accounts (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists gftvevents_entry_codes_event on gftvevents_entry_codes (event_id, position);
-- One code per person per event.
create unique index if not exists gftvevents_entry_codes_holder on gftvevents_entry_codes (event_id, assigned_to) where assigned_to is not null;
alter table gftvevents_entry_codes enable row level security;

commit;

-- Rollback (the venue allowances are not brought back: re-run that part of
-- 003 if they are ever wanted again):
-- begin;
-- drop table if exists gftvevents_entry_codes;
-- alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_checked_in_how;
-- alter table gftvevents_attendees drop column if exists id_door_checked_by, drop column if exists id_door_checked_at,
--   drop column if exists checked_in_how, drop column if exists checked_in_by, drop column if exists checked_in_at;
-- alter table gftvevents_events drop constraint if exists gftvevents_events_entry_qr;
-- alter table gftvevents_events drop constraint if exists gftvevents_events_id_check_providers;
-- alter table gftvevents_events drop column if exists entry_qr_hours, drop column if exists entry_qr_show,
--   drop column if exists entry_qr_audience, drop column if exists entry_qr_mode, drop column if exists self_checkin_on,
--   drop column if exists id_check_door, drop column if exists id_check_providers;
-- drop table if exists gftvevents_helloid_checks;
-- alter table gftvevents_accounts drop column if exists helloid_pending, drop column if exists id_verified_at,
--   drop column if exists id_verified_providers;
-- drop table if exists gftvevents_id_checks;
-- commit;
