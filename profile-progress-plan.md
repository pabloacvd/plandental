# Plan: Perfil y progreso (calorías, macros, peso y recálculo automático)

## Top-Level Overview

**Goal.** Agregar una sección "Perfil y progreso" que se abre al hacer click en el nombre de usuario del header. Permite:

- Calcular calorías de mantenimiento y objetivo (BMR → TDEE → objetivo con déficit del 20%).
- Registrar el historial de peso y ver su tendencia.
- Ver un dashboard (calorías y macros día a día, peso, déficit semanal).
- Evaluar la dieta (proteína en g/kg, % de macros) y recibir sugerencias.
- Recalcular automáticamente las calorías y metas a partir de la tendencia de peso y el comportamiento histórico.

**Non-goals.**

- No refactorizar la app existente. Todo es aditivo.
- No agregar registro de comidas fuera del plan. El plan es el 100% de la ingesta.
- No usar frameworks ni librerías de gráficos. Gráficos con SVG propio.
- No agregar tracking de entrenamiento.
- No guardar información en archivos (JSON, CSV, localStorage de datos de usuario). Todo dato vive en la base de datos.

## Decisiones confirmadas con el usuario

| Tema | Decisión |
|---|---|
| Ingesta real | **El plan ES lo comido.** Toda comida del plan en el día de hoy o en días pasados se considera consumida. No hay comidas fuera del plan. Los días futuros no cuentan |
| Déficit | **20% de las calorías de mantenimiento** (objetivo = mantenimiento × 0,80), no un valor fijo de kcal |
| Foco | Bajar grasa. Sin foco en construir músculo. Se prioriza conservar masa magra |
| Actividad | 3 a 5 días por semana, 30 a 60 minutos por día. Nivel "moderado" (factor 1,55) por defecto |
| Acceso | Nuevo modal con pestañas Datos / Dashboard / Sugerencias, abierto desde el nombre. "Mi cuenta" (contraseña, administración, logout) queda como sub-sección |
| Metas | Bajar (por defecto), mantener, subir |
| Recálculo | Automático, activado por defecto, con límites, historial y botón de revertir |
| Peso | Lo registra cada usuario cuando quiere (1, 2 o más veces por semana). El análisis tiene que tolerar datos irregulares |
| Unidades | Solo métricas: kg, g, cm, m, L. **Nunca** libras, onzas ni derivados. La energía es siempre en kcal (confirmado) |
| Base de datos | Se aceptan cambios de esquema. Todo el estado en la base de datos y consistente. Respeta familias y múltiples personas |

## Evidencia y buenas prácticas (investigadas)

Fuentes consultadas directamente (no de memoria):

| Fuente | Qué dice | Cómo se usa |
|---|---|---|
| Jäger et al. 2017, ISSN Position Stand: protein and exercise, J Int Soc Sports Nutr 14:20 | 1,4–2,0 g/kg/día de proteína es suficiente para la mayoría de las personas que hacen ejercicio. Con dieta hipocalórica y ejercicio, 2 a 3 veces la RDA (0,8 g/kg), es decir 1,6–2,4 g/kg, favorece mayor pérdida de grasa y conserva masa magra. En el estudio de Pasiakos citado (déficit del 30%), con 1,6 g/kg el 70% del peso perdido fue grasa; con 0,8 g/kg la proporción fue menor. Reparto cada 3–4 h y 20–40 g por toma | Rango objetivo de proteína. Piso de alerta en 1,6 g/kg. Sugerencia de distribuir la proteína en varias comidas |
| Morton et al. 2018, Br J Sports Med 52:376 (meta-análisis, 49 estudios, 1.863 personas) | Por encima de ~1,6 g/kg/día no hay ganancia adicional de masa magra con entrenamiento de fuerza | Se fija el piso en 1,6 g/kg. No se empuja a subir más allá de 2,2 g/kg |
| Helms et al. 2014, Int J Sport Nutr Exerc Metab 24:127 | Recomienda 2,3–3,1 g/kg de masa magra, pero solo para atletas magros, entrenados con pesas y en restricción severa | **No se aplica**: el usuario no es atleta magro y la app no conoce su masa magra. Queda documentado como fuera de alcance |
| Ricci et al. 2025, ISSN Position Stand (deportes de combate), J Int Soc Sports Nutr 22:2467909 | Mifflin-St Jeor está validada para estimar necesidades. En pérdida de peso sostenida, mínimos: proteína 1,2–2,0 g/kg, grasa 0,5–1,0 g/kg/día, carbohidratos 3,0–4,0 g/kg | Mifflin-St Jeor como fórmula de BMR. Piso de grasa en 0,5 g/kg. Se usa solo el piso de grasa, porque el contexto (combate) es más exigente que el del usuario |
| fitplan-skill (`docs/nutrition-logic.md`) | BMR Mifflin-St Jeor, factor de actividad 1,55 para 3–5 sesiones por semana, caso de prueba: hombre, 30 años, 175 cm, 75 kg → BMR 1699, TDEE 2633, objetivo con 20% de déficit 2106 | Fórmulas y casos de prueba |
| personal-trainer-skill (`references/nutrition.md`) | Causas de estancamiento: tracking inexacto, retención de agua, adaptación metabólica tras 8 semanas o más de déficit, mantenimiento real mayor al estimado. Carbohidratos como resto | Árbol de diagnóstico de las sugerencias |
| OpenNutriTracker | Vista de tendencias con ventanas 7/30/90 días, peso contra objetivo | Diseño del dashboard |

