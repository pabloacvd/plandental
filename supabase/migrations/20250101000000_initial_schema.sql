-- ============================================================
-- PlanDental — Supabase initial schema migration
-- Compatible with: supabase db push / SQL editor
-- Free-tier only. No paid add-ons used.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. PROFILES
--    One row per Supabase Auth user.
--    The user-facing login field is always "username".
--    Supabase Auth stores the identity as <username>@app.local
--    so the Auth layer never exposes a real email address.
-- ────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,
  role        text not null default 'user'
               check (role in ('user', 'admin')),
  created_at  timestamptz not null default now()
);
comment on table public.profiles is
  'One profile per auth.users row. username is the display name shown in the UI.';

-- Auto-create a profile row whenever a new auth user is inserted.
-- The username is extracted from the raw_user_meta_data that we pass during
-- sign-up (we set { username: "pablo" } in the options.data field).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'user')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ────────────────────────────────────────────────────────────
-- 2. PERSONS
--    A "person" is an individual whose nutrition plan exists.
--    Currently: Pablo, Juli. More can be added.
--    owner_id = the profile that created/owns this person record.
-- ────────────────────────────────────────────────────────────
create table if not exists public.persons (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner_id    uuid not null references public.profiles(id) on delete restrict,
  created_at  timestamptz not null default now()
);
comment on table public.persons is
  'Each individual whose meal plans are tracked. owner_id is the creating profile.';

create index if not exists persons_owner_idx on public.persons(owner_id);

-- ────────────────────────────────────────────────────────────
-- 3. PERSON_ACCESS
--    Models which profiles may access which persons.
--    status = 'approved' → full read/write access
--    status = 'pending'  → waiting for the target user to accept
-- ────────────────────────────────────────────────────────────
create table if not exists public.person_access (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references public.persons(id)   on delete cascade,
  granted_to   uuid not null references public.profiles(id)  on delete cascade,
  granted_by   uuid not null references public.profiles(id)  on delete cascade,
  status       text not null default 'pending'
               check (status in ('approved', 'pending')),
  created_at   timestamptz not null default now(),
  -- A profile can only have one access record per person
  unique (person_id, granted_to)
);
comment on table public.person_access is
  'approved = full access; pending = awaiting approval by granted_to.';

create index if not exists pa_person_idx     on public.person_access(person_id);
create index if not exists pa_granted_to_idx on public.person_access(granted_to);

-- ────────────────────────────────────────────────────────────
-- 4. VIEW: familia_flag
--    Returns, per profile, whether the "Familia" concept should
--    be shown in the UI.  Enforced at the data layer so UI just
--    reads this view — no hardcoded logic in JS needed.
--    show_familia = true  when the user has >= 2 approved persons.
-- ────────────────────────────────────────────────────────────
create or replace view public.familia_flag as
select
  granted_to                        as profile_id,
  count(*) >= 2                     as show_familia,
  count(*)                          as approved_count
from public.person_access
where status = 'approved'
group by granted_to;
comment on view public.familia_flag is
  'show_familia is true only when the user has access to 2+ persons. Read this in the UI instead of hardcoding the logic.';

-- ────────────────────────────────────────────────────────────
-- 5. PLANS
--    Each row = one meal slot assignment for one person on one day.
--    Replaces the nested plan.json structure.
--
--    person_id  → persons.id (data scoped to a person, not a profile)
--    date_key   → "YYYY-MM-DD"
--    week_key   → "YYYY-Www"   (derived, stored for fast weekly queries)
--    slot_id    → 'desayuno' | 'almuerzo' | 'snack_tarde' | 'cena' | 'snack_noche'
--    recipe_id  → references recipes.id (loose FK — text, no hard constraint
--                 so missing/deleted recipes don't break the plan row)
--    recipe_name → denormalised for display without a join
--    macros      → JSONB snapshot of macros at assignment time
-- ────────────────────────────────────────────────────────────
create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references public.persons(id) on delete cascade,
  date_key     text not null,   -- 'YYYY-MM-DD'
  week_key     text not null,   -- 'YYYY-Www'
  slot_id      text not null
               check (slot_id in ('desayuno','almuerzo','snack_tarde','cena','snack_noche')),
  recipe_id    text not null,
  recipe_name  text not null,
  macros       jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- One slot per person per day (upsert key)
  unique (person_id, date_key, slot_id)
);
comment on table public.plans is
  'One row per meal slot per person per day. Replaces the nested plan.json file.';

create index if not exists plans_person_week_idx on public.plans(person_id, week_key);
create index if not exists plans_person_date_idx on public.plans(person_id, date_key);

