# Plan: admin only Pablo, familias, recetas por familia y recetas versionadas

## Overview

Siete cambios sobre la app (JS vanilla + Supabase, sin framework ni tests automáticos):

1. Solo `pablo` es admin y puede crear usuarios.
2. Todo usuario tiene una persona propia, así que ve el form "Mis datos".
3. Ingredientes y recetas se ven solo dentro de la propia familia (se corrige el duplicado de Pablo).
4. Las recetas pertenecen a una familia, no son globales.
5. Cada comida del plan guarda una copia completa de la versión de la receta que se asignó.
6. `person_access` y todo su flujo (pedir/aprobar acceso, `familia_flag`) se eliminan; el acceso pasa a depender de la familia.
7. Las pre-selecciones de la lista de compras se guardan por familia en la base de datos.

### Decisiones confirmadas con el usuario

- **Versionado**: congelar todo (ingredientes, pasos, macros, porciones) en cada entrada del plan. El detalle del día y la lista de compras usan la versión congelada.
- **Familia**: concepto explícito (tabla `families` + `profiles.family_id`). Al crear un usuario, el admin elige una familia existente o crea una nueva.
- **Recetas existentes**: se asignan a la familia de Pablo (pablo + juli) y se copian a la familia de Lara y a la de Diana.
- **Mis datos**: el RPC de creación de usuario crea automáticamente la persona con el mismo nombre dentro de su familia. Una migración hace backfill para lara, diana y cualquier usuario sin persona.
- **`person_access` se elimina**: tabla, vista `familia_flag`, `has_approved_access()`, RPC `request_person_access` / `approve_person_access` / `reject_person_access`, UI de solicitudes pendientes y funciones JS asociadas. `persons` se conserva (es el sujeto del plan y de la nutrición; Juli existe como persona antes de tener cuenta) y pasa a tener `family_id`.
- **Pre-selecciones de la lista de compras**: hoy viven en `localStorage` con clave fija `shopping_deselected_defaults` ([`js/app.js`](js/app.js):1366), compartidas por todos los usuarios del navegador. Pasan a una tabla por `family_id`, compartida por la familia y sincronizada entre dispositivos.

### Hallazgos que determinan el diseño (verificados en el código)

- **Punto 1, causa probable**: `admin_create_user` ya valida `is_admin()` ([`20250610000003_fix_pgcrypto_search_path.sql`](supabase/migrations/20250610000003_fix_pgcrypto_search_path.sql):20). El agujero está en la policy `profiles: own row` (`for all using (id = auth.uid())`, [`20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql):225). Sin `with check` ni restricción de columnas, cualquier usuario puede hacer `update profiles set role='admin'` sobre su propia fila. También puede ser que lara se haya creado ya con `role='admin'`. Hay que revisar el dato real y cerrar el agujero.
- **Punto 2, causa**: `populateProfileSection()` oculta "Mis datos" si `state.persons` está vacío ([`js/app.js`](js/app.js):1660). Lara no tiene persona porque solo se genera acceso automático cuando ya existe una persona con su nombre (`handle_profile_matches_person`).
- **Punto 3, causa**: Pablo es admin y las policies de `ingredients` incluyen `public.is_admin()` en el SELECT ([`20250602000000_ingredients.sql`](supabase/migrations/20250602000000_ingredients.sql):98-105). Pablo ve sus filas y las copias de Lara y Diana. El mismo bypass existe en `plans`, `nutrition_data`, `default_week` y `persons`. Además `shares_access_with` se basa en personas compartidas, no en familia.
- **Punto 4, causa**: `recipes` no tiene dueño; sus policies permiten leer, insertar, actualizar y borrar a cualquier autenticado ([`20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql):294-304). La PK es `id text` (slug) global, así que copiar el catálogo a otra familia choca con la PK.
- **Punto 5, causa**: `plans` solo guarda `recipe_id`, `recipe_name` y `macros` ([`js/app.js`](js/app.js):852-879). Los ingredientes y pasos se leen en vivo de la receta actual (`getRecipeById` en [`js/app.js`](js/app.js):992 y `buildShoppingList` en [`js/app.js`](js/app.js):1449-1456). Los macros ya están congelados; lo demás no.

---

## Sub-task 1 — Solo Pablo es admin; cerrar la escalada de privilegios

**Intent**: Que solo `pablo` tenga `role='admin'` y que nadie pueda cambiar su rol desde el cliente.

**Expected Outcomes**
- Lara, Diana y cualquier otro usuario tienen `role='user'`.
- Un `update profiles set role='admin'` hecho por un usuario normal falla.
- Lara no ve "Gestionar usuarios" y `admin_create_user` / `admin_reset_password` la rechazan.

**Todo List**
- [x] Consultar `profiles` para confirmar el rol actual de lara y diana (diagnóstico, para saber si fue escalada o creación con rol admin).
- [x] Nueva migración: `update profiles set role='user' where lower(username) <> 'pablo'`, y `role='admin'` solo para pablo (`20261105000100_admin_only_pablo.sql`).
- [x] Reemplazar la policy `profiles: own row` (`for all`) por una de `select` sobre la fila propia / autenticados, y una de `update` con `with check` que impida cambiar `role` por el propio usuario. (Nota: `family_id` se agrega en la Sub-task 2).
- [x] Añadir un trigger `before update` en `profiles` (`tr_protect_profile_role` / `protect_profile_role()`) que bloquee cambios de `role` salvo que el rol de base de datos sea de servicio o postgres (cinturón y tirantes).
- [x] Mantener `is_admin()` como única fuente de verdad con `search_path = public, pg_temp`.
- [x] En `admin_create_user`, no aceptar `role` desde el cliente; sigue creando siempre `'user'`.

