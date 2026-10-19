# User Management — Fix Plan

## Overview

There are four related bugs in the user management system:

1. **Duplicate "juli" / case-sensitive persons** — the `persons` table has no uniqueness constraint on `name`, so "juli" and "Juli" can coexist as separate rows.
2. **id = 0 for Pablo and Juli in the persons table** — the actual DB UUIDs are `...000010` and `...000011`. The "0" is likely a display artifact or a code bug in the JS. Investigation needed.
3. **Juli has no profile** — Juli exists only as a `persons` row. No `auth.users` or `profiles` row exists. There is currently no in-app flow to create a new user.
4. **No password management UI** — there is no way to create a user from the app or for an existing user to change their own password.

### Confirmed Design Decisions
- Person name uniqueness is **global** (no two persons can share the same name case-insensitively, regardless of owner).
- Juli's account is created by the admin **from the app UI** — the seed will NOT include a password for her (password is set by Pablo after creation using the new admin UI).
- Change-password form asks for **new password twice** (no current-password field).

---

## Sub-Task 1 — Fix case-insensitive global uniqueness on persons.name

**Status:** [ ] pending

### Intent
Prevent two rows in `persons` with names that differ only in case (e.g. "juli" vs "Juli"). Uniqueness is global — not scoped per owner. The existing duplicate "juli"/"Juli" rows must be cleaned up before the constraint is added.

### Expected Outcomes
- `persons` table enforces `unique (lower(name))` globally.
- `create_person_with_access` RPC raises `'Ya existe una persona con ese nombre.'` if a case-insensitive match already exists.
- The duplicate "juli"/"Juli" row is removed (keep the row that has associated plan data, or the one with the canonical casing "Juli" if both are empty).
- `handle_profile_matches_person` trigger is unchanged (already uses `lower()` on both sides).

### Todo List
1. Write a new migration `supabase/migrations/20250610000000_persons_name_unique.sql`:
   - Add a `DO` block that deletes the duplicate lower-cased "juli" row (keeping "Juli") — only if both exist and only if "juli" has no plan rows.
   - Add: `create unique index if not exists persons_name_lower_idx on public.persons (lower(name));`
2. Update `create_person_with_access` in `supabase/migrations/20250101000001_rpc_functions.sql` (apply as a `create or replace`):
   - Before the `insert into persons`, add a check: `if exists (select 1 from public.persons where lower(name) = lower(p_name)) then raise exception 'Ya existe una persona con ese nombre.'; end if;`

