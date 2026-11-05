-- ============================================================
-- PlanDental — Sub-tarea 4: ingredientes por familia (sin bypass de admin)
--
-- Cambios:
--   1. ingredients.family_id (FK a families, on delete restrict):
--      backfill desde la familia del owner, default my_family_id()
--      para los inserts del cliente y NOT NULL.
--   2. owner_id pasa a ser solo "creador": default auth.uid() y no
--      editable por clientes. No interviene en ningún permiso.
--   3. Deduplicación previa: si dos miembros de una misma familia tienen
--      el mismo nombre (case-insensitive), se conserva una sola fila
--      (la de pablo, o la del owner más antiguo) y se borra la otra.
--   4. Unicidad por familia:
--        - UNIQUE CONSTRAINT (family_id, nombre): es lo que usa el upsert
--          de supabase-js (onConflict: 'family_id,nombre'); PostgREST no
--          puede inferir un índice sobre expresiones como lower(nombre).
--        - UNIQUE INDEX (family_id, lower(nombre)): garantiza la unicidad
--          case-insensitive (evita "Pollo" y "pollo" en la misma familia).
--      Se elimina la unicidad (owner_id, nombre).
--   5. Policies select/insert/update/delete por family_id = my_family_id()
--      (sin is_admin(), sin acceso anon).
--   6. Se elimina shares_access_with(uuid) (deprecada desde la sub-tarea 3).
--      same_family(uuid) se conserva (helper genérico, sin dependencias).
--
-- Idempotente: se puede ejecutar más de una vez.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. family_id: columna, backfill y NOT NULL
--    (sin default hasta terminar el backfill: en la migración
--     my_family_id() devolvería NULL porque no hay auth.uid())
-- ────────────────────────────────────────────────────────────
alter table public.ingredients
  add column if not exists family_id uuid references public.families(id) on delete restrict;

update public.ingredients i
set    family_id = pr.family_id
from   public.profiles pr
where  pr.id = i.owner_id
  and  i.family_id is null;

do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.ingredients where family_id is null;
  if v_n > 0 then
    raise exception 'Backfill fallido: % ingrediente(s) sin family_id (owner sin familia).', v_n;
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 2. Deduplicación por (family_id, lower(nombre))
--    Antes de borrar se comprueba que ninguna FK apunte a ingredients.
--    (Hoy ninguna tabla referencia ingredients(id); las recetas guardan
--     el nombre del ingrediente como texto dentro del jsonb.)
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_fks     text;
  v_deleted integer;
begin
  select string_agg(conrelid::regclass::text || '.' || conname, ', ')
    into v_fks
  from pg_constraint
  where contype = 'f'
    and confrelid = 'public.ingredients'::regclass;

  if v_fks is not null then
    raise exception 'Hay FKs que referencian ingredients(id) (%); revisá antes de deduplicar.', v_fks;
  end if;

  with ranked as (
    select i.id,
           row_number() over (
             partition by i.family_id, lower(i.nombre)
             order by (lower(pr.username) = 'pablo') desc,
                      pr.created_at,
                      i.created_at,
                      i.id
           ) as rn
    from public.ingredients i
    join public.profiles pr on pr.id = i.owner_id
  )
  delete from public.ingredients
  where id in (select id from ranked where rn > 1);

  get diagnostics v_deleted = row_count;
  raise notice 'Ingredientes duplicados dentro de una familia eliminados: %', v_deleted;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 3. Unicidad por familia
-- ────────────────────────────────────────────────────────────
alter table public.ingredients
  drop constraint if exists ingredients_owner_id_nombre_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ingredients'::regclass
      and conname  = 'ingredients_family_nombre_key'
  ) then
    alter table public.ingredients
      add constraint ingredients_family_nombre_key unique (family_id, nombre);
  end if;
end;
$$;

create unique index if not exists ingredients_family_nombre_lower_idx
  on public.ingredients (family_id, lower(nombre));

-- ────────────────────────────────────────────────────────────
-- 4. Defaults, NOT NULL y protección de propiedad
-- ────────────────────────────────────────────────────────────
alter table public.ingredients
  alter column family_id set default public.my_family_id(),
  alter column family_id set not null,
  alter column owner_id  set default auth.uid();

