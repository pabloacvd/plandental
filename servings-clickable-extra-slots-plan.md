# Plan: Porciones comidas, slot-card clickeable y slots extra

## Top-Level Overview

**Goal.** Tres mejoras al plan de comidas:

1. **Porciones comidas.** Poder indicar cuántas porciones comió cada persona de cada comida del plan (0,25; 0,5; 1; 2; 3…). Los macros y las calorías se escalan en consecuencia. Funciona en vista de una persona y en vista Familia (un control por integrante). Cubre tanto recetas de varias porciones (cheesecake de 4) como de 1 porción (Café Latte: 0,5 porción, o Pablo 1 + Juli 1 = 2 cafés).
2. **Slot-card clickeable.** En el panel de detalle del día, hacer click en una comida abre la receta **guardada en ese día y slot** (snapshot), no la receta actual del recetario.
3. **Slots extra.** Poder agregar comidas adicionales ("Snack extra") sin tope fijo, desde un botón "+ Agregar una comida" al final del día. Cada extra tiene un período (mañana / tarde / noche) editable, y se muestra justo después del slot fijo de su período.

**Non-goals.**

- No refactorizar la app. Todo es aditivo y mínimo.
- No cambiar el modelo de recetas ni el snapshot de recetas (`recipe_snapshot`).
- No renombrar ni reordenar los 5 slots fijos.
- No agregar horario exacto a los extras (solo mañana / tarde / noche).
- No tocar el autoplanner (`js/planner.js`): sigue usando solo los 5 slots fijos.
- No guardar datos en archivos. Todo vive en la base de datos.

## Decisiones confirmadas con el usuario

| Tema | Decisión |
|---|---|
| Orden de extras | Cada extra va **justo después del slot fijo de su período**: mañana después de Desayuno, tarde después de Snack tarde, noche después de Snack noche |
| Nombre | Los extras se llaman "Snack extra" y aceptan cualquier receta |
| Porciones, recetas de 1 porción | Sin caso especial: `servings` es un multiplicador de la porción de la receta. 0,5 = mitad de macros; 2 = doble de macros y se cocinan 2 porciones |
| Porciones, Familia | Cada integrante tiene su propio valor de porciones en cada comida |
| Receta abierta al click | La del snapshot de ese día y slot (`resolveMealReceta`) |

## Decisiones de diseño (propuestas, a validar)

| Tema | Propuesta | Motivo |
|---|---|---|
| Dónde se guarda `servings` | Columna nueva `plans.servings numeric` (default 1) y también en `default_week`. En la comida: `meal.servings` | Es dato de la comida, no de la receta. No entra en el snapshot, así que `sameMealVersion` sigue agrupando igual |
| `macros` | **Siguen siendo por porción** (copiadas de `macros_por_porcion`). Se multiplica por `servings` al sumar | No hay que reescribir filas existentes. Al cambiar porciones solo cambia un número |
| Rango de porciones | Mínimo 0,25, máximo 10, paso 0,25. Check en la base | Cubre 0,25 / 0,5 / 1 / 2 / 3 y evita valores absurdos |
| Control de porciones | Campo numérico con botones − / + (paso 0,25) en el slot-card del detalle del día. En el calendario semanal la pastilla muestra "×N" solo si `servings ≠ 1` | Cambio rápido y legible |
| Lista de compras | Se suman **porciones comidas** por (receta + versión): `batches = ceil(Σ servings / porciones de la receta)`, redondeando la suma a 2 decimales antes del `ceil` | Hoy es `ceil(cantidad de comidas / porciones)`, solo cambia que cada comida pesa `servings` en vez de 1 |
| Cómo se identifica un extra | `slot_id` = `extra_1`, `extra_2`… (único por día, compartido por todos los integrantes en Familia) y columna `slot_period` (`manana` / `tarde` / `noche`) en `plans` y `default_week` | Mantiene `unique (person_id, date_key, slot_id)` y el upsert actual sin cambios |
| Extra vacío | Un extra recién agregado vive solo en memoria hasta que se le asigna una receta (no se guarda una fila sin receta). Se descarta al quitar la última comida del extra | `plans.recipe_id` es `not null`; no se inventan filas vacías |
| Cambio de período | Actualiza `slot_period` de las filas del extra para todos los integrantes visibles | Mantiene el orden consistente |
| Click en slot-card | Toda la zona de la comida (nombre y macros) es clickeable, con `cursor: pointer`, `role="button"`, `tabindex="0"` y Enter/Espacio. Botones y controles (Quitar, porciones, período) no disparan la apertura | Accesibilidad y sin conflictos de eventos |

