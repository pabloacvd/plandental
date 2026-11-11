-- ============================================================
-- PlanDental — Perfil y progreso: historial de peso, metas y recálculo
--
-- Cambios:
--   1. nutrition_data: activity_level, goal, deficit_pct, target_weight_kg,
--      auto_recalc.
--   2. weight_log: historial de peso por persona (único por persona y día).
--      Fuente única de verdad del peso.
--   3. targets_history: historial de cambios de metas (auto / manual) con
--      reversión. Índice único parcial: un 'auto' por persona y semana.
--   4. Vista person_daily_intake (security_invoker): suma de plans.macros por
--      persona y día. Aplican las policies del usuario que consulta.
--   5. Trigger: nutrition_data.weight_kg = peso del date_key más reciente
--      de weight_log.
--   6. Backfill de weight_log con el weight_kg actual (fecha aproximada:
--      updated_at de la fila de nutrition_data).
--   7. RLS por familia (person_in_my_family). Sin acceso anon, sin bypass de
--      admin. targets_history es de solo lectura para el cliente: se escribe
--      únicamente con las RPCs apply_targets_change / revert_targets_change.
--   8. RPCs security definer: apply_targets_change, revert_targets_change.
--   9. Validación final con raise exception.
--
-- Idempotente: se puede ejecutar más de una vez.
-- Requiere 20261105000300_remove_person_access.sql (person_in_my_family).
-- Requiere Postgres 15+ (security_invoker en vistas).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. nutrition_data: parámetros del usuario
-- ────────────────────────────────────────────────────────────
alter table public.nutrition_data
  add column if not exists activity_level   text    not null default 'moderado',
  add column if not exists goal             text    not null default 'bajar',
  add column if not exists deficit_pct      numeric not null default 20,
  add column if not exists target_weight_kg numeric,
  add column if not exists auto_recalc      boolean not null default true;

alter table public.nutrition_data drop constraint if exists nutrition_data_activity_level_check;
alter table public.nutrition_data add  constraint nutrition_data_activity_level_check
  check (activity_level in ('sedentario', 'ligero', 'moderado', 'alto', 'atleta'));

alter table public.nutrition_data drop constraint if exists nutrition_data_goal_check;
alter table public.nutrition_data add  constraint nutrition_data_goal_check
  check (goal in ('bajar', 'mantener', 'subir'));

alter table public.nutrition_data drop constraint if exists nutrition_data_deficit_pct_check;
alter table public.nutrition_data add  constraint nutrition_data_deficit_pct_check
  check (deficit_pct between 0 and 30);

alter table public.nutrition_data drop constraint if exists nutrition_data_target_weight_check;
alter table public.nutrition_data add  constraint nutrition_data_target_weight_check
  check (target_weight_kg is null or (target_weight_kg > 0 and target_weight_kg < 500));

comment on column public.nutrition_data.activity_level is
  'sedentario 1.2 / ligero 1.375 / moderado 1.55 (3-5 días, 30-60 min) / alto 1.725 / atleta 1.9.';
comment on column public.nutrition_data.deficit_pct is
  'Porcentaje de déficit sobre el mantenimiento cuando goal = bajar (default 20).';
comment on column public.nutrition_data.auto_recalc is
  'Si es true, la app recalcula las metas automáticamente (como máximo una vez por semana).';

-- ────────────────────────────────────────────────────────────
-- 2. weight_log
-- ────────────────────────────────────────────────────────────
create table if not exists public.weight_log (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.persons(id) on delete cascade,
  date_key   text not null,
  weight_kg  numeric not null,
  created_at timestamptz not null default now(),
  constraint weight_log_person_date_key unique (person_id, date_key),
  constraint weight_log_weight_check check (weight_kg > 0 and weight_kg < 500),
  constraint weight_log_date_check
    check (date_key ~ '^\d{4}-\d{2}-\d{2}$' and to_char(date_key::date, 'YYYY-MM-DD') = date_key)
);

