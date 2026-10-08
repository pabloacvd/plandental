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

-- ── 4. Create approved access: pablo → Pablo ─────────────────
insert into public.person_access (person_id, granted_to, granted_by, status, created_at)
values (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'approved',
  now()
)
on conflict (person_id, granted_to) do nothing;

-- ── 5. Create the Juli person record ────────────────────────
-- Juli does not have a user profile yet.  Her plan data is
-- accessible to pablo (admin) and to any profile whose username
-- is 'juli' once they register.
insert into public.persons (id, name, owner_id, created_at)
values (
  '00000000-0000-0000-0000-000000000011',
  'Juli',
  '00000000-0000-0000-0000-000000000001',
  now()
)
on conflict (id) do nothing;

-- Grant pablo approved access to Juli as well (he is admin + owner)
insert into public.person_access (person_id, granted_to, granted_by, status, created_at)
values (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'approved',
  now()
)
on conflict (person_id, granted_to) do nothing;

-- ── Done ─────────────────────────────────────────────────────
-- ⚠️  REMEMBER: change pablo's password immediately after first login.
-- The temporary password is whatever you substituted for 'CHANGE_ME_NOW' above.