**Relevant Context**: [`supabase/migrations/20261105000100_admin_only_pablo.sql`](supabase/migrations/20261105000100_admin_only_pablo.sql); [`20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql):14-44, 203-234; [`20250610000003_fix_pgcrypto_search_path.sql`](supabase/migrations/20250610000003_fix_pgcrypto_search_path.sql); [`js/app.js`](js/app.js):1722-1738.

**Notas para Sub-task 2**:
- La migración `20261105000100_admin_only_pablo.sql` dejó blindada la tabla `public.profiles` frente a cambios de rol desde el cliente.
- En la Sub-task 2 se agregará `family_id` a `profiles` y `families`, y se actualizará el trigger `protect_profile_role` / policies para proteger también `family_id`.

**Status**: [x] done

---

## Sub-task 2 — Modelo de familia

**Intent**: Introducir la familia como unidad de compartición de ingredientes y recetas.

**Expected Outcomes**
- Tabla `families` y `profiles.family_id` no nulo para todos.
- Pablo y Juli en la misma familia; Lara y Diana en una familia cada una.
- Helper SQL `same_family(profile_id)` / `my_family_id()` reutilizable en las policies.

**Todo List**
- [x] Migración: crear `families(id, name, created_at)` con RLS (lectura de la propia familia; las altas solo vía RPC).
- [x] Añadir `profiles.family_id` (referencia a `families`) y backfill explícito. La base tiene solo 4 usuarios (confirmado por el usuario): `pablo`, `juli`, `lara` y `diana`. Pablo y Juli van a una misma familia, y Lara y Diana a una familia propia cada una. Para cualquier otro perfil que aparezca, crear una familia individual.
- [x] Al final de la migración, validar con un `do $$` que `pablo` y `juli` comparten `family_id`, que `lara` y `diana` tienen familias distintas entre sí y distintas de la de Pablo, y que ningún perfil ni persona queda con `family_id` nulo. Si algo falla, abortar con `raise exception` y mensaje claro.
- [x] Añadir `persons.family_id` y backfill: cada persona toma la familia de su `owner_id` (Pablo y Juli quedan en la familia de pablo). Hacer `not null` tras el backfill.
- [x] Cambiar la unicidad de `persons.name` de global a `(family_id, lower(name))` (hoy es único global, [`20250610000000_persons_name_unique.sql`](supabase/migrations/20250610000000_persons_name_unique.sql)).
- [x] Hacer `profiles.family_id` `not null` tras el backfill.
- [x] Funciones `security definer stable`: `my_family_id()` y `same_family(target_profile_id)` (con `search_path` fijo, como `is_admin()`).
- [x] Modificar `admin_create_user(p_username, p_password, p_family_id uuid default null, p_new_family_name text default null)`: si viene `p_family_id`, el usuario se une a esa familia; si no, crea una familia nueva. Validar que exactamente una de las dos opciones esté presente. Mantener la verificación de `is_admin()`.
- [x] Nuevo RPC de lectura `admin_list_families()` (solo admin) para poblar el selector. Revocar `public` y conceder a `authenticated`, con validación interna.
- [x] Proteger `family_id`: `protect_profile_role()` bloquea también cambios de `family_id`; la policy `profiles: update own row` exige `family_id = my_family_id()`.

**Relevant Context**: [`supabase/migrations/20261105000200_families.sql`](supabase/migrations/20261105000200_families.sql); [`20250610000003_fix_pgcrypto_search_path.sql`](supabase/migrations/20250610000003_fix_pgcrypto_search_path.sql) (versión anterior de `admin_create_user`); [`20250602000000_ingredients.sql`](supabase/migrations/20250602000000_ingredients.sql):69-86 (`shares_access_with`, a reemplazar).

**Notas para Sub-task 3** (implementado en `20261105000200_families.sql`):
- Tabla `families(id, name, created_at)`; `name` único case-insensitive. RLS: solo `select` de la propia familia (`id = my_family_id()`); sin policies de escritura (altas solo vía RPC / security definer).
- `profiles.family_id` y `persons.family_id` son `not null`, FK a `families` (`on delete restrict`). Backfill: pablo+juli → familia "Pablo y Juli"; cualquier otro perfil → familia individual "Familia <username>".
- Helpers disponibles (`security definer stable`, `search_path = public, pg_temp`, grant a `authenticated`): `my_family_id()` y `same_family(target_profile_id uuid)`. Para la sub-tarea 3 hay que crear `person_in_my_family(person_id)` aparte.
- Triggers nuevos: `tr_assign_profile_family` (BEFORE INSERT en `profiles`: usa el setting transaccional `app.new_user_family_id` que fija `admin_create_user`; si no está, crea una familia individual). `tr_persons_enforce_family_ins/_upd` en `persons`: en INSERT el `family_id` se toma siempre del `owner_id` (el cliente no necesita enviarlo); en UPDATE no se puede cambiar `family_id` ni `owner_id` salvo `postgres`/`service_role`.
- `persons.name`: se eliminó el índice global `persons_name_lower_idx` y existe `persons_family_name_lower_idx` sobre `(family_id, lower(name))`.
- `admin_create_user(p_username, p_password, p_family_id uuid default null, p_new_family_name text default null)`: exige exactamente una de las dos opciones; se eliminó la firma `(text, text)`. Todavía NO crea la persona: eso es de la sub-tarea 3 (tras el insert en `auth.users` ya existe `profiles` con `family_id`; se puede añadir ahí el insert en `persons (name, owner_id)` con `on conflict (family_id, lower(name)) do nothing`; no se puede usar `on conflict` con expresión sin índice inferible, así que usar `insert ... where not exists`).
- `admin_list_families()` devuelve `(id, name, member_count, members text[])`, solo admin.
- Ajustes mínimos que la sub-tarea 3 debe borrar junto con `person_access`: `handle_profile_matches_person()` ahora filtra `p.family_id = new.family_id`; `create_person_with_access()` chequea duplicados por `my_family_id()`.
- Siguen usando `is_admin()` (se reescriben en la sub-tarea 3): policies de `persons`, `plans`, `nutrition_data`, `default_week`, y `reject_person_access`.
- Efecto conocido hasta la sub-tarea 7: `adminCreateUser` en [`js/storage.js`](js/storage.js):62-69 solo envía `p_username` y `p_password`, por lo que el RPC nuevo rechaza la llamada ("Indicá exactamente una opción…"). Crear usuarios desde la UI no funciona hasta actualizar el cliente (sub-tarea 7); mientras tanto se puede llamar el RPC con `p_family_id` o `p_new_family_name` desde SQL.
- [`supabase/seed.sql`](supabase/seed.sql) sigue funcionando: el trigger asigna una familia individual a `pablo`; la sub-tarea 3 debe ajustarlo (familia explícita y `family_id`).

**Status**: [x] done

---

## Sub-task 3 — Eliminar `person_access` y crear persona automática por usuario (arregla "Mis datos")

**Intent**: Reemplazar el acceso por persona (`person_access`) por acceso por familia, y garantizar que todo usuario tenga una persona en su familia para que se muestre el form "Mis datos".

**Expected Outcomes**
- Un usuario nuevo, tras crearse, tiene la persona `<Username>` en su familia. Si la familia ya tiene una persona con ese nombre (caso Juli), la reutiliza.
- Lara y Diana (y cualquier perfil sin persona) tienen su persona tras la migración.
- Al abrir el modal de usuario, Lara ve "Mis datos" y puede guardar calorías, edad, etc.
- No quedan tabla, vista, funciones, RPC, policies ni código JS que usen `person_access`.

**Todo List**
- [x] Reemplazar las policies de `persons`, `plans`, `nutrition_data` y `default_week` por `persons.family_id = my_family_id()` (para `plans`, `nutrition_data` y `default_week`, a través de `person_id`). Sin bypass de admin. Crear la función helper `person_in_my_family(person_id)` (`security definer stable`).
- [x] Reescribir `upsert_plan_entry` y `delete_plan_entry` para validar con `person_in_my_family`.
- [x] Decisión confirmada: las personas se crean solo de forma automática al crear un usuario. Eliminar el RPC `create_person_with_access` (no se reescribe como `create_person`). La unicidad `(family_id, lower(name))` la garantiza el índice de la sub-tarea 2.
- [x] En `admin_create_user`: tras crear el usuario, crear la persona con su nombre en la familia elegida si no existe. Reemplazar el trigger `on_profile_created_match_person` / `handle_profile_matches_person` por esta lógica (o por un trigger que haga lo mismo con `family_id`).
- [x] Backfill: para cada perfil que no tenga ninguna persona con su nombre en su familia, crear la persona.
- [x] Eliminar: tabla `person_access` (con sus policies e índices), vista `familia_flag`, `has_approved_access()`, RPC `request_person_access`, `approve_person_access`, `reject_person_access`, trigger `on_profile_created_match_person`. Hacerlo en una migración nueva con `drop ... if exists`, después de reescribir las policies que dependen de ellos.
- [x] JS ([`js/storage.js`](js/storage.js)): borrar `createPerson`, `requestPersonAccess`, `approvePersonAccess`, `rejectPersonAccess`, `getPendingAccessRequests`, `getFamiliaFlag`. `getMyPersons` pasa a leer `persons` directamente (la RLS ya limita a la familia).
- [x] JS ([`js/app.js`](js/app.js)): quitar imports, `openPersonModal`, `closePersonModal`, `handleCreatePerson`, `handleRequestAccess`, `refreshPendingRequests` y los listeners asociados (líneas ~1904-1984 y ~2235-2237). `state.showFamilia` pasa a ser `state.persons.length >= 2`.
- [x] HTML ([`index.html`](index.html)): eliminar por completo el botón `btn-manage-persons` (línea 87) y el modal `modal-person` (líneas 299-331, "Gestionar personas"). Buscar y quitar el CSS huérfano (`.btn-manage-persons`, `.person-modal-section` si ya no se usa en otro lado — se usa también en `section-nutrition-profile`, conservarlo en ese caso, `.access-request-row`, `.btn-approve`, `.btn-reject`, `.no-requests`).
- [x] Limpiar [`supabase/seed.sql`](supabase/seed.sql) (inserts en `person_access`; añadir familia y `family_id`), [`scripts/validate-migration.js`](scripts/validate-migration.js) (líneas 60, 92, 104, 209) y comentarios de [`js/storage.js`](js/storage.js):17.
- [ ] Verificar que `populateProfileSection` y `saveNutritionProfile` funcionan para Lara (verificación manual tras ejecutar la migración; el código no cambió y depende solo de que `state.persons` tenga su persona).

**Relevant Context**: [`20250101000001_rpc_functions.sql`](supabase/migrations/20250101000001_rpc_functions.sql); [`20250610000002_update_create_person_rpc.sql`](supabase/migrations/20250610000002_update_create_person_rpc.sql); [`20250610000000_persons_name_unique.sql`](supabase/migrations/20250610000000_persons_name_unique.sql); [`20250601000000_default_week.sql`](supabase/migrations/20250601000000_default_week.sql):39-40; [`js/app.js`](js/app.js):11-13, 118, 1643-1662, 1904-1984; [`js/storage.js`](js/storage.js):141-240, 476-491.

**Notas para Sub-task 4** (implementado en `20261105000300_remove_person_access.sql`):
- `person_in_my_family(person_id)` (`security definer stable`, `search_path = public, pg_temp`, grant a `authenticated`) existe y la usan las policies de `plans`, `nutrition_data` y `default_week` (`for all`, con `using` y `with check`) y los RPC `upsert_plan_entry` / `delete_plan_entry`. Ninguno usa `is_admin()` (la migración lo valida).
- `persons`: una sola policy `persons: family select` (`family_id = my_family_id()`); se revocó `insert/update/delete/truncate` a `authenticated` y todo a `anon`. Las personas solo se crean con `ensure_person_for_profile(profile_id)` (security definer, sin grant a ningún rol de la API), que usan `admin_create_user` y el backfill. Si la familia ya tiene una persona con ese nombre (case-insensitive) se reutiliza sin tocar su owner (Juli sigue con owner pablo); si no, se crea con `initcap(username)` y `owner_id` = el perfil.
- `admin_create_user(text, text, uuid, text)` ahora llama a `ensure_person_for_profile` al final. Lara y Diana quedan con las personas `Lara` y `Diana` por el backfill.
- **`shares_access_with(uuid)` NO se eliminó**: se redefinió como `select public.same_family(target_profile_id)` (misma firma) porque las 4 policies de `ingredients` (`20250602000000_ingredients.sql`:98-132) la usan en el SELECT, y además siguen usando `is_admin()` en SELECT/INSERT/UPDATE/DELETE. La sub-tarea 4 debe reescribir esas policies con `owner_id = auth.uid() or same_family(owner_id)` (sin `is_admin()`) y luego `drop function public.shares_access_with(uuid)`. Su comentario ya dice "Deprecated".
- `scripts/validate-ingredients.js` valida con regex el SQL de la migración original `20250602000000_ingredients.sql` (no la base viva) y pasa 73/73; la línea 328 menciona `person_access` porque verifica esa migración histórica. Hay que actualizarlo en la sub-tarea 4 al apuntar a las nuevas policies.
- Eliminados: tabla `person_access`, vista `familia_flag`, `has_approved_access()`, `request/approve/reject_person_access`, `create_person_with_access`, `handle_profile_matches_person` y el trigger `on_profile_created_match_person`. La migración emite un `raise warning` (no aborta) si había accesos aprobados entre familias distintas, y termina con una validación (`raise exception`) que comprueba personas por perfil, objetos eliminados y que ninguna policy/función de `public` referencia lo eliminado ni usa `is_admin()` en persons/plans/nutrition_data/default_week.
- JS: `getMyPersons()` lee `persons` (RLS por familia, orden por nombre); `state.showFamilia = persons.length >= 2`. Se quitaron botón 👥, modal `modal-person`, handlers y CSS huérfano (`.access-request-row`, `.no-requests`, `.btn-manage-persons`, `.form-inline`); `.person-modal-section` se conserva (lo usan los modales de cuenta). `sw.js` pasó a `plandental-v9` para que el PWA descargue el HTML/JS nuevo.
- `supabase/seed.sql`: crea la familia "Pablo y Juli" y fija `app.new_user_family_id` (nivel sesión) antes de insertar a pablo; sin inserts a `person_access`. `scripts/validate-migration.js` ahora verifica `families`, la familia de las personas Pablo/Juli y que cada perfil tenga persona (reemplaza los checks de `person_access` y `familia_flag`).
- Las migraciones históricas se dejaron intactas; su contenido sobre `person_access` es esperado en `grep`.

**Status**: [x] done

---

## Sub-task 4 — Ingredientes por familia (sin bypass de admin)

**Intent**: Cada usuario ve solo los ingredientes de su familia. Pablo deja de ver los duplicados de Lara y Diana.

**Expected Outcomes**
- Pablo ve solo ingredientes de pablo y juli.
- Lara y Diana ven solo los suyos (copias ya creadas por la migración anterior).
- Ningún usuario, ni siquiera admin, ve filas de otras familias.

**Todo List**
- [x] Migración (`20261105000400_ingredients_by_family.sql`): `ingredients.family_id` (FK a `families`, `on delete restrict`) con backfill desde la familia del owner, `default my_family_id()` y `not null`. Las 4 policies pasan a `family_id = my_family_id()` (sin `is_admin()`, `to authenticated`, sin acceso `anon`).
- [x] Decisión confirmada: cualquier miembro de la familia puede leer, crear, editar y borrar cualquier ingrediente de su familia. `owner_id` queda como "creador" informativo (default `auth.uid()`); el INSERT exige `owner_id = auth.uid()` y un trigger impide cambiar `family_id`/`owner_id` en UPDATE (salvo `postgres`/`service_role`).
- [x] Eliminar `shares_access_with(uuid)` (`drop function` sin cascade, tras comprobar que ninguna policy/función la usa). `same_family(uuid)` se conserva como helper genérico.
- [x] Deduplicación previa a la nueva unicidad: dentro de cada `(family_id, lower(nombre))` se conserva una fila (la de pablo o, si no, la del perfil más antiguo) y se borran las demás; la migración informa con `raise notice` cuántas borró. Antes de borrar comprueba que ninguna FK apunte a `ingredients(id)` (hoy ninguna: las recetas guardan el ingrediente por nombre en el jsonb).
- [x] Unicidad por familia y `onConflict` del cliente (ver decisión abajo). `saveIngredient` usa `onConflict: 'family_id,nombre'`.
- [x] JS: `saveIngredient` ya no envía `owner_id` (ni consulta `auth.getUser()`); `family_id` y `owner_id` los completa la DB en el insert y no se tocan al editar un ingrediente de otro miembro. `fetchIngredients` y `deleteIngredient` no cambian de comportamiento (la RLS limita a la familia; solo se actualizaron comentarios). `js/ingredients.js` y la UI no usan `owner_id`, no requieren cambios. `sw.js` pasa a `plandental-v10`.
- [x] [`scripts/validate-ingredients.js`](scripts/validate-ingredients.js): se quitaron los asserts de la migración histórica que dependían de `shares_access_with`/`person_access`/`is_admin()` y de `unique (owner_id, nombre)`; se agregó la sección 3b que valida la nueva migración (88/88 OK).
- [ ] Verificación manual (tras ejecutar la migración): loguear como pablo, lara y diana y comparar el conteo de ingredientes (ver abajo).

**Decisión de unicidad y `onConflict`**:
- PostgREST/supabase-js arma `ON CONFLICT (family_id, nombre)` y Postgres solo lo resuelve contra un índice/constraint sobre esas columnas exactas; un índice sobre `lower(nombre)` (expresión) no es inferible desde `onConflict`. Por eso hay **dos** objetos: la constraint `ingredients_family_nombre_key unique (family_id, nombre)` (la que usa el upsert) y el índice único `ingredients_family_nombre_lower_idx on (family_id, lower(nombre))` (garantiza la unicidad case-insensitive).
- Consecuencia conocida: guardar "Pollo" cuando ya existe "pollo" en la familia no actualiza (el upsert inserta y choca con el índice `lower`); el cliente muestra el error del toast "Error al guardar". Es el comportamiento deseado (evita duplicados por mayúsculas). Editar el mismo nombre exacto sí actualiza.
- Dedupe aplicado: pablo y juli comparten familia, así que sus ingredientes homónimos quedan en una sola fila (se conserva la de pablo). Las copias de lara y diana (migración `20261105000000`) quedan cada una en su familia sin choques porque la unicidad ahora es por familia.

**Cómo ejecutar y verificar**:
1. Aplicar la migración (`supabase db push` o pegar el SQL en el editor de Supabase). Revisar los `NOTICE`: cantidad de duplicados eliminados y la lista "Familia ... : N ingrediente(s)". Si algo no cumple, la migración aborta con `Validación fallida: ...`.
2. Desplegar el JS junto con la migración (el cliente nuevo ya no envía `owner_id` y hace upsert por `family_id,nombre`; con el cliente viejo y la DB nueva el upsert falla por `onConflict` sin constraint).
3. Conteos esperados: pablo y juli ven exactamente el mismo catálogo, sin nombres repetidos (el total es el de la familia "Pablo y Juli" del NOTICE); lara y diana ven solo los suyos (la copia de pablo), sin las filas de otras familias. Pablo ya no ve las copias de lara y diana.
4. Prueba cruzada: como juli editar un ingrediente de pablo (debe guardarse y conservar `owner_id` de pablo) y borrar uno; como lara confirmar que no aparece ninguno de pablo/juli.
5. SQL de apoyo: `select f.name, count(*) from ingredients i join families f on f.id = i.family_id group by 1;`

**Notas para Sub-task 5** (implementado en `20261105000400_ingredients_by_family.sql`):
- Patrón reutilizable para `recipes`: `add column family_id uuid references families(id) on delete restrict` → backfill → `alter column family_id set default public.my_family_id()` + `set not null` → policies `for select/insert/update/delete ... to authenticated using/with check (family_id = public.my_family_id())` → `revoke all ... from anon`. El default se pone **después** del backfill (en una migración `my_family_id()` devuelve null porque no hay `auth.uid()`).
- Si el cliente hace `upsert` con `onConflict`, la PK/unique debe ser una **constraint real** sobre columnas exactas, p. ej. `primary key (family_id, id)` para `recipes` (`onConflict: 'family_id,id'`); no usar índices sobre expresiones.
- Si se necesita un campo de "creador" o de familia inmutable, se puede copiar el trigger `ingredients_protect_ownership()` (no `security definer`, para que `current_user` sea el rol que ejecuta; deja pasar a `postgres`/`supabase_admin`/`service_role`/`dashboard_user`).
- Toda migración de validación final puede reutilizar la forma: chequear nulos, consistencia con la familia del owner, duplicados, que ninguna policy use `is_admin()`, y `raise notice` con conteos por familia.
- `shares_access_with` ya no existe; ninguna policy ni función de `public` debe volver a referenciarla. `same_family(uuid)` sigue disponible pero hoy no la usa ninguna policy.
- Antes de borrar filas en `recipes`, buscar FKs con `pg_constraint` (como en la migración de ingredientes) y revisar `plans.recipe_id` (se guarda como texto, sin FK).

**Relevant Context**: [`20261105000400_ingredients_by_family.sql`](supabase/migrations/20261105000400_ingredients_by_family.sql); [`20250602000000_ingredients.sql`](supabase/migrations/20250602000000_ingredients.sql):92-132 (policies históricas); [`20261105000000_copy_pablo_ingredients_to_lara_diana.sql`](supabase/migrations/20261105000000_copy_pablo_ingredients_to_lara_diana.sql); [`js/storage.js`](js/storage.js):502-635; [`js/ingredients.js`](js/ingredients.js); [`scripts/validate-ingredients.js`](scripts/validate-ingredients.js):288-395.

**Status**: [x] done

---

## Sub-task 5 — Recetas por familia

**Intent**: Las recetas dejan de ser globales; cada familia tiene su catálogo.

**Expected Outcomes**
- `recipes` tiene `family_id` y solo se leen/escriben las de la propia familia.
- La familia de Pablo conserva las recetas existentes; la familia de Lara y la de Diana reciben una copia.
- Guardar o borrar una receta afecta solo a la propia familia.

**Todo List**
- [x] Migración: añadir `recipes.family_id`, backfill con la familia de pablo y cambiar la PK a `(family_id, id)`. El slug solo es único dentro de la familia (`20261105000500_recipes_by_family.sql`).
- [x] Copiar todas las recetas de la familia de pablo a la de lara y a la de diana (idempotente con `on conflict do nothing`).
- [x] Reemplazar las 4 policies de `recipes` por unas basadas en `family_id = my_family_id()`, sin bypass de admin.
- [x] `default family_id = my_family_id()` en el insert para que el cliente no tenga que enviarlo (la policy `with check` lo valida igual).
- [x] `saveRecipe`: `upsert` con `onConflict: 'family_id,id'`; `deleteRecipeFromDB`: filtrar por `id` (la RLS limita a la familia).
- [x] Revisar `fetchRecipes` y el fallback a `data/recipes.json` en `loadData` (no debe mostrar recetas globales a un usuario con catálogo vacío; para una familia sin recetas, mostrar lista vacía en lugar de cargar el JSON).
- [x] Revisar `addRecipe` (slug único, ahora acotado a la familia) y `handleDeleteRecipe` en `js/app.js` (llama a `deleteRecipeFromDB`).

**Notas para Sub-task 6** (implementado en `20261105000500_recipes_by_family.sql`):
- `recipes` tiene `family_id uuid not null references families(id) on delete restrict`, con default `public.my_family_id()`.
- La PK de `recipes` es `(family_id, id)` (`recipes_pkey`).
- Cada familia (Pablo y Juli, Lara, Diana) tiene su copia independiente del catálogo de recetas inicial.
- Importante para la Sub-task 6: al hacer backfill de `plans.recipe_snapshot` y `default_week.recipe_snapshot` desde `recipes.receta`, el join debe hacerse por `recipes.family_id = pe.family_id` (a través de `persons pe where pe.id = plans.person_id`) y `recipes.id = plans.recipe_id`, dado que `recipes.id` ya no es único global sino por familia.
- JS: `saveRecipe` usa `onConflict: 'family_id,id'`, `deleteRecipeFromDB` borra por `id` (RLS filtra a la familia), `loadData` solo hace fallback a `data/recipes.json` si `fetchRecipes()` devuelve `null` (offline/error o no autenticado).
- `sw.js` pasó a `plandental-v11`.

**Relevant Context**: [`supabase/migrations/20261105000500_recipes_by_family.sql`](supabase/migrations/20261105000500_recipes_by_family.sql); [`20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql):146-159, 289-304; [`js/storage.js`](js/storage.js):272-330; [`js/recipes.js`](js/recipes.js):30-49, 98-107.