comment on table public.weight_log is
  'Historial de peso (kg) por persona. Una fila por persona y día; cargar el mismo día sobrescribe. '
  'nutrition_data.weight_kg se sincroniza por trigger con el date_key más reciente.';

create index if not exists weight_log_person_date_idx on public.weight_log(person_id, date_key desc);

-- ────────────────────────────────────────────────────────────
-- 3. targets_history
-- ────────────────────────────────────────────────────────────
create table if not exists public.targets_history (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.persons(id) on delete cascade,
  week_key    text not null check (week_key ~ '^\d{4}-W\d{2}$'),
  source      text not null check (source in ('auto', 'manual')),
  reason      text not null default '',
  previous    jsonb not null,
  new         jsonb not null,
  created_at  timestamptz not null default now(),
  reverted_at timestamptz
);

comment on table public.targets_history is
  'Cambios de metas calóricas/macros. Se escribe solo vía apply_targets_change / revert_targets_change.';

create index if not exists targets_history_person_idx
  on public.targets_history(person_id, created_at desc);

-- Un único recálculo automático por persona y semana (aunque se revierta).
create unique index if not exists targets_history_auto_week_uq
  on public.targets_history(person_id, week_key)
  where source = 'auto';

-- ────────────────────────────────────────────────────────────
-- 4. Vista person_daily_intake (ingesta = lo que dice el plan)
-- ────────────────────────────────────────────────────────────
create or replace view public.person_daily_intake
with (security_invoker = true) as
select
  p.person_id,
  p.date_key,
  sum(coalesce(nullif(p.macros->>'calorias', '')::numeric, 0))        as kcal,
  sum(coalesce(nullif(p.macros->>'proteina_g', '')::numeric, 0))      as protein_g,
  sum(coalesce(nullif(p.macros->>'carbohidratos_g', '')::numeric, 0)) as carbs_g,
  sum(coalesce(nullif(p.macros->>'grasas_g', '')::numeric, 0))        as fat_g,
  count(*)::integer                                                    as meals_count
from public.plans p
group by p.person_id, p.date_key;

comment on view public.person_daily_intake is
  'Totales diarios del plan por persona (el plan es el 100% de la ingesta). security_invoker: aplica RLS de plans.';

-- ────────────────────────────────────────────────────────────
-- 5. Trigger: weight_log → nutrition_data.weight_kg
-- ────────────────────────────────────────────────────────────
create or replace function public.sync_nutrition_weight()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person uuid;
  v_latest numeric;
begin
  for v_person in
    select distinct x from unnest(array[
      case when tg_op in ('UPDATE', 'DELETE') then old.person_id end,
      case when tg_op in ('INSERT', 'UPDATE') then new.person_id end
    ]) as x
    where x is not null
  loop
    select wl.weight_kg into v_latest
    from public.weight_log wl
    where wl.person_id = v_person
    order by wl.date_key desc
    limit 1;

    -- Sin pesajes restantes se conserva el último valor; solo se actualiza
    -- si la fila de nutrition_data ya existe.
    if v_latest is not null then
      update public.nutrition_data
      set weight_kg = v_latest
      where person_id = v_person
        and weight_kg is distinct from v_latest;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.sync_nutrition_weight() from public, anon, authenticated;

drop trigger if exists tr_weight_log_sync on public.weight_log;
create trigger tr_weight_log_sync
  after insert or update or delete on public.weight_log
  for each row
  execute function public.sync_nutrition_weight();

-- Una fila nueva de nutrition_data nace con el último peso registrado
-- (el trigger anterior solo actúa cuando cambia weight_log).
create or replace function public.init_nutrition_weight()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.weight_kg is null then
    select wl.weight_kg into new.weight_kg
    from public.weight_log wl
    where wl.person_id = new.person_id
    order by wl.date_key desc
    limit 1;
  end if;
  return new;
end;
$$;

revoke all on function public.init_nutrition_weight() from public, anon, authenticated;

drop trigger if exists tr_nutrition_init_weight on public.nutrition_data;
create trigger tr_nutrition_init_weight
  before insert on public.nutrition_data
  for each row
  execute function public.init_nutrition_weight();