**Consecuencias de diseño sobre recomposición.**

- El objetivo es perder grasa y conservar músculo. La evidencia (ISSN 2017) indica que eso combina déficit moderado, proteína alta y ejercicio. La app controla los dos primeros. Para el tercero, una sugerencia de texto recomienda incluir trabajo de fuerza.
- Como al recomponer el peso en balanza puede avanzar más lento, las sugerencias exigen una tendencia de al menos 3 semanas antes de calificar un estancamiento.
- Ejemplo de cálculo con el deficit del 20%: mantenimiento 2500 kcal → objetivo 2000 kcal → déficit de 500 kcal/día → unos 0,45 kg/semana (3500 kcal ÷ 7700 kcal/kg). Es consistente con el dato existente de Juli (1690 kcal = 80% de 2113, ver `supabase/migrations/20250701000000_nutrition_profile_fields.sql`).

## Reglas de cálculo (guía común a todos los sub-tasks)

- **BMR.** Mifflin-St Jeor. Hombre: `10 × kg + 6,25 × cm − 5 × edad + 5`. Mujer: `10 × kg + 6,25 × cm − 5 × edad − 161`.
- **Mantenimiento.** BMR × factor de actividad (sedentario 1,2; ligero 1,375; moderado 1,55; alto 1,725; atleta 1,9). Por defecto: moderado (3–5 días por semana, 30–60 min).
- **Objetivo.**
  - Bajar: mantenimiento × (1 − déficit). El déficit por defecto es 20% y se guarda por persona (`deficit_pct`).
  - Mantener: mantenimiento × 1,00.
  - Subir: mantenimiento × 1,10 (valor de fitplan-skill, constante de código).
- **Macros (en g/kg del peso actual).**
  - Proteína: 2,0 g/kg al bajar (rango 1,6–2,2). Al mantener 1,6 g/kg. Al subir 1,8 g/kg.
  - Grasa: 25% de las calorías, con piso de 0,5 g/kg.
  - Carbohidratos: el resto de las calorías.
  - Conversión a calorías: proteína y carbohidratos 4 kcal/g; grasa 9 kcal/g.
- **Mantenimiento real (adaptativo).** `ingesta promedio − (pendiente de tendencia en kg/día × 7700)`. La ingesta sale del plan.
- **Ingesta válida.**
  - Un día cuenta si tiene al menos una comida en el plan y es hoy o anterior.
  - Un día con al menos una comida cuenta con el total de calorías de lo que tenga, sin importar cuán bajo sea. Un día con una sola comida de 50% de las calorías objetivo es lo que realmente se comió. No se descartan días por tener pocas calorías (puede compensarse con el día anterior o el siguiente).
  - El único criterio de exclusión es que el día **no tenga ninguna comida**. Esos días son "sin datos" y no entran en ningún promedio ni en el cálculo adaptativo.
  - Para el cálculo adaptativo se usan solo días anteriores a hoy, porque hoy todavía puede tener comidas planificadas que no se comieron. El dashboard sí incluye hoy.
  - Los días sin plan son "sin datos", nunca cero.