**Status**: [x] done

---

## Sub-task 6 — Plan con recetas versionadas (snapshot completo)

**Intent**: Cada entrada del plan conserva la versión exacta de la receta con la que se asignó, de modo que editar la receta no altera los días ya planificados.

**Expected Outcomes**
- Asignar la receta con 100 g de harina al lunes, editarla a 50 g y asignarla al martes: el lunes suma macros de 100 g y el martes de 50 g.
- Al abrir la receta desde el lunes se ve la versión del lunes (ingredientes, pasos, porciones, macros).
- La lista de compras usa la versión de cada día.
- Los registros de plan existentes siguen funcionando.

**Todo List**
- [x] Migración (`20261105000600_plan_recipe_snapshot.sql`): `plans.recipe_snapshot jsonb` y `default_week.recipe_snapshot jsonb` (nullable), con CHECK en ambas (objeto jsonb y < 100 kB, validado sobre filas existentes).
- [x] Backfill: `recipes.receta` con `recipes.id = recipe_id` y `recipes.family_id = persons.family_id` (vía `person_id`); si no existe, snapshot mínimo `{nombre, macros_por_porcion}`. `macros` no se recalcula.
- [x] `upsert_plan_entry` recibe `p_recipe_snapshot jsonb default null`; se elimina la firma vieja de 7 parámetros.
- [x] `assignMeal` / `assignMealForPerson`: usan `mealFromRecipe()` (copia profunda independiente por persona; `macros` derivados del snapshot).
- [x] `fetchPlan` / `savePlan` y `fetchDefaultWeek` / `saveDefaultWeek` en [`js/storage.js`](js/storage.js): leen y escriben `recipe_snapshot` ↔ `meal.recipeSnapshot` (fila vieja sin snapshot → meal sin `recipeSnapshot`).
- [x] Vista de receta desde el plan: la pill pasa la comida a `openRecipeModal(recipeId, meal)`, que muestra el snapshot (fallback a la receta actual). El catálogo sigue usando `openRecipeModal(recipeId)`.
- [x] `buildShoppingList` delega en `buildShoppingItems()` ([`js/plan-versions.js`](js/plan-versions.js)): agrupa por `(recipeId + huella de ingredientes/porciones)`; cada versión tiene sus propios lotes.
- [x] `planner.js` (`mealEntry`): usa `mealFromRecipe()`. La semana por defecto se copia al plan con `copyMealForPlan()` (genera snapshot desde la receta actual si la plantilla no lo tiene); «Usar como predeterminada» guarda `recipeSnapshot` porque las comidas ya lo llevan.
- [x] Confirmado por `grep`: `calendar.js` (`computeDayMacros`), `ui.js` y `planner.js` suman `meal.macros`; `saveRecipeFromForm` / `saveRecipeFromJSON` no tocan el plan.
- [x] Vista «Familia» (`getDayEntry` y `renderDayDetail`): «Los dos» solo si `sameMealVersion()`; si la versión difiere se muestran por separado.
- [x] `scripts/verify-recipe-versions.js` (17 checks, sin DB) pasa.
- [ ] Prueba manual del escenario 100 g → 50 g (pendiente del usuario, ver pasos abajo).

