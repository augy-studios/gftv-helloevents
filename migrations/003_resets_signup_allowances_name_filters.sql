-- 003_resets_signup_allowances_name_filters.sql
--
-- GFTV HelloEvents, third migration (help desk #7, round 4). Run once, whole,
-- in the Supabase SQL editor, after 001 and 002.
--
-- 1. gftvevents_password_resets: one-time password reset codes an admin
--    makes for a public account that has neither Telegram nor 2FA (no email
--    is ever sent). Shown to the admin once; only the SHA-256 is stored.
-- 2. gftvevents_signup_allowances: "venue mode". A staff member on a venue's
--    Wi-Fi raises the sign-up limit for that one connection (its salted IP
--    hash, never the address) for a few hours, so a con crowd sharing one
--    address can sign up.
-- 3. gftvevents_name_filters: words admins add to the built-in list of names
--    a public account may not use as a username or display name (staff,
--    official, GFTV, ...). Stored in the same folded form the API compares.
--
-- RLS on, no policies, service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 004 onwards.

begin;

create table if not exists gftvevents_password_resets (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references gftvevents_accounts (id) on delete cascade,
  -- SHA-256 of the code. The code itself is shown to the admin once.
  code_hash   text not null unique,
  created_by  uuid references gftvevents_accounts (id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists gftvevents_password_resets_account_idx on gftvevents_password_resets (account_id);
create index if not exists gftvevents_password_resets_expires_idx on gftvevents_password_resets (expires_at);

create table if not exists gftvevents_signup_allowances (
  id            uuid primary key default gen_random_uuid(),
  -- Salted SHA-256 of the connection's address (crypto.js hashIp).
  ip_hash       text not null,
  -- Sign-ups allowed per hour from that connection while this lasts.
  max_per_hour  integer not null check (max_per_hour between 1 and 1000),
  label         text check (label is null or char_length(label) <= 80),
  created_by    uuid references gftvevents_accounts (id) on delete set null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists gftvevents_signup_allowances_lookup_idx on gftvevents_signup_allowances (ip_hash, expires_at);

create table if not exists gftvevents_name_filters (
  id          uuid primary key default gen_random_uuid(),
  -- Folded form: lowercase letters and digits only, look-alikes mapped
  -- (api/_lib/name-filter.js fold()).
  term        text not null unique check (term ~ '^[a-z0-9]{3,40}$'),
  created_by  uuid references gftvevents_accounts (id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table gftvevents_password_resets    enable row level security;
alter table gftvevents_signup_allowances  enable row level security;
alter table gftvevents_name_filters       enable row level security;
revoke all on gftvevents_password_resets, gftvevents_signup_allowances, gftvevents_name_filters
  from anon, authenticated;

commit;

-- Rollback, if this ever has to be undone:
--
-- begin;
-- drop table if exists gftvevents_name_filters, gftvevents_signup_allowances, gftvevents_password_resets;
-- commit;
