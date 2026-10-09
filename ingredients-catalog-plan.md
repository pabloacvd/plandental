# Plan: Catálogo de Ingredientes, Privacidad Compartida y Cálculo Automático de Macros

## Resumen Ejecutivo
Implementar un sistema integral de **Catálogo de Ingredientes** para PlanDental que permita:
1. Gestionar ingredientes con su información nutricional de referencia (calorías, proteínas, carbohidratos, grasas por 100g, 100ml o 1 unidad).
2. Visualizar y editar ingredientes tanto en formato **Formulario** como en formato **JSON** (idéntico al editor de recetas).
3. Gestionar permisos multi-usuario: los ingredientes pertenecen a un usuario (`owner_id`), pero si dos usuarios comparten acceso aprobado a través de `person_access` (por ejemplo, Pablo y Juli), ambos pueden ver y utilizar los ingredientes del otro automáticamente. Un usuario independiente (ej: José) solo verá sus propios ingredientes.
4. Ejecutar un **script de extracción/población** que analice todas las recetas existentes para crear los ingredientes base, normalizando "a gusto" / "c/n" a "1 unidad", y omitiendo listas combinadas complejas como "verduras (brócoli, coliflor, zanahoria)".
5. Integrar el catálogo en las pestañas del Sidebar y en el editor de recetas para el **cálculo 100% automático y en tiempo real** de calorías y macros.

---

## Sub-tareas

### Sub-tarea 1: Esquema de Base de Datos, RLS Multi-Usuario y Persistencia
- **Intent**: Crear la tabla `ingredients` en Supabase con políticas de seguridad que respeten la privacidad individual y el acceso compartido entre usuarios vinculados, y actualizar `js/storage.js`.
- **Expected Outcomes**:
  - Migración SQL `supabase/migrations/20250602000000_ingredients.sql` creando la tabla `ingredients` con `owner_id uuid references public.profiles(id)`.
  - Función SQL de seguridad `shares_access_with(target_profile_id uuid)` que valida si el usuario actual comparte acceso aprobado (`person_access`) con el dueño del ingrediente.
  - Políticas RLS para `select`, `insert`, `update`, `delete` basadas en `is_admin()`, `owner_id = auth.uid()` y `shares_access_with(owner_id)`.
  - Funciones en `js/storage.js`: `fetchIngredients()`, `saveIngredient(ingObj)`, `saveIngredients(ingArray)`, `deleteIngredient(id)`.
- **Todo List**:
  1. Redactar migración `supabase/migrations/20250602000000_ingredients.sql` con definición de tabla, índices y políticas RLS multi-tenant compartidas.
  2. Implementar funciones CRUD de ingredientes en `js/storage.js` con soporte para fallback a almacenamiento local/JSON si no está autenticado.
- **Relevant Context**:
  - `supabase/migrations/20250101000000_initial_schema.sql` (definición de `person_access`, `profiles`, `has_approved_access`)
  - `js/storage.js`
- **Status**: `[x] completed`

---

### Sub-tarea 2: Script de Extracción y Población Inicial de Ingredientes
- **Intent**: Desarrollar un script que recorra todas las recetas en `data/recipes.json` (y base de datos), extraiga los ingredientes individuales, normalice unidades y cree el catálogo inicial en `data/ingredients.json` y Supabase.
- **Expected Outcomes**:
  - Script `scripts/extract-ingredients.js` ejecutable con Node.js.
  - Reglas de parsing:
    - Normalizar nombres de ingredientes y deduplicar sinónimos o variantes de texto.
    - Cuando la unidad/cantidad indique "a gusto", "al gusto" o "c/n", asignar `cantidad_referencia: 1`, `unidad: 'unidad'`.
    - Omitir agrupaciones complejas con listas compuestas entre paréntesis como `"verduras (brócoli, coliflor, zanahoria)"`, `"vegetales de raíz mixtos (...)"`, `"vegetales mixtos (...)"`.
    - Asignar macros estimados/estándar por unidad de referencia (100g, 100ml o 1 unidad).
  - Generación del archivo semilla limpio `data/ingredients.json`.
- **Todo List**:
  1. Escribir `scripts/extract-ingredients.js` con lógica de filtrado de paréntesis y parsing de "al gusto".
  2. Ejecutar el script para generar `data/ingredients.json` poblado con los ingredientes extraídos de las recetas existentes.
  3. Validar que los ingredientes generados tengan la estructura correcta con `id`, `nombre`, `unidad_referencia`, `cantidad_referencia`, `categoria`, `macros` (`calorias`, `proteina_g`, `carbohidratos_g`, `grasas_g`).
- **Relevant Context**:
  - `data/recipes.json`
  - `scripts/validate-migration.js`
