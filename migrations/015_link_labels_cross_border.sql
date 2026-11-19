-- 015_link_labels_cross_border.sql
--
-- GFTV HelloEvents, fifteenth migration. Run once, whole, in the Supabase
-- SQL editor, after 001 to 014, and before deploying the release with link
-- labels and cross-border events.
--
-- 1. What the event page's link button says. The link is not always to
--    tickets: it can be the event's website, a group to join (Telegram,
--    WhatsApp, Discord) or a sign-up form. The editor picks:
--    external_url_label         'tickets_website' ("Tickets and website",
--                               what every link said before), 'tickets',
--                               'website', 'group' ("Join the group"),
--                               'register' ("Register"), or 'custom'.
--    external_url_custom_label  the editor's own words for 'custom' (up to
--                               40 characters), kept while another label is
--                               picked.
--
-- 2. Cross-border events. An event outside Singapore (or a convention, which
--    draws people from everywhere) is marked cross_border. Someone signed in
--    must have a country of origin on their account to RSVP to it, or to see
--    its link; editors see each attendee's country in the attendee list,
--    with a count per country. Signed-out visitors are asked to sign in for
--    the link. Conventions are cross-border unless the editor unticks it:
--    the edit form ticks it when Kind is set to Convention, and the
--    conventions already here are marked below.
--
-- 3. gftvevents_accounts.country: the account's country of origin, an ISO
--    3166-1 alpha-2 code ("SG", "MY", "ID"). New public accounts pick one when
--    they sign up; accounts already here (and staff) set it on the account
--    page. Null until then. Shown only to the person and, for a cross-border
--    event they RSVPed to, to its editors.
--
-- RLS is unchanged: the tables are service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 016 onwards.

begin;

alter table gftvevents_events
  add column if not exists external_url_label text not null default 'tickets_website',
  add column if not exists external_url_custom_label text,
  add column if not exists cross_border boolean not null default false;

alter table gftvevents_events drop constraint if exists gftvevents_events_external_url_label_check;
alter table gftvevents_events
  add constraint gftvevents_events_external_url_label_check check (
    external_url_label in ('tickets_website', 'tickets', 'website', 'group', 'register', 'custom')
    and (external_url_custom_label is null or char_length(external_url_custom_label) <= 40)
  );

-- Conventions already here are cross-border, as new ones are by default.
update gftvevents_events set cross_border = true where kind = 'convention' and cross_border = false;

alter table gftvevents_accounts
  add column if not exists country text;

alter table gftvevents_accounts drop constraint if exists gftvevents_accounts_country_check;
alter table gftvevents_accounts
  add constraint gftvevents_accounts_country_check check (country is null or country ~ '^[A-Z]{2}$');

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before link labels and cross-border events):
--
-- begin;
-- alter table gftvevents_accounts
--   drop constraint if exists gftvevents_accounts_country_check,
--   drop column if exists country;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_external_url_label_check,
--   drop column if exists cross_border,
--   drop column if exists external_url_custom_label,
--   drop column if exists external_url_label;
-- commit;
