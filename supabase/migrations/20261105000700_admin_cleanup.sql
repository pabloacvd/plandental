-- ============================================================
-- PlanDental — Sub-task 7: limpieza de bypass admin y profiles
--
-- Auditoría de is_admin() sobre el estado final de las migraciones
-- (hasta 20261105000600): ninguna policy ni función de persons, plans,
-- nutrition_data, default_week, ingredients, recipes, profiles o families
-- la usa. Las únicas funciones que la llaman son admin_create_user,
-- admin_reset_password y admin_list_families. Esta migración:
--
-- 1. Restringe SELECT de public.profiles a la propia fila + la misma
--    familia (antes: using (true) para cualquier autenticado, lo que
--    exponía username/role/family_id de otras familias).
--    admin_list_families es security definer y no depende de esta policy.
-- 2. Revoca todo acceso de anon sobre public.profiles.
-- 3. Cierra a anon la ejecución de admin_reset_password (la migración
--    original solo hizo "revoke ... from public"; en Supabase anon tiene
--    un grant propio por default privileges).
-- 4. Termina con un bloque de validación ejecutable que falla si queda
--    cualquier uso de is_admin() fuera de las funciones permitidas.
--
-- Idempotente. No modifica migraciones anteriores.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. profiles: lectura limitada a la propia fila y a la familia
--    my_family_id() es security definer (lee profiles sin RLS), por lo
--    que no hay recursión de policies.
-- ────────────────────────────────────────────────────────────
drop policy if exists "profiles: select authenticated" on public.profiles;
drop policy if exists "profiles: select own family"    on public.profiles;

create policy "profiles: select own family" on public.profiles
  for select
  to authenticated
  using (
    id = auth.uid()
    or family_id = public.my_family_id()
  );

revoke all on public.profiles from anon;

-- ────────────────────────────────────────────────────────────
-- 2. admin_reset_password: sin ejecución para anon
--    (sigue ejecutable por authenticated; valida is_admin() adentro)
-- ────────────────────────────────────────────────────────────
revoke all on function public.admin_reset_password(text, text) from public, anon;
grant execute on function public.admin_reset_password(text, text) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_names   text;
  v_n       integer;
  v_cfg     boolean;
  r         record;
  v_allowed text[] := array['admin_create_user', 'admin_reset_password', 'admin_list_families'];
begin
  -- 3.1 Ninguna policy de public usa is_admin()
  --     (no hay excepciones justificadas: profiles tampoco la usa).
  select string_agg(pol.tablename || '.' || pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public'
    and (coalesce(pol.qual, '')       ~* 'is_admin'
      or coalesce(pol.with_check, '') ~* 'is_admin');
  if v_names is not null then
    raise exception 'Validación fallida: policies que usan is_admin(): %', v_names;
  end if;

  -- 3.2 Ninguna vista de public usa is_admin()
  select string_agg(v.viewname, ', ')
    into v_names
  from pg_views v
  where v.schemaname = 'public'
    and v.definition ~* 'is_admin';
  if v_names is not null then
    raise exception 'Validación fallida: vistas que usan is_admin(): %', v_names;
  end if;

  -- 3.3 Solo las funciones permitidas (y la propia is_admin) la referencian
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and p.proname <> 'is_admin'
    and p.proname <> all (v_allowed)
    and p.prosrc ~* 'is_admin';
  if v_names is not null then
    raise exception 'Validación fallida: funciones/RPCs con is_admin() no permitidas: %', v_names;
  end if;

  -- 3.4 is_admin(): security definer con search_path fijo
  select count(*) into v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'is_admin';
  if v_n <> 1 then
    raise exception 'Validación fallida: se esperaba exactamente 1 función is_admin(), hay %.', v_n;
  end if;

  select p.prosecdef
         and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c ~ '^search_path=')
    into v_cfg
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'is_admin';
  if not coalesce(v_cfg, false) then
    raise exception 'Validación fallida: is_admin() debe ser security definer con search_path fijo.';
  end if;

  -- 3.5 Funciones admin: una sola firma, usan is_admin(), security definer
  --     con search_path fijo, ejecutables por authenticated y no por anon
  for r in
    select a.name as proname
    from unnest(v_allowed) as a(name)
  loop
    select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.proname;
    if v_n <> 1 then
      raise exception 'Validación fallida: % debe tener exactamente 1 firma (hay %).', r.proname, v_n;
    end if;
  end loop;

  for r in
    select p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (v_allowed)
  loop
    if r.prosrc !~* 'is_admin' then
      raise exception 'Validación fallida: % no verifica is_admin().', r.proname;
    end if;

    if not r.prosecdef then
      raise exception 'Validación fallida: % debe ser security definer.', r.proname;
    end if;

    if not exists (
      select 1 from unnest(coalesce(r.proconfig, '{}'::text[])) c where c ~ '^search_path='
    ) then
      raise exception 'Validación fallida: % debe fijar search_path.', r.proname;
    end if;

    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_function_privilege('anon', r.oid, 'execute') then
      raise exception 'Validación fallida: anon puede ejecutar %.', r.proname;
    end if;

    if not has_function_privilege('authenticated', r.oid, 'execute') then
      raise exception 'Validación fallida: authenticated no puede ejecutar %.', r.proname;
    end if;
  end loop;

  -- 3.6 profiles: solo SELECT (propia fila / familia) y UPDATE (fila propia);
  --     ninguna policy abierta ni para anon/public
  select count(*) into v_n
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'profiles'
    and pol.cmd not in ('SELECT', 'UPDATE');
  if v_n > 0 then
    raise exception 'Validación fallida: profiles tiene % policy(ies) distintas de SELECT/UPDATE.', v_n;
  end if;

  select count(*) into v_n
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'profiles' and pol.cmd = 'SELECT';
  if v_n <> 1 then
    raise exception 'Validación fallida: profiles debe tener exactamente 1 policy de SELECT (hay %).', v_n;
  end if;

  select count(*) into v_n
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'profiles' and pol.cmd = 'SELECT'
    and coalesce(pol.qual, '') ~* 'auth\.uid\(\)'
    and coalesce(pol.qual, '') ~* 'my_family_id'
    and lower(trim(coalesce(pol.qual, ''))) <> 'true';
  if v_n <> 1 then
    raise exception 'Validación fallida: la policy de SELECT de profiles debe limitarse a auth.uid() / my_family_id().';
  end if;

  select count(*) into v_n
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'profiles'
    and (pol.roles && array['anon', 'public']::name[]
         or lower(trim(coalesce(pol.qual, ''))) = 'true'
         or lower(trim(coalesce(pol.with_check, ''))) = 'true');
  if v_n > 0 then
    raise exception 'Validación fallida: profiles tiene % policy(ies) abiertas o para anon/public.', v_n;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.profiles', 'select') then
    raise exception 'Validación fallida: anon conserva SELECT sobre profiles.';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.profiles'::regclass) then
    raise exception 'Validación fallida: RLS deshabilitado en profiles.';
  end if;

  raise notice 'admin_cleanup OK: sin is_admin() fuera de %, profiles limitado a la propia familia.', v_allowed;
end;
$$;
