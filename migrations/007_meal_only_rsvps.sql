-- 007_meal_only_rsvps.sql
--
-- GFTV HelloEvents, seventh migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 006, and before deploying the release with meal-only
-- RSVPs.
--
-- Some people only want to come for a meal (the lunch at a furmeet, the
-- dinner after a con day). An editor ticks which meals an event offers on
-- its own: breakfast, lunch, dinner, and up to five meals they name
-- themselves ("High tea"). Someone going can then say they are coming only
-- for one or more of those meals, instead of the whole event.
--
-- 1. gftvevents_events.meal_options: the meals offered, in order:
--    [{ id, label }]. id is "breakfast", "lunch" or "dinner" (label null:
--    the pages name those in the reader's language), or "m-" and a few
--    letters and digits for a meal the editor named (label is its name).
--    The API checks each entry (api/_lib/event-rules.js readMeals); the table
--    only holds the list's shape. An empty list means no meal-only RSVPs.
-- 2. gftvevents_attendees.meals: the ids of the meals someone is coming for.
--    Empty means they are coming to the whole event. A meal the editor stops
--    offering stays in the list but is no longer shown, so ticking it again
--    brings the choices back; someone left with none of their meals still
--    offered is shown as coming to the whole event.
-- 3. gftvevents_rsvp takes the meals as a third argument (default: none, so
--    the release before this one keeps working, calling it with two). Someone
--    already going who sends a different choice has it changed ("changed");
--    the same choice again is "already". Meal-only attendees take a space
--    like anyone else.
--
-- RLS is unchanged: both tables are service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 008 onwards.

begin;

alter table gftvevents_events
  add column if not exists meal_options jsonb not null default '[]'::jsonb;

alter table gftvevents_events drop constraint if exists gftvevents_events_meal_options_check;
alter table gftvevents_events
  add constraint gftvevents_events_meal_options_check
    check (jsonb_typeof(meal_options) = 'array' and jsonb_array_length(meal_options) <= 8);

alter table gftvevents_attendees
  add column if not exists meals text[] not null default '{}';

alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_meals_check;
alter table gftvevents_attendees
  add constraint gftvevents_attendees_meals_check check (cardinality(meals) <= 8);

-- Replaced, not overloaded: with both a two- and a three-argument version, a
-- call with two arguments would match both and fail.
drop function if exists gftvevents_rsvp(uuid, uuid);

-- RSVP "going", for the whole event (p_meals empty) or only for those meals.
-- Locks the event row, so two people cannot both take the last space.
-- Returns ok, already, changed, not_found, rsvp_closed, event_full or
-- event_over. An unreleased event answers not_found, like a missing one.
create or replace function gftvevents_rsvp(p_event_id uuid, p_user_id uuid, p_meals text[] default '{}')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event gftvevents_events%rowtype;
  v_count integer;
  v_meals text[] := coalesce(p_meals, '{}');
  v_current text[];
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
  select meals into v_current from gftvevents_attendees where event_id = p_event_id and user_id = p_user_id;
  if found then
    if v_current = v_meals then
      return 'already';
    end if;
    update gftvevents_attendees set meals = v_meals where event_id = p_event_id and user_id = p_user_id;
    return 'changed';
  end if;
  if v_event.capacity is not null then
    select count(*) into v_count from gftvevents_attendees where event_id = p_event_id;
    if v_count >= v_event.capacity then
      return 'event_full';
    end if;
  end if;
  insert into gftvevents_attendees (event_id, user_id, meals) values (p_event_id, p_user_id, v_meals);
  return 'ok';
end;
$$;

revoke all on function gftvevents_rsvp(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function gftvevents_rsvp(uuid, uuid, text[]) to service_role;

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before meal-only RSVPs; everyone keeps their place, as coming to the whole
-- event):
--
-- begin;
-- drop function if exists gftvevents_rsvp(uuid, uuid, text[]);
-- create or replace function gftvevents_rsvp(p_event_id uuid, p_user_id uuid) ...
--   (the version in 001, with its revoke and grant)
-- alter table gftvevents_attendees
--   drop constraint if exists gftvevents_attendees_meals_check,
--   drop column if exists meals;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_meal_options_check,
--   drop column if exists meal_options;
-- commit;
