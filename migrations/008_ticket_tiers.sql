-- 008_ticket_tiers.sql
--
-- GFTV HelloEvents, eighth migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 007, and before deploying the release with ticket
-- tiers.
--
-- A paid event (a con with day passes and sponsor badges, a meet with a
-- dinner add-on) can sell its tickets in tiers. The editor switches tiers on
-- under Price and gives each tier a name, a price and a list of benefits.
-- From the second tier on, a tier can include the benefits of the tier
-- before it, and the event page then either lists those again in full or
-- says "Everything in <previous tier>, plus:".
--
-- 1. tiers_enabled: whether the event page shows the tiers. Only a paid event
--    has them on (the API sets it false for any other price type); the tiers
--    themselves are kept while it is off, so switching back brings them back.
-- 2. ticket_tiers: the tiers, in order: [{ name, price, benefits,
--    includes_previous, previous_display }]. price is a number in the event's
--    currency; benefits a list of short texts; previous_display "full" or
--    "reference". The API checks each entry (api/_lib/event-rules.js
--    readTiers); the table only holds the list's shape.
--
-- With tiers on, the API also writes the cheapest and dearest tier prices
-- to price_min and price_max, so the feed cards show "SGD 45 to SGD 120"
-- without reading the tiers.
--
-- RLS is unchanged: the table is service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 009 onwards.

begin;

alter table gftvevents_events
  add column if not exists tiers_enabled boolean not null default false,
  add column if not exists ticket_tiers jsonb not null default '[]'::jsonb;

alter table gftvevents_events drop constraint if exists gftvevents_events_ticket_tiers_check;
alter table gftvevents_events
  add constraint gftvevents_events_ticket_tiers_check
    check (jsonb_typeof(ticket_tiers) = 'array' and jsonb_array_length(ticket_tiers) <= 10);

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before ticket tiers; price_min and price_max keep the last range written):
--
-- begin;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_ticket_tiers_check,
--   drop column if exists ticket_tiers,
--   drop column if exists tiers_enabled;
-- commit;
