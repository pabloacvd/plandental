-- ============================================================
-- PlanDental — Porciones comidas y slots extra
--
-- Cambios:
--   1. plans y default_week: columna servings (porciones comidas,
--      default 1, entre 0,25 y 10). macros sigue siendo POR PORCIÓN;
--      se multiplica por servings al sumar.
--   2. plans y default_week: columna slot_period ('manana' | 'tarde' |
--      'noche'), nullable. Obligatoria solo para slots extra.
--   3. slot_id acepta los 5 slots fijos y 'extra_<n>'. El check
--      existente se busca por definición en pg_constraint (no se
--      asume su nombre) y se reemplaza.
--   4. Vista person_daily_intake: suma macros × servings (misma
--      forma de columnas, security_invoker = true).
--   5. Validación final con raise exception.
--
-- Sin cambios en RLS, policies ni grants.
-- Los datos existentes quedan intactos (servings = 1, slot_period null).
--
-- Idempotente: se puede ejecutar más de una vez.
-- Requiere 20261111000100_weight_log_and_goals.sql (person_daily_intake).
-- Requiere Postgres 15+ (security_invoker en vistas).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Columnas nuevas: servings y slot_period
-- ────────────────────────────────────────────────────────────
alter table public.plans
  add column if not exists servings    numeric not null default 1,
  add column if not exists slot_period text;

alter table public.default_week
  add column if not exists servings    numeric not null default 1,
  add column if not exists slot_period text;

comment on column public.plans.servings is
  'Porciones comidas de la receta (0,25–10). plans.macros es por porción: el total es macros × servings.';
comment on column public.plans.slot_period is
  'Período del slot extra (manana/tarde/noche). Null en los 5 slots fijos.';
comment on column public.default_week.servings is
  'Porciones comidas de la receta (0,25–10). default_week.macros es por porción.';
comment on column public.default_week.slot_period is
  'Período del slot extra (manana/tarde/noche). Null en los 5 slots fijos.';

-- ────────────────────────────────────────────────────────────
-- 2. Checks de servings y slot_period
-- ────────────────────────────────────────────────────────────
alter table public.plans drop constraint if exists plans_servings_check;
alter table public.plans add  constraint plans_servings_check
  check (servings >= 0.25 and servings <= 10);

alter table public.plans drop constraint if exists plans_slot_period_check;
alter table public.plans add  constraint plans_slot_period_check
  check (slot_period is null or slot_period in ('manana', 'tarde', 'noche'));

alter table public.default_week drop constraint if exists default_week_servings_check;
alter table public.default_week add  constraint default_week_servings_check
  check (servings >= 0.25 and servings <= 10);

alter table public.default_week drop constraint if exists default_week_slot_period_check;
alter table public.default_week add  constraint default_week_slot_period_check
  check (slot_period is null or slot_period in ('manana', 'tarde', 'noche'));

-- ────────────────────────────────────────────────────────────
-- 3. Check de slot_id: 5 fijos o extra_<n>
--    Se dropean por DEFINICIÓN todos los check constraints que
--    referencian slot_id y no referencian slot_period (el check
--    original inline, sea cual sea su nombre, y el de esta
--    migración si se re-ejecuta). Después se recrean con nombre
--    explícito.
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_tbl text;
  r     record;
begin
  foreach v_tbl in array array['plans', 'default_week'] loop
    for r in
      select c.conname
      from pg_constraint c
      where c.conrelid = ('public.' || v_tbl)::regclass
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ~ 'slot_id'
        and pg_get_constraintdef(c.oid) !~ 'slot_period'
    loop
      execute format('alter table public.%I drop constraint %I', v_tbl, r.conname);
    end loop;
  end loop;
end;
$$;

alter table public.plans add constraint plans_slot_id_check
  check (
    slot_id in ('desayuno', 'almuerzo', 'snack_tarde', 'cena', 'snack_noche')
    or slot_id ~ '^extra_[0-9]+$'
  );

alter table public.default_week add constraint default_week_slot_id_check
  check (
    slot_id in ('desayuno', 'almuerzo', 'snack_tarde', 'cena', 'snack_noche')
    or slot_id ~ '^extra_[0-9]+$'
  );

-- Los extras exigen slot_period
alter table public.plans drop constraint if exists plans_extra_requires_period_check;
alter table public.plans add  constraint plans_extra_requires_period_check
  check (slot_id !~ '^extra_' or slot_period is not null);

alter table public.default_week drop constraint if exists default_week_extra_requires_period_check;
alter table public.default_week add  constraint default_week_extra_requires_period_check
  check (slot_id !~ '^extra_' or slot_period is not null);