### Relevant Context
- [`supabase/migrations/20250101000001_rpc_functions.sql`](supabase/migrations/20250101000001_rpc_functions.sql:76) — `create_person_with_access` function.
- [`supabase/migrations/20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql:52) — `persons` table definition.
- `handle_profile_matches_person` at line 102 of rpc_functions.sql — already correct, no changes needed.

---

## Sub-Task 2 — Add admin-only user creation flow

**Status:** [ ] pending

### Intent
Pablo (admin) needs to create new Supabase Auth users from the app UI — without the Supabase SQL editor. The chosen approach is a `SECURITY DEFINER` Postgres RPC that inserts directly into `auth.users` (same pattern as the seed script), restricted to admins only. The admin sets the initial password at creation time. The `on_auth_user_created` trigger automatically creates the `profiles` row.

### Expected Outcomes
- Admin sees a "Crear usuario" section in a new `#modal-user-mgmt` modal (accessible from the "Mi cuenta" modal or a dedicated button — only visible when `state.profile.role === 'admin'`).
- Form fields: username + initial password.
- On success: `auth.users` row created → trigger fires → `profiles` row created → toast shown.
- On error (username taken, password too short, non-admin caller): error toast shown.
- Non-admin users never see this section.

### Todo List
1. Write a new migration `supabase/migrations/20250610000001_admin_create_user_rpc.sql` with function `admin_create_user(p_username text, p_password text)`:
   - Verify `public.is_admin()`, else `raise exception 'Solo administradores pueden crear usuarios.'`
   - Validate `p_username` not already in `public.profiles` by username.
   - Validate `p_username` not already in `auth.users` by email (`p_username || '@app.local'`).
   - Generate a new UUID: `v_id := gen_random_uuid()`.
   - Insert into `auth.users` following the same column set as the seed script (instance_id, aud, role, email, encrypted_password via `crypt(p_password, gen_salt('bf'))`, email_confirmed_at, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change).
   - Return the new user's UUID.
   - Use `SECURITY DEFINER` so the function runs as the DB owner who has write access to `auth.users`.
2. Add `export async function adminCreateUser(username, password)` to [`js/storage.js`](js/storage.js):
   - Calls `supabase.rpc('admin_create_user', { p_username: username.toLowerCase().trim(), p_password: password })`.
   - Throws on error.
3. Add `#modal-user-mgmt` to [`index.html`](index.html) (new modal, separate from `#modal-person`):
   - Section "Crear usuario" with `input-new-username`, `input-new-user-password`, `btn-create-user`.
   - Only rendered/shown when admin — controlled by JS visibility logic.
4. In [`js/app.js`](js/app.js):
   - Add `openUserMgmtModal()` / `closeUserMgmtModal()` helpers.
   - Add a "Gestionar usuarios" button inside `#modal-auth` that is only visible when `state.profile.role === 'admin'`.
   - Wire `btn-create-user`: validate fields, call `adminCreateUser(username, password)`, show toast, clear form on success.

### Relevant Context
- [`supabase/seed.sql`](supabase/seed.sql:19) — exact `auth.users` insert column set (lines 19–53).
- [`supabase/migrations/20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql:27) — `handle_new_user` trigger (auto-creates `profiles` row).
- [`supabase/migrations/20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql:203) — `is_admin()` helper.
- [`js/storage.js`](js/storage.js:33) — `signIn` as pattern for RPC calls.
- [`index.html`](index.html:189) — `#modal-auth` ("Mi cuenta") where the "Gestionar usuarios" button will be added.
- [`index.html`](index.html:200) — `#modal-person` structure as UI pattern to follow for the new modal.

---

## Sub-Task 3 — Add change-password flow for existing users

**Status:** [ ] pending

### Intent
Any authenticated user can change their own password from the "Mi cuenta" modal. No admin involvement required. Supabase v2 `auth.updateUser({ password })` is used — no current-password needed (the active JWT proves identity). The form asks for the new password twice (confirmation).

### Expected Outcomes
- "Mi cuenta" modal (`#modal-auth`) has a "Cambiar contraseña" section with two password fields and a submit button.
- Client-side validation: both fields must match, minimum 6 characters.
- On success: toast "Contraseña actualizada", fields cleared.
- On error: error toast shown.

### Todo List
1. Add `export async function changePassword(newPassword)` to [`js/storage.js`](js/storage.js):
   - Calls `supabase.auth.updateUser({ password: newPassword })`.
   - Throws `new Error(error.message)` on failure.
2. In [`index.html`](index.html:189), extend `#modal-auth`:
   - Add `<section>` with `<h4>Cambiar contraseña</h4>`.
   - Add `<input type="password" id="input-new-password" placeholder="Nueva contraseña" />`.
   - Add `<input type="password" id="input-confirm-password" placeholder="Repetir contraseña" />`.
   - Add `<button id="btn-change-password" class="btn-primary">Cambiar contraseña</button>`.
3. In [`js/app.js`](js/app.js:1516), inside `openAuthModal()` area:
   - Wire `btn-change-password` click handler.
   - Validate: both fields non-empty, equal, length ≥ 6.
   - Call `changePassword(newPassword)`.
   - Show toast on success/error; clear fields on success.

### Relevant Context
- [`js/storage.js`](js/storage.js:33) — `signIn` / `signOut` as patterns.
- [`index.html`](index.html:189) — `#modal-auth` current structure (lines 189–198).
- [`js/app.js`](js/app.js:1516) — `openAuthModal`, `handleLogout` as reference (lines 1516–1535).

---

## Sub-Task 4 — Update seed.sql for a fresh-install scenario (no Juli password)

**Status:** [ ] pending

### Intent
The seed currently creates Pablo but not Juli as a user. For a fresh-database install, the seed should create Juli's `persons` row and profile-ready state, but **without a password** — Pablo will set her password via the admin UI (Sub-Task 2) after first login. The seed insert for `auth.users` for Juli is therefore omitted; only the `persons` row and its access record for Pablo remain (as they already exist in the seed). The seed comment should be updated to clarify that Juli's account must be created by the admin via the app.

### Expected Outcomes
- `seed.sql` still creates Pablo's full auth user + profile + person + access.
- `seed.sql` still creates Juli's `persons` row + Pablo's access to Juli (already present).
- A clear comment is added: "Para crear la cuenta de Juli, usá 'Gestionar usuarios' en la app (como administrador)."
- No `auth.users` insert for Juli in seed (password would be unknown).

### Todo List
1. In [`supabase/seed.sql`](supabase/seed.sql):
   - Remove any planned `auth.users` insert for Juli (there is none currently — confirm and leave as-is).
   - Update the comment at line 90–93 to say: "Juli no tiene cuenta de usuario todavía. Creala desde la app con el usuario admin (Gestionar usuarios). La asignación de acceso se crea automáticamente por el trigger `on_profile_created_match_person`."
   - Verify the `public.profiles` safety-net insert for Juli is NOT present (it shouldn't be — her trigger will handle it when her account is created).

### Relevant Context
- [`supabase/seed.sql`](supabase/seed.sql:90) — Juli's persons block (lines 90–112).
- [`supabase/migrations/20250101000001_rpc_functions.sql`](supabase/migrations/20250101000001_rpc_functions.sql:102) — `handle_profile_matches_person` trigger.

---

## Sub-Task 5 — Investigate and fix id=0 display for Pablo and Juli

**Status:** [x] done — No JS code bug found. `personNameToId` maps `name → uuid` correctly and person IDs are never displayed in the app UI. The `id = 0` is a Supabase dashboard rendering artifact: the table editor interprets `00000000-0000-0000-0000-000000000010` as an integer-like value and displays `0`. No fix needed.

### Intent
The user sees `id = 0` for Pablo and Juli in the persons table. The actual UUIDs are `00000000-0000-0000-0000-000000000010` and `...000011`. Determine whether this is a Supabase dashboard display artifact or a code bug in the JS app (e.g., `indexOf` on an array returning `0`), and fix if it's a code bug.

### Expected Outcomes
- Root cause identified and documented.
- If a JS code bug: fixed (person IDs always use the UUID from the DB, never an array index).
- If a Supabase dashboard artifact: documented and closed.

### Todo List
1. Search `js/app.js` for `personNameToId`, `indexOf`, and any integer-based person ID usage.
2. Verify `state.personNameToId` maps `name → uuid` string (not array index).
3. Search `js/storage.js` `getMyPersons()` return shape — confirm it returns `{ id: uuid, name, owner_id }`.
4. If a code bug is found, fix the relevant JS line(s).

### Relevant Context
- [`js/app.js`](js/app.js) — search for `personNameToId`.
- [`js/storage.js`](js/storage.js:102) — `getMyPersons()` at line 102.
