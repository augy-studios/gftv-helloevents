-- 009_meal_limits.sql
--
-- GFTV HelloEvents, ninth migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 008, and before deploying the release with meal
-- limits.
--
-- People coming only for a meal (migrations/007) no longer take one of the
-- event's spaces: the capacity, "N going" and "Full" count only the people
-- coming to the whole event. Instead each meal can have its own limit, set
-- by the editor next to it, and the event page says how many places are
-- left for it.
--
-- 1. meal_options entries may carry a limit: [{ id, label, limit }], limit a
--    whole number or null for none. The API checks it (event-rules.js
--    readMeals); the shape check from 007 is unchanged.
-- 2. gftvevents_full_attendees: the attendees coming to the whole event
--    (no meals chosen). The API counts it where it counted every attendee
--    before (gftvevents_full_attendees(count)); PostgREST finds its link to
--    gftvevents_events through gftvevents_attendees.event_id. It runs with
--    the rights of whoever reads it (security_invoker), and only the service
--    role may, as with every table here.
-- 3. gftvevents_meal_counts(event): how many people are coming for each meal,
--    for the places left on the event page.
-- 4. gftvevents_rsvp checks the event's capacity only for someone coming to
--    the whole event (or changing to it), and each meal's limit for the meals
--    someone adds; a meal with no places left answers "meal_full".
--
-- This file is never edited after it has been run. Changes go in 010 onwards.

begin;

create or replace view gftvevents_full_attendees
  with (security_invoker = true) as
  select event_id, user_id, created_at
    from gftvevents_attendees
   where cardinality(meals) = 0;

revoke all on gftvevents_full_attendees from public, anon, authenticated;
grant select on gftvevents_full_attendees to service_role;

create or replace function gftvevents_meal_counts(p_event_id uuid)
returns table (meal text, taken integer)
language sql
stable
security definer
set search_path = public
as $$
  select chosen.meal, count(*)::integer
    from gftvevents_attendees a, unnest(a.meals) as chosen(meal)
   where a.event_id = p_event_id
   group by chosen.meal;
$$;

revoke all on function gftvevents_meal_counts(uuid) from public, anon, authenticated;
grant execute on function gftvevents_meal_counts(uuid) to service_role;

-- RSVP "going", for the whole event (p_meals empty) or only for those meals.
-- Locks the event row, so two people cannot both take the last space (or
-- the last place at a meal). Returns ok, already, changed, not_found,
-- rsvp_closed, event_full, meal_full or event_over.
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
  v_going boolean;
  v_meal jsonb;
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
  v_going := found;
  if v_going and v_current = v_meals then
    return 'already';
  end if;

  -- A space, for someone coming to the whole event who did not have one.
  if cardinality(v_meals) = 0 and v_event.capacity is not null and (not v_going or cardinality(v_current) > 0) then
    select count(*) into v_count from gftvevents_attendees where event_id = p_event_id and cardinality(meals) = 0;
    if v_count >= v_event.capacity then
      return 'event_full';
    end if;
  end if;

  -- A place at each meal with a limit that this person is adding.
  for v_meal in select * from jsonb_array_elements(v_event.meal_options) loop
    if jsonb_typeof(v_meal -> 'limit') = 'number'
       and (v_meal ->> 'id') = any (v_meals)
       and not (v_going and (v_meal ->> 'id') = any (v_current)) then
      select count(*) into v_count from gftvevents_attendees where event_id = p_event_id and (v_meal ->> 'id') = any (meals);
      if v_count >= (v_meal ->> 'limit')::integer then
        return 'meal_full';
      end if;
    end if;
  end loop;

  if v_going then
    update gftvevents_attendees set meals = v_meals where event_id = p_event_id and user_id = p_user_id;
    return 'changed';
  end if;
  insert into gftvevents_attendees (event_id, user_id, meals) values (p_event_id, p_user_id, v_meals);
  return 'ok';
end;
$$;

revoke all on function gftvevents_rsvp(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function gftvevents_rsvp(uuid, uuid, text[]) to service_role;

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before meal limits): put back 007's gftvevents_rsvp, then
--
-- begin;
-- drop function if exists gftvevents_meal_counts(uuid);
-- drop view if exists gftvevents_full_attendees;
-- commit;