-- ────────────────────────────────────────────────────────────
-- 6. Backfill (fecha aproximada: updated_at de nutrition_data)
-- ────────────────────────────────────────────────────────────
insert into public.weight_log (person_id, date_key, weight_kg)
select nd.person_id, to_char(nd.updated_at, 'YYYY-MM-DD'), nd.weight_kg
from public.nutrition_data nd
where nd.weight_kg is not null
on conflict (person_id, date_key) do nothing;

-- ────────────────────────────────────────────────────────────
-- 7. RLS por familia (sin is_admin, sin anon)
-- ────────────────────────────────────────────────────────────
alter table public.weight_log      enable row level security;
alter table public.targets_history enable row level security;

drop policy if exists "weight_log: family access"      on public.weight_log;
drop policy if exists "targets_history: family select" on public.targets_history;

create policy "weight_log: family access" on public.weight_log
  for all
  to authenticated
  using      (public.person_in_my_family(person_id))
  with check (public.person_in_my_family(person_id));

create policy "targets_history: family select" on public.targets_history
  for select
  to authenticated
  using (public.person_in_my_family(person_id));

revoke all on public.weight_log      from anon, public;
revoke all on public.targets_history from anon, public;
revoke all on public.person_daily_intake from anon, public;

revoke truncate on public.weight_log from authenticated;
grant select, insert, update, delete on public.weight_log to authenticated;

revoke insert, update, delete, truncate on public.targets_history from authenticated;
grant select on public.targets_history to authenticated;

grant select on public.person_daily_intake to authenticated;

-- ────────────────────────────────────────────────────────────
-- 8. RPCs
-- ────────────────────────────────────────────────────────────

