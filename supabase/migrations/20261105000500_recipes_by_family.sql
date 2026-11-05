-- ============================================================
-- PlanDental — Sub-tarea 5: recetas por familia (sin bypass de admin)
--
-- Cambios:
--   1. recipes.family_id (FK a families, on delete restrict):
--      backfill con la familia de pablo (pablo + juli).
--   2. Modificación de PK: pasa de (id) a (family_id, id) como constraint
--      real para que supabase-js pueda usar onConflict: 'family_id,id'.
--   3. Copia del catálogo de la familia de pablo a cada una de las otras
--      familias existentes en families (lara, diana y cualquier otra),
--      conservando id, nombre, categoria, receta, created_at y updated_at.
--      Idempotente mediante ON CONFLICT (family_id, id) DO NOTHING.
--   4. recipes.family_id pasa a tener default my_family_id() y NOT NULL
--      (el default se aplica DESPUÉS del backfill).
--   5. Trigger BEFORE UPDATE que impide a clientes modificar family_id
--      (patrón recipes_protect_ownership(), permite postgres/service_role/etc.).
--   6. Reemplazo de las 4 policies de recipes por policies por familia:
--      select, insert, update y delete con family_id = my_family_id(),
--      to authenticated, sin is_admin().
--   7. Revoke all on recipes from anon; revoke truncate from authenticated.
--   8. Validación final con do $$ y raise exception.
--
-- Idempotente: se puede ejecutar más de una vez.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. recipes.family_id: columna y backfill desde la familia de pablo
--    (sin default hasta terminar el backfill: en la migración
--     my_family_id() devolvería NULL porque no hay auth.uid())
-- ────────────────────────────────────────────────────────────
alter table public.recipes
  add column if not exists family_id uuid references public.families(id) on delete restrict;

do $$
declare
  v_pablo_family_id uuid;
  v_n               integer;
begin
  select family_id into v_pablo_family_id
  from public.profiles
  where lower(username) = 'pablo';

  if v_pablo_family_id is null then
    raise exception 'Backfill fallido: no se encontró el perfil "pablo" o no tiene family_id asignado.';
  end if;

  update public.recipes
  set    family_id = v_pablo_family_id
  where  family_id is null;

  select count(*) into v_n from public.recipes where family_id is null;
  if v_n > 0 then
    raise exception 'Backfill fallido: % receta(s) quedaron con family_id nulo.', v_n;
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 2. Verificación de FKs entrantes y cambio de Primary Key
--    Antes de cambiar la PK de (id) a (family_id, id), comprobamos
--    que ninguna otra tabla dependa de recipes(id) por foreign key.
--    (plans.recipe_id y default_week.recipe_id son texto sin FK.)
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_fks text;
begin
  select string_agg(conrelid::regclass::text || '.' || conname, ', ')
    into v_fks
  from pg_constraint
  where contype = 'f'
    and confrelid = 'public.recipes'::regclass;

  if v_fks is not null then
    raise exception 'Hay FKs que referencian recipes(id) (%); revisá antes de modificar la PK.', v_fks;
  end if;
end;
$$;

alter table public.recipes
  drop constraint if exists recipes_pkey;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.recipes'::regclass
      and conname  = 'recipes_pkey'
      and contype  = 'p'
  ) then
    alter table public.recipes
      add constraint recipes_pkey primary key (family_id, id);
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 3. Copia del catálogo a las demás familias
--    Copia todas las recetas de la familia de pablo a lara, diana
--    y cualquier otra familia existente en families.
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_pablo_family_id uuid;
  v_copied          integer;
begin
  select family_id into v_pablo_family_id
  from public.profiles
  where lower(username) = 'pablo';

  if v_pablo_family_id is null then
    raise exception 'No se encontró el perfil "pablo" para copiar recetas a otras familias.';
  end if;

  insert into public.recipes (family_id, id, nombre, categoria, receta, created_at, updated_at)
  select f.id as family_id,
         r.id,
         r.nombre,
         r.categoria,
         r.receta,
         r.created_at,
         r.updated_at
  from public.recipes r
  cross join public.families f
  where r.family_id = v_pablo_family_id
    and f.id <> v_pablo_family_id
  on conflict (family_id, id) do nothing;

  get diagnostics v_copied = row_count;
  raise notice 'Recetas copiadas a otras familias: %', v_copied;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 4. Defaults, NOT NULL e índice de búsqueda
-- ────────────────────────────────────────────────────────────
alter table public.recipes
  alter column family_id set default public.my_family_id(),
  alter column family_id set not null;

comment on column public.recipes.family_id is
  'Familia dueña de la receta. Es la unidad de acceso (RLS): default my_family_id().';
comment on table public.recipes is
  'Catálogo de recetas por familia. Cada familia tiene su propio catálogo de recetas; '
  'cualquier miembro puede leer, crear, editar y borrar las recetas de su familia.';

-- Índice GIN para búsqueda full-text sobre nombre + categoria
create index if not exists recipes_nombre_idx on public.recipes
  using gin (to_tsvector('spanish', coalesce(nombre,'') || ' ' || coalesce(categoria,'')));

-- ────────────────────────────────────────────────────────────
-- 5. Protección de family_id en UPDATE
--    No es security definer: current_user debe ser el rol que ejecuta.
-- ────────────────────────────────────────────────────────────
create or replace function public.recipes_protect_ownership()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.family_id is distinct from old.family_id)
     and current_user not in ('postgres', 'supabase_admin', 'service_role', 'dashboard_user') then
    raise exception 'No está permitido modificar la familia de una receta.';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_recipes_protect_ownership on public.recipes;
