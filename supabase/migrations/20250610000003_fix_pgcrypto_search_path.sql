-- ============================================================
-- PlanDental — Fix gen_salt: add extensions to search_path
-- pgcrypto lives in the extensions schema on Supabase.
-- Re-creates both admin RPCs with the corrected search_path.
-- ============================================================

create or replace function public.admin_create_user(
  p_username text,
  p_password text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id    uuid;
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden crear usuarios.';
  end if;

  if p_username is null or trim(p_username) = '' then
    raise exception 'El nombre de usuario no puede estar vacío.';
  end if;

  if p_password is null or length(p_password) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;

  p_username := lower(trim(p_username));
  v_email    := p_username || '@app.local';

  if exists (select 1 from public.profiles where lower(username) = p_username) then
    raise exception 'Ya existe un usuario con ese nombre.';
  end if;

  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'Ya existe un usuario con ese nombre.';
  end if;

  v_id := gen_random_uuid();

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    v_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(),
    jsonb_build_object('username', p_username, 'role', 'user'),
    now(), now(), '', '', '', ''
  );

  return v_id;
end;
$$;

revoke all on function public.admin_create_user(text, text) from public;
grant execute on function public.admin_create_user(text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────

create or replace function public.admin_reset_password(
  p_username text,
  p_new_password text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden cambiar contraseñas de otros usuarios.';
  end if;

  if p_username is null or trim(p_username) = '' then
    raise exception 'El nombre de usuario no puede estar vacío.';
  end if;

  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;

  p_username := lower(trim(p_username));
  v_email    := p_username || '@app.local';

  update auth.users
    set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
        updated_at         = now()
  where email = v_email;

  if not found then
    raise exception 'No existe ningún usuario con ese nombre.';
  end if;
end;
$$;

revoke all on function public.admin_reset_password(text, text) from public;
grant execute on function public.admin_reset_password(text, text) to authenticated;