-- ────────────────────────────────────────────────────────────
-- 4. Vista person_daily_intake: macros × servings
--    Mismas columnas y tipos que antes (create or replace válido).
-- ────────────────────────────────────────────────────────────
create or replace view public.person_daily_intake
with (security_invoker = true) as
select
  p.person_id,
  p.date_key,
  sum(coalesce(nullif(p.macros->>'calorias', '')::numeric, 0)        * coalesce(p.servings, 1)) as kcal,
  sum(coalesce(nullif(p.macros->>'proteina_g', '')::numeric, 0)      * coalesce(p.servings, 1)) as protein_g,
  sum(coalesce(nullif(p.macros->>'carbohidratos_g', '')::numeric, 0) * coalesce(p.servings, 1)) as carbs_g,
  sum(coalesce(nullif(p.macros->>'grasas_g', '')::numeric, 0)        * coalesce(p.servings, 1)) as fat_g,
  count(*)::integer                                                                              as meals_count
from public.plans p
group by p.person_id, p.date_key;

comment on view public.person_daily_intake is
  'Totales diarios del plan por persona (macros por porción × servings). security_invoker: aplica RLS de plans.';

-- ────────────────────────────────────────────────────────────
-- 4b. Sin privilegios para anon sobre plans / default_week
--     (en Supabase anon recibe grants por defecto; las migraciones
--     originales nunca los revocaron. RLS ya bloqueaba el acceso,
--     esto cierra también el nivel de tabla. El cliente usa siempre
--     el rol authenticated.)
-- ────────────────────────────────────────────────────────────
revoke all on public.plans        from anon, public;
revoke all on public.default_week from anon, public;

-- ────────────────────────────────────────────────────────────
-- 5. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_t     text;
  v_n     integer;
  v_names text;
begin
  foreach v_t in array array['plans', 'default_week'] loop
    -- Columnas nuevas
    if (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = v_t
          and column_name in ('servings', 'slot_period')) <> 2 then
      raise exception 'Validación fallida: faltan columnas servings/slot_period en %.', v_t;
    end if;

    -- servings: numeric, not null, default 1
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v_t
        and column_name = 'servings'
        and data_type = 'numeric' and is_nullable = 'NO'
        and column_default ~ '^1'
    ) then
      raise exception 'Validación fallida: % servings debe ser numeric not null default 1.', v_t;
    end if;

    -- Checks activos y validados
    if (select count(*) from pg_constraint
        where conrelid = ('public.' || v_t)::regclass and contype = 'c' and convalidated
          and conname in (v_t || '_servings_check',
                          v_t || '_slot_period_check',
                          v_t || '_slot_id_check',
                          v_t || '_extra_requires_period_check')) <> 4 then
      raise exception 'Validación fallida: faltan checks de servings/slot_period/slot_id en %.', v_t;
    end if;

    -- Solo un check sobre slot_id (sin restos del check original)
    select count(*) into v_n
    from pg_constraint c
    where c.conrelid = ('public.' || v_t)::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~ 'slot_id'
      and pg_get_constraintdef(c.oid) !~ 'slot_period';
    if v_n <> 1 then
      raise exception 'Validación fallida: % tiene % checks de slot_id (se esperaba 1).', v_t, v_n;
    end if;

    -- RLS sigue habilitado
    if not exists (select 1 from pg_class where oid = ('public.' || v_t)::regclass and relrowsecurity) then
      raise exception 'Validación fallida: RLS no está habilitado en %.', v_t;
    end if;

    -- Sin policies para anon/public
    select string_agg(policyname, ', ') into v_names
    from pg_policies
    where schemaname = 'public' and tablename = v_t
      and (roles && array['anon'::name, 'public'::name]);
    if v_names is not null then
      raise exception 'Validación fallida: policies de % aplicables a anon/public: %', v_t, v_names;
    end if;

    -- Sin grants a anon
    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_table_privilege('anon', 'public.' || v_t,
                               'select,insert,update,delete,truncate,references,trigger') then
      raise exception 'Validación fallida: anon conserva privilegios sobre %.', v_t;
    end if;
  end loop;

  -- Filas existentes fuera de rango (no debería ocurrir: default 1)
  if exists (select 1 from public.plans where servings < 0.25 or servings > 10) then
    raise exception 'Validación fallida: plans con servings fuera de rango.';
  end if;

  -- Vista con security_invoker y sin acceso anon
  if not exists (
    select 1 from pg_class
    where oid = 'public.person_daily_intake'::regclass
      and coalesce(reloptions, '{}') @> array['security_invoker=true']
  ) then
    raise exception 'Validación fallida: person_daily_intake no es security_invoker.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.person_daily_intake', 'select') then
    raise exception 'Validación fallida: anon puede leer person_daily_intake.';
  end if;

  -- La vista expone las mismas columnas que antes
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'person_daily_intake'
        and column_name in ('person_id', 'date_key', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'meals_count')) <> 7 then
    raise exception 'Validación fallida: person_daily_intake cambió sus columnas.';
  end if;

  raise notice 'servings / slots extra: validación OK (plans: %, default_week: %).',
    (select count(*) from public.plans), (select count(*) from public.default_week);
end;
$$;
