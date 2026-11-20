-- 018: editors for one event.
--
-- An admin can make any account (a public one, or staff who are not editors)
-- an editor of a specific event, from that event's Editors tab on /manage.
-- An event editor:
--   - sees only the events they edit on /manage, and no staff tools;
--   - edits every section of those events and manages their attendees
--     (payments, volunteers, removing people), but cannot change the
--     Status or the release time (staff decide when it goes live), create
--     events, or delete them;
--   - must have two-step sign-in on (an authenticator app or a passkey):
--     without it, the rights are there but do nothing until it is turned on.
-- Staff editors and admins edit every event, as before.
--
-- gftvevents_event_editors: one row per event and account, with the admin
-- who added it. Goes with the event and with the account.
--
-- Run after 017. Safe to run twice.

begin;

create table if not exists gftvevents_event_editors (
  event_id    uuid not null references gftvevents_events (id) on delete cascade,
  account_id  uuid not null references gftvevents_accounts (id) on delete cascade,
  added_by    uuid references gftvevents_accounts (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (event_id, account_id)
);

create index if not exists gftvevents_event_editors_account_idx on gftvevents_event_editors (account_id);

alter table gftvevents_event_editors enable row level security;
revoke all on gftvevents_event_editors from anon, authenticated;

-- The "active in the last 30 days" list an admin picks from reads this.
create index if not exists gftvevents_accounts_last_sign_in_idx on gftvevents_accounts (last_sign_in_at);

commit;

-- Rollback:
-- begin;
-- drop table if exists gftvevents_event_editors;
-- drop index if exists gftvevents_accounts_last_sign_in_idx;
-- commit;
