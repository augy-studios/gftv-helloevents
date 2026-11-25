-- 025: a limit on how many people each ticket tier takes.
--
-- Until now only the event as a whole had a limit (capacity). Now each
-- tier can have its own as well: an editor sells 20 sponsor badges and 200
-- attendee passes, with or without a capacity for the whole event. Someone
-- holds a tier when their ticket for the whole event (no meals, not lepak,
-- as for the capacity) includes it, however many of it they bought (a day
-- pass for two of the days is still one person). Once a tier has as many
-- holders as its limit it is sold out: the event and checkout pages say so,
-- it cannot be bought or upgraded to, and the people holding it keep it.
--
-- 1. Events: nothing to change. ticket_tiers entries (a jsonb list) gain
--    "limit", a whole number from 1, or null for none. The API checks it
--    (api/_lib/event-rules.js readTiers).
-- 2. gftvevents_tier_holders(event, tier, except): how many people hold a
--    tier (a ticket_tiers entry), leaving out one account. A ticket from
--    before payment_items (migrations/022) holds the tier it names.
-- 3. gftvevents_tier_counts(event): how many people hold each tier, by id,
--    for the places left on the event and checkout pages.
-- 4. gftvevents_tiers_full(event, user, items): whether any tier in a
--    basket (payment_items) that this person does not already hold has no
--    places left. Called with the event row locked.
-- 5. gftvevents_rsvp takes p_items, the tiers a checkout is buying (its
--    payment_items), and answers tier_full when one has no places left.
--    It writes them to the attendee row with the place, under the same
--    lock, so two people cannot both take a tier's last place. The
--    four-argument version from 017 is replaced.
-- 6. gftvevents_take_tiers(event, user, items): an upgrade's new tiers,
--    checked and written the same way. Answers ok, tier_full or not_going.
--
-- Run after 024. Safe to run twice.

begin;

-- 2. Who holds a tier --------------------------------------------------------

create or replace function gftvevents_tier_holders(p_event_id uuid, p_tier jsonb, p_except uuid default null)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from gftvevents_attendees a
   where a.event_id = p_event_id
     and cardinality(a.meals) = 0
     and not a.lepak
     and (p_except is null or a.user_id <> p_except)
     and (
       (a.payment_items is not null and jsonb_array_length(a.payment_items) > 0
         and a.payment_items @> jsonb_build_array(jsonb_build_object('id', p_tier ->> 'id')))
       or ((a.payment_items is null or jsonb_array_length(a.payment_items) = 0)
         and a.payment_tier = p_tier ->> 'name')
     );
$$;

revoke all on function gftvevents_tier_holders(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function gftvevents_tier_holders(uuid, jsonb, uuid) to service_role;

-- 3. The holders of each tier -----------------------------------------------

create or replace function gftvevents_tier_counts(p_event_id uuid)
returns table (tier text, taken integer)
language sql
stable
security definer
set search_path = public
as $$
  select t.value ->> 'id', gftvevents_tier_holders(p_event_id, t.value)
    from gftvevents_events e, jsonb_array_elements(e.ticket_tiers) as t(value)
   where e.id = p_event_id
     and jsonb_typeof(t.value -> 'id') = 'string';
$$;

revoke all on function gftvevents_tier_counts(uuid) from public, anon, authenticated;
grant execute on function gftvevents_tier_counts(uuid) to service_role;

-- 4. Whether a basket takes a tier with no places left ----------------------

create or replace function gftvevents_tiers_full(p_event_id uuid, p_user_id uuid, p_items jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tier jsonb;
  v_mine jsonb;
  v_id jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return false;
  end if;
  -- The tiers this person already holds keep their place.
  select payment_items into v_mine
    from gftvevents_attendees
   where event_id = p_event_id and user_id = p_user_id and cardinality(meals) = 0 and not lepak;
  for v_tier in
    select t.value
      from gftvevents_events e, jsonb_array_elements(e.ticket_tiers) as t(value)
     where e.id = p_event_id
  loop
    if jsonb_typeof(v_tier -> 'limit') is distinct from 'number' or jsonb_typeof(v_tier -> 'id') is distinct from 'string' then
      continue;
    end if;
    v_id := jsonb_build_array(jsonb_build_object('id', v_tier ->> 'id'));
    if not p_items @> v_id then
      continue;
    end if;
    if v_mine is not null and jsonb_typeof(v_mine) = 'array' and v_mine @> v_id then
      continue;
    end if;
    if gftvevents_tier_holders(p_event_id, v_tier, p_user_id) >= (v_tier ->> 'limit')::integer then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

revoke all on function gftvevents_tiers_full(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function gftvevents_tiers_full(uuid, uuid, jsonb) to service_role;

-- 5. RSVPs ------------------------------------------------------------------

drop function if exists gftvevents_rsvp(uuid, uuid, text[], boolean);

create or replace function gftvevents_rsvp(p_event_id uuid, p_user_id uuid, p_meals text[] default '{}', p_lepak boolean default false, p_items jsonb default null)
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

  -- A place in each tier with a limit that this person is buying.
  if v_whole and p_items is not null and gftvevents_tiers_full(p_event_id, p_user_id, p_items) then
    return 'tier_full';
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
    update gftvevents_attendees
       set meals = v_meals,
           lepak = v_lepak,
           payment_items = case when v_whole and p_items is not null then p_items else payment_items end
     where event_id = p_event_id and user_id = p_user_id;
    return 'changed';
  end if;
  insert into gftvevents_rsvp_counters as c (event_id, last_number) values (p_event_id, 1)
    on conflict (event_id) do update set last_number = c.last_number + 1
    returning last_number into v_number;
  insert into gftvevents_attendees (event_id, user_id, meals, lepak, rsvp_number, payment_items)
    values (p_event_id, p_user_id, v_meals, v_lepak, v_number, case when v_whole then p_items else null end);
  return 'ok';
end;
$$;

revoke all on function gftvevents_rsvp(uuid, uuid, text[], boolean, jsonb) from public, anon, authenticated;
grant execute on function gftvevents_rsvp(uuid, uuid, text[], boolean, jsonb) to service_role;

-- 6. Upgrades ---------------------------------------------------------------

create or replace function gftvevents_take_tiers(p_event_id uuid, p_user_id uuid, p_items jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from gftvevents_events where id = p_event_id for update;
  if not found then
    return 'not_going';
  end if;
  perform 1 from gftvevents_attendees
   where event_id = p_event_id and user_id = p_user_id and cardinality(meals) = 0 and not lepak;
  if not found then
    return 'not_going';
  end if;
  if gftvevents_tiers_full(p_event_id, p_user_id, p_items) then
    return 'tier_full';
  end if;
  update gftvevents_attendees set payment_items = p_items where event_id = p_event_id and user_id = p_user_id;
  return 'ok';
end;
$$;

revoke all on function gftvevents_take_tiers(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function gftvevents_take_tiers(uuid, uuid, jsonb) to service_role;

commit;

-- Rollback (roll the code back first): run 017's gftvevents_rsvp again, then
-- begin;
-- drop function if exists gftvevents_rsvp(uuid, uuid, text[], boolean, jsonb);
-- drop function if exists gftvevents_take_tiers(uuid, uuid, jsonb);
-- drop function if exists gftvevents_tiers_full(uuid, uuid, jsonb);
-- drop function if exists gftvevents_tier_counts(uuid);
-- drop function if exists gftvevents_tier_holders(uuid, jsonb, uuid);
-- commit;
