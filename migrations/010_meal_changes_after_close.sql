-- 010_meal_changes_after_close.sql
--
-- GFTV HelloEvents, tenth migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 009.
--
-- Once an editor stops taking RSVPs, someone already going can still change
-- which meals they are coming for (within each meal's places), or go from
-- the whole event to just meals. They cannot take one of the event's spaces
-- then (from just meals to the whole event), and nobody new can join. A
-- cancelled or finished event takes no changes at all, as before.
--
-- Only gftvevents_rsvp changes; its answers are the same as in 009.
--
-- This file is never edited after it has been run. Changes go in 011 onwards.

begin;

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
  if v_event.status = 'cancelled' then
    return 'rsvp_closed';
  end if;
  select meals into v_current from gftvevents_attendees where event_id = p_event_id and user_id = p_user_id;
  v_going := found;
  -- RSVPs closed: nobody new joins.
  if not v_event.rsvp_open and not v_going then
    return 'rsvp_closed';
  end if;
  if v_event.last_at is not null and v_event.last_at < now() then
    return 'event_over';
  end if;
  if v_going and v_current = v_meals then
    return 'already';
  end if;
  -- RSVPs closed: someone going may change their meals, but not take a space.
  if not v_event.rsvp_open and cardinality(v_meals) = 0 then
    return 'rsvp_closed';
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

-- Rollback: run the gftvevents_rsvp from 009 again.