**Cómo ejecutar**: aplicar `20261105000600_plan_recipe_snapshot.sql` (`supabase db push` o pegar en el editor SQL) y desplegar el JS a la vez (el cliente nuevo llama a `upsert_plan_entry`/`plans` con `recipe_snapshot`; `sw.js` pasó a `plandental-v12`). Revisar los `NOTICE` de conteos de snapshot completo vs mínimo.

**Prueba manual (100 g → 50 g)**:
1. Crear/editar una receta con 100 g de harina y macros conocidos. Asignarla al lunes.
2. Editar la receta: 50 g de harina y macros menores. Guardar.
3. Asignar la receta editada al martes.
4. Verificar que el lunes suma los macros de 100 g y el martes los de 50 g (barra de kcal y panel del día).
5. Hacer click en el nombre de la receta en el lunes (ingredientes 100 g) y en el martes (50 g); desde el sidebar debe verse 50 g.
6. Lista de compras (desde hoy hasta el domingo): la harina suma 100 + 50 (lotes separados por versión).
7. En Familia, asignar la v1 a Pablo y la v2 a Juli en el mismo slot: se muestran como comidas distintas; con la misma versión, «Los dos».

**Relevant Context**: [`20250101000001_rpc_functions.sql`](supabase/migrations/20250101000001_rpc_functions.sql):131-163; [`js/app.js`](js/app.js):789-945, 1401-1480; [`js/storage.js`](js/storage.js):246-330, 497-560; [`js/planner.js`](js/planner.js):97-160; [`js/ui.js`](js/ui.js):200-235.

