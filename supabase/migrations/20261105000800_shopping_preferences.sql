-- ============================================================
-- PlanDental — Sub-tarea 8: pre-selecciones de la lista de compras por familia
--
-- Cambios:
--   1. Tabla public.shopping_preferences (una fila por familia):
--        family_id   uuid PK, FK a families (on delete cascade),
--                    default my_family_id()
--        deselected  text[] con los ingredientes deseleccionados por defecto
--        updated_at  timestamptz (default now(); lo actualiza el cliente al guardar)
--      CHECK de tamaño: <= 1000 elementos, sin NULL y <= 20000 caracteres en total.
--   2. Trigger BEFORE UPDATE (no security definer) que impide cambiar family_id
--      (mismo patrón que recipes_protect_ownership()).
--   3. RLS: 4 policies (select/insert/update/delete) to authenticated con
--      family_id = my_family_id(). Sin is_admin(). anon sin privilegios.
--   4. Validación final con do $$ ... raise exception.
--
-- No se insertan filas semilla: my_family_id() devuelve NULL dentro de una
-- migración (no hay auth.uid()). Una familia sin fila usa SHOPPING_DESELECT_SEED
-- en el cliente; la fila se crea con el primer "Guardar pre-selecciones".
--
-- Idempotente: se puede ejecutar más de una vez.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Tabla
-- ────────────────────────────────────────────────────────────
create table if not exists public.shopping_preferences (
  family_id  uuid primary key
             references public.families(id) on delete cascade
             default public.my_family_id(),
  deselected text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.shopping_preferences
  drop constraint if exists shopping_preferences_deselected_check;
alter table public.shopping_preferences
  add constraint shopping_preferences_deselected_check
  check (
    cardinality(deselected) <= 1000
    and array_position(deselected, null) is null
    and coalesce(octet_length(array_to_string(deselected, ',')), 0) <= 20000
  );

comment on table public.shopping_preferences is
  'Ingredientes deseleccionados por defecto en la lista de compras, una fila por familia. '
  'Sin fila = el cliente usa su lista semilla.';
comment on column public.shopping_preferences.family_id is
  'Familia dueña de la preferencia (RLS): default my_family_id().';

-- ────────────────────────────────────────────────────────────
-- 2. Protección de family_id en UPDATE
--    No es security definer: current_user es el rol que ejecuta.
-- ────────────────────────────────────────────────────────────
create or replace function public.shopping_preferences_protect_ownership()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.family_id is distinct from old.family_id)
     and current_user not in ('postgres', 'supabase_admin', 'service_role', 'dashboard_user') then
    raise exception 'No está permitido modificar la familia de las pre-selecciones.';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_shopping_preferences_protect_ownership on public.shopping_preferences;
create trigger tr_shopping_preferences_protect_ownership
  before update on public.shopping_preferences
  for each row
  execute function public.shopping_preferences_protect_ownership();

-- ────────────────────────────────────────────────────────────
-- 3. RLS: policies por familia, sin is_admin()
-- ────────────────────────────────────────────────────────────
alter table public.shopping_preferences enable row level security;

drop policy if exists "shopping_preferences: family select" on public.shopping_preferences;
drop policy if exists "shopping_preferences: family insert" on public.shopping_preferences;
drop policy if exists "shopping_preferences: family update" on public.shopping_preferences;
drop policy if exists "shopping_preferences: family delete" on public.shopping_preferences;

create policy "shopping_preferences: family select"
  on public.shopping_preferences
  for select
  to authenticated
  using (family_id = public.my_family_id());

create policy "shopping_preferences: family insert"
  on public.shopping_preferences
  for insert
  to authenticated
  with check (family_id = public.my_family_id());

create policy "shopping_preferences: family update"
  on public.shopping_preferences
  for update
  to authenticated
  using (family_id = public.my_family_id())
  with check (family_id = public.my_family_id());

create policy "shopping_preferences: family delete"
  on public.shopping_preferences
  for delete
  to authenticated
  using (family_id = public.my_family_id());

revoke all on public.shopping_preferences from anon;
revoke all on public.shopping_preferences from public;
revoke truncate on public.shopping_preferences from authenticated;  -- TRUNCATE saltea RLS
grant select, insert, update, delete on public.shopping_preferences to authenticated;

-- ────────────────────────────────────────────────────────────
-- 4. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_n     integer;
  v_names text;
  v_pk    text;
