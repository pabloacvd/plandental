-- ============================================================
-- PlanDental — Default Week template
-- Each person can have a "default" set of meals (one per slot
-- per day-of-week). When a new week has no meals, the app
-- copies the default week in as a starting placeholder.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- default_week
--   person_id  → persons.id
--   day_index  → 0 (Monday) … 6 (Sunday)
--   slot_id    → same enum as plans
--   recipe_id / recipe_name / macros — snapshot at save time
-- ────────────────────────────────────────────────────────────
create table if not exists public.default_week (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references public.persons(id) on delete cascade,
  day_index    smallint not null check (day_index between 0 and 6),
  slot_id      text not null
               check (slot_id in ('desayuno','almuerzo','snack_tarde','cena','snack_noche')),
  recipe_id    text not null,
  recipe_name  text not null,
  macros       jsonb not null default '{}',
  updated_at   timestamptz not null default now(),
  -- One slot per person per day-of-week
  unique (person_id, day_index, slot_id)
);

comment on table public.default_week is
  'Template meal plan (one per day-of-week per person). Copied into a new week when it has no meals yet.';

create index if not exists default_week_person_idx on public.default_week(person_id);

-- ── RLS ─────────────────────────────────────────────────────
alter table public.default_week enable row level security;

create policy "default_week: approved access only" on public.default_week
  for all using (
    public.is_admin()
    or public.has_approved_access(person_id)
  );