**Notas para Sub-task 7** (implementado en `20261105000600_plan_recipe_snapshot.sql`):
- `plans` y `default_week` tienen `recipe_snapshot jsonb` (CHECK `*_recipe_snapshot_check`: objeto y < 100 kB). La migración valida que `upsert_plan_entry` (única firma, 8 parámetros) no use `is_admin()`, sea `security definer` con `search_path` fijo y solo la ejecute `authenticated`.
- Módulo puro nuevo [`js/plan-versions.js`](js/plan-versions.js) (sin DOM): `mealFromRecipe`, `copyMealForPlan`, `sameMealVersion`, `versionFingerprint`, `resolveMealReceta`, `buildShoppingItems`. La sub-tarea 8 (pre-selecciones de compras) debe seguir usando `buildShoppingItems`; `isExcluded` se inyecta desde `app.js`.
- `ui.js` ahora tiene `esc()` y escapa el contenido de `renderRecipeDetail`, las pills y los paneles del día. **Hallazgo**: antes no se escapaba nada (nombre, descripción, ingredientes, pasos); como el snapshot lo puede haber editado otro miembro de la familia, se escapó lo tocado. Siguen sin escapar (fuera de alcance): `renderRecipeCard` (nombre/categoría, `ui.js`), `showSlotPickerForDrop` (`app.js`) y otros `innerHTML` del editor de recetas/ingredientes; conviene revisarlos en una pasada de seguridad.
- Para la sub-tarea 7: las policies de `plans`/`default_week` ya usan `person_in_my_family()` (sin `is_admin()`) y no se tocaron aquí; `scripts/validate-ingredients.js` sigue pasando (88/88).
- Limitación conocida: el backfill usa la receta actual, no la histórica; las filas migradas con snapshot mínimo (sin `ingredientes`) caen al catálogo actual en vista de receta y compras.
- Mismo `recipeId` con distinta versión ya no se agrupa en compras ni se muestra como «Los dos» en Familia.

