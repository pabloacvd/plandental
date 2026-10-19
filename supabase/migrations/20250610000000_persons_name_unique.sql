-- ============================================================
-- PlanDental — Make persons.name case-insensitively unique (global)
-- No two persons may share the same name regardless of case or owner.
-- ============================================================

-- ── 1. Remove any duplicate lower-case rows ──────────────────
-- If both "Juli" and "juli" exist, delete the one with no plan
-- rows (the lowercase duplicate introduced by the bug).
-- The DO block is safe to re-run: if no duplicates exist, nothing happens.
do $$
declare
  v_keep_id   uuid;
  v_drop_id   uuid;
begin
  -- Find pairs of persons whose names are the same case-insensitively
  -- but differ in actual casing.
  for v_keep_id, v_drop_id in
    select
      -- Keep the row whose name matches its own title-case (canonical),
      -- or the one with more plan rows if both are bare.
      case
        when p1.name = initcap(p1.name) then p1.id
        else p2.id
      end as keep_id,
      case
        when p1.name = initcap(p1.name) then p2.id
        else p1.id
      end as drop_id
    from public.persons p1
    join public.persons p2
      on lower(p1.name) = lower(p2.name)
     and p1.id < p2.id   -- avoid self-join duplicates
  loop
    -- Only drop the duplicate if it has no plan rows.
    if not exists (
      select 1 from public.plans where person_id = v_drop_id
    ) and not exists (
      select 1 from public.nutrition_data where person_id = v_drop_id
    ) and not exists (
      select 1 from public.default_week where person_id = v_drop_id
    ) then
      -- Reassign person_access rows to the kept person before deleting.
      update public.person_access
        set person_id = v_keep_id
      where person_id = v_drop_id
        and not exists (
          select 1 from public.person_access
          where person_id = v_keep_id
            and granted_to = person_access.granted_to
        );
      delete from public.person_access where person_id = v_drop_id;
      delete from public.persons where id = v_drop_id;
      raise notice 'Deleted duplicate person id=% (kept id=%)', v_drop_id, v_keep_id;
    else
      raise notice 'Cannot auto-delete duplicate person id=% — it has data. Manual cleanup required.', v_drop_id;
    end if;
  end loop;
end;
$$;

-- ── 2. Add the unique index on lower(name) ───────────────────
-- This prevents any future insert/update from creating case-variant duplicates.
create unique index if not exists persons_name_lower_idx
  on public.persons (lower(name));
