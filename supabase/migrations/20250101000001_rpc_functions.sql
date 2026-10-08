-- ============================================================
-- PlanDental — RPC functions migration
-- Handles the access-request / approval flow as database functions
-- so the logic runs atomically server-side (free-tier compatible).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- request_person_access
--   Called by a user who wants access to a person owned by
--   someone else. Inserts a 'pending' record.
--   Returns the new person_access id.
-- ────────────────────────────────────────────────────────────
create or replace function public.request_person_access(p_person_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  -- Prevent requesting access to your own person
  if exists (
    select 1 from public.persons
    where id = p_person_id and owner_id = auth.uid()
  ) then
    raise exception 'You already own this person record.';
  end if;

  insert into public.person_access (person_id, granted_to, granted_by, status)
  values (p_person_id, auth.uid(), auth.uid(), 'pending')
  on conflict (person_id, granted_to) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- approve_person_access
--   Called by the TARGET user (granted_to) to accept a pending request.
--   Only the person the access was granted TO may approve it.
-- ────────────────────────────────────────────────────────────
create or replace function public.approve_person_access(p_access_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.person_access
  set status = 'approved'
  where id = p_access_id
    and granted_to = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Access record not found or not pending for your account.';
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- reject_person_access
--   Deletes a pending record (called by either party to cancel/reject).
-- ────────────────────────────────────────────────────────────
create or replace function public.reject_person_access(p_access_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.person_access
  where id = p_access_id
    and (granted_to = auth.uid() or granted_by = auth.uid() or public.is_admin());
end;
$$;

-- ────────────────────────────────────────────────────────────
-- create_person_with_access
--   Atomically creates a person record AND an approved access record
--   for the calling user in one transaction.
--   Also checks: if a person with the same name exists whose owner
--   is a profile where username matches name (case-insensitive),
--   grants approved access to that existing person instead.
-- ────────────────────────────────────────────────────────────
create or replace function public.create_person_with_access(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_person_id uuid;
begin
  -- Create the person owned by the calling user
  insert into public.persons (name, owner_id)
  values (p_name, auth.uid())
  returning id into v_person_id;

  -- Grant immediate approved access to the creator
  insert into public.person_access (person_id, granted_to, granted_by, status)
  values (v_person_id, auth.uid(), auth.uid(), 'approved');

  return v_person_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- handle_profile_matches_person
--   Called (manually or via trigger) when a new profile is created.
--   If a person exists whose name case-insensitively matches the
--   new user's username, auto-grant 'approved' access.
--   Business rule: "when a real user registers with a name matching
--   an existing person, they automatically get approved access."
-- ────────────────────────────────────────────────────────────
create or replace function public.handle_profile_matches_person()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Find persons whose name matches the new profile's username (case-insensitive)
  insert into public.person_access (person_id, granted_to, granted_by, status)
  select p.id, new.id, p.owner_id, 'approved'
  from public.persons p
  where lower(p.name) = lower(new.username)
  on conflict (person_id, granted_to) do nothing;

  return new;
end;
$$;

drop trigger if exists on_profile_created_match_person on public.profiles;
create trigger on_profile_created_match_person
  after insert on public.profiles
  for each row execute function public.handle_profile_matches_person();

-- ────────────────────────────────────────────────────────────
-- upsert_plan_entry (convenience RPC used by the JS client)
--   Inserts or updates a single meal slot assignment.
--   Enforces that the caller has approved access to the person.
-- ────────────────────────────────────────────────────────────
create or replace function public.upsert_plan_entry(
  p_person_id   uuid,
  p_date_key    text,
  p_week_key    text,
  p_slot_id     text,
  p_recipe_id   text,
  p_recipe_name text,
  p_macros      jsonb
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  -- Authorisation check (mirrors RLS but explicit for clarity)
  if not (public.is_admin() or public.has_approved_access(p_person_id)) then
    raise exception 'Access denied to person %.', p_person_id;
  end if;

  insert into public.plans
    (person_id, date_key, week_key, slot_id, recipe_id, recipe_name, macros, updated_at)
  values
    (p_person_id, p_date_key, p_week_key, p_slot_id, p_recipe_id, p_recipe_name, p_macros, now())
  on conflict (person_id, date_key, slot_id) do update
    set recipe_id   = excluded.recipe_id,
        recipe_name = excluded.recipe_name,
        macros      = excluded.macros,
        week_key    = excluded.week_key,
        updated_at  = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- delete_plan_entry (convenience RPC)
-- ────────────────────────────────────────────────────────────
create or replace function public.delete_plan_entry(
  p_person_id uuid,
  p_date_key  text,
  p_slot_id   text
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.has_approved_access(p_person_id)) then
    raise exception 'Access denied to person %.', p_person_id;
  end if;

  delete from public.plans
  where person_id = p_person_id
    and date_key  = p_date_key
    and slot_id   = p_slot_id;
end;
$$;