**Status**: [x] done

---

## Sub-task 7 — UI de administración y limpieza de bypass admin

**Intent**: Exponer la elección de familia al crear usuarios y cerrar el resto de accesos transversales del admin.

**Expected Outcomes**
- El modal "Gestionar usuarios" permite elegir una familia existente o crear una nueva.
- Solo Pablo ve el botón; la validación real sigue en el servidor.
- Pablo no ve planes ni datos nutricionales de familias ajenas.

**Todo List**
- [x] [`index.html`](index.html): en "Crear usuario", `<select id="select-new-user-family">` (con `<label for>`) y campo `#field-new-family-name` (oculto salvo "Nueva familia…", `maxlength=100`). Sin CSS nuevo: reutiliza `.form-field` y `.hidden`.
- [x] [`js/storage.js`](js/storage.js): `adminCreateUser(username, password, { familyId = null, newFamilyName = null } = {})` envía `p_family_id` / `p_new_family_name`; nueva `adminListFamilies()` (RPC `admin_list_families`, devuelve array, lanza `Error` en fallo como el resto).
- [x] [`js/app.js`](js/app.js): `openUserMgmtModal` llama a `loadFamiliesForUserMgmt()` (solo si `state.profile.role === 'admin'`); `renderFamilySelect` arma las `<option>` con `createElement` + `textContent` (nombre y miembros, sin `innerHTML`); `handleCreateUser` exige familia elegida o nombre de familia nueva no vacío (≤ 100) y tras crear recarga la lista. El error del RPC se registra con `console.error` y al usuario se le muestra un mensaje genérico.
- [x] Auditoría de `is_admin()` sobre el estado final (ver abajo): sin bypass. Aislamiento total confirmado para `persons`, `plans`, `nutrition_data`, `default_week`, `ingredients`, `recipes`, `profiles` y `families`. (`shopping_preferences` aún no existe: la crea la sub-tarea 8 y no debe usar `is_admin()`.)
- [x] Migración [`20261105000700_admin_cleanup.sql`](supabase/migrations/20261105000700_admin_cleanup.sql): restringe SELECT de `profiles`, revoca `anon` sobre `profiles` y sobre `admin_reset_password`, y termina con un bloque de validación ejecutable (ver abajo).
- [x] [`scripts/validate-ingredients.js`](scripts/validate-ingredients.js): nueva sección 3c que valida la migración (99/99 OK). [`scripts/validate-migration.js`](scripts/validate-migration.js): checks de que `anon` no lee `profiles` ni ejecuta `admin_list_families` (requiere DB y `scripts/.env`; no se pudo correr aquí). `sw.js` → `plandental-v13`.
- [ ] Verificación manual (pendiente del usuario, ver pasos abajo).

