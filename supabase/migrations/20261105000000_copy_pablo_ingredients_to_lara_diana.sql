-- ============================================================
-- PlanDental — Copy Pablo's ingredient catalog to Lara and Diana
--
-- Ingredients are owned per profile (ingredients.owner_id), so
-- each target user gets its own independent copy of Pablo's rows.
--
-- Recipes are NOT copied: public.recipes has no owner_id and is a
-- global catalog readable by every authenticated user, so Lara and
-- Diana already see the same recipes as Pablo.
--
-- Safe to re-run: existing (owner_id, nombre) pairs are left
-- untouched (ON CONFLICT DO NOTHING), so nothing a target user
-- already edited is overwritten.
-- ============================================================

do $$
declare
  v_pablo_id  uuid;
  v_target_id uuid;
  v_username  text;
  v_inserted  integer;
begin
  select id into v_pablo_id
  from public.profiles
  where lower(username) = 'pablo';

  if v_pablo_id is null then
    raise exception 'Profile "pablo" not found — cannot copy ingredients.';
  end if;

  foreach v_username in array array['lara', 'diana'] loop
    select id into v_target_id
    from public.profiles
    where lower(username) = v_username;

    if v_target_id is null then
      raise exception 'Profile "%" not found — create the user first, then re-run.', v_username;
    end if;

    insert into public.ingredients (
      owner_id, nombre, categoria, unidad_referencia, cantidad_referencia,
      calorias, proteina_g, carbohidratos_g, grasas_g
    )
    select
      v_target_id, nombre, categoria, unidad_referencia, cantidad_referencia,
      calorias, proteina_g, carbohidratos_g, grasas_g
    from public.ingredients
    where owner_id = v_pablo_id
    on conflict (owner_id, nombre) do nothing;

    get diagnostics v_inserted = row_count;
    raise notice 'Copied % ingredient(s) from pablo to %', v_inserted, v_username;
  end loop;
end;
$$;