begin
  -- Tabla
  if to_regclass('public.shopping_preferences') is null then
    raise exception 'Validación fallida: no existe public.shopping_preferences.';
  end if;

  -- PK = family_id
  select string_agg(att.attname, ', ' order by array_position(con.conkey, att.attnum))
    into v_pk
  from pg_constraint con
  join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
  where con.conrelid = 'public.shopping_preferences'::regclass
    and con.contype = 'p';
  if v_pk is distinct from 'family_id' then
    raise exception 'Validación fallida: la PK de shopping_preferences es "%" (se esperaba "family_id").', v_pk;
  end if;

  -- FK family_id -> families(id) on delete cascade
  if not exists (
    select 1 from pg_constraint
    where conrelid  = 'public.shopping_preferences'::regclass
      and contype   = 'f'
      and confrelid = 'public.families'::regclass
      and confdeltype = 'c'
  ) then
    raise exception 'Validación fallida: falta la FK family_id -> families(id) on delete cascade.';
  end if;

  -- Default de family_id
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shopping_preferences'
      and column_name = 'family_id' and column_default ~* 'my_family_id'
  ) then
    raise exception 'Validación fallida: shopping_preferences.family_id no tiene default my_family_id().';
  end if;

  -- CHECK de tamaño validado
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.shopping_preferences'::regclass
      and conname = 'shopping_preferences_deselected_check'
      and contype = 'c' and convalidated
  ) then
    raise exception 'Validación fallida: falta el CHECK validado shopping_preferences_deselected_check.';
  end if;

  -- Trigger de protección de family_id (no security definer)
  if not exists (
    select 1
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.shopping_preferences'::regclass
      and t.tgname = 'tr_shopping_preferences_protect_ownership'
      and not t.tgisinternal
      and not p.prosecdef
  ) then
    raise exception 'Validación fallida: falta el trigger tr_shopping_preferences_protect_ownership (o es security definer).';
  end if;

  -- RLS activo
  if not exists (
    select 1 from pg_class
    where oid = 'public.shopping_preferences'::regclass and relrowsecurity
  ) then
    raise exception 'Validación fallida: RLS no está habilitado en shopping_preferences.';
  end if;

  -- Exactamente 4 policies, una por comando
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public' and tablename = 'shopping_preferences';
  if v_n <> 4 then
    raise exception 'Validación fallida: shopping_preferences tiene % policies (se esperaban 4).', v_n;
  end if;

  select count(distinct cmd) into v_n
  from pg_policies
  where schemaname = 'public' and tablename = 'shopping_preferences'
    and cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if v_n <> 4 then
    raise exception 'Validación fallida: shopping_preferences no tiene una policy por cada SELECT/INSERT/UPDATE/DELETE.';
  end if;

  -- Sin is_admin()
  select string_agg(policyname, ', ') into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'shopping_preferences'
    and (coalesce(qual, '') ~* 'is_admin' or coalesce(with_check, '') ~* 'is_admin');
  if v_names is not null then
    raise exception 'Validación fallida: policies de shopping_preferences con is_admin(): %', v_names;
  end if;

  -- Todas filtran por my_family_id()
  select string_agg(pol.policyname, ', ') into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'shopping_preferences'
    and not (
      case pol.cmd
        when 'INSERT' then coalesce(pol.with_check, '') ~* 'my_family_id\(\)'
        when 'UPDATE' then (coalesce(pol.qual, '')       ~* 'my_family_id\(\)')
                       and (coalesce(pol.with_check, '') ~* 'my_family_id\(\)')
        else coalesce(pol.qual, '') ~* 'my_family_id\(\)'
      end
    );
  if v_names is not null then
    raise exception 'Validación fallida: policies de shopping_preferences que no filtran por my_family_id(): %', v_names;
  end if;

  -- Ninguna policy para anon/public
  select string_agg(policyname, ', ') into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'shopping_preferences'
    and (roles && array['anon'::name, 'public'::name]);
  if v_names is not null then
    raise exception 'Validación fallida: policies de shopping_preferences aplicables a anon/public: %', v_names;
  end if;

  -- anon sin privilegios
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.shopping_preferences',
                             'select,insert,update,delete,truncate,references,trigger') then
    raise exception 'Validación fallida: anon conserva privilegios sobre shopping_preferences.';
  end if;

  raise notice 'shopping_preferences: validación OK (filas actuales: %).',
    (select count(*) from public.shopping_preferences);
end;
$$;
