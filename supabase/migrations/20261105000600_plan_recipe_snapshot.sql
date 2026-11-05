-- ============================================================
-- PlanDental — Sub-tarea 6: plan con recetas versionadas (snapshot completo)
--
-- Cambios:
--   1. plans.recipe_snapshot y default_week.recipe_snapshot (jsonb, nullable):
--      copia completa del objeto `receta` tal como estaba al asignar la comida.
--   2. Backfill de filas existentes (solo donde recipe_snapshot es NULL):
--        - snapshot = recipes.receta cuya recipes.id = recipe_id Y
--          recipes.family_id = persons.family_id (vía persons.id = person_id).
--          recipes.id ya no es único global, solo por familia.
--        - si la receta no existe: snapshot mínimo
--          { nombre: recipe_name, macros_por_porcion: macros }.
--      La columna `macros` NO se toca: ya está congelada por fila.
--      El snapshot del backfill es solo la mejor aproximación de
--      ingredientes/pasos (la versión histórica real no se guardó).
--   3. CHECK en ambas tablas: el snapshot es un objeto jsonb y pesa < 100 kB.
--      Se agrega después del backfill y valida las filas existentes.
--   4. upsert_plan_entry recibe p_recipe_snapshot jsonb default null.
--      Se elimina la firma vieja de 7 parámetros (evita sobrecarga ambigua).
--   5. Validación final con do $$ y raise exception.
--
-- Idempotente: se puede ejecutar más de una vez.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Columnas (nullable: los clientes viejos pueden no enviarlas)
-- ────────────────────────────────────────────────────────────
alter table public.plans        add column if not exists recipe_snapshot jsonb;
alter table public.default_week add column if not exists recipe_snapshot jsonb;

comment on column public.plans.recipe_snapshot is
  'Copia completa del objeto receta (ingredientes, pasos, macros, porciones, nombre, categoria, descripcion) al asignar la comida.';
comment on column public.default_week.recipe_snapshot is
  'Copia completa del objeto receta al guardar la semana por defecto.';

-- ────────────────────────────────────────────────────────────
-- 2. Backfill (solo filas sin snapshot). `macros` no se modifica.
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_plans_full  integer;
  v_plans_min   integer;
  v_week_full   integer;
  v_week_min    integer;
begin
  -- plans: snapshot completo desde la receta de la familia de la persona
  update public.plans p
  set    recipe_snapshot = (
           select r.receta
           from public.recipes r
           join public.persons pe on pe.id = p.person_id
           where r.id        = p.recipe_id
             and r.family_id = pe.family_id
             and jsonb_typeof(r.receta) = 'object'
             and octet_length(r.receta::text) < 102400
         )
  where  p.recipe_snapshot is null;
  get diagnostics v_plans_full = row_count;

  -- plans: snapshot mínimo para las que no tienen receta
  update public.plans p
  set    recipe_snapshot = jsonb_build_object(
           'nombre',             p.recipe_name,
           'macros_por_porcion', p.macros
         )
  where  p.recipe_snapshot is null;
  get diagnostics v_plans_min = row_count;

  -- default_week: idem
  update public.default_week d
  set    recipe_snapshot = (
           select r.receta
           from public.recipes r
           join public.persons pe on pe.id = d.person_id
           where r.id        = d.recipe_id
             and r.family_id = pe.family_id
             and jsonb_typeof(r.receta) = 'object'
             and octet_length(r.receta::text) < 102400
         )
  where  d.recipe_snapshot is null;
  get diagnostics v_week_full = row_count;

  update public.default_week d
  set    recipe_snapshot = jsonb_build_object(
           'nombre',             d.recipe_name,
           'macros_por_porcion', d.macros
         )
  where  d.recipe_snapshot is null;
  get diagnostics v_week_min = row_count;

  -- El primer update toca todas las filas sin snapshot (las que no tienen receta
  -- quedan en NULL por el subselect), así que v_*_full cuenta filas procesadas.
  -- Los conteos exactos completo/mínimo se informan en la validación final.
  raise notice 'Backfill plans: % fila(s) procesadas en el paso de receta, % con snapshot mínimo.',
    v_plans_full, v_plans_min;
  raise notice 'Backfill default_week: % fila(s) procesadas en el paso de receta, % con snapshot mínimo.',
    v_week_full, v_week_min;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 3. CHECK: objeto jsonb de menos de 100 kB (valida filas existentes)
-- ────────────────────────────────────────────────────────────
alter table public.plans
  drop constraint if exists plans_recipe_snapshot_check;
alter table public.plans
  add constraint plans_recipe_snapshot_check
  check (
    recipe_snapshot is null
    or (jsonb_typeof(recipe_snapshot) = 'object'
        and octet_length(recipe_snapshot::text) < 102400)
  );

alter table public.default_week
  drop constraint if exists default_week_recipe_snapshot_check;
alter table public.default_week
  add constraint default_week_recipe_snapshot_check
  check (
    recipe_snapshot is null
    or (jsonb_typeof(recipe_snapshot) = 'object'
        and octet_length(recipe_snapshot::text) < 102400)
  );

-- ────────────────────────────────────────────────────────────
-- 4. upsert_plan_entry con p_recipe_snapshot
--    Se elimina la firma vieja (7 parámetros) para no dejar
--    una sobrecarga ambigua con el default null.
-- ────────────────────────────────────────────────────────────
drop function if exists public.upsert_plan_entry(uuid, text, text, text, text, text, jsonb);

