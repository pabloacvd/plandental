-- ============================================================
-- PlanDental — Nutrition profile fields
-- Adds the per-person profile columns edited from "Mi cuenta":
--   maintenance_kcal (REQUIRED), weight_kg, height_cm, age_years, sex.
-- bmr_kcal and daily_calories_kcal already exist.
-- Safe to re-run.
-- ============================================================

-- ── 1. New columns ───────────────────────────────────────────
alter table public.nutrition_data
  add column if not exists maintenance_kcal numeric,
  add column if not exists weight_kg        numeric  check (weight_kg is null or weight_kg > 0),
  add column if not exists height_cm        numeric  check (height_cm is null or height_cm > 0),
  add column if not exists age_years        smallint check (age_years is null or age_years between 1 and 120),
  add column if not exists sex              text     check (sex is null or sex in ('male', 'female'));

comment on column public.nutrition_data.maintenance_kcal is
  'Maintenance calories per day. Required. 100% of the calorie bar; daily_calories_kcal and bmr_kcal are marked against it.';

-- ── 2. Backfill from the legacy JSON blob (Pablo has body_composition) ──
update public.nutrition_data
set maintenance_kcal = (data->'body_composition'->'calories'->>'maintenance_kcal_day')::numeric
where maintenance_kcal is null
  and data->'body_composition'->'calories' ? 'maintenance_kcal_day';

update public.nutrition_data
set weight_kg = (data->'body_composition'->'body'->>'weight_kg_current')::numeric
where weight_kg is null
  and data->'body_composition'->'body' ? 'weight_kg_current';

update public.nutrition_data
set height_cm = (data->'body_composition'->'body'->>'height_cm')::numeric
where height_cm is null
  and data->'body_composition'->'body' ? 'height_cm';

-- ── 3. Juli: maintenance inferred from her target (1690 kcal = 80% → 2113) ──
update public.nutrition_data nd
set maintenance_kcal = 2113
from public.persons p
where nd.person_id = p.id
  and lower(p.name) = 'juli'
  and nd.maintenance_kcal is null;

-- ── 4. Make maintenance_kcal mandatory ───────────────────────
-- Added NOT VALID so it is enforced on every insert/update, then validated
-- against existing rows. VALIDATE fails loudly if any row still has no
-- maintenance value (fix that row, then re-run).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'nutrition_data_maintenance_required'
      and conrelid = 'public.nutrition_data'::regclass
  ) then
    alter table public.nutrition_data
      add constraint nutrition_data_maintenance_required
      check (maintenance_kcal is not null and maintenance_kcal > 0) not valid;
  end if;
end;
$$;

alter table public.nutrition_data
  validate constraint nutrition_data_maintenance_required;
