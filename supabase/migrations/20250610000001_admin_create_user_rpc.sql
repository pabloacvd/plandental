-- ============================================================
-- PlanDental — admin_create_user RPC
-- Allows an admin to create a new Supabase Auth user from the
-- app UI without direct SQL access.
--
-- Uses SECURITY DEFINER so it runs as the DB owner (postgres),
-- who has INSERT access to auth.users — same technique as seed.sql.
-- ============================================================

create or replace function public.admin_create_user(
  p_username text,
  p_password text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_email text;
begin
  -- ── 1. Authorisation ────────────────────────────────────────
  if not public.is_admin() then
    raise exception 'Solo administradores pueden crear usuarios.';
  end if;

  -- ── 2. Input validation ──────────────────────────────────────
  if p_username is null or trim(p_username) = '' then
    raise exception 'El nombre de usuario no puede estar vacío.';
  end if;

  if p_password is null or length(p_password) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;

  -- Normalise to lowercase
  p_username := lower(trim(p_username));
  v_email    := p_username || '@app.local';

  -- ── 3. Check for existing username ───────────────────────────
  if exists (select 1 from public.profiles where lower(username) = p_username) then
    raise exception 'Ya existe un usuario con ese nombre.';
  end if;

  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'Ya existe un usuario con ese nombre.';
  end if;

  -- ── 4. Create the auth user ──────────────────────────────────
  -- This is the same pattern used in seed.sql.
  -- The on_auth_user_created trigger will auto-create the profiles row.
  v_id := gen_random_uuid();

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
  ) values (
    v_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    v_email,
    crypt(p_password, gen_salt('bf')),
    now(),
    jsonb_build_object('username', p_username, 'role', 'user'),
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

  return v_id;
end;
$$;

-- Revoke public execute; only the function's own SECURITY DEFINER
-- and the admin check inside protect it, but belt-and-suspenders:
revoke all on function public.admin_create_user(text, text) from public;
grant execute on function public.admin_create_user(text, text) to authenticated;