create trigger tr_recipes_protect_ownership
  before update on public.recipes
  for each row
  execute function public.recipes_protect_ownership();

-- ────────────────────────────────────────────────────────────
-- 6. RLS: policies por familia, sin is_admin()
-- ────────────────────────────────────────────────────────────
alter table public.recipes enable row level security;

drop policy if exists "recipes: any authenticated reads" on public.recipes;
drop policy if exists "recipes: authenticated insert"    on public.recipes;
drop policy if exists "recipes: authenticated update"    on public.recipes;
drop policy if exists "recipes: admin delete"            on public.recipes;
drop policy if exists "recipes: family select"           on public.recipes;
drop policy if exists "recipes: family insert"           on public.recipes;
drop policy if exists "recipes: family update"           on public.recipes;
drop policy if exists "recipes: family delete"           on public.recipes;

create policy "recipes: family select"
  on public.recipes
  for select
  to authenticated
  using (family_id = public.my_family_id());

create policy "recipes: family insert"
  on public.recipes
  for insert
  to authenticated
  with check (family_id = public.my_family_id());

create policy "recipes: family update"
  on public.recipes
  for update
  to authenticated
  using (family_id = public.my_family_id())
  with check (family_id = public.my_family_id());

create policy "recipes: family delete"
  on public.recipes
  for delete
  to authenticated
  using (family_id = public.my_family_id());

revoke all on public.recipes from anon;
revoke truncate on public.recipes from authenticated;  -- TRUNCATE saltea RLS

-- ────────────────────────────────────────────────────────────
-- 7. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_n                  integer;
  v_names              text;
  v_pk_cols            text;
  v_pablo_family_id    uuid;
  v_pablo_recipe_count integer;
  r                    record;
begin
  -- 1. family_id nunca nulo
  select count(*) into v_n from public.recipes where family_id is null;
  if v_n > 0 then
    raise exception 'Validación fallida: % receta(s) con family_id nulo.', v_n;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'recipes'
      and column_name = 'family_id' and is_nullable = 'YES'
  ) then
    raise exception 'Validación fallida: recipes.family_id admite nulos.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'recipes'
      and column_name = 'family_id' and column_default ~* 'my_family_id'
  ) then
    raise exception 'Validación fallida: recipes.family_id no tiene default my_family_id().';
  end if;

  -- 2. PK compuesta (family_id, id)
  select string_agg(att.attname, ', ' order by array_position(con.conkey, att.attnum))
    into v_pk_cols
  from pg_constraint con
  join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
  where con.conrelid = 'public.recipes'::regclass
    and con.contype = 'p';

  if v_pk_cols is distinct from 'family_id, id' then
    raise exception 'Validación fallida: la PK de recipes es "%" (se esperaba "family_id, id").', v_pk_cols;
  end if;

  -- 3. Policies: exactamente 4, por familia, sin is_admin()
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public' and tablename = 'recipes';
  if v_n <> 4 then
    raise exception 'Validación fallida: recipes tiene % policies (se esperaban 4).', v_n;
  end if;

  select string_agg(pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'recipes'
    and (coalesce(pol.qual, '')       ~* 'is_admin'
      or coalesce(pol.with_check, '') ~* 'is_admin');
  if v_names is not null then
    raise exception 'Validación fallida: policies de recipes con is_admin(): %', v_names;
  end if;

  select string_agg(pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'recipes'
    and not (
      case pol.cmd
        when 'INSERT' then coalesce(pol.with_check, '') ~* 'my_family_id\(\)'
        when 'UPDATE' then (coalesce(pol.qual, '')       ~* 'my_family_id\(\)')
                       and (coalesce(pol.with_check, '') ~* 'my_family_id\(\)')
        else coalesce(pol.qual, '') ~* 'my_family_id\(\)'
      end
    );
  if v_names is not null then
    raise exception 'Validación fallida: policies de recipes que no filtran por my_family_id(): %', v_names;
  end if;

  select string_agg(pol.policyname, ', ')
    into v_names
  from pg_policies pol
  where pol.schemaname = 'public' and pol.tablename = 'recipes'
    and (pol.roles && array['anon'::name, 'public'::name]);
  if v_names is not null then
    raise exception 'Validación fallida: policies de recipes aplicables a anon/public: %', v_names;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.recipes', 'select,insert,update,delete') then
    raise exception 'Validación fallida: anon conserva privilegios sobre recipes.';
  end if;

  -- 4. Conteo de recetas por familia (todas deben tener la misma cantidad que Pablo)
  select family_id into v_pablo_family_id
  from public.profiles
  where lower(username) = 'pablo';

  select count(*) into v_pablo_recipe_count
  from public.recipes
  where family_id = v_pablo_family_id;

  for r in
    select f.id, f.name, count(rc.id) as n_recipes,
           (select string_agg(pr.username, ', ' order by pr.username)
              from public.profiles pr where pr.family_id = f.id) as members
    from public.families f
    left join public.recipes rc on rc.family_id = f.id
    group by f.id, f.name
    order by f.name
  loop
    if r.n_recipes <> v_pablo_recipe_count then
      raise exception 'Validación fallida: la familia "%" tiene % recetas (se esperaban % como en Pablo).',
        r.name, r.n_recipes, v_pablo_recipe_count;
    end if;
    raise notice 'Familia "%" (miembros: %): % receta(s)', r.name, coalesce(r.members, '-'), r.n_recipes;
  end loop;
end;
$$;