- **Tendencia de peso con datos irregulares.** Regresión lineal sobre fecha y peso en una ventana de 28 días. Se exige un mínimo de 3 pesajes que abarquen al menos 14 días. Con menos datos no se ajusta nada y se explica por qué.
- **Datos mínimos para el adaptativo.** Ventana de al menos 21 días, y que al menos el 70% de esos días tengan una o más comidas en el plan. Este umbral solo mide cuántos días tienen datos, no cuánto se comió. Si no se cumple, solo se recalcula con la fórmula usando el peso actual. El 70% es una heurística de cobertura de datos y queda como constante revisable.
- **Mezcla.** Mantenimiento nuevo = mezcla ponderada de fórmula y adaptativo, con más peso al adaptativo cuanto más datos haya.
- **Límites de seguridad.**
  - Cada recálculo cambia el mantenimiento como máximo ±5% (o ±150 kcal, lo menor). Converge en varias semanas.
  - El objetivo nunca queda por debajo del BMR ni de un piso absoluto (1200 kcal mujer / 1500 kcal hombre). Si el 20% de déficit cae debajo del piso, se usa el piso y se avisa.
  - Alerta, sin bloquear, si el ritmo implícito de pérdida supera el 1% del peso corporal por semana.
- **Aviso de salud.** Texto fijo: no es asesoramiento médico. Se muestra en el perfil.

## Modelo de datos y consistencia (familias y personas)

- **Pertenencia.** Cada persona (`persons`) pertenece a una familia (`persons.family_id`). Los usuarios ven y editan a todas las personas de su familia. El acceso se resuelve con `public.person_in_my_family(person_id)`, igual que `plans`, `nutrition_data` y `default_week`. No hay bypass de admin sobre datos de personas (aislamiento total, ver `supabase/migrations/20261105000300_remove_person_access.sql`).
- **Fuente única de verdad del peso.** `weight_log` es la fuente. `nutrition_data.weight_kg` queda sincronizado por un trigger con el peso más reciente por fecha. La app deja de escribir `weight_kg` directamente.
- **Ingesta calculada en la base.** Una vista `person_daily_intake` (con `security_invoker`, para que apliquen las policies del usuario que consulta) suma las macros de `plans` por persona y día. Dashboard y recálculo leen de ahí, así los totales son idénticos en todos los dispositivos y no dependen de que el cliente tenga el plan completo cargado.
- **Recálculo atómico.** Los cálculos viven en JS puro (testeable), pero cada cambio de metas se persiste mediante una RPC `security definer` que verifica la pertenencia a la familia, valida los límites, inserta el historial y actualiza `nutrition_data` en una sola transacción.
- **Idempotencia entre dispositivos.** Un índice único impide más de un recálculo automático por persona y semana, aunque dos integrantes de la familia abran la app a la vez.
- **Reversión.** Revertir restaura los valores anteriores y marca la entrada como revertida. La entrada no se borra, por lo que el índice único impide que el automático vuelva a aplicar el mismo cambio hasta la semana siguiente.
- **Sin archivos.** No se agregan JSON ni archivos con datos. Los parámetros de usuario (actividad, meta, déficit, peso objetivo, interruptor) son columnas. Las constantes de fórmulas (factores, 7700, etc.) son código.

## Estado actual relevante (verificado en el código)

- Stack: JS vanilla ES modules, sin build. Supabase con RLS. PWA con service worker versionado (`CACHE_NAME` en [`sw.js`](sw.js)).
- El nombre de usuario ya abre `modal-auth` ([`index.html`](index.html:188)) mediante `openAuthModal()` ([`js/app.js`](js/app.js:1717)).
- Ese modal ya contiene "Mis datos": BMR, objetivo, mantenimiento, peso, altura, edad y sexo ([`js/app.js`](js/app.js:1638), `handleSaveProfile` en [`js/app.js`](js/app.js:1659)).
- `fetchPlan` carga todas las filas de `plans` sin filtro de fecha ([`js/storage.js`](js/storage.js:181)). `plans.macros` es JSONB con claves `calorias`, `proteina_g`, `carbohidratos_g`, `grasas_g` (ver `computeDayMacros` en [`js/calendar.js`](js/calendar.js:86)).
- `nutrition_data` tiene un único `weight_kg` que se pisa en cada guardado, y los objetivos `protein_g`, `carbs_g`, `fat_g` cargados a mano ([`js/storage.js`](js/storage.js:360)).
- `saveNutritionProfile` escribe `weight_kg` directamente ([`js/storage.js`](js/storage.js:412)).
- No hay tests ni librería de gráficos.