comment on column public.ingredients.family_id is
  'Familia dueña del ingrediente. Es la unidad de acceso (RLS): default my_family_id().';
comment on column public.ingredients.owner_id is
  'Perfil que creó el ingrediente. Solo informativo: no se usa para permisos.';
comment on table public.ingredients is
  'Catálogo de ingredientes por familia. Cualquier miembro de la familia puede '
  'leer, crear, editar y borrar; owner_id solo registra quién lo creó.';

-- family_id y owner_id no son editables por clientes (el upsert de
-- supabase-js no envía owner_id, así que editar el ingrediente de otro
-- miembro no cambia su creador).
-- No es security definer: current_user debe ser el rol que ejecuta.
create or replace function public.ingredients_protect_ownership()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.family_id is distinct from old.family_id
      or new.owner_id is distinct from old.owner_id)
     and current_user not in ('postgres', 'supabase_admin', 'service_role', 'dashboard_user') then
    raise exception 'No está permitido modificar la familia ni el creador de un ingrediente.';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_ingredients_protect_ownership on public.ingredients;
create trigger tr_ingredients_protect_ownership
  before update on public.ingredients
  for each row
  execute function public.ingredients_protect_ownership();

-- ────────────────────────────────────────────────────────────
-- 5. RLS: policies por familia, sin is_admin()
-- ────────────────────────────────────────────────────────────
alter table public.ingredients enable row level security;

drop policy if exists "ingredients: select" on public.ingredients;
drop policy if exists "ingredients: insert" on public.ingredients;
drop policy if exists "ingredients: update" on public.ingredients;
drop policy if exists "ingredients: delete" on public.ingredients;
drop policy if exists "ingredients: family select" on public.ingredients;
drop policy if exists "ingredients: family insert" on public.ingredients;
drop policy if exists "ingredients: family update" on public.ingredients;
drop policy if exists "ingredients: family delete" on public.ingredients;

create policy "ingredients: family select"
  on public.ingredients
  for select
  to authenticated
  using (family_id = public.my_family_id());

-- INSERT: en la familia propia y registrando al usuario actual como creador
create policy "ingredients: family insert"
  on public.ingredients
  for insert
  to authenticated
  with check (
    family_id = public.my_family_id()
    and owner_id = auth.uid()
  );

create policy "ingredients: family update"
  on public.ingredients
  for update
  to authenticated
  using (family_id = public.my_family_id())
  with check (family_id = public.my_family_id());

create policy "ingredients: family delete"
  on public.ingredients
  for delete
  to authenticated
  using (family_id = public.my_family_id());

revoke all on public.ingredients from anon;
revoke truncate on public.ingredients from authenticated;  -- TRUNCATE saltea RLS