## Estado actual relevante (verificado en el código)

- Stack: JS vanilla ES modules, sin build. Supabase con RLS. PWA con `CACHE_NAME = 'plandental-v16'` en [`sw.js`](sw.js).
- Una comida del plan es `{ recipeId, recipeName, macros, recipeSnapshot? }` ([`js/plan-versions.js`](js/plan-versions.js:25), `mealFromRecipe`). Hoy 1 comida = 1 porción siempre.
- `plans` tiene `unique (person_id, date_key, slot_id)` y `check (slot_id in (5 valores))` ([`supabase/migrations/20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql:123)). `default_week` tiene el mismo check ([`supabase/migrations/20250601000000_default_week.sql`](supabase/migrations/20250601000000_default_week.sql:19)).
- Los totales se calculan en `computeDayMacros` ([`js/calendar.js`](js/calendar.js:86)) y en la vista `person_daily_intake` ([`supabase/migrations/20261111000100_weight_log_and_goals.sql`](supabase/migrations/20261111000100_weight_log_and_goals.sql:111)); esta última alimenta dashboard y recálculo automático. `accumulatedMacros` en [`js/planner.js`](js/planner.js:144) solo se usa al autocompletar (siempre 1 porción).
- `MEAL_SLOTS` ([`js/calendar.js`](js/calendar.js:75)) se itera en [`js/ui.js`](js/ui.js:168) (pastillas), [`js/ui.js`](js/ui.js:387) y [`js/ui.js`](js/ui.js:459) (slot-cards de detalle, Familia y persona), [`js/app.js`](js/app.js:748) y [`js/app.js`](js/app.js:831) (selectores de slot) y [`js/planner.js`](js/planner.js:198).
- `savePlan`/`fetchPlan` ([`js/storage.js`](js/storage.js:181)) y `saveDefaultWeek`/`fetchDefaultWeek` ([`js/storage.js`](js/storage.js:549)) mapean campo por campo: hay que agregar las columnas nuevas ahí.
- Ya existe `openRecipeModal(recipeId, meal)` ([`js/app.js`](js/app.js:980)), que usa el snapshot de la comida. La pastilla del calendario ya lo usa ([`js/ui.js`](js/ui.js:262)); el slot-card del detalle del día aún no.
- `buildShoppingList` ([`js/app.js`](js/app.js:1431)) y `buildShoppingItems` ([`js/plan-versions.js`](js/plan-versions.js:120)) cuentan 1 por comida.
- Las RPC `upsert_plan_entry` de migraciones viejas (p. ej. [`20261105000600_plan_recipe_snapshot.sql`](supabase/migrations/20261105000600_plan_recipe_snapshot.sql:135)) existen en la base pero el cliente actual hace upsert directo a la tabla; no se tocan salvo que se confirme que algo las usa.
- Tests: solo [`scripts/test-nutrition.mjs`](scripts/test-nutrition.mjs) y [`scripts/verify-recipe-versions.js`](scripts/verify-recipe-versions.js), ambos importan módulos puros desde Node.
- Última migración: `20261111000100_weight_log_and_goals.sql`.

---

## Sub-Tasks

> Cada sub-task es independiente y revisable. Se implementan de a uno, esperando la validación del usuario entre cada uno.

### 1. Slot-card clickeable (receta guardada del día y slot)

**Intent.** Que se pueda ver la receta tal como estaba cuando se agregó al plan, directamente desde el detalle del día. No requiere cambios de base.

**Expected Outcomes.**

- En vista persona, click en una comida del slot-card abre el modal de receta con el snapshot de ese slot.
- En vista Familia, tanto la comida compartida como cada fila por integrante abre el snapshot de la comida de esa persona.
- Los botones Quitar / + Agregar y el drop de recetas siguen funcionando igual.
- Navegable con teclado (Enter / Espacio) y con indicador visual de que es clickeable.
- Comidas legacy sin snapshot abren la receta actual del catálogo (comportamiento ya existente de `resolveMealReceta`).

**Todo List.**

- [x] Agregar un parámetro `onRecipeClick(recipeId, meal)` a `renderDayDetail` en [`js/ui.js`](js/ui.js:363).
- [x] En el slot-card de persona: hacer clickeable la zona de nombre y macros; guardar la comida en el elemento (mismo patrón `mealRef` de las pastillas, [`js/ui.js`](js/ui.js:239)).
- [x] En Familia: lo mismo en la tarjeta compartida y en cada `slot-family-person-row` con comida (`buildPersonMealHTML`, [`js/ui.js`](js/ui.js:514)).
- [x] Pasar `onRecipeClick: openRecipeModal` desde `refreshDayDetail` ([`js/app.js`](js/app.js:680)), en ambas ramas.
- [x] Estilos en [`css/style.css`](css/style.css:495): `cursor: pointer`, hover y `:focus-visible` para la zona clickeable, con variables CSS existentes.
- [x] Verificar que ningún click en botones o controles dispare el modal (`closest('button, input')`).

**Relevant Context.**

- [`js/ui.js`](js/ui.js:363) (`renderDayDetail`), [`js/app.js`](js/app.js:980) (`openRecipeModal`), [`js/plan-versions.js`](js/plan-versions.js:102) (`resolveMealReceta`).
- Contexto para Sub-Task 2 y 3: Los elementos `.slot-meal-clickable` en `js/ui.js` ya filtran clics provenientes de controles hijos mediante `e.target.closest('button, input, select')`, por lo que cuando se agreguen los controles de `servings` o selectores de período en los sub-tasks siguientes no dispararán el modal de receta accidentalmente.

**Status.** [x] done

---

### 2. Base de datos: `servings`, slots extra y vista de ingesta

**Intent.** Persistir las porciones y los slots extra de forma consistente, y que la ingesta diaria (dashboard y recálculo automático) refleje las porciones reales.

**Expected Outcomes.**

- `plans` y `default_week` tienen `servings` (default 1, entre 0,25 y 10) y `slot_period`.
- `slot_id` acepta los 5 fijos y `extra_<n>`; los extras exigen `slot_period` válido.
- `person_daily_intake` suma `macros × servings`.
- Datos existentes quedan intactos (todo en `servings = 1`).
- La migración es idempotente y no cambia RLS.

**Todo List.**

- [x] Crear `supabase/migrations/20261112000100_servings_and_extra_slots.sql`. Idempotente ("Safe to re-run"), mismo estilo que [`20261111000100_weight_log_and_goals.sql`](supabase/migrations/20261111000100_weight_log_and_goals.sql).
- [x] `alter table public.plans add column if not exists servings numeric not null default 1` con check `servings >= 0.25 and servings <= 10`. Igual en `default_week`.
- [x] `add column if not exists slot_period text` en ambas tablas, con check `slot_period in ('manana','tarde','noche')` (nullable para los fijos).
- [x] Reemplazar el check de `slot_id` (drop del constraint existente por nombre real, verificándolo en la base antes) por: `slot_id in (5 fijos)` **o** `slot_id ~ '^extra_[0-9]+$'`. Check adicional: si `slot_id` empieza con `extra_`, `slot_period` no puede ser null.
- [x] `create or replace view public.person_daily_intake` multiplicando cada macro por `coalesce(p.servings, 1)`. Mantener `security_invoker = true` y las mismas columnas.
- [x] Bloque final de validación con `raise exception` (columnas existen, checks activos, vista con `security_invoker`, RLS de `plans` y `default_week` sigue habilitado, sin grants a `anon`), como en la migración anterior.
- [x] En [`js/storage.js`](js/storage.js): `fetchPlan`/`savePlan`/`fetchDefaultWeek`/`saveDefaultWeek` leen y escriben `servings` y `slot_period`. Filas sin valor: `servings = 1`.
- [x] Función nueva en `storage.js` para actualizar el período de un extra (`updateExtraSlotPeriod`) o reutilizar `savePlan` (decidir al implementar según lo más simple). **Decisión: no se crea `updateExtraSlotPeriod`; se reutiliza `savePlan`** (ver contexto abajo).

**Relevant Context.**

- [`supabase/migrations/20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql:118), [`supabase/migrations/20250601000000_default_week.sql`](supabase/migrations/20250601000000_default_week.sql), [`supabase/migrations/20261111000100_weight_log_and_goals.sql`](supabase/migrations/20261111000100_weight_log_and_goals.sql:111).
- [`js/storage.js`](js/storage.js:181), [`js/storage.js`](js/storage.js:549).
- Verificar el nombre del check constraint actual en la base antes de dropearlo (Postgres lo nombra `plans_slot_id_check` por defecto, pero hay que confirmarlo).
- Migración manual: hay que aplicarla en Supabase antes de usar la UI nueva.
- **Contexto para Sub-Task 3 y 4 (resultado del Sub-Task 2):**
  - La migración está **escrita pero NO aplicada** en ninguna base. Hasta aplicarla, `fetchPlan`/`savePlan`/`fetchDefaultWeek`/`saveDefaultWeek` fallan (el `select` y el upsert piden `servings` y `slot_period`). Aplicarla antes de probar en la UI.
  - **Nombre del check de `slot_id`:** en las migraciones, el check es inline y sin nombre ([`20250101000000_initial_schema.sql`](supabase/migrations/20250101000000_initial_schema.sql:123) y [`20250601000000_default_week.sql`](supabase/migrations/20250601000000_default_week.sql:19)), así que Postgres lo nombra `plans_slot_id_check` / `default_week_slot_id_check`. La migración no asume el nombre: dropea por definición (`pg_get_constraintdef ~ 'slot_id'` y `!~ 'slot_period'`) todos los checks de `slot_id` y recrea con esos nombres explícitos. Al final valida que quede exactamente un check de `slot_id` por tabla.
  - **Modelo de comida en memoria:** `{ recipeId, recipeName, macros (por porción), servings, recipeSnapshot?, slotPeriod? }`. `fetchPlan`/`fetchDefaultWeek` siempre devuelven `servings` (número, 1 si la fila no lo tiene); `slotPeriod` solo existe si la fila tiene `slot_period` (extras).
  - `savePlan`/`saveDefaultWeek` escriben `servings: meal.servings ?? 1` y `slot_period` **solo si `slotId` empieza con `extra_`** (`meal.slotPeriod ?? null`); en slots fijos siempre mandan `null`. Un extra sin `slotPeriod` en memoria falla por el check `plans_extra_requires_period_check`: en el sub-task 4, `assignMeal`/`assignMealForPerson` deben setear `meal.slotPeriod` antes de guardar.
  - **Cambio de período de un extra (`updateExtraSlotPeriod`):** se decidió **no crear una función nueva**. Basta con actualizar `meal.slotPeriod` en `state.plan` de cada integrante visible y llamar a `savePlan`: el upsert por `person_id,date_key,slot_id` sobrescribe `slot_period`. Es lo mismo que haría el cambio de porciones (`setMealServings` del sub-task 3 también usa `savePlan`).
  - `servings` no se valida en el cliente en `storage.js` (solo default 1). El clamp 0,25–10 / paso 0,25 es responsabilidad de `mealServings(meal)` (sub-task 3); la base rechaza valores fuera de rango con `plans_servings_check`.
  - `person_daily_intake` ya devuelve `macros × servings`; `meals_count` sigue contando filas (no porciones).
  - `savePlan` hace upsert pero no borra: quitar un extra sigue usando `removePlanEntry` por `slot_id`, sin cambios.

**Status.** [x] done

---

### 3. Porciones comidas: lógica y UI

**Intent.** Que cada comida del plan tenga porciones editables y que todos los cálculos las respeten, incluyendo la lista de compras.

**Expected Outcomes.**

- Al agregar una receta, `servings` = 1 por defecto.
- En el detalle del día, cada comida tiene un control de porciones (−, valor editable, +; paso 0,25). En Familia, un control por integrante, también en la tarjeta compartida (el nombre aparece una vez y las porciones, por persona).
- Calorías y macros del slot-card, resumen del día, barras del calendario, dashboard y recálculo automático usan `macros × servings`.
- La pastilla del calendario muestra "×N" si `servings ≠ 1`.
- Receta de 1 porción: 0,5 → mitad de macros; Pablo 1 + Juli 1 → la lista de compras suma 2 porciones (2 cafés).
- Cheesecake de 4 porciones: 2 porciones comidas → el doble de macros por persona; 4 porciones entre todos → un solo batch.
- Cambiar porciones guarda en la base y no pierde el snapshot.

**Todo List.**

- [x] Helpers puros en [`js/plan-versions.js`](js/plan-versions.js): `mealServings(meal)` (default 1, normaliza a rango 0,25–10, paso 0,25) y `scaledMacros(meal)`.
- [x] `mealFromRecipe` agrega `servings: 1`; `copyMealForPlan` conserva `servings`.
- [x] `computeDayMacros` ([`js/calendar.js`](js/calendar.js:86)) usa `scaledMacros`. Revisar `accumulatedMacros` de [`js/planner.js`](js/planner.js:144): queda sin cambios (siempre 1 porción), documentarlo (solo se agregó un comentario).
- [x] `buildShoppingItems` ([`js/plan-versions.js`](js/plan-versions.js:120)): acumular `Σ servings` por grupo en lugar de contar comidas; `batches = ceil(round2(Σ) / porciones)`. Actualizar comentarios que dicen "1 meal = 1 portion" (también en [`js/app.js`](js/app.js:1442)).
- [x] Función `setMealServings(dateKey, slotId, personId, servings)` en [`js/app.js`](js/app.js): actualiza `state.plan`, re-renderiza semana y detalle, y llama a `savePlan` (con debounce corto para no guardar en cada click del botón).
- [x] Controles de porciones en `renderDayDetail` ([`js/ui.js`](js/ui.js:363)) y en `buildPersonMealHTML` ([`js/ui.js`](js/ui.js:514)); macros del slot-card mostrados ya escalados.
- [x] Mostrar "×N" en la pastilla ([`js/ui.js`](js/ui.js:233)). En Familia, `groupSlotMeals` agrupa por versión: si las porciones difieren, mostrar el detalle por persona en el `title`.
- [x] Estilos del stepper en [`css/style.css`](css/style.css), con variables existentes y área táctil adecuada en móvil (< 700px).
- [x] Propagación al copiar semana, aplicar semana por defecto y guardar como semana por defecto (los tres usan el objeto de comida, así que deberían conservar `servings`; verificarlo). **Verificado:** no existe una función "copiar semana" en el código (`grep`); aplicar la semana por defecto usa `copyMealForPlan` (deepClone, conserva `servings`) y guardar como predeterminada pasa el objeto de comida a `saveDefaultWeek`, que escribe `servings`.
- [x] Script nuevo `scripts/test-servings.mjs` (Node, `assert`, sin dependencias): `scaledMacros`, `computeDayMacros` con 0,5 / 1 / 2 porciones, y `buildShoppingItems` con Café Latte 1+1 → 2 batches, cheesecake de 4 porciones con 2+2 → 1 batch y 2+3 → 2 batches, y 0,5 de receta de 1 porción → 1 batch.

**Relevant Context.**

- [`js/plan-versions.js`](js/plan-versions.js), [`js/calendar.js`](js/calendar.js:86), [`js/ui.js`](js/ui.js:363), [`js/app.js`](js/app.js:886) (`assignMeal`, `assignMealForPerson`), [`js/app.js`](js/app.js:1431) (`buildShoppingList`).
- `computeDayMacros` ya lo importa [`scripts/verify-recipe-versions.js`](scripts/verify-recipe-versions.js:81): no romper su ejecución.
- **Contexto para Sub-Task 4 (resultado del Sub-Task 3):**
  - [`js/plan-versions.js`](js/plan-versions.js) exporta ahora `SERVINGS_MIN/MAX/STEP`, `normalizeServings`, `mealServings` y `scaledMacros`. [`js/calendar.js`](js/calendar.js) importa `scaledMacros` desde ahí (sin ciclo: `plan-versions.js` no importa nada). `computeDayMacros` itera `Object.keys(dayEntry)`, así que los extras ya cuentan con su `servings`.
  - **`setMealServings(dateKey, slotId, personId, servings)`** ([`js/app.js`](js/app.js)) no tiene lógica específica de slots fijos: funciona igual con `extra_n`. Reemplaza el objeto de comida (`{ ...meal, servings }`, no lo muta, porque puede compartirse con `state.defaultWeek`), llama a `renderWeek()` (que refresca el detalle abierto) y guarda con `savePlan` con debounce de 500 ms (`_servingsSaveTimer`). `savePlan` sube todo `state.plan`, así que incluye `slotPeriod` de los extras sin cambios.
  - **Steppers en `ui.js`:** `servingsStepperHTML(meal, personId)` y `wireServingsStepper(...)`. El slot se lee de `stepper.closest('.slot-card').dataset.slot`, por lo que cualquier card nueva para extras con `data-slot="extra_n"` y el stepper dentro funciona sin cambios. `renderDayDetail` recibe `onSetServings`; la caja de "+ Agregar una comida" no necesita nada de porciones. En Familia la tarjeta compartida muestra una lista `.slot-servings-list` (un stepper por integrante) y oculta los macros de cabecera si las porciones difieren.
  - **Pastilla ×N:** `groupSlotMeals` ahora devuelve `{ meal, personIds, servings[] }` (las porciones no afectan el agrupado por versión). `buildDayPills` itera `MEAL_SLOTS`; el sub-task 4 debe conservar `servings` al cambiar a `orderedDaySlots`. La pastilla toma `slotIconMap[slotId] || '🍽️'`.
  - `meal.servings` siempre existe en memoria tras `fetchPlan`/`fetchDefaultWeek`/`mealFromRecipe`; los helpers igualmente toleran comidas sin el campo.
  - No existe un "copiar semana": la propagación de `servings` aplica a `applyDefaultWeekIfEmpty` (`copyMealForPlan`) y `handleSetDefaultWeek`. Al agregar extras, `slotPeriod` también viaja en el deepClone.
  - **Pendiente de prueba manual (sub-task 5):** el stepper nunca se probó contra la base real porque la migración no está aplicada; UI y debounce se verificaron solo por sintaxis y tests de los módulos puros. El input de porciones acepta coma o punto decimal y se normaliza a 0,25–10 en pasos de 0,25 (un valor tipeado fuera de rango se ajusta al más cercano).
  - Tests: `node scripts/test-servings.mjs` (12 checks). El sub-task 4 debe ampliarlo con `orderedDaySlots`, `nextExtraId` y totales con extras.

**Status.** [x] done

---

### 4. Slots extra ("Snack extra")

**Intent.** Eliminar el tope de 5 comidas por día permitiendo agregar extras con período elegible.

**Expected Outcomes.**

- Debajo del último slot del detalle del día aparece una caja "+ Agregar una comida".
- Al usarla se crea un "Snack extra" nuevo con selector de período (mañana / tarde / noche); se le puede arrastrar una receta o usar "+ Agregar".
- El extra se muestra justo después del slot fijo de su período (mañana → después de Desayuno; tarde → después de Snack tarde; noche → después de Snack noche). Varios extras del mismo período se ordenan por número.
- Se puede cambiar el período de un extra con comida y el orden se actualiza.
- Funciona en vista persona y Familia (el mismo `extra_n` para todos los integrantes ese día; cada uno puede tener o no comida).
- Los extras aparecen en la pastilla del calendario, en los totales, en la lista de compras, al copiar semana y en la semana por defecto.
- Quitar la comida de un extra elimina el extra (no quedan extras vacíos persistidos).
- Los selectores de slot (arrastrar a un día, picker) incluyen "Snack extra" y crean un extra nuevo.
- El autoplanner no los usa.

**Todo List.**

- [ ] En [`js/calendar.js`](js/calendar.js:75): dejar `MEAL_SLOTS` como los 5 fijos (lo usa el planner) y agregar `EXTRA_PERIODS` (`manana`, `tarde`, `noche` con etiqueta e ícono) y helpers puros: `isExtraSlot(id)`, `extraAnchorSlot(period)` (desayuno / snack_tarde / snack_noche), `nextExtraId(existingIds)` y `orderedDaySlots(slotEntriesOrIds)` que devuelve los 5 fijos con los extras intercalados.
- [ ] Estado transitorio `state.pendingExtras[dateKey] = [{ id, period }]` en [`js/app.js`](js/app.js): se crea al presionar "+ Agregar una comida" y se limpia al persistir una comida en ese extra.
- [ ] `renderDayDetail` ([`js/ui.js`](js/ui.js:363)) recorre `orderedDaySlots` (unión de extras existentes de todos los integrantes visibles y extras pendientes). Los extras muestran título "Snack extra" y un `<select>` de período.
- [ ] Caja "+ Agregar una comida" al final del contenedor `#meal-slots`, con estilo propio y aria-label.
- [ ] `buildDayPills` ([`js/ui.js`](js/ui.js:167)) usa el mismo orden y el ícono del período para los extras.
- [ ] `assignMeal` / `assignMealForPerson` ([`js/app.js`](js/app.js:886)): al asignar a un extra, guardar `slotPeriod` en la comida y quitar el pendiente.
- [ ] `removeMeal` ([`js/app.js`](js/app.js:910)): sin cambios para extras; ya borra por `slot_id`.
- [ ] Cambio de período: actualizar `meal.slotPeriod` para los integrantes visibles y persistir.
- [ ] `showSlotPickerForDrop` y `openSlotPicker` ([`js/app.js`](js/app.js:812)) incluyen la opción "Snack extra" (crea un `extra_n` nuevo con período por defecto "tarde").
- [ ] `savePlan`, `fetchPlan`, `saveDefaultWeek`, `fetchDefaultWeek` ya manejan `slot_period` desde el sub-task 2; verificar `applyDefaultWeekIfEmpty` ([`js/app.js`](js/app.js:203)) y copiar semana con ids `extra_n`.
- [ ] `buildShoppingList` / `computeDayMacros` iteran `Object.values(dayEntry)` / `Object.keys(dayEntry)`, así que incluyen extras sin cambios; confirmarlo con una prueba.
- [ ] Estilos: caja punteada "+ Agregar una comida", etiqueta de período, adaptación móvil.
- [ ] Ampliar `scripts/test-servings.mjs` (o archivo equivalente) con pruebas de `orderedDaySlots`, `nextExtraId` y totales con extras.

**Relevant Context.**

- [`js/calendar.js`](js/calendar.js:75), [`js/ui.js`](js/ui.js:167), [`js/ui.js`](js/ui.js:387), [`js/ui.js`](js/ui.js:459), [`js/app.js`](js/app.js:740) (`openSlotPicker`), [`js/app.js`](js/app.js:812) (`showSlotPickerForDrop`), [`js/planner.js`](js/planner.js:198) (no se modifica).
- [`scripts/migrate-to-supabase.js`](scripts/migrate-to-supabase.js:204) tiene una lista fija de slots válidos: es un script de migración puntual y no se toca.

**Status.** [ ] pending

---

### 5. Cierre: service worker, documentación y validación

**Intent.** Dejar el cambio desplegable y verificado.

**Expected Outcomes.**

- La caché se invalida para que los clientes reciban los cambios.
- README documenta porciones, slots extra y la migración.
- Sin errores de consola y sin regresiones.

**Todo List.**

- [ ] Subir `CACHE_NAME` en [`sw.js`](sw.js) (v16 → v17). No hay archivos JS nuevos en el app shell.
- [ ] Documentar en [`README.md`](README.md): porciones, slot-card clickeable, extras y migración `20261112000100`.
- [ ] Ejecutar `node scripts/test-servings.mjs`, `node scripts/test-nutrition.mjs` y `node scripts/verify-recipe-versions.js`.
- [ ] Prueba manual (Playwright o navegador): cheesecake de 4 porciones con 1/2/3 porciones; Café Latte 0,5 y 1+1 en Familia; click en slot-card tras editar la receta del catálogo (debe abrir la versión vieja del slot); agregar 2 extras en períodos distintos y del mismo período; mover un extra de período; quitar extras; copiar semana y semana por defecto; móvil (< 700px).
- [ ] Verificar dashboard y recálculo automático con porciones distintas de 1.
- [ ] Probar RLS: la persona de otra familia no puede leer ni escribir filas con `servings` o extras.
- [ ] Revisar la consola del navegador: sin errores ni warnings nuevos.

**Relevant Context.**

- [`sw.js`](sw.js), [`README.md`](README.md).

**Status.** [ ] pending

---

## Riesgos y notas

- **Orden de despliegue.** La migración (sub-task 2) debe aplicarse antes de usar la UI de los sub-tasks 3 y 4; si no, `savePlan` fallaría por columnas inexistentes. El sub-task 1 no depende de la base.
- **Vista de ingesta.** Al cambiar `person_daily_intake`, el historial pasado queda igual (todo `servings = 1`), por lo que dashboard y recálculo no se alteran retroactivamente.
- **Recálculo adaptativo.** Con porciones reales la ingesta del plan es más fiel; no requiere cambios en [`js/nutrition.js`](js/nutrition.js).
- **Check constraint de `slot_id`.** Hay que confirmar el nombre real del constraint en la base antes de dropearlo; la migración debe poder re-ejecutarse sin error.
- **Familia con extras.** Dos integrantes pueden crear extras al mismo tiempo desde dispositivos distintos y chocar en el mismo `extra_n`; en ese caso el upsert sobrescribe la comida de la misma persona/día/slot. El riesgo es bajo (una familia, mismo plan) y se acepta; `nextExtraId` toma el siguiente libre según los datos cargados.
- **Extras sin comida.** No se persisten; si el usuario recarga la página con un extra vacío, desaparece.
- **Seguridad.** No se agregan tablas ni accesos nuevos. Las columnas nuevas llevan `check` en la base; el cliente valida el rango, pero la validación definitiva es la de Postgres. RLS de `plans` y `default_week` no cambia.
