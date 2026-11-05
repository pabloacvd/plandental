-- ============================================================
-- PlanDental — Sub-task 2: Modelo de familia
--
-- 1. Tabla public.families (+ RLS: cada usuario solo lee la suya;
--    las altas solo ocurren vía RPC / funciones security definer).
-- 2. profiles.family_id y persons.family_id con backfill explícito:
--    - pablo y juli  -> misma familia ("Pablo y Juli")
--    - lara, diana y cualquier otro perfil -> familia individual
--    - cada persona toma la familia de su owner_id
--    Ambas columnas quedan NOT NULL tras el backfill.
-- 3. persons.name deja de ser único global: pasa a ser único por
--    (family_id, lower(name)).
-- 4. Helpers security definer stable: my_family_id(), same_family(uuid).
-- 5. Triggers:
--    - profiles BEFORE INSERT: asigna family_id (la elegida por
--      admin_create_user o una familia individual nueva).
--    - persons BEFORE INSERT/UPDATE: family_id siempre = familia del owner;
--      el cliente no puede cambiarla.
--    - protect_profile_role() ahora también bloquea cambios de family_id.
-- 6. Ajustes mínimos a handle_profile_matches_person() y
--    create_person_with_access() para el nuevo índice por familia
--    (ambos desaparecen en la sub-tarea 3).
-- 7. admin_create_user(p_username, p_password, p_family_id, p_new_family_name)
--    y admin_list_families() (solo admin).
-- 8. Validación final con raise exception.
--
-- Idempotente y seguro para re-ejecución.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. FAMILIES
-- ────────────────────────────────────────────────────────────
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 100),
  created_at  timestamptz not null default now()
);
comment on table public.families is
  'Unidad de compartición de ingredientes, recetas y personas. Altas solo vía RPC/security definer.';

create unique index if not exists families_name_lower_idx
  on public.families (lower(name));

alter table public.families enable row level security;

-- Lectura: solo la propia familia. my_family_id() se define más abajo;
-- la policy se crea después de la función.
revoke all on public.families from anon;
revoke insert, update, delete, truncate on public.families from authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. COLUMNAS family_id
-- ────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists family_id uuid references public.families(id) on delete restrict;

alter table public.persons
  add column if not exists family_id uuid references public.families(id) on delete restrict;

create index if not exists profiles_family_idx on public.profiles (family_id);

