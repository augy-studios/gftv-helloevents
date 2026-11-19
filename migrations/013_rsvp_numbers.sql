-- 013_rsvp_numbers.sql
--
-- GFTV HelloEvents, thirteenth migration. Run once, whole, in the Supabase
-- SQL editor, after 001 to 012, and before deploying the release with RSVP
-- IDs.
--
-- Everyone who RSVPs to an event (any kind: furmeet, convention or other,
-- for the whole event or just a meal) gets an ID: a number counting up from
-- 1 for that event. The first person going is #1, the next #2, and so on.
-- Numbers are never reused: when #3 takes back their RSVP the next person
-- still gets a new number, and someone who RSVPs again after taking it back
-- gets a new one too, so an ID never points at two people.
--
-- 1. gftvevents_rsvp_counters: the last number handed out for each event.
--    Its own table, not a column on the event, so an RSVP never touches the
--    event's row (and its updated_at, which orders the list on /manage).
-- 2. gftvevents_attendees.rsvp_number: the ID, unique within the event.
--    RSVPs made before this migration are numbered in the order they were
--    made, and each event's counter starts after them.
-- 3. gftvevents_rsvp hands out the next number when someone joins (under
--    the lock on the event row it already takes). Changing meals keeps the
--    number. Its answers are the same as in 010.
--
-- RLS: on, no policies, service role only, as everywhere else.
--
-- This file is never edited after it has been run. Changes go in 014 onwards.

begin;

create table if not exists gftvevents_rsvp_counters (
  event_id     uuid primary key references gftvevents_events (id) on delete cascade,
  last_number  integer not null default 0 check (last_number >= 0)
);

alter table gftvevents_rsvp_counters enable row level security;
revoke all on gftvevents_rsvp_counters from anon, authenticated;

alter table gftvevents_attendees add column if not exists rsvp_number integer;

-- Number the RSVPs already there, oldest first, after any already numbered.
with numbered as (
  select a.event_id, a.user_id,
         coalesce((select max(b.rsvp_number) from gftvevents_attendees b where b.event_id = a.event_id), 0)
           + row_number() over (partition by a.event_id order by a.created_at, a.user_id) as n
    from gftvevents_attendees a
   where a.rsvp_number is null
)
update gftvevents_attendees a
   set rsvp_number = numbered.n
  from numbered
 where a.event_id = numbered.event_id and a.user_id = numbered.user_id;

insert into gftvevents_rsvp_counters (event_id, last_number)
  select event_id, max(rsvp_number) from gftvevents_attendees group by event_id
  on conflict (event_id) do update set last_number = greatest(gftvevents_rsvp_counters.last_number, excluded.last_number);

alter table gftvevents_attendees alter column rsvp_number set not null;
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_rsvp_number_check;
alter table gftvevents_attendees add constraint gftvevents_attendees_rsvp_number_check check (rsvp_number > 0);
alter table gftvevents_attendees drop constraint if exists gftvevents_attendees_rsvp_number_key;
alter table gftvevents_attendees add constraint gftvevents_attendees_rsvp_number_key unique (event_id, rsvp_number);

-- 010's function, with the next number handed out on joining.
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
  v_number integer;
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
  insert into gftvevents_rsvp_counters as c (event_id, last_number) values (p_event_id, 1)
    on conflict (event_id) do update set last_number = c.last_number + 1
    returning last_number into v_number;
  insert into gftvevents_attendees (event_id, user_id, meals, rsvp_number) values (p_event_id, p_user_id, v_meals, v_number);
  return 'ok';
end;
$$;

revoke all on function gftvevents_rsvp(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function gftvevents_rsvp(uuid, uuid, text[]) to service_role;

commit;

-- Rollback, if this ever has to be undone (after going back to the release
-- before RSVP IDs): run the gftvevents_rsvp from 010 again, then
--
-- begin;
-- alter table gftvevents_attendees
--   drop constraint if exists gftvevents_attendees_rsvp_number_key,
--   drop constraint if exists gftvevents_attendees_rsvp_number_check,
--   drop column if exists rsvp_number;
-- drop table if exists gftvevents_rsvp_counters;
-- commit;