**Hallazgos del audit de `is_admin()`** (estado final tras `20261105000600`):
- Policies: ninguna usa `is_admin()`. Las históricas (`profiles: admin all`, `persons: *`, `plans`, `nutrition_data`, `default_week`, `ingredients: *`, `recipes: *`) fueron reemplazadas en 0100, 0300, 0400 y 0500; `families` y `profiles` actuales no la usan.
- Funciones: solo `admin_create_user` (versión de 0300), `admin_reset_password` (versión de `20250610000003`) y `admin_list_families` (0200) la llaman. `upsert_plan_entry`/`delete_plan_entry` usan `person_in_my_family()`. Las versiones viejas que la usaban (`reject_person_access`, `approve_*`, etc.) fueron eliminadas en 0300. `is_admin()` queda definida (0100) como `security definer` con `search_path = public, pg_temp`.
- Conclusión: no quedaba ningún bypass de datos, así que 0700 no reescribe policies de datos.
- Hallazgo menor corregido: `admin_reset_password` solo tenía `revoke ... from public`; en Supabase `anon` suele tener un grant propio por default privileges. 0700 hace `revoke ... from public, anon` (la función igual valida `is_admin()` adentro).

**Hallazgo y decisión sobre `profiles`**: desde 0100 la policy `profiles: select authenticated` era `using (true)`: cualquier usuario autenticado podía listar `username`, `role` y `family_id` de todas las familias (y con eso, por ejemplo, saber cuáles son admin). Se reemplazó por `profiles: select own family` (`id = auth.uid() or family_id = my_family_id()`, `to authenticated`). Riesgo evaluado como bajo: el único `.from('profiles')` del cliente es `getMyProfile` (fila propia); `admin_list_families`, `admin_create_user`, `my_family_id()`, `same_family()` y los triggers son `security definer` y no dependen de la policy; ninguna otra policy lee `profiles` con el rol del cliente. La vista "Familia" usa `persons` (no `profiles`). `my_family_id()` es `security definer`, por lo que no hay recursión de RLS.

**Validación ejecutable de 0700** (falla con `raise exception`): ninguna policy ni vista de `public` referencia `is_admin`; ninguna función de `public` fuera de `admin_create_user`, `admin_reset_password`, `admin_list_families` e `is_admin` la referencia; `is_admin()` única, `security definer` con `search_path` fijo; cada RPC admin con una sola firma, verifica `is_admin()`, `security definer`, `search_path` fijo, ejecutable por `authenticated` y no por `anon`; `profiles` con RLS, solo policies SELECT (una, limitada a `auth.uid()`/`my_family_id()`) y UPDATE, sin policies abiertas ni para `anon`/`public`, y `anon` sin SELECT.

**Cómo ejecutar**: aplicar `20261105000700_admin_cleanup.sql` (`supabase db push` o editor SQL) y desplegar el JS a la vez (`sw.js` v13): con el JS viejo, crear usuarios sigue roto. Si la validación aborta, el mensaje dice qué objeto viola la regla. Nota: no se pudo ejecutar el SQL (no hay DB disponible); se revisó a mano.

**Prueba manual**:
1. Como pablo: Mi cuenta → Gestionar usuarios. El selector debe listar las familias con sus miembros (p. ej. "Pablo y Juli (juli, pablo)") y "Nueva familia…".
2. Crear usuario en familia existente (p. ej. `test1` en la de Lara): debe crearse, aparecer en esa familia tras recargar la lista, y al loguearse ver las recetas/ingredientes de esa familia y su persona "Test1" en "Mis datos".
3. Crear usuario con "Nueva familia…" (nombre `Familia Test`): la familia aparece en el selector con ese usuario; el usuario no ve datos de otras familias. Probar nombre vacío y nombre duplicado: mensaje de error sin detalles internos.
4. Sin elegir familia ni nombre: el cliente bloquea con un toast.
5. Como lara: no aparece "Gestionar usuarios"; desde la consola, `supabase.rpc('admin_list_families')`, `admin_create_user` y `admin_reset_password` fallan.
6. Como lara: `supabase.from('profiles').select('username, family_id')` solo devuelve su propia fila (y las de su familia); pablo ve solo pablo y juli.
7. Opcional, `node scripts/validate-migration.js` (con `scripts/.env`) para los checks de `anon`.