-- Helper interno: crea una familia individual para un username.
-- No se expone a clientes (solo lo usan el backfill y el trigger de profiles).
create or replace function public.new_individual_family(p_username text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_name text;
  v_id   uuid;
begin
  v_base := 'Familia ' || coalesce(nullif(trim(p_username), ''), 'sin nombre');
  v_name := v_base;

  if exists (select 1 from public.families where lower(name) = lower(v_name)) then
    v_name := v_base || ' ' || substr(gen_random_uuid()::text, 1, 8);
  end if;

  insert into public.families (name) values (v_name) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.new_individual_family(text) from public, anon, authenticated;

-- ── Backfill de profiles ─────────────────────────────────────
do $$
declare
  v_pablo_family uuid;
  v_pablo_exists boolean;
  r              record;
begin
  -- Familia de pablo (compartida con juli)
  select exists (select 1 from public.profiles where lower(username) = 'pablo')
    into v_pablo_exists;

  select family_id into v_pablo_family
  from public.profiles
  where lower(username) = 'pablo';

  if v_pablo_exists and v_pablo_family is null then
    select id into v_pablo_family
    from public.families
    where lower(name) = lower('Pablo y Juli');

    if v_pablo_family is null then
      insert into public.families (name) values ('Pablo y Juli')
      returning id into v_pablo_family;
    end if;

    update public.profiles
    set family_id = v_pablo_family
    where lower(username) = 'pablo' and family_id is null;
  end if;

  -- Juli comparte la familia de pablo
  if v_pablo_family is not null then
    update public.profiles
    set family_id = v_pablo_family
    where lower(username) = 'juli' and family_id is null;
  end if;

  -- Cualquier otro perfil (lara, diana, ...): familia individual propia
  for r in
    select id, username from public.profiles where family_id is null order by created_at, id
  loop
    update public.profiles
    set family_id = public.new_individual_family(r.username)
    where id = r.id;
  end loop;
end;
$$;

-- ── Backfill de persons: familia del owner ───────────────────
update public.persons pe
set family_id = pr.family_id
from public.profiles pr
where pe.owner_id = pr.id
  and pe.family_id is null;

-- ── NOT NULL tras el backfill ────────────────────────────────
alter table public.profiles alter column family_id set not null;
alter table public.persons  alter column family_id set not null;

-- ────────────────────────────────────────────────────────────
-- 3. UNICIDAD DE persons.name: global -> por familia
-- ────────────────────────────────────────────────────────────
create unique index if not exists persons_family_name_lower_idx
  on public.persons (family_id, lower(name));

drop index if exists public.persons_name_lower_idx;

-- ────────────────────────────────────────────────────────────
-- 4. HELPERS my_family_id() / same_family()
-- ────────────────────────────────────────────────────────────
create or replace function public.my_family_id()
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select p.family_id
  from public.profiles p
  where p.id = auth.uid();
$$;

create or replace function public.same_family(target_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles t
    where t.id = target_profile_id
      and t.family_id is not null
      and t.family_id = (
        select me.family_id from public.profiles me where me.id = auth.uid()
      )
  );
$$;

revoke all on function public.my_family_id()         from public, anon;
revoke all on function public.same_family(uuid)      from public, anon;
grant execute on function public.my_family_id()      to authenticated;
grant execute on function public.same_family(uuid)   to authenticated;

-- Policy de lectura de families (ya existe my_family_id())
drop policy if exists "families: read own" on public.families;
create policy "families: read own" on public.families
  for select
  to authenticated
  using (id = public.my_family_id());

-- ────────────────────────────────────────────────────────────
-- 5. TRIGGERS
-- ────────────────────────────────────────────────────────────

-- 5a. profiles BEFORE INSERT: asigna family_id.
--     admin_create_user fija app.new_user_family_id (local a la transacción)
--     antes de insertar en auth.users; si no está, se crea una familia
--     individual (p. ej. alta directa por el dashboard o el seed).
create or replace function public.assign_profile_family()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_setting text;
begin
  if new.family_id is null then
    v_setting := nullif(current_setting('app.new_user_family_id', true), '');
    if v_setting is not null then
      new.family_id := v_setting::uuid;
    else
      new.family_id := public.new_individual_family(new.username);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tr_assign_profile_family on public.profiles;
create trigger tr_assign_profile_family
  before insert on public.profiles
  for each row
  execute function public.assign_profile_family();

-- 5b. profiles BEFORE UPDATE: protege role y family_id.
--     (No es security definer: current_user debe ser el rol que ejecuta.)
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role
     or new.family_id is distinct from old.family_id then
    -- Permitir cambios únicamente a roles administrativos/servicio de base de datos
    -- (migraciones corriendo como postgres/supabase_admin o llamadas con service_role key,
    -- que PostgREST ejecuta con current_user = 'service_role').
    if current_user in ('postgres', 'supabase_admin', 'service_role', 'dashboard_user') then
      return new;
    end if;

    if new.role is distinct from old.role then
      raise exception 'No está permitido modificar el rol de usuario.';
    end if;

    raise exception 'No está permitido modificar la familia del usuario.';
  end if;

  return new;
end;
$$;

drop trigger if exists tr_protect_profile_role on public.profiles;
create trigger tr_protect_profile_role
  before update on public.profiles
  for each row
  execute function public.protect_profile_role();

-- 5c. persons: family_id siempre = familia del owner y no modificable por clientes.
--     (No es security definer por el mismo motivo que arriba.)
create or replace function public.persons_enforce_family()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.family_id := (
      select p.family_id from public.profiles p where p.id = new.owner_id
    );
    return new;
  end if;

  -- UPDATE: ni family_id ni owner_id (que determina la familia) son editables por clientes
  if (new.family_id is distinct from old.family_id
      or new.owner_id is distinct from old.owner_id)
     and current_user not in ('postgres', 'supabase_admin', 'service_role', 'dashboard_user') then
    raise exception 'No está permitido modificar la familia ni el propietario de una persona.';
  end if;

  return new;
end;
$$;

drop trigger if exists tr_persons_enforce_family_ins on public.persons;
create trigger tr_persons_enforce_family_ins
  before insert on public.persons
  for each row
  execute function public.persons_enforce_family();

drop trigger if exists tr_persons_enforce_family_upd on public.persons;
create trigger tr_persons_enforce_family_upd
  before update on public.persons
  for each row
  execute function public.persons_enforce_family();

-- ────────────────────────────────────────────────────────────
-- 5d. Policy de UPDATE en profiles: tampoco puede cambiar family_id
-- ────────────────────────────────────────────────────────────
drop policy if exists "profiles: update own row" on public.profiles;
create policy "profiles: update own row" on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (
      select p.role
      from public.profiles p
      where p.id = auth.uid()
    )
    and family_id is not distinct from public.my_family_id()
  );

-- ────────────────────────────────────────────────────────────
-- 6. Ajustes mínimos a lo existente hasta la sub-tarea 3
-- ────────────────────────────────────────────────────────────