---

## Sub-Tasks

> Cada sub-task es independiente y revisable. Se implementan de a uno, esperando la validación del usuario entre cada uno.

### 1. Base de datos: esquema, vista, trigger y RPCs

**Intent.** Persistir lo que hoy no existe (historial de peso, meta, historial de recálculos), de forma consistente y respetando familias.

**Expected Outcomes.**

- `weight_log`, `targets_history` y la vista `person_daily_intake` existen con RLS de familia.
- `nutrition_data` guarda actividad, meta, déficit, peso objetivo e interruptor de auto-recálculo.
- El peso de `nutrition_data` se mantiene sincronizado con el último registro de `weight_log`.
- Las RPCs aplican y revierten cambios de metas de forma atómica.
- Un usuario de otra familia no puede leer ni escribir nada de esto.

**Todo List.**

- [ ] Crear `supabase/migrations/20261111000100_weight_log_and_goals.sql`. Idempotente ("Safe to re-run"), mismo estilo que las migraciones existentes.
- [ ] Tabla `weight_log(id, person_id → persons on delete cascade, date_key text 'YYYY-MM-DD', weight_kg numeric > 0, created_at)`. Único `(person_id, date_key)`. Si el usuario carga dos veces el mismo día, se sobrescribe.
- [ ] RLS en `weight_log`, `targets_history` y la vista, con la política `person_in_my_family(person_id)` (for all, to authenticated, using + with check). Sin acceso `anon`, sin bypass de admin.
- [ ] Agregar a `nutrition_data`: `activity_level` (default `moderado`), `goal` (`bajar` / `mantener` / `subir`, default `bajar`), `deficit_pct` (default 20, check entre 0 y 30), `target_weight_kg` (nullable, check > 0), `auto_recalc` (boolean, default true).
- [ ] Tabla `targets_history(id, person_id, week_key, source ('auto' / 'manual'), reason text, previous jsonb, new jsonb, created_at, reverted_at)`. Índice único parcial `(person_id, week_key)` donde `source = 'auto'`.
- [ ] Vista `person_daily_intake` con `security_invoker = true`: una fila por `(person_id, date_key)` con `kcal`, `protein_g`, `carbs_g`, `fat_g` y `meals_count`, sumando `plans.macros`. Verificar que la versión de Postgres de Supabase soporta `security_invoker` (Postgres 15 o superior).
- [ ] Trigger sobre `weight_log` (insert/update/delete) que actualiza `nutrition_data.weight_kg` con el peso del `date_key` más reciente, solo si la fila de `nutrition_data` ya existe.
- [ ] Backfill: sembrar `weight_log` con el `weight_kg` actual de cada persona, usando `updated_at::date`. Se documenta que esa fecha es aproximada.
- [ ] RPC `apply_targets_change(p_person_id, p_source, p_reason, p_week_key, p_new jsonb)`: verifica `person_in_my_family`, valida límites (positivos; en `auto`, el mantenimiento no cambia más de ±5%), inserta el historial y actualiza `nutrition_data` en una transacción. Si ya existe un `auto` de esa semana, devuelve el existente sin error.
- [ ] RPC `revert_targets_change(p_history_id)`: solo permite revertir la última entrada no revertida de esa persona, restaura `previous` y marca `reverted_at`.
- [ ] Bloque final de validación con `raise exception` (RLS activo, sin policies que usen `is_admin()` en las tablas nuevas, sin grants a `anon`), como en `20261105000300_remove_person_access.sql`.
- [ ] En [`js/storage.js`](js/storage.js): `fetchWeightLog`, `saveWeightEntry`, `deleteWeightEntry`, `fetchDailyIntake`, `fetchTargetsHistory`, `applyTargetsChange`, `revertTargetsChange`.
- [ ] Extender `fetchNutrition` con las columnas nuevas.
- [ ] Quitar `weight_kg` de la escritura directa en `saveNutritionProfile`. Los pesos se guardan por `weight_log`.

**Relevant Context.**

