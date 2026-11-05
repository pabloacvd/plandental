-- ============================================================
-- PlanDental — Seed script
-- Run ONCE in the Supabase SQL editor (or via supabase db push).
-- ⚠️  CHANGE THE ADMIN PASSWORD IMMEDIATELY after first login.
-- ============================================================

-- Before running: replace the placeholder below with a real temporary password.
-- Example: replace :admin_password with a strong random string.
-- After first login, change it via the Supabase Auth dashboard or the app.

-- ── 1. Create the admin Auth user ────────────────────────────
-- Supabase Auth stores users in auth.users.  We use the admin API
-- here via a direct insert into auth.users (valid in the SQL editor
-- when connected as the service role / postgres superuser).
--
-- Internal email convention: <username>@app.local
-- This email is never shown to the user — username is always used.

-- ── 0. Create the family shared by pablo and juli ───────────
-- profiles.family_id is NOT NULL. The trigger tr_assign_profile_family reads
-- the session setting app.new_user_family_id when the profile is created;
-- without it, it would create an individual family for pablo.
insert into public.families (name)
select 'Pablo y Juli'
where not exists (
  select 1 from public.families where lower(name) = lower('Pablo y Juli')
);

select set_config(
  'app.new_user_family_id',
  (select id::text from public.families where lower(name) = lower('Pablo y Juli')),
  false   -- session-level: works even if the script is not one transaction
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change
)
values (
  '00000000-0000-0000-0000-000000000001',     -- fixed uuid for idempotency
  '00000000-0000-0000-0000-000000000000',     -- default instance_id
  'authenticated',
  'authenticated',
  'pablo@app.local',
  -- Replace 'CHANGE_ME_NOW' with a strong temporary password before running.
  -- Immediately change it after first login via the Supabase Auth dashboard.
  crypt('CHANGE_ME_NOW', gen_salt('bf')),
  now(),                                      -- mark email as confirmed
  '{"username": "pablo", "role": "admin"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
)
on conflict (id) do nothing;

-- ── 2. Create the profile ────────────────────────────────────
-- The trigger handle_new_user fires on auth.users insert and creates
-- the profile automatically. This explicit insert is a safety net in
-- case the trigger already ran or the seed is re-run.
insert into public.profiles (id, username, role, created_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'pablo',
  'admin',
  now()
)
on conflict (id) do update
  set username = 'pablo', role = 'admin';

-- ── 3. Create the Pablo person record ───────────────────────
insert into public.persons (id, name, owner_id, created_at)
values (
  '00000000-0000-0000-0000-000000000010',
  'Pablo',
  '00000000-0000-0000-0000-000000000001',
  now()
)
on conflict (id) do nothing;

-- ── 4. Create the Juli person record ────────────────────────
-- Juli no tiene cuenta de usuario todavía; su persona pertenece a la familia
-- de pablo (persons.family_id se toma del owner). Para crear su cuenta:
-- iniciá sesión como pablo (admin) y usá "Mi cuenta → Gestionar usuarios",
-- eligiendo la familia "Pablo y Juli". admin_create_user reutiliza esta
-- persona (mismo nombre dentro de la familia) en lugar de crear otra.
insert into public.persons (id, name, owner_id, created_at)
values (
  '00000000-0000-0000-0000-000000000011',
  'Juli',
  '00000000-0000-0000-0000-000000000001',
  now()
)
on conflict (id) do nothing;

-- Clear the session setting used above.
select set_config('app.new_user_family_id', '', false);

-- ── Done ─────────────────────────────────────────────────────
-- ⚠️  REMEMBER: change pablo's password immediately after first login.
-- The temporary password is whatever you substituted for 'CHANGE_ME_NOW' above.
