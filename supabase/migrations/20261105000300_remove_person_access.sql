-- ============================================================
-- PlanDental — Sub-task 3: eliminar person_access y crear una
-- persona automática por usuario
--
-- 1. Helper person_in_my_family(person_id).
-- 2. Reescribe las policies de persons, plans, nutrition_data y
--    default_week en base a la familia (sin bypass de admin).
--    persons queda de solo lectura para los clientes.
-- 3. Reescribe upsert_plan_entry / delete_plan_entry.
-- 4. ensure_person_for_profile() + admin_create_user() crea la
--    persona del nuevo usuario (reutiliza una existente en la
--    familia con el mismo nombre; no cambia owners existentes).
-- 5. Backfill: todo perfil queda con una persona con su nombre
--    en su familia (lara y diana quedan con 'Lara' y 'Diana').
-- 6. shares_access_with() pasa a basarse en same_family() para
--    que las policies de ingredients sigan funcionando (la
--    sub-tarea 4 termina de pulir ingredients).
-- 7. Elimina person_access, familia_flag, has_approved_access(),
--    request/approve/reject_person_access, create_person_with_access,
--    on_profile_created_match_person y handle_profile_matches_person.
-- 8. Validación final.
--
-- Idempotente. Requiere 20261105000200_families.sql.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. HELPER person_in_my_family(person_id)
-- ────────────────────────────────────────────────────────────
create or replace function public.person_in_my_family(p_person_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.persons pe
    where pe.id = p_person_id
      and pe.family_id is not null
      and pe.family_id = public.my_family_id()
  );
$$;

revoke all on function public.person_in_my_family(uuid) from public, anon;
grant execute on function public.person_in_my_family(uuid) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. POLICIES basadas en familia (sin is_admin)
-- ────────────────────────────────────────────────────────────

-- 2a. persons: solo lectura de la propia familia. Las altas se hacen
--     únicamente desde admin_create_user / ensure_person_for_profile
--     (security definer); los clientes no insertan, editan ni borran.
drop policy if exists "persons: owner or approved" on public.persons;
drop policy if exists "persons: owner insert"      on public.persons;
drop policy if exists "persons: owner update"      on public.persons;
drop policy if exists "persons: owner delete"      on public.persons;
drop policy if exists "persons: family select"     on public.persons;

create policy "persons: family select" on public.persons
  for select
  to authenticated
  using (family_id = public.my_family_id());

revoke all on public.persons from anon;
revoke insert, update, delete, truncate on public.persons from authenticated;

-- 2b. plans
drop policy if exists "plans: approved access only" on public.plans;
drop policy if exists "plans: family access"        on public.plans;

create policy "plans: family access" on public.plans
  for all
  to authenticated
  using      (public.person_in_my_family(person_id))
  with check (public.person_in_my_family(person_id));

-- 2c. nutrition_data
drop policy if exists "nutrition_data: approved access only" on public.nutrition_data;
drop policy if exists "nutrition_data: family access"        on public.nutrition_data;

create policy "nutrition_data: family access" on public.nutrition_data
  for all
  to authenticated
  using      (public.person_in_my_family(person_id))
  with check (public.person_in_my_family(person_id));

-- 2d. default_week
drop policy if exists "default_week: approved access only" on public.default_week;
drop policy if exists "default_week: family access"         on public.default_week;

create policy "default_week: family access" on public.default_week
  for all
  to authenticated
  using      (public.person_in_my_family(person_id))
  with check (public.person_in_my_family(person_id));

-- ────────────────────────────────────────────────────────────
-- 3. RPCs del plan
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
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.person_in_my_family(p_person_id) then
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

