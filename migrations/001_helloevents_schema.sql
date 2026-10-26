-- 001_helloevents_schema.sql
--
-- GFTV HelloEvents (events.globalfurry.tv), first schema.
-- Run once, whole, in the Supabase SQL editor of the project that already
-- holds gftvhello_users. Every table this app owns carries the gftvevents_
-- prefix so it cannot collide with the gftvhello_, gftvonelink_, gftvjobs_
-- and gftvlinks_ tables that share the project.
--
-- Accounts are gftvhello_users (owned by gftv.asia). This file references it
-- with foreign keys and never alters it. Sessions, passkeys, Telegram links,
-- this site's authenticator secrets and backup codes live in this app's own
-- tables, so signing in or out here never touches another GFTV site.
--
-- Secrets are never stored as issued: session, challenge and link tokens are
-- SHA-256, backup codes and Telegram codes are bcrypt, TOTP secrets set up on
-- this site are AES-256-GCM encrypted by the API before they reach the table.
--
-- RLS is enabled on every table with no policies, so the anon and
-- authenticated keys can read nothing, including the events table: the
-- public feed is served by the API, which strips unreleased events, hidden
-- prices and private details first. Only the service role key, which lives
-- in the Vercel environment and never in the browser, gets through.
--
-- This file is never edited after it has been run. Changes go in 002 onwards.

begin;

-- gen_random_uuid() is built into Postgres 13 and later, so no extension.

-- ---------------------------------------------------------------------------
-- Sessions: one row per signed-in browser, issued only after a second factor
-- ---------------------------------------------------------------------------

create table if not exists gftvevents_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references gftvhello_users (id) on delete cascade,
  -- SHA-256 of the cookie value. The cookie itself is never stored.
  token_hash    text not null unique,
  -- The second factor that opened this session.
  factor        text not null check (factor in ('totp', 'passkey', 'telegram', 'backup')),
  -- Salted SHA-256 of the address it was opened from, for the audit trail.
  ip_hash       text,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists gftvevents_sessions_user_idx on gftvevents_sessions (user_id);
create index if not exists gftvevents_sessions_expires_idx on gftvevents_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Challenges: a sign in that has passed the password and waits on a second
-- factor (login), or an account setting up its first one (enrol). Never a
-- session.
-- ---------------------------------------------------------------------------

create table if not exists gftvevents_auth_challenges (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references gftvhello_users (id) on delete cascade,
  purpose                    text not null check (purpose in ('login', 'enrol')),
  token_hash                 text not null unique,
  attempts                   integer not null default 0,
  -- A TOTP secret being set up, encrypted like the real one.
  pending_totp_secret        text,
  -- A six digit code sent by Telegram for this challenge, bcrypt hashed.
  telegram_code_hash         text,
  telegram_code_expires_at   timestamptz,
  -- While setting up Telegram: the chat that pressed Start, linked only once
  -- the code it was sent comes back.
  pending_telegram_chat_id   bigint,
  pending_telegram_username  text,
  expires_at                 timestamptz not null,
  created_at                 timestamptz not null default now()
);

create index if not exists gftvevents_auth_challenges_user_idx on gftvevents_auth_challenges (user_id, purpose);
create index if not exists gftvevents_auth_challenges_expires_idx on gftvevents_auth_challenges (expires_at);

-- WebAuthn ceremonies. Server generated, single use, minutes long. Kept in a
-- table because the request that verifies a ceremony is rarely served by the
-- function instance that started it.
create table if not exists gftvevents_webauthn_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references gftvhello_users (id) on delete cascade,
  purpose     text not null check (purpose in ('register', 'authenticate')),
  challenge   text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists gftvevents_webauthn_challenges_lookup_idx on gftvevents_webauthn_challenges (user_id, purpose);
create index if not exists gftvevents_webauthn_challenges_expires_idx on gftvevents_webauthn_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- Second factors set up on this site
-- ---------------------------------------------------------------------------