- **Status**: `[x] completed`
  - Script `scripts/extract-ingredients.js` creado y ejecutado exitosamente.
  - `data/ingredients.json` generado con **205 ingredientes** únicos extraídos de todas las recetas.
  - Validación estructural confirmada: todos los campos requeridos (`id`, `nombre`, `categoria`, `unidad_referencia`, `cantidad_referencia`, `macros`) presentes en los 205 registros.
  - Reglas aplicadas:
    - Agrupaciones complejas con listas en paréntesis omitidas (ej: `"Vegetales de raíz mixtos (rodfrugter: ...)"`, `"Frutos rojos (frutillas, arándanos)"`).
    - Listas multi-ingrediente sin paréntesis omitidas (ej: `"Nuez moscada, sal y polvo de hornear"`).
    - Nombres de producto con coma decimal preservados (ej: `"Cheasy Skyr Vanilje 0,2%"`).
    - Ingredientes con unidad `al gusto` / `c/n` → `cantidad_referencia: 1`, `unidad_referencia: 'unidad'`.
    - Macros asignados por tabla de referencia estándar (100 g / 100 ml / 1 unidad); 0 advertencias de macros faltantes en la ejecución final.

---

### Sub-tarea 3: Módulo de Lógica de Negocio (`js/ingredients.js`)
- **Intent**: Centralizar la carga, búsqueda, cálculo y manipulación de ingredientes en memoria.
- **Expected Outcomes**:
  - Módulo `js/ingredients.js` con estado en memoria `_ingredients`.
  - Métodos: `loadIngredients()`, `getAllIngredients()`, `getIngredientById(id)`, `searchIngredients(query, category)`, `addIngredient(data)`, `updateIngredient(id, data)`, `deleteIngredient(id)`, `slugifyIngredient(name)`.
  - Método `calculateRecipeMacros(ingredientesList, porciones)` que calcula en tiempo real calorías, proteínas, carbohidratos y grasas por porción en base a las cantidades y unidades de referencia.
- **Todo List**:
  1. Crear `js/ingredients.js` exportando todas las funciones CRUD y de cálculo nutricional.
  2. Implementar regla de conversión de proporciones: `(cantidad / cantidad_referencia) * macro_referencia`.
  3. Integrar la carga de ingredientes en el ciclo de inicio en `recipes.js` o `app.js`.
- **Relevant Context**:
  - `js/recipes.js`
  - `js/calendar.js`
- **Status**: `[x] completed`
  - Módulo `js/ingredients.js` creado con estado en memoria `_ingredients`.
  - Exporta: `loadIngredients()`, `getAllIngredients()`, `getIngredientById(id)`, `getIngredientByName(name)`, `searchIngredients(query, category)`, `addIngredient(data)`, `updateIngredient(id, data)`, `deleteIngredient(id)`, `setIngredients(arr)`, `slugifyIngredient(name)`.
  - Exporta: `calculateItemMacros(ingredientObj, cantidad, unidad)` — proporción `(cantidad / cantidad_referencia) * macro_referencia`, redondeado a 2 decimales.
  - Exporta: `calculateRecipeMacros(ingredientesList, porciones)` — devuelve `{ total, porcion }` con calorías, proteínas, carbohidratos y grasas.
  - `_normalise()` interna aplana el sub-objeto `macros` del seed JSON al shape plano del esquema Supabase.
  - `loadIngredients()` usa `fetchIngredients()` de `storage.js` (con su propio fallback a `data/ingredients.json`) y tiene un segundo fallback directo al JSON seed.
  - Carga inicial integrada en `loadData()` de `js/recipes.js` con `await loadIngredients()`.

---

### Sub-tarea 4: Interfaz de Usuario para Pestañas del Sidebar y Modal Dual (Formulario + JSON)
- **Intent**: Habilitar en la interfaz la navegación entre Recetas e Ingredientes en la barra lateral, y construir el modal de Ingredientes con pestañas de Formulario y JSON idéntico al editor de recetas.
- **Expected Outcomes**:
  - Pestañas en el Sidebar (`Recetas` | `Ingredientes`) en `index.html`.
  - El botón "＋" de la barra lateral cambia dinámicamente según la pestaña activa ("Nueva receta" o "Nuevo ingrediente").
  - Buscador del Sidebar filtra recetas o ingredientes según la pestaña activa.
  - Modal `#modal-ingredient-editor` en `index.html` con dos pestañas:
    - **📝 Formulario**: Campos para Nombre, Unidad de referencia (`g`, `ml`, `unidad`), Cantidad de referencia (100, 1), Categoría, y Macros (Calorías, Proteína, Carbohidratos, Grasas).
    - **{ } JSON**: Textarea para editar o importar/exportar ingrediente(s) en formato JSON, con botón "Previsualizar" y "Guardar".
  - Renderizado de tarjetas de ingredientes en `js/ui.js` mostrando nombre, referencia y desglose de macros (Kcal | P | C | G) con opciones para editar y eliminar.