create or replace function public.delete_plan_entry(
  p_person_id uuid,
  p_date_key  text,
  p_slot_id   text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.person_in_my_family(p_person_id) then
    raise exception 'Access denied to person %.', p_person_id;
  end if;

  delete from public.plans
  where person_id = p_person_id
    and date_key  = p_date_key
    and slot_id   = p_slot_id;
end;
$$;

revoke all on function public.upsert_plan_entry(uuid, text, text, text, text, text, jsonb) from public, anon;
revoke all on function public.delete_plan_entry(uuid, text, text)                          from public, anon;
grant execute on function public.upsert_plan_entry(uuid, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.delete_plan_entry(uuid, text, text)                          to authenticated;

-- ────────────────────────────────────────────────────────────
-- 4. Persona automática por perfil
--    Función interna: no se expone a ningún rol de la API.
--    Si la familia del perfil ya tiene una persona con ese nombre
--    (comparación case-insensitive) se reutiliza tal cual, sin
--    tocar su owner. Si no, se crea con owner = el perfil; el
--    trigger persons_enforce_family fija persons.family_id.
-- ────────────────────────────────────────────────────────────
create or replace function public.ensure_person_for_profile(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_username  text;
  v_family_id uuid;
  v_person_id uuid;
begin
  select pr.username, pr.family_id
    into v_username, v_family_id
  from public.profiles pr
  where pr.id = p_profile_id;

  if v_username is null or v_family_id is null then
    raise exception 'Perfil % no encontrado o sin familia.', p_profile_id;
  end if;

  select pe.id into v_person_id
  from public.persons pe
  where pe.family_id = v_family_id
    and lower(pe.name) = lower(v_username)
  limit 1;

  if v_person_id is null then
    insert into public.persons (name, owner_id)
    values (initcap(v_username), p_profile_id)
    returning id into v_person_id;
  end if;

  return v_person_id;
end;
$$;

revoke all on function public.ensure_person_for_profile(uuid) from public, anon, authenticated;

-- admin_create_user: igual que en 20261105000200_families.sql, más la
-- creación de la persona al final.
create or replace function public.admin_create_user(
  p_username        text,
  p_password        text,
  p_family_id       uuid default null,
  p_new_family_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id         uuid;
  v_email      text;
  v_family_id  uuid;
  v_new_name   text;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden crear usuarios.';
  end if;

  if p_username is null or trim(p_username) = '' then
    raise exception 'El nombre de usuario no puede estar vacío.';
  end if;

  if p_password is null or length(p_password) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;

  v_new_name := nullif(trim(coalesce(p_new_family_name, '')), '');

  if (p_family_id is null and v_new_name is null)
     or (p_family_id is not null and v_new_name is not null) then
    raise exception 'Indicá exactamente una opción: una familia existente o el nombre de una familia nueva.';
  end if;

  if v_new_name is not null and length(v_new_name) > 100 then
    raise exception 'El nombre de la familia no puede superar los 100 caracteres.';
  end if;

  p_username := lower(trim(p_username));
  v_email    := p_username || '@app.local';

  if exists (select 1 from public.profiles where lower(username) = p_username) then
    raise exception 'Ya existe un usuario con ese nombre.';
  end if;

  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'Ya existe un usuario con ese nombre.';
  end if;

  if p_family_id is not null then
    if not exists (select 1 from public.families where id = p_family_id) then
      raise exception 'La familia indicada no existe.';
    end if;
    v_family_id := p_family_id;
  else
    if exists (select 1 from public.families where lower(name) = lower(v_new_name)) then
      raise exception 'Ya existe una familia con ese nombre.';
    end if;
    insert into public.families (name) values (v_new_name) returning id into v_family_id;
  end if;

  v_id := gen_random_uuid();

  -- El trigger tr_assign_profile_family lee este valor (local a la transacción)
  perform set_config('app.new_user_family_id', v_family_id::text, true);

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    v_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(),
    jsonb_build_object('username', p_username, 'role', 'user'),
    now(), now(), '', '', '', ''
  );

  perform set_config('app.new_user_family_id', '', true);

  if not exists (
    select 1 from public.profiles where id = v_id and family_id = v_family_id
  ) then
    raise exception 'No se pudo asignar la familia al nuevo usuario.';
  end if;

  -- Persona propia del usuario en su familia (reutiliza una existente con ese nombre)
  perform public.ensure_person_for_profile(v_id);

  return v_id;
end;
$$;

revoke all on function public.admin_create_user(text, text, uuid, text) from public, anon;
grant execute on function public.admin_create_user(text, text, uuid, text) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. BACKFILL: todo perfil tiene una persona con su nombre en su familia
-- ────────────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select pr.id
    from public.profiles pr
    where not exists (
      select 1
      from public.persons pe
      where pe.family_id = pr.family_id
        and lower(pe.name) = lower(pr.username)
    )
  loop
    perform public.ensure_person_for_profile(r.id);
  end loop;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 6. shares_access_with() sin person_access
--    Misma firma (la usan las policies de ingredients). Ahora delega
--    en same_family(); la sub-tarea 4 reescribe esas policies y la elimina.
-- ────────────────────────────────────────────────────────────
create or replace function public.shares_access_with(target_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.same_family(target_profile_id);
$$;

comment on function public.shares_access_with(uuid) is
  'Deprecated: delegates to same_family(). To be removed in sub-task 4.';

revoke all on function public.shares_access_with(uuid) from public, anon;
grant execute on function public.shares_access_with(uuid) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 7. DROPS (después de reescribir todo lo que dependía de ellos)
-- ────────────────────────────────────────────────────────────

-- Aviso (no aborta): accesos aprobados que cruzaban familias y se perderán.
do $$
declare
  v_n integer := 0;
begin
  if to_regclass('public.person_access') is not null then
    execute $q$
      select count(*)
      from public.person_access pa
      join public.persons  pe on pe.id = pa.person_id
      join public.profiles pr on pr.id = pa.granted_to
      where pa.status = 'approved'
        and pr.family_id <> pe.family_id
    $q$ into v_n;

    if v_n > 0 then
      raise warning '% acceso(s) aprobado(s) entre familias distintas se pierden al eliminar person_access.', v_n;
    end if;
  end if;
end;
$$;

drop trigger  if exists on_profile_created_match_person on public.profiles;
drop function if exists public.handle_profile_matches_person();
drop function if exists public.create_person_with_access(text);
drop function if exists public.request_person_access(uuid);
drop function if exists public.approve_person_access(uuid);
drop function if exists public.reject_person_access(uuid);

drop view     if exists public.familia_flag;
drop table    if exists public.person_access;  -- sus policies e índices caen con la tabla

-- Sin cascade: si alguna policy o vista aún dependiera de la función, esto falla.
drop function if exists public.has_approved_access(uuid);

-- ────────────────────────────────────────────────────────────
-- 8. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_n     integer;
  v_names text;
  r       record;
begin
  -- Todo perfil tiene una persona con su nombre en su familia
  select count(*), string_agg(pr.username, ', ')
    into v_n, v_names
  from public.profiles pr
  where not exists (
    select 1 from public.persons pe
    where pe.family_id = pr.family_id
      and lower(pe.name) = lower(pr.username)
  );
  if v_n > 0 then
    raise exception 'Validación fallida: perfil(es) sin persona en su familia: %', v_names;
  end if;

  -- Usuarios conocidos
  for r in
    select u.username
    from (values ('pablo'), ('juli'), ('lara'), ('diana')) as u(username)
  loop
    if not exists (select 1 from public.profiles where lower(username) = r.username) then
      raise warning 'Perfil % no encontrado: se omite su validación.', r.username;
    elsif not exists (
      select 1
      from public.profiles pr
      join public.persons  pe on pe.family_id = pr.family_id
                             and lower(pe.name) = lower(pr.username)
      where lower(pr.username) = r.username
    ) then
      raise exception 'Validación fallida: % no tiene persona en su familia.', r.username;
    end if;
  end loop;

  -- Personas con family_id consistente con su owner
  select count(*) into v_n
  from public.persons pe
  join public.profiles pr on pr.id = pe.owner_id
  where pe.family_id <> pr.family_id;
  if v_n > 0 then
    raise exception 'Validación fallida: % persona(s) con familia distinta a la de su owner.', v_n;
  end if;

  -- Objetos eliminados
  if to_regclass('public.person_access') is not null then
    raise exception 'Validación fallida: la tabla person_access sigue existiendo.';
  end if;
  if to_regclass('public.familia_flag') is not null then
    raise exception 'Validación fallida: la vista familia_flag sigue existiendo.';
  end if;

  select string_agg(p.proname, ', ')
    into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('has_approved_access', 'request_person_access',
                      'approve_person_access', 'reject_person_access',
                      'create_person_with_access', 'handle_profile_matches_person');
  if v_names is not null then
    raise exception 'Validación fallida: funciones obsoletas siguen existiendo: %', v_names;
  end if;

  -- Ninguna función de public referencia lo eliminado
  select string_agg(p.proname, ', ')
    into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.prosrc ~* '(person_access|has_approved_access|familia_flag)';
  if v_names is not null then
    raise exception 'Validación fallida: funciones que aún referencian person_access/has_approved_access/familia_flag: %', v_names;
  end if;

  -- Ninguna policy referencia lo eliminado
  select string_agg(pol.tablename || '.' || pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public'
    and (coalesce(pol.qual, '')       ~* '(person_access|has_approved_access|familia_flag)'
      or coalesce(pol.with_check, '') ~* '(person_access|has_approved_access|familia_flag)');
  if v_names is not null then
    raise exception 'Validación fallida: policies que aún referencian person_access/has_approved_access/familia_flag: %', v_names;
  end if;

  -- Aislamiento total: sin is_admin() en persons/plans/nutrition_data/default_week
  select string_agg(pol.tablename || '.' || pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public'
    and pol.tablename in ('persons', 'plans', 'nutrition_data', 'default_week')
    and (coalesce(pol.qual, '')       ~* 'is_admin'
      or coalesce(pol.with_check, '') ~* 'is_admin');
  if v_names is not null then
    raise exception 'Validación fallida: policies que aún usan is_admin(): %', v_names;
  end if;

  select string_agg(p.proname, ', ')
    into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('upsert_plan_entry', 'delete_plan_entry')
    and p.prosrc ~* 'is_admin';
  if v_names is not null then
    raise exception 'Validación fallida: RPCs del plan que aún usan is_admin(): %', v_names;
  end if;
end;
$$;