-- Passkeys, bound to this site's relying party ID (events.globalfurry.tv).
-- The same columns as gftvonelink_staff_passkeys.
create table if not exists gftvevents_passkeys (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references gftvhello_users (id) on delete cascade,
  -- base64url, as the authenticator reports it.
  credential_id  text not null unique,
  -- base64url of the COSE public key. Public by definition.
  public_key     text not null,
  -- Rejected on a decrease, the one signal WebAuthn gives of a cloned key.
  counter        bigint not null default 0,
  transports     text[],
  label          text check (label is null or char_length(label) <= 60),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create index if not exists gftvevents_passkeys_user_idx on gftvevents_passkeys (user_id);

-- An authenticator app set up here, for an account that has none on
-- gftv.asia. gftvhello_users.totp_secret is never written by this site.
create table if not exists gftvevents_totp_secrets (
  user_id     uuid primary key references gftvhello_users (id) on delete cascade,
  -- "v1:<iv>:<tag>:<data>", AES-256-GCM with TOTP_ENCRYPTION_KEY.
  secret_enc  text not null,
  created_at  timestamptz not null default now()
);

-- Backup codes issued here, ten at a time, shown once. Shared codes in
-- gftvhello_backup_codes are accepted too and are not copied here.
create table if not exists gftvevents_backup_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references gftvhello_users (id) on delete cascade,
  code_hash   text not null,
  used        boolean not null default false,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists gftvevents_backup_codes_user_idx on gftvevents_backup_codes (user_id, used);

-- A Telegram chat that receives this account's sign-in codes.
create table if not exists gftvevents_telegram_links (
  user_id            uuid primary key references gftvhello_users (id) on delete cascade,
  chat_id            bigint not null,
  telegram_username  text check (telegram_username is null or char_length(telegram_username) <= 64),
  linked_at          timestamptz not null default now()
);

create index if not exists gftvevents_telegram_links_chat_idx on gftvevents_telegram_links (chat_id);

-- One-time tokens carried in a t.me deep link. challenge_id is set when the
-- link was made during first-time set-up.
create table if not exists gftvevents_telegram_link_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references gftvhello_users (id) on delete cascade,
  challenge_id  uuid references gftvevents_auth_challenges (id) on delete cascade,
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists gftvevents_telegram_link_tokens_user_idx on gftvevents_telegram_link_tokens (user_id);
create index if not exists gftvevents_telegram_link_tokens_expires_idx on gftvevents_telegram_link_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Events
--
-- Public only when status is published or cancelled AND publish_at is empty
-- or past. Everything else is unreleased and only editors see it. Which
-- fields of a released event reach whom is decided by the API
-- (main-site/api/_lib/serialize.js), never by this table.
-- ---------------------------------------------------------------------------

create table if not exists gftvevents_events (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique
                            check (char_length(slug) between 3 and 60 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind                    text not null default 'furmeet' check (kind in ('furmeet', 'convention', 'other')),
  title                   text not null check (char_length(title) between 1 and 120),
  summary                 text check (summary is null or char_length(summary) <= 280),
  description             text check (description is null or char_length(description) <= 8000),
  status                  text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  -- The release time: a published event stays hidden until then.
  publish_at              timestamptz,

  -- When. Stored in UTC; timezone is the IANA zone the event happens in, for
  -- showing it. dates_hidden: "dates to be announced", the stored dates stay
  -- on the server.
  starts_at               timestamptz,
  ends_at                 timestamptz,
  timezone                text not null default 'Asia/Singapore' check (char_length(timezone) <= 64),
  dates_hidden            boolean not null default false,
  -- When the event is over, for the upcoming and past lists.
  last_at                 timestamptz generated always as (coalesce(ends_at, starts_at)) stored,

  -- Where. address_attendees_only: the street address goes only to people
  -- going. online_url always goes only to people going.
  is_online               boolean not null default false,
  online_url              text check (online_url is null or (char_length(online_url) <= 500 and online_url like 'https://%')),
  venue_name              text check (venue_name is null or char_length(venue_name) <= 160),
  venue_address           text check (venue_address is null or char_length(venue_address) <= 300),
  address_attendees_only  boolean not null default false,
  city                    text check (city is null or char_length(city) <= 80),
  country                 text check (country is null or char_length(country) <= 80),

  cover_image_url         text check (cover_image_url is null or (char_length(cover_image_url) <= 500 and cover_image_url like 'https://%')),
  external_url            text check (external_url is null or (char_length(external_url) <= 500 and external_url like 'https://%')),
  organiser_name          text check (organiser_name is null or char_length(organiser_name) <= 120),

  -- Price. price_hidden: "price to be announced", the stored amounts stay on
  -- the server.
  price_type              text not null default 'free' check (price_type in ('free', 'paid', 'tba')),
  price_min               numeric(10, 2) check (price_min is null or price_min >= 0),
  price_max               numeric(10, 2) check (price_max is null or price_max >= 0),
  currency                text check (currency is null or currency ~ '^[A-Z]{3}$'),
  price_note              text check (price_note is null or char_length(price_note) <= 200),
  price_hidden            boolean not null default false,

  -- RSVP. capacity null means no limit.
  capacity                integer check (capacity is null or capacity > 0),
  rsvp_open               boolean not null default true,

  -- Editors only, never public.
  staff_notes             text check (staff_notes is null or char_length(staff_notes) <= 4000),
  created_by              uuid references gftvhello_users (id) on delete set null,
  updated_by              uuid references gftvhello_users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint gftvevents_events_dates_check check (dates_hidden or starts_at is not null),
  constraint gftvevents_events_order_check check (ends_at is null or (starts_at is not null and ends_at >= starts_at)),
  constraint gftvevents_events_price_check check (price_max is null or price_min is null or price_max >= price_min)
);

create index if not exists gftvevents_events_release_idx on gftvevents_events (status, publish_at);
create index if not exists gftvevents_events_last_at_idx on gftvevents_events (last_at);
create index if not exists gftvevents_events_starts_idx on gftvevents_events (starts_at);
create index if not exists gftvevents_events_kind_idx on gftvevents_events (kind);

-- ---------------------------------------------------------------------------
-- Attendees: one row per person going to an event
-- ---------------------------------------------------------------------------

create table if not exists gftvevents_attendees (
  event_id    uuid not null references gftvevents_events (id) on delete cascade,
  user_id     uuid not null references gftvhello_users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists gftvevents_attendees_user_idx on gftvevents_attendees (user_id);

-- ---------------------------------------------------------------------------
-- Audit log and rate limits
-- ---------------------------------------------------------------------------

create table if not exists gftvevents_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  action      text not null,
  actor_id    uuid references gftvhello_users (id) on delete set null,
  event_id    uuid references gftvevents_events (id) on delete set null,
  -- Never a secret, a code, a password or a full address.
  details     jsonb not null default '{}'::jsonb,
  ip_hash     text,
  created_at  timestamptz not null default now()
);

create index if not exists gftvevents_audit_logs_created_idx on gftvevents_audit_logs (created_at desc);
create index if not exists gftvevents_audit_logs_actor_idx on gftvevents_audit_logs (actor_id, created_at desc);

create table if not exists gftvevents_rate_limits (
  bucket        text primary key,
  hits          integer not null default 0,
  window_start  timestamptz not null default now()
);

create index if not exists gftvevents_rate_limits_window_idx on gftvevents_rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Functions the API calls through RPC, service role only
-- ---------------------------------------------------------------------------

-- Count one hit against a bucket and return the total inside the current
-- window. Atomic, so two instances cannot both read 4 and both allow a fifth.
-- The same function as gftvonelink_rate_hit.
create or replace function gftvevents_rate_hit(p_bucket text, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  insert into gftvevents_rate_limits as r (bucket, hits, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set hits = case
                 when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
                 else r.hits + 1
               end,
        window_start = case
                         when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
                         else r.window_start
                       end
  returning hits into v_hits;
  return v_hits;
end;
$$;

-- RSVP "going". Locks the event row, so two people cannot both take the last
-- space. Returns ok, already, not_found, rsvp_closed, event_full or
-- event_over. An unreleased event answers not_found, like a missing one.
create or replace function gftvevents_rsvp(p_event_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event gftvevents_events%rowtype;
  v_count integer;
begin
  select * into v_event from gftvevents_events where id = p_event_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_event.status not in ('published', 'cancelled') or (v_event.publish_at is not null and v_event.publish_at > now()) then
    return 'not_found';
  end if;
  if v_event.status = 'cancelled' or not v_event.rsvp_open then
    return 'rsvp_closed';
  end if;
  if v_event.last_at is not null and v_event.last_at < now() then
    return 'event_over';
  end if;
  if exists (select 1 from gftvevents_attendees where event_id = p_event_id and user_id = p_user_id) then
    return 'already';
  end if;
  if v_event.capacity is not null then
    select count(*) into v_count from gftvevents_attendees where event_id = p_event_id;
    if v_count >= v_event.capacity then
      return 'event_full';
    end if;
  end if;
  insert into gftvevents_attendees (event_id, user_id) values (p_event_id, p_user_id);
  return 'ok';
end;
$$;

-- Keep updated_at honest without every API route remembering to set it.
create or replace function gftvevents_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists gftvevents_events_touch on gftvevents_events;
create trigger gftvevents_events_touch
  before update on gftvevents_events
  for each row execute function gftvevents_touch_updated_at();

revoke all on function gftvevents_rate_hit(text, integer) from public, anon, authenticated;
revoke all on function gftvevents_rsvp(uuid, uuid) from public, anon, authenticated;
grant execute on function gftvevents_rate_hit(text, integer) to service_role;
grant execute on function gftvevents_rsvp(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Row level security: on everywhere, no policies, service role only
-- ---------------------------------------------------------------------------

alter table gftvevents_sessions              enable row level security;
alter table gftvevents_auth_challenges       enable row level security;
alter table gftvevents_webauthn_challenges   enable row level security;
alter table gftvevents_passkeys              enable row level security;
alter table gftvevents_totp_secrets          enable row level security;
alter table gftvevents_backup_codes          enable row level security;
alter table gftvevents_telegram_links        enable row level security;
alter table gftvevents_telegram_link_tokens  enable row level security;
alter table gftvevents_events                enable row level security;
alter table gftvevents_attendees             enable row level security;
alter table gftvevents_audit_logs            enable row level security;
alter table gftvevents_rate_limits           enable row level security;

-- Belt and braces: the anon and authenticated roles get no table rights at
-- all, so a policy added by mistake later still exposes nothing.
revoke all on gftvevents_sessions, gftvevents_auth_challenges, gftvevents_webauthn_challenges,
  gftvevents_passkeys, gftvevents_totp_secrets, gftvevents_backup_codes, gftvevents_telegram_links,
  gftvevents_telegram_link_tokens, gftvevents_events, gftvevents_attendees, gftvevents_audit_logs,
  gftvevents_rate_limits
  from anon, authenticated;

commit;

-- Rollback, if this ever has to be undone before anything depends on it:
--
-- begin;
-- drop function if exists gftvevents_rsvp(uuid, uuid);
-- drop function if exists gftvevents_rate_hit(text, integer);
-- drop table if exists gftvevents_rate_limits, gftvevents_audit_logs,
--   gftvevents_attendees, gftvevents_events, gftvevents_telegram_link_tokens,
--   gftvevents_telegram_links, gftvevents_backup_codes, gftvevents_totp_secrets,
--   gftvevents_passkeys, gftvevents_webauthn_challenges,
--   gftvevents_auth_challenges, gftvevents_sessions;
-- drop function if exists gftvevents_touch_updated_at();
-- commit;