**Notas para Sub-task 8**:
- `shopping_preferences` es nueva: usar el patrón de 0400/0500 (`family_id` PK con FK a `families`, `default my_family_id()`, policies `to authenticated` con `family_id = my_family_id()`, `revoke all ... from anon`). No usar `is_admin()`: al agregar su migración, el bloque de 0700 (si se vuelve a ejecutar o se copia) y `validate-ingredients.js` 3c ayudan a no reintroducirlo.
- Como la PK será `family_id`, el `upsert` del cliente usa `onConflict: 'family_id'` (constraint real). Hacer `updated_at` con default `now()` y actualizarlo desde el cliente al guardar.
- `state.profile` ya trae `role`; la lista de deseleccionados se debe cargar tras el login junto a `getMyPersons`, para que `buildShoppingList` siga síncrono. `buildShoppingItems` en [`js/plan-versions.js`](js/plan-versions.js) recibe `isExcluded` inyectado desde `app.js`.
- Subir `CACHE_NAME` a `plandental-v14` si se tocan JS/HTML.
- Pendiente de seguridad fuera de alcance (ya anotado en sub-tarea 6): `innerHTML` sin escapar en `renderRecipeCard`, `showSlotPickerForDrop` y el editor de recetas/ingredientes.

**Relevant Context**: [`supabase/migrations/20261105000700_admin_cleanup.sql`](supabase/migrations/20261105000700_admin_cleanup.sql); [`index.html`](index.html):262-295; [`js/app.js`](js/app.js):1717-1840, 2187; [`js/storage.js`](js/storage.js):55-97.

**Status**: [x] done

---

## Sub-task 8 — Pre-selecciones de la lista de compras por familia

**Intent**: Guardar "Guardar pre-selecciones" por familia en la base de datos, en vez de en `localStorage` con clave global.

**Expected Outcomes**
- Todos los miembros de una familia comparten la misma lista de ingredientes deseleccionados por defecto, en cualquier dispositivo.
- Dos familias distintas, o dos usuarios en el mismo navegador, ya no se pisan.
- Una familia sin lista guardada empieza con `SHOPPING_DESELECT_SEED`.

**Todo List**
- [ ] Migración: crear `shopping_preferences(family_id uuid primary key references families, deselected text[] not null default '{}', updated_at timestamptz)`. RLS por `family_id = my_family_id()`, sin bypass de admin.
- [ ] [`js/storage.js`](js/storage.js): añadir `fetchShoppingDeselected()` (devuelve `null` si la familia no tiene fila) y `saveShoppingDeselected(list)` (upsert por `family_id`; el valor lo completa un default `my_family_id()`).
- [ ] [`js/app.js`](js/app.js):1366-1385: reemplazar `loadShoppingDeselectedDefaults` / `saveShoppingDeselectedDefaults` (localStorage) por estas llamadas. Cargar la lista una vez al iniciar sesión y guardarla en `state`, para que `buildShoppingList` y el modal de compras sigan siendo síncronos. `saveShoppingPreselections` (línea 1568) pasa a ser `async` con manejo de error y toast.
- [ ] Eliminar el uso de `localStorage` y la clave `shopping_deselected_defaults`. Decisión confirmada: no se migra el valor local; cada familia parte de `SHOPPING_DESELECT_SEED` y el usuario ajusta sus pre-selecciones a mano.
- [ ] Verificación manual: guardar como Lara, entrar como Pablo (otra familia) y confirmar que ve el seed; entrar como Juli y confirmar que ve la de Pablo.

**Relevant Context**: [`js/app.js`](js/app.js):1365-1395, 1545-1576, 2216; [`index.html`](index.html):438-439.

**Status**: [ ] pending

---

## Verificación final (después de la sub-tarea 8)

Pendientes detectados durante la ejecución, a comprobar al terminar todas las sub-tareas:

- [ ] Lara (y cualquier usuario no admin) ya no ve el botón 👥 "Gestionar personas" ni puede crear personas. Detectado el 2026-11-05 al probar la sub-tarea 1: seguía visible porque se elimina en la sub-tarea 3. Comprobar también desde la consola que el RPC `create_person_with_access` ya no existe.
- [ ] Lara no ve "Gestionar usuarios" y `admin_create_user` / `admin_reset_password` la rechazan.
- [ ] Un `update profiles set role='admin'` hecho por un usuario no admin falla.
- [ ] Pablo ve solo ingredientes y recetas de pablo y juli; Lara y Diana, solo los suyos.
- [ ] Lara ve el form "Mis datos" y puede guardarlo.
- [ ] Escenario de versionado: receta con 100 g de harina al lunes, editar a 50 g, asignar al martes; el lunes suma 100 g y el martes 50 g, también en la lista de compras.
- [ ] Las pre-selecciones de la lista de compras se comparten dentro de la familia y no entre familias.
- [ ] No quedan referencias a `person_access`, `familia_flag`, `has_approved_access`, `shares_access_with` ni `localStorage` de `shopping_deselected_defaults` (hacer `grep` en `js/`, `supabase/`, `scripts/` e `index.html`).
- [ ] Ninguna policy ni RPC usa `is_admin()` salvo `admin_create_user`, `admin_reset_password` y `admin_list_families`.

---

## Orden de ejecución y riesgos

- Orden: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Las sub-tareas 1 y 2 son prerrequisito del resto; la 3 depende de la 2 (usa `persons.family_id` y `my_family_id()`).
- Contexto confirmado por el usuario: la base tiene solo 4 usuarios (`pablo`, `juli`, `lara`, `diana`); `lara` y `diana` son nuevos y nunca usaron la app. La única familia con datos es la de `pablo` y `juli`, por lo que el riesgo de las migraciones es bajo. Aun así, la migración debe dejar la familia pablo + juli correcta y verificada.
- Riesgo: eliminar `person_access` es destructivo e irreversible. Antes de la migración de borrado hay que confirmar que el backfill de `family_id` cubrió a todos los perfiles y personas, y que las policies reescritas ya no referencian la tabla.
- Cada sub-tarea es una migración nueva con timestamp posterior a `20261105000000`, más sus cambios de JS. No editar migraciones ya ejecutadas.
- Riesgo: cambiar la PK de `recipes` y el nombre único global de `persons` (`persons.name` único case-insensitive) pueden chocar con datos existentes. Las migraciones deben ser idempotentes y fallar con mensaje claro.
- Riesgo: el backfill de `recipe_snapshot` usa la receta actual, no la versión histórica real (que no se guardó). Los días ya planificados no reflejarán ediciones previas.
- Los despliegues de migración y del JS deben ir juntos (el cliente nuevo llama a RPCs con nuevos parámetros).
- Seguridad: las comprobaciones de rol y familia viven en RLS y en RPCs `security definer` con `search_path` fijo. La UI solo oculta controles.