-- ────────────────────────────────────────────────────────────
-- 6. RECIPES
--    Replaces data/recipes.json.
--    The full recipe object is stored in a JSONB `receta` column
--    to exactly preserve every existing field without schema churn.
--    Top-level searchable columns are extracted for indexing.
-- ────────────────────────────────────────────────────────────
create table if not exists public.recipes (
  id           text primary key,  -- slug, e.g. "batido-ninja-pablo"
  nombre       text not null,     -- receta.nombre (extracted for search)
  categoria    text,              -- receta.categoria
  receta       jsonb not null,    -- full receta object, preserves every field
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.recipes is
  'Recipe catalog. receta JSONB preserves every legacy field from recipes.json.';

-- Full-text search index on nombre + categoria
create index if not exists recipes_nombre_idx on public.recipes
  using gin (to_tsvector('spanish', coalesce(nombre,'') || ' ' || coalesce(categoria,'')));

-- ────────────────────────────────────────────────────────────
-- 7. NUTRITION_DATA
--    Replaces data/nutrition.json.
--    person_id scopes data to a person.
--    The full JSON blob is stored in `data` JSONB.
--    Top-level macro targets are extracted for easy querying.
-- ────────────────────────────────────────────────────────────
create table if not exists public.nutrition_data (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null unique references public.persons(id) on delete cascade,
  bmr_kcal             numeric,
  daily_calories_kcal  numeric,
  protein_g            numeric,
  carbs_g              numeric,
  fat_g                numeric,
  creatine_g           numeric,
  whey_g               numeric,
  whey_purity_percent  numeric,
  notes                text,
  data                 jsonb not null default '{}',  -- full blob for body_composition etc.
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.nutrition_data is
  'Nutrition targets per person. data JSONB stores body_composition and projection fields.';

-- ════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- All tables are locked down. Access is derived through person_access.
-- Admin role bypasses all restrictions.
-- ════════════════════════════════════════════════════════════

alter table public.profiles       enable row level security;
alter table public.persons        enable row level security;
alter table public.person_access  enable row level security;
alter table public.plans          enable row level security;
alter table public.recipes        enable row level security;
alter table public.nutrition_data enable row level security;

-- ── Helper: is the calling user an admin? ────────────────────
-- Defined as a security-definer function so the check runs with
-- elevated privileges and can read profiles without RLS recursion.
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ── Helper: does the calling user have approved access to a person? ──
create or replace function public.has_approved_access(p_person_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.person_access
    where person_id = p_person_id
      and granted_to = auth.uid()
      and status = 'approved'
  );
$$;

-- ────────────────────────────────────────────────────────────
-- PROFILES policies
-- ────────────────────────────────────────────────────────────
create policy "profiles: own row" on public.profiles
  for all using (id = auth.uid());

create policy "profiles: admin all" on public.profiles
  for all using (public.is_admin());

-- Allow any authenticated user to read other profiles by username
-- (needed for the access-request flow).
create policy "profiles: read any authenticated" on public.profiles
  for select using (auth.uid() is not null);

-- ────────────────────────────────────────────────────────────
-- PERSONS policies
-- ────────────────────────────────────────────────────────────
create policy "persons: owner or approved" on public.persons
  for select using (
    public.is_admin()
    or owner_id = auth.uid()
    or public.has_approved_access(id)
  );

create policy "persons: owner insert" on public.persons
  for insert with check (owner_id = auth.uid() or public.is_admin());

create policy "persons: owner update" on public.persons
  for update using (owner_id = auth.uid() or public.is_admin());

create policy "persons: owner delete" on public.persons
  for delete using (owner_id = auth.uid() or public.is_admin());

-- ────────────────────────────────────────────────────────────
-- PERSON_ACCESS policies
-- ────────────────────────────────────────────────────────────
-- A user can see their own access records, or records they granted.
create policy "person_access: involved parties" on public.person_access
  for select using (
    public.is_admin()
    or granted_to = auth.uid()
    or granted_by = auth.uid()
  );

create policy "person_access: insert by owner" on public.person_access
  for insert with check (granted_by = auth.uid() or public.is_admin());

-- Only the person the access was granted TO can approve it.
create policy "person_access: approve own" on public.person_access
  for update using (granted_to = auth.uid() or public.is_admin());

create policy "person_access: delete by parties" on public.person_access
  for delete using (
    public.is_admin()
    or granted_to = auth.uid()
    or granted_by = auth.uid()
  );

-- ────────────────────────────────────────────────────────────
-- PLANS policies
-- ────────────────────────────────────────────────────────────
create policy "plans: approved access only" on public.plans
  for all using (
    public.is_admin()
    or public.has_approved_access(person_id)
  );

-- ────────────────────────────────────────────────────────────
-- RECIPES policies
-- Any authenticated user can read recipes (they are shared/global).
-- Only admins (and the owner via person logic) can write.
-- ────────────────────────────────────────────────────────────
create policy "recipes: any authenticated reads" on public.recipes
  for select using (auth.uid() is not null);

create policy "recipes: authenticated insert" on public.recipes
  for insert with check (auth.uid() is not null);

create policy "recipes: authenticated update" on public.recipes
  for update using (auth.uid() is not null);

create policy "recipes: admin delete" on public.recipes
  for delete using (public.is_admin() or auth.uid() is not null);

-- ────────────────────────────────────────────────────────────
-- NUTRITION_DATA policies
-- ────────────────────────────────────────────────────────────
create policy "nutrition_data: approved access only" on public.nutrition_data
  for all using (
    public.is_admin()
    or public.has_approved_access(person_id)
  );