- [`js/storage.js`](js/storage.js:354) (sección Nutrition data).
- [`supabase/migrations/20250701000000_nutrition_profile_fields.sql`](supabase/migrations/20250701000000_nutrition_profile_fields.sql) (estilo idempotente).
- [`supabase/migrations/20261105000200_families.sql`](supabase/migrations/20261105000200_families.sql) (`my_family_id`, `families`).
- [`supabase/migrations/20261105000300_remove_person_access.sql`](supabase/migrations/20261105000300_remove_person_access.sql:29) (`person_in_my_family`, policies, validación final).
- Verificar el nombre de la migración más reciente en `supabase/migrations/` antes de fijar el prefijo de fecha.

**Status.** [ ] pending

---

### 2. Módulo de cálculo puro `js/nutrition.js`

**Intent.** Concentrar toda la lógica numérica en funciones puras, explicables y testeables. La UI no calcula nada por su cuenta.

**Expected Outcomes.**

- Un módulo sin dependencias de DOM ni de Supabase.
- Un script Node mínimo que verifica las fórmulas contra los valores de referencia.
- Todas las magnitudes en unidades métricas (kg, g, cm, m, kcal).

**Todo List.**

- [ ] `bmrMifflin(sex, kg, cm, age)`, `maintenanceFromFormula(bmr, activityLevel)`, `goalCalories(maintenance, goal, deficitPct)`.
- [ ] `macroTargets({kcal, kg, goal})`: proteína por g/kg, grasa 25% con piso de 0,5 g/kg, carbohidratos como resto.
- [ ] `weightTrend(entries)`: regresión lineal sobre fecha y peso, ventana de 28 días, mínimo 3 pesajes en 14 días. Devuelve `null` con motivo cuando no alcanza.
- [ ] `adaptiveMaintenance({intakeByDay, trend})`: aplica las reglas de ingesta válida y cobertura. Devuelve `null` con motivo si no hay datos suficientes.
- [ ] `proposeTargets(profile, weightLog, intakeByDay)`: combina fórmula, adaptativo y límites de seguridad. Devuelve valores nuevos y un motivo en texto.
- [ ] `analyzeDiet(days, targets, kg)`: g/kg de proteína, % de macros por calorías, adherencia a calorías, días fuera de rango.
- [ ] `buildSuggestions(analysis, trend, goal)`: lista con severidad, causa probable y fuente. Cubre al menos: proteína por debajo de 1,6 g/kg, grasa por debajo de 0,5 g/kg, calorías por encima o por debajo del objetivo, estancamiento (con las 4 causas), ritmo de pérdida superior al 1% semanal, recomendación de trabajo de fuerza y distribución de proteína en varias comidas.
- [ ] Agregar `scripts/test-nutrition.mjs` (Node, `assert`, sin dependencias). Caso base: hombre, 30 años, 175 cm, 75 kg, moderado → BMR 1699, mantenimiento 2633, objetivo 2106. Caso adicional: mantenimiento 2113 → objetivo 1690. Casos de tendencia con pesajes irregulares (1 por semana, 2 por semana, huecos).

**Relevant Context.**

- [`js/calendar.js`](js/calendar.js:86) (claves de macros: `calorias`, `proteina_g`, `carbohidratos_g`, `grasas_g`).
- Convención de módulos ES de [`js/app.js`](js/app.js).

**Status.** [ ] pending

---

### 3. Modal "Perfil y progreso" (shell, pestaña Datos y registro de peso)

**Intent.** Crear el nuevo punto de entrada sin romper "Mi cuenta" y mover los datos de perfil a la pestaña Datos.

**Expected Outcomes.**

- Click en el nombre abre "Perfil y progreso" con pestañas Datos / Dashboard / Sugerencias.
- Dentro hay una sub-sección "Mi cuenta" con contraseña, administración y logout.
- Datos permite elegir la persona de la familia, editar meta, actividad, déficit (20% por defecto) y peso objetivo.
- Datos permite registrar y borrar pesajes, con fecha elegible (por defecto hoy).
- Datos incluye el interruptor de recálculo automático y el historial con botón de revertir.
- Datos permite "Calcular con fórmulas" y aplicar los valores (BMR, mantenimiento, objetivo, macros), mostrando el desarrollo del cálculo.
- Los campos y la lógica de guardado actuales de "Mis datos" siguen funcionando.

**Todo List.**