-- ────────────────────────────────────────────────────────────
-- 6. Eliminar shares_access_with(uuid)
--    Sin cascade; antes se comprueba que nada más la use.
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_names text;
begin
  select string_agg(pol.tablename || '.' || pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public'
    and (coalesce(pol.qual, '')       ~* 'shares_access_with'
      or coalesce(pol.with_check, '') ~* 'shares_access_with');
  if v_names is not null then
    raise exception 'shares_access_with sigue en uso por policies: %', v_names;
  end if;

  select string_agg(p.proname, ', ')
    into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname <> 'shares_access_with'
    and p.prosrc ~* 'shares_access_with';
  if v_names is not null then
    raise exception 'shares_access_with sigue en uso por funciones: %', v_names;
  end if;
end;
$$;

drop function if exists public.shares_access_with(uuid);

-- ────────────────────────────────────────────────────────────
-- 7. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_n     integer;
  v_names text;
  r       record;
begin
  -- family_id nunca nulo
  select count(*) into v_n from public.ingredients where family_id is null;
  if v_n > 0 then
    raise exception 'Validación fallida: % ingrediente(s) con family_id nulo.', v_n;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ingredients'
      and column_name = 'family_id' and is_nullable = 'YES'
  ) then
    raise exception 'Validación fallida: ingredients.family_id admite nulos.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ingredients'
      and column_name = 'family_id' and column_default ~* 'my_family_id'
  ) then
    raise exception 'Validación fallida: ingredients.family_id no tiene default my_family_id().';
  end if;

  -- family_id consistente con la familia del owner
  select count(*) into v_n
  from public.ingredients i
  join public.profiles pr on pr.id = i.owner_id
  where i.family_id <> pr.family_id;
  if v_n > 0 then
    raise exception 'Validación fallida: % ingrediente(s) con familia distinta a la de su owner.', v_n;
  end if;

  -- Sin duplicados (family_id, lower(nombre))
  select count(*) into v_n
  from (
    select 1
    from public.ingredients
    group by family_id, lower(nombre)
    having count(*) > 1
  ) d;
  if v_n > 0 then
    raise exception 'Validación fallida: % grupo(s) duplicados por (family_id, lower(nombre)).', v_n;
  end if;

  -- Unicidad: constraint para onConflict + índice case-insensitive; la antigua ya no existe
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ingredients'::regclass
      and conname = 'ingredients_family_nombre_key' and contype = 'u'
  ) then
    raise exception 'Validación fallida: falta la constraint unique (family_id, nombre).';
  end if;
  if to_regclass('public.ingredients_family_nombre_lower_idx') is null then
    raise exception 'Validación fallida: falta el índice único (family_id, lower(nombre)).';
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.ingredients'::regclass
      and conname = 'ingredients_owner_id_nombre_key'
  ) then
    raise exception 'Validación fallida: sigue existiendo unique (owner_id, nombre).';
  end if;

  -- Policies: exactamente select/insert/update/delete, por familia, sin is_admin/shares_access_with
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public' and tablename = 'ingredients';
  if v_n <> 4 then
    raise exception 'Validación fallida: ingredients tiene % policies (se esperaban 4).', v_n;
  end if;

  select string_agg(pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'ingredients'
    and (coalesce(pol.qual, '')       ~* '(is_admin|shares_access_with)'
      or coalesce(pol.with_check, '') ~* '(is_admin|shares_access_with)');
  if v_names is not null then
    raise exception 'Validación fallida: policies de ingredients con is_admin()/shares_access_with: %', v_names;
  end if;

  select string_agg(pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'ingredients'
    and not (
      case pol.cmd
        when 'INSERT' then coalesce(pol.with_check, '') ~* 'my_family_id\(\)'
        when 'UPDATE' then (coalesce(pol.qual, '')       ~* 'my_family_id\(\)')
                       and (coalesce(pol.with_check, '') ~* 'my_family_id\(\)')
        else coalesce(pol.qual, '') ~* 'my_family_id\(\)'
      end
    );
  if v_names is not null then
    raise exception 'Validación fallida: policies de ingredients que no filtran por my_family_id(): %', v_names;
  end if;

  select string_agg(pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'ingredients'
    and (pol.roles && array['anon'::name, 'public'::name]);
  if v_names is not null then
    raise exception 'Validación fallida: policies de ingredients aplicables a anon/public: %', v_names;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.ingredients', 'select,insert,update,delete') then
    raise exception 'Validación fallida: anon conserva privilegios sobre ingredients.';
  end if;

  -- shares_access_with eliminada y sin referencias
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'shares_access_with'
  ) then
    raise exception 'Validación fallida: la función shares_access_with sigue existiendo.';
  end if;

  select string_agg(p.proname, ', ')
    into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.prosrc ~* 'shares_access_with';
  if v_names is not null then
    raise exception 'Validación fallida: funciones que aún referencian shares_access_with: %', v_names;
  end if;

  -- Conteos por familia (informativo)
  for r in
    select f.name,
           count(i.id) as n_ingredients,
           (select string_agg(pr.username, ', ' order by pr.username)
              from public.profiles pr where pr.family_id = f.id) as members
    from public.families f
    left join public.ingredients i on i.family_id = f.id
    group by f.id, f.name
    order by f.name
  loop
    raise notice 'Familia "%" (miembros: %): % ingrediente(s)', r.name, coalesce(r.members, '-'), r.n_ingredients;
  end loop;
end;
$$;
