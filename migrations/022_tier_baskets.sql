-- 022: buying several ticket tiers at once, and tiers that include any tier.
--
-- Until now someone got one ticket in one tier at checkout. Now they can
-- buy several tiers together (a weekend pass and a dinner), each once, or
-- more than once where the editor lets one person buy more of that tier (a
-- day pass for two of the days). One payment pays for the lot: the tiers in
-- a basket must share a way to pay (api/_lib/event-rules.js basketOptions).
--
-- A tier can now also include everything in any other tier, not just the
-- one before it (a day pass that includes only the attendee pass).
--
-- 1. Events: nothing to change. ticket_tiers entries (a jsonb list) gain
--    "includes", the id of the tier included (null for none), and
--    "max_per_person", how many of the tier one person can buy (1 for
--    once). "includes_previous" is still written, true when the tier
--    included is the one before it, for the release before this one.
-- 2. Attendees: payment_items, what was bought, as kept at checkout so a
--    later change to the tiers does not change it: a list of { id, name,
--    quantity, price }, at most 10 (one per tier), or null for a ticket
--    without tiers or from before. payment_tier keeps them in words ("Day
--    pass × 2, Dinner") for the attendee list.
--
-- Run after 021. Safe to run twice.

begin;

alter table gftvevents_attendees add column if not exists payment_items jsonb;

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_items_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_items_check
  check (payment_items is null or (jsonb_typeof(payment_items) = 'array' and jsonb_array_length(payment_items) <= 10));

-- payment_tier now holds every tier bought, in words.
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_tier_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_payment_tier_check
  check (payment_tier is null or char_length(payment_tier) <= 1000);

commit;

-- Rollback (the release before reads only the first tier's name from
-- payment_tier, so roll the code back first):
-- begin;
-- alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_payment_tier_check;
-- alter table gftvevents_attendees drop column if exists payment_items;
-- commit;
