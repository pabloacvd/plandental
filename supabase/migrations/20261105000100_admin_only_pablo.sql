-- ============================================================
-- PlanDental — Sub-task 1: Solo Pablo es admin; cerrar escalada de roles
--
-- 1. Normaliza roles: pablo es 'admin', todos los demás son 'user'.
-- 2. Actualiza is_admin() con search_path seguro (public, pg_temp).
-- 3. Trigger BEFORE UPDATE en public.profiles que rechaza cambios
--    en la columna 'role' salvo que el ejecutor sea un rol de servicio/postgres.
-- 4. Reemplaza policies abiertas de public.profiles:
--    - SELECT: cualquier usuario autenticado puede leer perfiles.
--    - UPDATE: solo la fila propia y con WITH CHECK que impide cambiar role.
--    - Se elimina 'profiles: admin all' y 'profiles: own row' (for all).
--
-- Idempotente y seguro para re-ejecución.
-- ============================================================

-- 1. Normalizar roles existentes en profiles y metadata de auth.users
update public.profiles
set role = 'admin'
where lower(username) = 'pablo' and role <> 'admin';

update public.profiles
set role = 'user'
where lower(username) <> 'pablo' and role <> 'user';

update auth.users
set raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{role}', '"admin"')
where (lower(email) = 'pablo@app.local' or lower(coalesce(raw_user_meta_data->>'username', '')) = 'pablo')
  and coalesce(raw_user_meta_data->>'role', '') <> 'admin';

update auth.users
set raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{role}', '"user"')
where lower(email) <> 'pablo@app.local'
  and lower(coalesce(raw_user_meta_data->>'username', split_part(email, '@', 1))) <> 'pablo'
  and coalesce(raw_user_meta_data->>'role', '') <> 'user';

-- 2. Helper is_admin() con search_path fijado explícitamente
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- 3. Trigger para bloquear modificación de 'role' en public.profiles
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role then
    -- Permitir cambios de rol únicamente a roles administrativos/servicio de base de datos
    -- (migraciones corriendo como postgres/supabase_admin o llamadas con service_role key,
    -- que PostgREST ejecuta con current_user = 'service_role').
    if current_user in ('postgres', 'supabase_admin', 'service_role', 'dashboard_user') then
      return new;
    end if;

    raise exception 'No está permitido modificar el rol de usuario.';
  end if;

  return new;
end;
$$;

drop trigger if exists tr_protect_profile_role on public.profiles;
create trigger tr_protect_profile_role
  before update on public.profiles
  for each row
  execute function public.protect_profile_role();

-- 4. Reemplazar policies de RLS en public.profiles
drop policy if exists "profiles: own row" on public.profiles;
drop policy if exists "profiles: admin all" on public.profiles;
drop policy if exists "profiles: read any authenticated" on public.profiles;
drop policy if exists "profiles: select authenticated" on public.profiles;
drop policy if exists "profiles: update own row" on public.profiles;

-- Lectura: usuarios autenticados pueden ver perfiles (para nombres de usuario en la UI)
create policy "profiles: select authenticated" on public.profiles
  for select
  to authenticated
  using (true);

-- Edición: cada usuario solo puede actualizar su propia fila, sin poder cambiar role
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
  );
