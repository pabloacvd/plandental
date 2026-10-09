-- ============================================================
-- PlanDental — ingredients table, RLS and shared-access helper
-- Migration: 20250602000000_ingredients.sql
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. TABLE: public.ingredients
--
--    Each row is a reference ingredient owned by one profile.
--    Shared access between linked users is handled via RLS +
--    the shares_access_with() helper below.
--
--    Columns:
--      id                — UUID PK, auto-generated
--      owner_id          — profile that created the ingredient
--      nombre            — ingredient display name (unique per owner)
--      categoria         — optional grouping (e.g. "lácteos", "carnes")
--      unidad_referencia — 'g' | 'ml' | 'unidad'
--      cantidad_referencia — reference quantity (100 for g/ml, 1 for unidad)
--      calorias          — kcal per cantidad_referencia
--      proteina_g        — grams of protein per cantidad_referencia
--      carbohidratos_g   — grams of carbs per cantidad_referencia
--      grasas_g          — grams of fat per cantidad_referencia
--      created_at / updated_at
-- ────────────────────────────────────────────────────────────
create table if not exists public.ingredients (
  id                   uuid        primary key default gen_random_uuid(),
  owner_id             uuid        not null references public.profiles(id) on delete cascade,
  nombre               text        not null,
  categoria            text,
  unidad_referencia    text        not null default 'g'
                       check (unidad_referencia in ('g', 'ml', 'unidad')),
  cantidad_referencia  numeric     not null default 100
                       check (cantidad_referencia > 0),
  calorias             numeric     not null default 0,
  proteina_g           numeric     not null default 0,
  carbohidratos_g      numeric     not null default 0,
  grasas_g             numeric     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Prevent duplicate ingredient names per owner
  unique (owner_id, nombre)
);

comment on table public.ingredients is
  'Ingredient catalog. Each ingredient is owned by a profile. '
  'Approved linked users (person_access) can also read each other''s ingredients.';

-- ── Indexes ──────────────────────────────────────────────────
create index if not exists ingredients_owner_idx
  on public.ingredients(owner_id);

-- Full-text search on nombre + categoria
create index if not exists ingredients_nombre_idx
  on public.ingredients
  using gin (to_tsvector('spanish', coalesce(nombre,'') || ' ' || coalesce(categoria,'')));

-- ────────────────────────────────────────────────────────────
-- 2. HELPER: shares_access_with(target_profile_id)
--
--    Returns TRUE when the calling user (auth.uid()) has at least
--    one approved person_access record in common with target_profile_id.
--    "In common" means: both users are granted_to of the same person,
--    OR one has granted access to a person the other also has access to.
--
--    Implementation: a user "shares access with" another if there
--    exists any person for which BOTH users have approved access.
-- ────────────────────────────────────────────────────────────
create or replace function public.shares_access_with(target_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.person_access my_access
    join public.person_access their_access
      on their_access.person_id = my_access.person_id
    where my_access.granted_to    = auth.uid()
      and their_access.granted_to = target_profile_id
      and my_access.status        = 'approved'
      and their_access.status     = 'approved'
  );
$$;

comment on function public.shares_access_with(uuid) is
  'Returns TRUE if the calling user and target_profile_id both have approved '
  'access to at least one common person. Used in ingredients RLS policies.';

-- ────────────────────────────────────────────────────────────
-- 3. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
alter table public.ingredients enable row level security;

-- SELECT: own rows, admin, or a linked user sharing access
create policy "ingredients: select"
  on public.ingredients
  for select
  using (
    public.is_admin()
    or owner_id = auth.uid()
    or public.shares_access_with(owner_id)
  );

-- INSERT: only for own rows (owner_id must equal auth.uid())
create policy "ingredients: insert"
  on public.ingredients
  for insert
  with check (
    owner_id = auth.uid()
    or public.is_admin()
  );

-- UPDATE: only the owner or an admin may update
create policy "ingredients: update"
  on public.ingredients
  for update
  using (
    owner_id = auth.uid()
    or public.is_admin()
  );

-- DELETE: only the owner or an admin may delete
create policy "ingredients: delete"
  on public.ingredients
  for delete
  using (
    owner_id = auth.uid()
    or public.is_admin()
  );