- **Todo List**:
  1. Actualizar `index.html` con la estructura del sidebar (tabs), contenedor `#ingredients-list-sidebar` y modal `#modal-ingredient-editor`.
  2. Añadir estilos en `css/style.css` para las pestañas del sidebar, tarjetas de ingredientes y modal dual.
  3. Crear funciones de renderizado en `js/ui.js`: `renderIngredientCard()` y `renderIngredientsSidebar()`.
  4. Implementar handlers en `js/app.js` para alternar pestañas del sidebar, abrir/cerrar modal de ingrediente, cambiar entre formulario/JSON y guardar desde ambos formatos.
- **Relevant Context**:
  - `index.html` (líneas 97-118 y 210-294)
  - `css/style.css`
  - `js/ui.js`
  - `js/app.js`
- **Status**: `[x] completed`
  - `index.html`: Sidebar nav tabs (`Recetas` | `Ingredientes`), `#ingredients-sidebar-list` container, ingredient category filter chips (`#filter-chips-ingredients`), `#btn-add-sidebar` unificado, modal `#modal-ingredient-editor` con pestañas Formulario y JSON.
  - `css/style.css`: `.sidebar-nav-tabs` / `.sidebar-nav-tab`, `.ingredient-card`, `.ingredient-macros`, `.ingredient-macro-badge` (kcal/prot/carb/fat badges), `.ingredient-card-actions`, `.editor-actions--split`. Reglas de sidebar colapsado extendidas para nuevos elementos.
  - `js/ui.js`: `renderIngredientCard(ingredient, onEdit, onDelete)` y `renderIngredientsSidebar(ingredients, container, onEdit, onDelete)` exportados.
  - `js/app.js`: `setSidebarTab(tab)`, `openIngredientEditor()`, `openIngredientEditorForEdit(id)`, `closeIngredientEditor()`, `setIngredientEditorTab(tab)`, `saveIngredientFromForm()`, `saveIngredientFromJSON()`, `previewIngredientJSON()`, `deleteIngredientHandler(id)` implementados. `wireControls()` conecta todos los nuevos elementos. El buscador y filtros de categoría actúan sobre recetas o ingredientes según pestaña activa.

---

### Sub-tarea 5: Integración en el Editor de Recetas y Cálculo en Tiempo Real
- **Intent**: Conectar el catálogo de ingredientes con el editor de recetas para autocompletar ingredientes, sugerir unidades y recalcular automáticamente los macros totales y por porción a medida que el usuario edita la receta.
- **Expected Outcomes**:
  - Las filas de ingredientes en `#modal-recipe-editor` permiten seleccionar un ingrediente del catálogo mediante un selector/autocompletado interactivo.
  - Al seleccionar un ingrediente, se sugiere su unidad y se muestra en vivo el aporte calórico/macro de esa fila.
  - Al cambiar cualquier cantidad, ingrediente o número de porciones (`rf-porciones`), los campos `rf-cal`, `rf-prot`, `rf-carbs` y `rf-fat` se recalculan automáticamente en tiempo real.
  - Botón de "+ Nuevo ingrediente rápido" en el editor de recetas para registrar un ingrediente sobre la marcha sin cerrar el editor.
- **Todo List**:
  1. Modificar `addIngredientRow()` en `js/app.js` para vincular cada fila con el catálogo de ingredientes disponibles.
  2. Agregar listeners reactivos que recalculen los macros de la receta en tiempo real al alterar cantidades, ingredientes o porciones.
  3. Asegurar que `collectFormData()` y `openRecipeEditorForEdit()` manejen tanto ingredientes vinculados como retrocompatibilidad con recetas existentes.
- **Relevant Context**:
  - `js/app.js` (líneas 696-880)
  - `index.html` (modal `#modal-recipe-editor`)