-- apply_targets_change: valida pertenencia y límites, inserta el historial y
-- actualiza nutrition_data en una sola transacción. En 'auto' es idempotente
-- por persona y semana: si ya existe devuelve la existente sin error.
create or replace function public.apply_targets_change(
  p_person_id uuid,
  p_source    text,
  p_reason    text,
  p_week_key  text,
  p_new       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_keys constant text[] := array[
    'maintenance_kcal', 'daily_calories_kcal', 'bmr_kcal',
    'protein_g', 'carbs_g', 'fat_g'
  ];
  v_key     text;
  v_val     numeric;
  v_nd      public.nutrition_data%rowtype;
  v_prev    jsonb := '{}'::jsonb;
  v_old     numeric;
  v_new_m   numeric;
  v_max     numeric;
  v_existing public.targets_history%rowtype;
  v_row     public.targets_history%rowtype;
begin
  if not public.person_in_my_family(p_person_id) then
    raise exception 'No autorizado.';
  end if;
  if p_source not in ('auto', 'manual') then
    raise exception 'Origen inválido.';
  end if;
  if p_week_key is null or p_week_key !~ '^\d{4}-W\d{2}$' then
    raise exception 'Semana inválida.';
  end if;
  if p_new is null or jsonb_typeof(p_new) <> 'object' or p_new = '{}'::jsonb then
    raise exception 'Metas inválidas.';
  end if;

  -- Claves permitidas y valores positivos
  for v_key in select jsonb_object_keys(p_new) loop
    if not (v_key = any (c_keys)) then
      raise exception 'Campo no permitido: %', v_key;
    end if;
    if jsonb_typeof(p_new->v_key) <> 'number' then
      raise exception 'Valor inválido para %', v_key;
    end if;
    v_val := (p_new->>v_key)::numeric;
    if v_val <= 0 or v_val > 20000 then
      raise exception 'Valor fuera de rango para %', v_key;
    end if;
  end loop;

  -- Bloquea la fila para serializar recálculos concurrentes de la familia
  select * into v_nd
  from public.nutrition_data
  where person_id = p_person_id
  for update;
  if not found then
    raise exception 'La persona no tiene datos nutricionales.';
  end if;

  if p_source = 'auto' then
    select * into v_existing
    from public.targets_history
    where person_id = p_person_id and week_key = p_week_key and source = 'auto';
    if found then
      return to_jsonb(v_existing) || jsonb_build_object('already_applied', true);
    end if;

    if p_new ? 'maintenance_kcal' then
      v_old   := v_nd.maintenance_kcal;
      v_new_m := (p_new->>'maintenance_kcal')::numeric;
      v_max   := least(v_old * 0.05, 150) + 0.5;
      if abs(v_new_m - v_old) > v_max then
        raise exception 'El cambio automático de mantenimiento supera el límite permitido.';
      end if;
    end if;
  end if;

  -- Valores previos de las claves que se van a cambiar
  select coalesce(jsonb_object_agg(k, to_jsonb(
           case k
             when 'maintenance_kcal'    then v_nd.maintenance_kcal
             when 'daily_calories_kcal' then v_nd.daily_calories_kcal
             when 'bmr_kcal'            then v_nd.bmr_kcal
             when 'protein_g'           then v_nd.protein_g
             when 'carbs_g'             then v_nd.carbs_g
             when 'fat_g'               then v_nd.fat_g
           end)), '{}'::jsonb)
    into v_prev
  from jsonb_object_keys(p_new) as k;

  insert into public.targets_history (person_id, week_key, source, reason, previous, new)
  values (p_person_id, p_week_key, p_source, left(coalesce(p_reason, ''), 1000), v_prev, p_new)
  returning * into v_row;

  update public.nutrition_data set
    maintenance_kcal    = coalesce((p_new->>'maintenance_kcal')::numeric,    maintenance_kcal),
    daily_calories_kcal = coalesce((p_new->>'daily_calories_kcal')::numeric, daily_calories_kcal),
    bmr_kcal            = coalesce((p_new->>'bmr_kcal')::numeric,            bmr_kcal),
    protein_g           = coalesce((p_new->>'protein_g')::numeric,           protein_g),
    carbs_g             = coalesce((p_new->>'carbs_g')::numeric,             carbs_g),
    fat_g               = coalesce((p_new->>'fat_g')::numeric,               fat_g),
    updated_at          = now()
  where person_id = p_person_id;

  return to_jsonb(v_row) || jsonb_build_object('already_applied', false);
end;
$$;

-- revert_targets_change: solo la última entrada no revertida de la persona.
create or replace function public.revert_targets_change(p_history_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_h      public.targets_history%rowtype;
  v_latest uuid;
  v_prev   jsonb;
begin
  select * into v_h from public.targets_history where id = p_history_id;
  if not found or not public.person_in_my_family(v_h.person_id) then
    raise exception 'No autorizado.';
  end if;

  perform 1 from public.nutrition_data where person_id = v_h.person_id for update;

  -- Relee tras el lock
  select * into v_h from public.targets_history where id = p_history_id;
  if v_h.reverted_at is not null then
    raise exception 'El cambio ya fue revertido.';
  end if;

  select id into v_latest
  from public.targets_history
  where person_id = v_h.person_id and reverted_at is null
  order by created_at desc, id desc
  limit 1;
  if v_latest is distinct from v_h.id then
    raise exception 'Solo se puede revertir el último cambio.';
  end if;

  v_prev := v_h.previous;
  update public.nutrition_data set
    maintenance_kcal    = coalesce((v_prev->>'maintenance_kcal')::numeric,    maintenance_kcal),
    daily_calories_kcal = coalesce((v_prev->>'daily_calories_kcal')::numeric, daily_calories_kcal),
    bmr_kcal            = coalesce((v_prev->>'bmr_kcal')::numeric,            bmr_kcal),
    protein_g           = case when v_prev ? 'protein_g' then (v_prev->>'protein_g')::numeric else protein_g end,
    carbs_g             = case when v_prev ? 'carbs_g'   then (v_prev->>'carbs_g')::numeric   else carbs_g   end,
    fat_g               = case when v_prev ? 'fat_g'     then (v_prev->>'fat_g')::numeric     else fat_g     end,
    updated_at          = now()
  where person_id = v_h.person_id;

  update public.targets_history set reverted_at = now()
  where id = v_h.id
  returning * into v_h;

  return to_jsonb(v_h);
end;
$$;

revoke all on function public.apply_targets_change(uuid, text, text, text, jsonb) from public, anon;
revoke all on function public.revert_targets_change(uuid)                         from public, anon;
grant execute on function public.apply_targets_change(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.revert_targets_change(uuid)                         to authenticated;

-- ────────────────────────────────────────────────────────────
-- 9. VALIDACIÓN FINAL
-- ────────────────────────────────────────────────────────────
do $$
declare
  v_t     text;
  v_names text;
begin
  foreach v_t in array array['weight_log', 'targets_history'] loop
    if to_regclass('public.' || v_t) is null then
      raise exception 'Validación fallida: no existe public.%.', v_t;
    end if;
    if not exists (select 1 from pg_class where oid = ('public.' || v_t)::regclass and relrowsecurity) then
      raise exception 'Validación fallida: RLS no está habilitado en %.', v_t;
    end if;

    select string_agg(policyname, ', ') into v_names
    from pg_policies
    where schemaname = 'public' and tablename = v_t
      and (coalesce(qual, '') ~* 'is_admin' or coalesce(with_check, '') ~* 'is_admin');
    if v_names is not null then
      raise exception 'Validación fallida: policies de % con is_admin(): %', v_t, v_names;
    end if;

    select string_agg(policyname, ', ') into v_names
    from pg_policies
    where schemaname = 'public' and tablename = v_t
      and (roles && array['anon'::name, 'public'::name]);
    if v_names is not null then
      raise exception 'Validación fallida: policies de % aplicables a anon/public: %', v_t, v_names;
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_t
        and coalesce(qual, '') ~* 'person_in_my_family'
    ) then
      raise exception 'Validación fallida: % no tiene policy basada en person_in_my_family.', v_t;
    end if;

    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_table_privilege('anon', 'public.' || v_t,
                               'select,insert,update,delete,truncate,references,trigger') then
      raise exception 'Validación fallida: anon conserva privilegios sobre %.', v_t;
    end if;
  end loop;

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

  -- targets_history: el cliente no escribe directamente
  if has_table_privilege('authenticated', 'public.targets_history', 'insert,update,delete') then
    raise exception 'Validación fallida: authenticated puede escribir targets_history directamente.';
  end if;

  -- Índice único parcial de recálculo automático
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'targets_history_auto_week_uq'
  ) then
    raise exception 'Validación fallida: falta el índice targets_history_auto_week_uq.';
  end if;

  -- Trigger de sincronización de peso
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.weight_log'::regclass
      and tgname = 'tr_weight_log_sync' and not tgisinternal
  ) then
    raise exception 'Validación fallida: falta el trigger tr_weight_log_sync.';
  end if;

  -- RPCs security definer con search_path fijo y sin acceso anon
  select string_agg(p.proname, ', ') into v_names
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('apply_targets_change', 'revert_targets_change', 'sync_nutrition_weight', 'init_nutrition_weight')
    and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=public, pg_temp']);
  if v_names is not null then
    raise exception 'Validación fallida: funciones sin security definer / search_path fijo: %', v_names;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_function_privilege('anon', 'public.apply_targets_change(uuid,text,text,text,jsonb)', 'execute')
          or has_function_privilege('anon', 'public.revert_targets_change(uuid)', 'execute')) then
    raise exception 'Validación fallida: anon puede ejecutar las RPCs de metas.';
  end if;

  -- Columnas nuevas de nutrition_data
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'nutrition_data'
        and column_name in ('activity_level', 'goal', 'deficit_pct', 'target_weight_kg', 'auto_recalc')) <> 5 then
    raise exception 'Validación fallida: faltan columnas nuevas en nutrition_data.';
  end if;

  raise notice 'weight_log / targets_history: validación OK (pesajes: %).',
    (select count(*) from public.weight_log);
end;
$$;