- [ ] Agregar el markup del modal en [`index.html`](index.html) (siguiendo `modal-box` y `person-modal-section`) y los estilos en [`css/style.css`](css/style.css) con las variables CSS existentes.
- [ ] Reapuntar los listeners de `btn-github-auth` y `btn-github-auth-footer` ([`js/app.js`](js/app.js:2092), [`js/app.js`](js/app.js:2200)) al nuevo modal.
- [ ] Reutilizar `fillProfileForm`, `populateProfileSection` y `handleSaveProfile` en lugar de duplicarlos. Cambiar el guardado de peso para que pase por `weight_log`.
- [ ] Controles de meta, actividad (opciones con texto "3–5 días por semana, 30–60 min" para moderado), déficit, peso objetivo y toggle de auto-recálculo.
- [ ] Botón "Calcular con fórmulas" (usa `nutrition.js`) y panel con el desglose.
- [ ] Lista de pesajes con alta y baja.
- [ ] Mantener la apertura automática del modal si faltan datos obligatorios ([`js/app.js`](js/app.js:175), `personsMissingMaintenance`).
- [ ] Mostrar el aviso de salud.
- [ ] Código nuevo en `js/profile.js`, importado desde `app.js`, para no seguir inflando `app.js`.

**Relevant Context.**

- [`index.html`](index.html:188) (modal-auth actual), [`js/app.js`](js/app.js:1620) (`PROFILE_FIELDS`, `openAuthModal`, `closeAuthModal`).
- `state.persons` y `state.personNameToId` contienen las personas de la familia del usuario.

**Status.** [ ] pending

---

### 4. Pestaña Dashboard

**Intent.** Visualizar progreso y cumplimiento: calorías y macros día a día, peso y déficit semanal.

**Expected Outcomes.**

- Selector de ventana: 7 / 30 / 90 días y persona.
- Gráfico de calorías diarias contra objetivo y mantenimiento.
- Gráfico de peso con puntos reales, línea de tendencia y línea de peso objetivo.
- Macros promedio (g, g/kg y % de calorías) contra metas.
- Déficit o superávit semanal acumulado (`Σ(ingesta − mantenimiento)`) con kg estimados (÷ 7700).
- Tarjetas resumen: peso actual, cambio, ritmo kg/semana, adherencia.
- Los días sin plan figuran como "sin datos". Los días futuros no se consideran.

**Todo List.**

- [ ] Crear `js/charts.js` con helpers SVG pequeños (línea, barras, línea de referencia) y estilos con variables CSS.
- [ ] Crear `js/dashboard.js`: lee `person_daily_intake` y `weight_log` por la capa de storage y arma los datos de cada gráfico.
- [ ] Estado vacío claro si hay menos de 2 pesajes o ningún día con plan.
- [ ] Accesibilidad: `role="img"` y `aria-label` en los SVG, y resumen en texto.
- [ ] Texto aclaratorio: la ingesta se toma del plan.

**Relevant Context.**

- [`js/ui.js`](js/ui.js:527) (estilo visual de barras), colores semánticos existentes: naranja calorías, accent proteína, verde carbohidratos, púrpura grasa.

**Status.** [ ] pending

---

### 5. Pestaña Sugerencias (evaluación de dieta)

**Intent.** Evaluar la dieta y explicar qué cambiar, con base en reglas citadas.

**Expected Outcomes.**

- Proteína en g/kg y % de macros del período, contra el rango recomendado para bajar grasa.
- Lista de sugerencias priorizadas con severidad (info / atención / alerta).
- Diagnóstico de estancamiento con causas probables, solo con tendencia de 3 semanas o más.
- Cada sugerencia indica su fuente.
- Comparación "metas actuales" contra "metas recomendadas" y botón "Aplicar" (aplicación manual, registrada en el historial como `manual`).
- Sección breve "Fuentes".

**Todo List.**

- [ ] Usar `analyzeDiet`, `buildSuggestions` y `proposeTargets` de `nutrition.js`.
- [ ] Renderizar las tarjetas y la tabla de comparación.
- [ ] Botón "Aplicar meta recomendada" que llama a `applyTargetsChange` con `source = 'manual'`.
- [ ] Sección "Fuentes" con las referencias de este plan.

**Relevant Context.**

- Texto en español rioplatense coherente con el resto de la UI ("Ingresá", "Elegí").

**Status.** [ ] pending

---

### 6. Recálculo automático, historial y reversión

**Intent.** Cerrar el ciclo: ajustar metas solas a partir de la tendencia y del historial, de forma segura, consistente y reversible.

**Expected Outcomes.**