create or replace function public.upsert_plan_entry(
  p_person_id       uuid,
  p_date_key        text,
  p_week_key        text,
  p_slot_id         text,
  p_recipe_id       text,
  p_recipe_name     text,
  p_macros          jsonb,
  p_recipe_snapshot jsonb default null
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
    (person_id, date_key, week_key, slot_id, recipe_id, recipe_name, macros, recipe_snapshot, updated_at)
  values
    (p_person_id, p_date_key, p_week_key, p_slot_id, p_recipe_id, p_recipe_name, p_macros, p_recipe_snapshot, now())
  on conflict (person_id, date_key, slot_id) do update
    set recipe_id       = excluded.recipe_id,
        recipe_name     = excluded.recipe_name,
        macros          = excluded.macros,
        recipe_snapshot = excluded.recipe_snapshot,
        week_key        = excluded.week_key,
        updated_at      = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_plan_entry(uuid, text, text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.upsert_plan_entry(uuid, text, text, text, text, text, jsonb, jsonb) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_n          integer;
  v_def        text;
  v_plans_full integer;
  v_plans_min  integer;
  v_week_full  integer;
  v_week_min   integer;
  v_sec        boolean;
  v_cfg        text[];
begin
  -- 1. Columnas
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'plans'
      and column_name = 'recipe_snapshot' and data_type = 'jsonb'
  ) then
    raise exception 'Validación fallida: plans.recipe_snapshot (jsonb) no existe.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'default_week'
      and column_name = 'recipe_snapshot' and data_type = 'jsonb'
  ) then
    raise exception 'Validación fallida: default_week.recipe_snapshot (jsonb) no existe.';
  end if;

  -- 2. Ninguna fila sin snapshot tras el backfill
  select count(*) into v_n from public.plans where recipe_snapshot is null;
  if v_n > 0 then
    raise exception 'Validación fallida: % fila(s) de plans con recipe_snapshot nulo.', v_n;
  end if;
  select count(*) into v_n from public.default_week where recipe_snapshot is null;
  if v_n > 0 then
    raise exception 'Validación fallida: % fila(s) de default_week con recipe_snapshot nulo.', v_n;
  end if;

  -- 3. CHECKs presentes
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.plans'::regclass
      and conname = 'plans_recipe_snapshot_check' and contype = 'c' and convalidated
  ) then
    raise exception 'Validación fallida: falta el CHECK validado plans_recipe_snapshot_check.';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.default_week'::regclass
      and conname = 'default_week_recipe_snapshot_check' and contype = 'c' and convalidated
  ) then
    raise exception 'Validación fallida: falta el CHECK validado default_week_recipe_snapshot_check.';
  end if;

  -- 4. Firma vieja eliminada, firma nueva presente
  if to_regprocedure('public.upsert_plan_entry(uuid,text,text,text,text,text,jsonb)') is not null then
    raise exception 'Validación fallida: sigue existiendo la firma vieja de upsert_plan_entry (7 parámetros).';
  end if;
  if to_regprocedure('public.upsert_plan_entry(uuid,text,text,text,text,text,jsonb,jsonb)') is null then
    raise exception 'Validación fallida: no existe upsert_plan_entry con p_recipe_snapshot.';
  end if;

  select count(*) into v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'upsert_plan_entry';
  if v_n <> 1 then
    raise exception 'Validación fallida: hay % sobrecargas de upsert_plan_entry (se esperaba 1).', v_n;
  end if;

  -- 5. Propiedades de la función: security definer, search_path fijo, sin is_admin()
  select p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
    into v_sec, v_cfg, v_def
  from pg_proc p
  where p.oid = 'public.upsert_plan_entry(uuid,text,text,text,text,text,jsonb,jsonb)'::regprocedure;

  if not v_sec then
    raise exception 'Validación fallida: upsert_plan_entry no es security definer.';
  end if;
  if v_cfg is null or not exists (
    select 1 from unnest(v_cfg) c where c like 'search_path=%'
  ) then
    raise exception 'Validación fallida: upsert_plan_entry no fija search_path.';
  end if;
  if v_def ~* 'is_admin' then
    raise exception 'Validación fallida: upsert_plan_entry usa is_admin().';
  end if;
  if v_def !~* 'person_in_my_family' then
    raise exception 'Validación fallida: upsert_plan_entry no valida person_in_my_family().';
  end if;

  -- 6. Permisos: authenticated sí, anon/public no
  if not has_function_privilege('authenticated',
       'public.upsert_plan_entry(uuid,text,text,text,text,text,jsonb,jsonb)', 'execute') then
    raise exception 'Validación fallida: authenticated no puede ejecutar upsert_plan_entry.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon',
       'public.upsert_plan_entry(uuid,text,text,text,text,text,jsonb,jsonb)', 'execute') then
    raise exception 'Validación fallida: anon puede ejecutar upsert_plan_entry.';
  end if;

  -- 7. Conteos: snapshot completo (con ingredientes) vs mínimo (solo nombre + macros)
  select count(*) filter (where recipe_snapshot ? 'ingredientes'),
         count(*) filter (where not (recipe_snapshot ? 'ingredientes'))
    into v_plans_full, v_plans_min
  from public.plans;

  select count(*) filter (where recipe_snapshot ? 'ingredientes'),
         count(*) filter (where not (recipe_snapshot ? 'ingredientes'))
    into v_week_full, v_week_min
  from public.default_week;

  raise notice 'plans: % fila(s) con snapshot completo, % con snapshot mínimo.', v_plans_full, v_plans_min;
  raise notice 'default_week: % fila(s) con snapshot completo, % con snapshot mínimo.', v_week_full, v_week_min;
end;
$$;
