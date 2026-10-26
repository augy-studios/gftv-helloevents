-- 002_public_accounts_covers_notifications.sql
--
-- GFTV HelloEvents, second migration (help desk #7, round 3). Run once, whole,
-- in the Supabase SQL editor, after 001.
--
-- 1. Public accounts. Anyone can sign up to RSVP. Every account this site
--    knows is now a row in gftvevents_accounts, of one of two kinds:
--
--      staff   a pointer to gftvhello_users (owned by gftv.asia, never
--              written here). The row's id IS the gftvhello_users id, so
--              every row 001 already wrote stays valid as it is.
--      public  this site's own account: username, display name, email and a
--              bcrypt password hash. No Supabase Auth.
--
--    Sessions, second factors, Telegram links, RSVPs and the audit log's
--    actor now reference gftvevents_accounts instead of gftvhello_users, so
--    one RSVP table and one set of factor tables serve both kinds. A staff
--    account deleted on gftv.asia still cascades: gftvhello_users ->
--    gftvevents_accounts -> everything below it.
--
-- 2. Cover pictures in a Supabase Storage bucket, gftvevents_covers, as WebP
--    only. The event keeps the object's path; the API builds the public
--    address. cover_image_url from 001 is no longer written or read; it is
--    left in place so nothing 001 stored is destroyed, and can be dropped in
--    a later migration.
--
-- 3. Notifications. Accounts get notification choices; RSVPs remember when
--    their reminder went; events remember when they were announced. Push
--    subscriptions themselves live in Redis (Upstash via Vercel), not here.
--
-- Sign-in for staff accounts still needs a second factor (as on OneLink
-- GFTV); for public accounts it is optional. The API enforces that.
--
-- RLS stays on everywhere with no policies; only the service role key gets
-- through.
--
-- This file is never edited after it has been run. Changes go in 003 onwards.

begin;

-- ---------------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------------

create table if not exists gftvevents_accounts (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('staff', 'public')),
  -- staff only: the gftv.asia account, and equal to id.
  staff_user_id        uuid unique references gftvhello_users (id) on delete cascade,

  -- public only. username and email are stored lowercased.
  username             text unique check (username is null or username ~ '^[a-z0-9_]{3,32}$'),
  display_name         text check (display_name is null or char_length(display_name) between 1 and 60),
  email                text unique check (email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  -- bcrypt, cost 12.
  password_hash        text check (password_hash is null or password_hash like '$2%'),
  terms_accepted_at    timestamptz,
  -- No email is sent yet, so this stays empty until an email sender exists.
  email_verified_at    timestamptz,
  password_changed_at  timestamptz,
  status               text not null default 'active' check (status in ('active', 'suspended')),

  -- Notification choices, for both kinds.
  notify_updates       boolean not null default true,   -- changes to events I am going to
  notify_reminders     boolean not null default true,   -- a day before events I am going to
  notify_new_events    boolean not null default false,  -- newly announced events
  notify_telegram      boolean not null default false,  -- also send these to my linked Telegram

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  last_sign_in_at      timestamptz,

  constraint gftvevents_accounts_shape_check check (
    (kind = 'staff' and staff_user_id is not null and id = staff_user_id
       and username is null and email is null and password_hash is null)
    or
    (kind = 'public' and staff_user_id is null and username is not null and display_name is not null
       and email is not null and password_hash is not null and terms_accepted_at is not null)
  )
);

drop trigger if exists gftvevents_accounts_touch on gftvevents_accounts;
create trigger gftvevents_accounts_touch
  before update on gftvevents_accounts
  for each row execute function gftvevents_touch_updated_at();

-- A staff account row for every staff member 001's tables already mention.
insert into gftvevents_accounts (id, kind, staff_user_id)
select u.id, 'staff', u.id
from gftvhello_users u
where u.id in (
  select user_id from gftvevents_sessions
  union select user_id from gftvevents_auth_challenges
  union select user_id from gftvevents_webauthn_challenges
  union select user_id from gftvevents_passkeys
  union select user_id from gftvevents_totp_secrets
  union select user_id from gftvevents_backup_codes
  union select user_id from gftvevents_telegram_links
  union select user_id from gftvevents_telegram_link_tokens
  union select user_id from gftvevents_attendees
  union select actor_id from gftvevents_audit_logs where actor_id is not null
)
on conflict (id) do nothing;

-- Repoint every account reference from gftvhello_users to gftvevents_accounts.
-- The old foreign keys are found by what they reference rather than by name,
-- so this does not depend on Postgres's naming of 001's constraints.
do $$
declare
  r record;
begin
  for r in
    select c.conname, c.conrelid::regclass as tbl
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid = 'public.gftvhello_users'::regclass
      and c.conrelid in (
        'public.gftvevents_sessions'::regclass,
        'public.gftvevents_auth_challenges'::regclass,
        'public.gftvevents_webauthn_challenges'::regclass,
        'public.gftvevents_passkeys'::regclass,
        'public.gftvevents_totp_secrets'::regclass,
        'public.gftvevents_backup_codes'::regclass,
        'public.gftvevents_telegram_links'::regclass,
        'public.gftvevents_telegram_link_tokens'::regclass,
        'public.gftvevents_attendees'::regclass,
        'public.gftvevents_audit_logs'::regclass
      )
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end
$$;

alter table gftvevents_sessions
  add constraint gftvevents_sessions_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_auth_challenges
  add constraint gftvevents_auth_challenges_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_webauthn_challenges
  add constraint gftvevents_webauthn_challenges_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_passkeys
  add constraint gftvevents_passkeys_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_totp_secrets
  add constraint gftvevents_totp_secrets_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_backup_codes
  add constraint gftvevents_backup_codes_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_telegram_links
  add constraint gftvevents_telegram_links_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_telegram_link_tokens
  add constraint gftvevents_telegram_link_tokens_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_attendees
  add constraint gftvevents_attendees_account_fkey foreign key (user_id) references gftvevents_accounts (id) on delete cascade;
alter table gftvevents_audit_logs
  add constraint gftvevents_audit_logs_account_fkey foreign key (actor_id) references gftvevents_accounts (id) on delete set null;

-- A public account without a second factor signs in with its password alone
-- (factor "password"). Challenges gain password reset and setting up an
-- authenticator from the account page.
alter table gftvevents_sessions drop constraint if exists gftvevents_sessions_factor_check;
alter table gftvevents_sessions
  add constraint gftvevents_sessions_factor_check check (factor in ('password', 'totp', 'passkey', 'telegram', 'backup'));

alter table gftvevents_auth_challenges drop constraint if exists gftvevents_auth_challenges_purpose_check;
alter table gftvevents_auth_challenges
  add constraint gftvevents_auth_challenges_purpose_check check (purpose in ('login', 'enrol', 'recover', 'totp-setup'));

-- ---------------------------------------------------------------------------
-- 2. Cover pictures
-- ---------------------------------------------------------------------------

-- <event id>/<random name>.webp. A new random name on every upload, so a
-- replaced picture is never served from a stale cache.
alter table gftvevents_events
  add column if not exists cover_image_path text
    check (cover_image_path is null
           or cover_image_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{16,64}\.webp$');

-- Public for reading, so a cover loads from its public address without a
-- signed URL. No storage policies at all: with none, the anon and
-- authenticated keys can neither upload, replace, delete nor list, and only
-- the API (service role key) writes. The bucket enforces WebP and 1 MB as a
-- second line behind the API's own checks.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gftvevents_covers', 'gftvevents_covers', true, 1048576, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Notifications
-- ---------------------------------------------------------------------------

-- When this RSVP's day-before reminder went out, so it goes once.
alter table gftvevents_attendees add column if not exists reminded_at timestamptz;

-- When the "new event" notice went out. Events already public when this runs
-- count as announced, so nobody is sent a backlog.
alter table gftvevents_events add column if not exists announced_at timestamptz;
update gftvevents_events
   set announced_at = now()
 where announced_at is null
   and status in ('published', 'cancelled')
   and (publish_at is null or publish_at <= now());

create index if not exists gftvevents_events_announce_idx on gftvevents_events (status, announced_at);
create index if not exists gftvevents_attendees_reminder_idx on gftvevents_attendees (event_id, reminded_at);

-- ---------------------------------------------------------------------------
-- Row level security: on, no policies, service role only
-- ---------------------------------------------------------------------------

alter table gftvevents_accounts enable row level security;
revoke all on gftvevents_accounts from anon, authenticated;

commit;

-- Rollback, if this ever has to be undone before public accounts exist
-- (empty the gftvevents_covers bucket first in the Storage dashboard):
--
-- begin;
-- delete from storage.buckets where id = 'gftvevents_covers';
-- alter table gftvevents_events drop column if exists cover_image_path, drop column if exists announced_at;
-- alter table gftvevents_attendees drop column if exists reminded_at;
-- -- then drop each *_account_fkey added above, re-add the 001 foreign keys
-- -- to gftvhello_users (id), and: drop table gftvevents_accounts;
-- commit;
