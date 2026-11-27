-- 028: email as a backup second step, and as a way to reset a forgotten
-- password (api/_lib/email.js, api/_lib/email-factor.js).
--
-- Emails go out through Resend (RESEND_API_KEY, EMAIL_FROM), on its free
-- plan: about 100 a day. With neither set, nothing here is offered.
--
-- 1. gftvevents_email_factors: the address an account confirmed, by a code or
--    a link emailed to it from the account page. Only that address counts:
--    if the account's email changes (a staff member's, on gftv.asia), the
--    confirmation no longer holds. Email is never enough to turn 2FA on by
--    itself: once 2FA is on (an authenticator or a passkey), it is accepted
--    as the second step, as Telegram is. A public account with a confirmed
--    address can reset its password with it (plus the second step when 2FA
--    is on). A public account's email_verified_at is set too.
--
-- 2. Challenges: each email holds a six digit code (bcrypt) and a link
--    (SHA-256 of its token), both expiring at email_code_expires_at. The
--    link works only in the browser that asked for the email:
--    email_browser_hash is the SHA-256 of a random value kept in an
--    HttpOnly cookie there. email_verified_at: a reset whose link was
--    followed. Purpose 'email-setup': confirming the address.
--
-- 3. Sessions: factor 'email'.
--
-- RLS on, no policies, service role only, as everywhere else.

begin;

create table if not exists gftvevents_email_factors (
  user_id       uuid primary key references gftvevents_accounts (id) on delete cascade,
  email         text not null,
  confirmed_at  timestamptz not null default now()
);
alter table gftvevents_email_factors enable row level security;

alter table gftvevents_auth_challenges add column if not exists email_code_hash text;
alter table gftvevents_auth_challenges add column if not exists email_code_expires_at timestamptz;
alter table gftvevents_auth_challenges add column if not exists email_link_hash text;
alter table gftvevents_auth_challenges add column if not exists email_browser_hash text;
alter table gftvevents_auth_challenges add column if not exists email_verified_at timestamptz;
create index if not exists gftvevents_auth_challenges_email_link_idx
  on gftvevents_auth_challenges (email_link_hash) where email_link_hash is not null;

alter table gftvevents_auth_challenges drop constraint if exists gftvevents_auth_challenges_purpose_check;
alter table gftvevents_auth_challenges
  add constraint gftvevents_auth_challenges_purpose_check check (purpose in ('login', 'enrol', 'recover', 'totp-setup', 'email-setup'));

alter table gftvevents_sessions drop constraint if exists gftvevents_sessions_factor_check;
alter table gftvevents_sessions
  add constraint gftvevents_sessions_factor_check check (factor in ('password', 'totp', 'passkey', 'telegram', 'backup', 'email'));

commit;

-- Rollback:
-- begin;
-- delete from gftvevents_sessions where factor = 'email';
-- alter table gftvevents_sessions drop constraint if exists gftvevents_sessions_factor_check;
-- alter table gftvevents_sessions
--   add constraint gftvevents_sessions_factor_check check (factor in ('password', 'totp', 'passkey', 'telegram', 'backup'));
-- delete from gftvevents_auth_challenges where purpose = 'email-setup';
-- alter table gftvevents_auth_challenges drop constraint if exists gftvevents_auth_challenges_purpose_check;
-- alter table gftvevents_auth_challenges
--   add constraint gftvevents_auth_challenges_purpose_check check (purpose in ('login', 'enrol', 'recover', 'totp-setup'));
-- drop index if exists gftvevents_auth_challenges_email_link_idx;
-- alter table gftvevents_auth_challenges drop column if exists email_verified_at, drop column if exists email_browser_hash,
--   drop column if exists email_link_hash, drop column if exists email_code_expires_at, drop column if exists email_code_hash;
-- drop table if exists gftvevents_email_factors;
-- commit;