- El recálculo corre al registrar un peso y al abrir el perfil, como máximo una vez por semana por persona (garantizado por la base).
- Respeta datos mínimos y límites de seguridad.
- Cada cambio queda en el historial con motivo y se puede revertir.
- Revertir no vuelve a aplicarse hasta la semana siguiente.
- El interruptor de auto-recálculo lo desactiva por completo.
- Las barras de calorías del calendario reflejan los nuevos valores.

**Todo List.**

- [ ] Implementar `runAutoRecalc(person)` en `js/profile.js`: lee peso, ingesta y metas, llama a `proposeTargets` y a `applyTargetsChange`.
- [ ] Solo corre si `auto_recalc` está activo y hay datos mínimos. Si no, no hace nada y deja el motivo visible en el perfil.
- [ ] Actualizar `state.nutrition` y llamar `renderWeek()` para refrescar las barras ([`js/app.js`](js/app.js:281)).
- [ ] UI de historial con botón "Revertir".
- [ ] Toast cuando se aplica un cambio automático.
- [ ] Casos límite: dos integrantes de la familia abriendo la app a la vez, menos del 70% de los días con alguna comida (solo fórmula), tendencia contradictoria, persona sin altura/edad/sexo (no se puede aplicar la fórmula), día con una sola comida de pocas calorías (cuenta tal cual).

**Relevant Context.**

- [`js/app.js`](js/app.js:149) (carga de `state.nutrition`), [`js/app.js`](js/app.js:1706) (recarga tras guardar).
- `maintenance_kcal` es el 100% de la barra de calorías. Documentar el efecto en la UI.

**Status.** [ ] pending

---

### 7. Cierre: service worker, documentación y validación

**Intent.** Dejar el cambio desplegable y verificado.

**Expected Outcomes.**

- Los módulos nuevos quedan cacheados y se invalida la caché vieja.
- README documenta la sección, las fórmulas y la migración.
- La app arranca sin errores de consola y las pantallas existentes no regresionan.

**Todo List.**

- [ ] Agregar `nutrition.js`, `profile.js`, `dashboard.js` y `charts.js` a la lista de assets de [`sw.js`](sw.js) y subir `CACHE_NAME`.
- [ ] Documentar en [`README.md`](README.md).
- [ ] Ejecutar `node scripts/test-nutrition.mjs`.
- [ ] Probar RLS con dos familias: una persona de otra familia no puede leer ni escribir `weight_log`, `targets_history`, ni ver filas de la vista.
- [ ] Prueba manual (Playwright o navegador): abrir el perfil desde el nombre, registrar pesos con frecuencias distintas, dashboard con y sin datos, sugerencias, recálculo y reversión, móvil (< 700px), cambio de persona dentro de la familia.
- [ ] Confirmar que calendario, recetas y lista de compras siguen funcionando.
- [ ] Revisar la consola del navegador: sin errores ni warnings nuevos.

**Relevant Context.**

- [`sw.js`](sw.js) (`CACHE_NAME`), [`README.md`](README.md).

**Status.** [ ] pending

---

## Riesgos y notas

- **Factor de actividad.** 1,55 puede sobreestimar el gasto en sesiones de 30 minutos. El ajuste adaptativo lo corrige con el tiempo, con los límites de ±5% por semana.
- **Precisión del adaptativo.** Depende de que el plan sea lo realmente comido, lo cual el usuario confirmó. Los días con pocas calorías no se filtran. La variación diaria se promedia en la ventana de 21 días o más y la tendencia de peso la suaviza.
- **Auto-ajuste de datos sensibles.** Mitigado con límites, historial, reversión, interruptor y aviso de salud.
- **Seguridad.** Las tablas nuevas llevan RLS por familia, sin acceso anónimo y sin bypass de admin. Las RPCs `security definer` verifican la pertenencia a la familia y fijan `search_path`, como las existentes. Las entradas se validan en el cliente y con `check` en la base. No se registran datos personales en logs.
- **Migración manual.** Hay que aplicar la nueva migración en Supabase antes de usar la UI nueva.
- **Evidencia fuera de alcance.** La recomendación de Helms (2,3–3,1 g/kg de masa magra) está pensada para atletas magros en restricción severa y no se aplica aquí.

## Supuestos confirmados

1. La energía es siempre en kcal.
2. La meta "subir" se mantiene con un superávit del 10%.