-- El trigger on_profile_created_match_person solo debe enlazar personas
-- de la MISMA familia (la unicidad de nombre ya no es global).
create or replace function public.handle_profile_matches_person()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.person_access (person_id, granted_to, granted_by, status)
  select p.id, new.id, p.owner_id, 'approved'
  from public.persons p
  where lower(p.name) = lower(new.username)
    and p.family_id = new.family_id
  on conflict (person_id, granted_to) do nothing;

  return new;
end;
$$;

-- El chequeo de duplicados ahora es por familia (coincide con el nuevo índice).
create or replace function public.create_person_with_access(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_person_id uuid;
begin
  if exists (
    select 1 from public.persons
    where family_id = public.my_family_id()
      and lower(name) = lower(p_name)
  ) then
    raise exception 'Ya existe una persona con ese nombre.';
  end if;

  -- family_id lo completa el trigger persons_enforce_family a partir del owner
  insert into public.persons (name, owner_id)
  values (p_name, auth.uid())
  returning id into v_person_id;

  insert into public.person_access (person_id, granted_to, granted_by, status)
  values (v_person_id, auth.uid(), auth.uid(), 'approved');

  return v_person_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 7. RPCs de administración
-- ────────────────────────────────────────────────────────────

-- Eliminar la firma vieja para no dejar una sobrecarga insegura/ambigua.
drop function if exists public.admin_create_user(text, text);

create or replace function public.admin_create_user(
  p_username        text,
  p_password        text,
  p_family_id       uuid default null,
  p_new_family_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
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

  return v_id;
end;
$$;

revoke all on function public.admin_create_user(text, text, uuid, text) from public, anon;
grant execute on function public.admin_create_user(text, text, uuid, text) to authenticated;

create or replace function public.admin_list_families()
returns table (
  id            uuid,
  name          text,
  member_count  integer,
  members       text[]
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden listar familias.';
  end if;

  return query
    select
      f.id,
      f.name,
      count(p.id)::integer,
      coalesce(array_agg(p.username order by p.username) filter (where p.id is not null), '{}'::text[])
    from public.families f
    left join public.profiles p on p.family_id = f.id
    group by f.id, f.name
    order by lower(f.name);
end;
$$;

revoke all on function public.admin_list_families() from public, anon;
grant execute on function public.admin_list_families() to authenticated;

-- ────────────────────────────────────────────────────────────
-- 8. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_pablo uuid;
  v_juli  uuid;
  v_lara  uuid;
  v_diana uuid;
  v_n     integer;
begin
  select count(*) into v_n from public.profiles where family_id is null;
  if v_n > 0 then
    raise exception 'Validación fallida: % perfil(es) con family_id nulo.', v_n;
  end if;

  select count(*) into v_n from public.persons where family_id is null;
  if v_n > 0 then
    raise exception 'Validación fallida: % persona(s) con family_id nulo.', v_n;
  end if;

  select count(*) into v_n
  from public.persons pe
  join public.profiles pr on pr.id = pe.owner_id
  where pe.family_id <> pr.family_id;
  if v_n > 0 then
    raise exception 'Validación fallida: % persona(s) con familia distinta a la de su owner.', v_n;
  end if;

  select family_id into v_pablo from public.profiles where lower(username) = 'pablo';
  select family_id into v_juli  from public.profiles where lower(username) = 'juli';
  select family_id into v_lara  from public.profiles where lower(username) = 'lara';
  select family_id into v_diana from public.profiles where lower(username) = 'diana';

  if v_pablo is null then raise warning 'Perfil pablo no encontrado: se omite su validación.'; end if;
  if v_juli  is null then raise warning 'Perfil juli no encontrado: se omite su validación.';  end if;
  if v_lara  is null then raise warning 'Perfil lara no encontrado: se omite su validación.';  end if;
  if v_diana is null then raise warning 'Perfil diana no encontrado: se omite su validación.'; end if;

  if v_pablo is not null and v_juli is not null and v_pablo <> v_juli then
    raise exception 'Validación fallida: pablo y juli deben compartir family_id.';
  end if;

  if v_lara is not null and v_diana is not null and v_lara = v_diana then
    raise exception 'Validación fallida: lara y diana deben tener familias distintas.';
  end if;

  if v_lara is not null and v_pablo is not null and v_lara = v_pablo then
    raise exception 'Validación fallida: lara no debe estar en la familia de pablo.';
  end if;

  if v_diana is not null and v_pablo is not null and v_diana = v_pablo then
    raise exception 'Validación fallida: diana no debe estar en la familia de pablo.';
  end if;
end;
$$;