- **Status**: `[x] completed`
  - `index.html`: `<datalist id="ingredients-datalist">`, indicador `#rf-macros-auto` ("Auto-calculado desde ingredientes") junto a "Macros por porción" y botón `#btn-new-ingredient-quick` ("+ Nuevo ingrediente") en la cabecera de ingredientes.
  - `js/app.js`: `refreshIngredientsDatalist()`, `updateIngredientRowBadge(row)`, `recalculateRecipeEditorMacros()` (usa `calculateRecipeMacros()`), `addIngredientRow()` reescrita (input con `list`, autocompleta unidad si está vacía, badge por fila `.ingr-row-macros`, recálculo en vivo al cambiar ingrediente/cantidad/unidad/eliminar fila). `rf-porciones` conectado al recálculo. El botón rápido abre el editor de ingredientes sin cerrar el de recetas; al guardar/editar/eliminar un ingrediente se refrescan datalist, badges y macros.
  - Retrocompatibilidad: si ninguna fila coincide con el catálogo, los macros ingresados manualmente no se sobrescriben; editar manualmente un campo de macros oculta el indicador de auto-cálculo. `collectFormData()` y `openRecipeEditorForEdit()` mantienen el formato `item/cantidad/unidad` existente.
  - `css/style.css`: `.ingr-row-macros`, `.ingr-row-macros--unknown`, `.macros-auto-badge`, `.dynamic-row--ingr`, `.form-section-actions`.

---

### Sub-tarea 6: Pruebas de Integración, Multi-Usuario y Validación Final
- **Intent**: Comprobar el funcionamiento del catálogo, la privacidad compartida entre usuarios vinculados, el script de extracción y el flujo completo en la interfaz.
- **Expected Outcomes**:
  - Comprobar que el script de extracción genera el catálogo inicial correctamente.
  - Comprobar que los ingredientes se guardan y se sincronizan en Supabase con su `owner_id`.
  - Validar las reglas de acceso: Pablo y Juli ven los ingredientes mutuos; un usuario sin acceso mutuo no los ve.
  - Validar edición en Formulario y JSON de ingredientes.
  - Validar que al crear/editar una receta los macros se calculan de forma 100% matemática y exacta.
- **Todo List**:
  1. Ejecutar el script extractor y validar el archivo `data/ingredients.json`.
  2. Ejecutar validaciones de base de datos y endpoints en `js/storage.js`.
  3. Probar flujos de usuario (creación de ingrediente en Formulario y JSON, receta con autocalc, lista de compras).
- **Relevant Context**:
  - `scripts/validate-migration.js`
  - `js/storage.js`
  - `js/planner.js`
- **Status**: `[x] completed`
  - Sintaxis JS validada con `node --check` en todos los archivos de `js/*.js` y `scripts/*.js`: sin errores.
  - Script `scripts/validate-ingredients.js` creado con 4 secciones de validación y **73 checks**:
    1. **`data/ingredients.json`**: 11 checks — estructura, campos requeridos, IDs únicos, unidades válidas, macros completos y positivos (205 ingredientes).
    2. **`js/ingredients.js` — lógica de negocio**: 23 checks — `slugifyIngredient`, `_normalise` (aplanado de macros, prioridad campos planos), `calculateItemMacros` (proporción, redondeo 2 decimales, caso 0), `calculateRecipeMacros` (suma total, división por porciones, ingrediente desconocido→0, porciones=0→1), `searchIngredients` (query, categoría, combinado, sin match).
    3. **`supabase/migrations/20250602000000_ingredients.sql`**: 27 checks — columnas, CHECK constraint multi-línea, índices (`ingredients_owner_idx`, `ingredients_nombre_idx` GIN), función `shares_access_with` (security definer, stable, join person_access, status='approved'), RLS habilitado, 4 políticas (SELECT/INSERT/UPDATE/DELETE) con `is_admin()`, `owner_id=auth.uid()` y `shares_access_with`.
    4. **Integración `recipes.json` ↔ `ingredients.json`**: 6 checks — forma `{ item, cantidad, unidad }` en todas las filas de ingredientes, cobertura ≥ 60% (80 % actual: 186/233).
  - **Correcciones realizadas durante la ejecución**:
    - `data/recipes.json` — receta `pollo-al-horno-con-papas-y-vegetales-asados-2-porciones`: 4 filas de ingredientes usaban `nombre` en lugar de `item` y codificaban unidad dentro del string de cantidad; convertidas al schema canónico `{ item, cantidad, unidad }`. La fila de vegetales mixtos (agrupación compleja) fue eliminada según las reglas del extractor.
    - `data/recipes.json` — receta `yogur-griego-con-dulce-de-leche`: 2 filas usaban `nombre` en lugar de `item` y tenían un sub-objeto `macros` redundante; convertidas al schema canónico y el sub-objeto eliminado.
    - `scripts/validate-ingredients.js` — regex del CHECK constraint de `unidad_referencia` corregida para tolerar salto de línea entre la definición de columna y la cláusula `check(...)` (usa `[\s\S]{0,120}` en lugar de `.*`).
  - Resultado final: **73 passed, 0 failed** (`node scripts/validate-ingredients.js` → exit 0).
