-- 017: "Just Lepak Only", coming to a paid event without a ticket.
--
-- An editor can let people come to a paid event without paying: to hang out
-- ("lepak"). The RSVP choice says "Just Lepak Only" unless the editor typed
-- other words for the event. Someone lepak:
--   - is going (an RSVP ID, attendees-only addresses, reminders, notices),
--     marked as lepak on the attendee list;
--   - takes none of the event's spaces (no ticket), but the editor can cap
--     how many lepak RSVPs the event takes (lepak_limit, blank for none);
--   - can also tick meals, taking those meals' places as usual.
-- Coming for the whole event takes a ticket (and a space); coming only for
-- meals, or lepak, does not.
--
-- 1. Events: lepak_enabled, lepak_limit, lepak_label.
-- 2. Attendees: lepak.
-- 3. gftvevents_full_attendees (migrations/009) leaves lepak attendees out,
--    so "N going" and the capacity count ticket holders only.
-- 4. gftvevents_rsvp takes p_lepak: it checks the lepak cap for someone
--    becoming lepak, and checks the event's capacity only for someone coming
--    to the whole event (no meals, not lepak). The three-argument version
--    from 013 is replaced.
--
-- Run after 016. Safe to run twice.

begin;

-- 1. Events ---------------------------------------------------------------

alter table gftvevents_events add column if not exists lepak_enabled boolean not null default false;
alter table gftvevents_events add column if not exists lepak_limit integer;
alter table gftvevents_events add column if not exists lepak_label text;

alter table gftvevents_events drop constraint if exists gftvevents_events_lepak_limit_check;
alter table gftvevents_events add constraint gftvevents_events_lepak_limit_check
  check (lepak_limit is null or (lepak_limit between 1 and 1000000));
alter table gftvevents_events drop constraint if exists gftvevents_events_lepak_label_check;
alter table gftvevents_events add constraint gftvevents_events_lepak_label_check
  check (lepak_label is null or char_length(lepak_label) <= 40);

-- 2. Attendees ------------------------------------------------------------

alter table gftvevents_attendees add column if not exists lepak boolean not null default false;

-- 3. The ticket holders ---------------------------------------------------

create or replace view gftvevents_full_attendees
  with (security_invoker = true) as
  select event_id, user_id, created_at
    from gftvevents_attendees
   where cardinality(meals) = 0 and not lepak;

revoke all on gftvevents_full_attendees from public, anon, authenticated;
grant select on gftvevents_full_attendees to service_role;

-- 4. RSVPs ------------------------------------------------------------------

drop function if exists gftvevents_rsvp(uuid, uuid, text[]);

create or replace function gftvevents_rsvp(p_event_id uuid, p_user_id uuid, p_meals text[] default '{}', p_lepak boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event gftvevents_events%rowtype;
  v_count integer;
  v_meals text[] := coalesce(p_meals, '{}');
  v_lepak boolean := coalesce(p_lepak, false);
  v_current text[];
  v_current_lepak boolean;
  v_going boolean;
  v_whole boolean;
  v_had_space boolean;
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
  select meals, lepak into v_current, v_current_lepak from gftvevents_attendees where event_id = p_event_id and user_id = p_user_id;
  v_going := found;
  -- RSVPs closed: nobody new joins.
  if not v_event.rsvp_open and not v_going then
    return 'rsvp_closed';
  end if;
  if v_event.last_at is not null and v_event.last_at < now() then
    return 'event_over';
  end if;
  if v_going and v_current = v_meals and v_current_lepak = v_lepak then
    return 'already';
  end if;
  -- Coming to the whole event: no meals picked, and not lepak.
  v_whole := cardinality(v_meals) = 0 and not v_lepak;
  v_had_space := v_going and cardinality(v_current) = 0 and not v_current_lepak;
  -- RSVPs closed: someone going may change, but not take a space.
  if not v_event.rsvp_open and v_whole and not v_had_space then
    return 'rsvp_closed';
  end if;

  -- A space, for someone coming to the whole event who did not have one.
  if v_whole and not v_had_space and v_event.capacity is not null then
    select count(*) into v_count from gftvevents_full_attendees where event_id = p_event_id;
    if v_count >= v_event.capacity then
      return 'event_full';
    end if;
  end if;

  -- A lepak place, for someone becoming lepak, while the event takes lepak
  -- RSVPs at all (a paid event with it switched on).
  if v_lepak and not (v_going and v_current_lepak) then
    if not v_event.lepak_enabled or v_event.price_type <> 'paid' then
      return 'lepak_not_offered';
    end if;
    if v_event.lepak_limit is not null then
      select count(*) into v_count from gftvevents_attendees where event_id = p_event_id and lepak;
      if v_count >= v_event.lepak_limit then
        return 'lepak_full';
      end if;
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
    update gftvevents_attendees set meals = v_meals, lepak = v_lepak where event_id = p_event_id and user_id = p_user_id;
    return 'changed';
  end if;
  insert into gftvevents_rsvp_counters as c (event_id, last_number) values (p_event_id, 1)
    on conflict (event_id) do update set last_number = c.last_number + 1
    returning last_number into v_number;
  insert into gftvevents_attendees (event_id, user_id, meals, lepak, rsvp_number) values (p_event_id, p_user_id, v_meals, v_lepak, v_number);
  return 'ok';
end;
$$;

revoke all on function gftvevents_rsvp(uuid, uuid, text[], boolean) from public, anon, authenticated;
grant execute on function gftvevents_rsvp(uuid, uuid, text[], boolean) to service_role;

commit;

-- Rollback: run 013's gftvevents_rsvp and 009's view again, then
-- begin;
-- drop function if exists gftvevents_rsvp(uuid, uuid, text[], boolean);
-- alter table gftvevents_attendees drop column if exists lepak;
-- alter table gftvevents_events drop column if exists lepak_enabled,
--   drop column if exists lepak_limit, drop column if exists lepak_label;
-- commit;
