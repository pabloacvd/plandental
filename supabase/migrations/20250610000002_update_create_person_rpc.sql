-- ============================================================
-- PlanDental — Update create_person_with_access to enforce
-- case-insensitive global uniqueness on persons.name
-- ============================================================

create or replace function public.create_person_with_access(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_person_id uuid;
begin
  -- Reject case-insensitive duplicates (persons.name is globally unique case-insensitively)
  if exists (select 1 from public.persons where lower(name) = lower(p_name)) then
    raise exception 'Ya existe una persona con ese nombre.';
  end if;

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
