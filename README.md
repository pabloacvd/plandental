# PlanDental — Meal Planner Semanal

Una webapp serverless para planificar las comidas de la semana.  
Corre en GitHub Pages, guarda los datos vía GitHub API.

## Uso

1. Abrí `index.html` localmente con un servidor estático, o en GitHub Pages.
2. Hacé clic en **Conectar GitHub** e ingresá tu Personal Access Token con permisos `repo`, el owner y el nombre de este repositorio.
3. Buscá recetas en el panel izquierdo y arrastrálas al calendario.
4. Los cambios se guardan automáticamente en `data/plan.json` dentro del repositorio.

## Desarrollo local

```bash
# Con Python 3
python3 -m http.server 8080

# Con Node
npx serve .
```

Luego abrí `http://localhost:8080`.

## PWA / iPhone

### 1. Ejecutar localmente

```bash
# Con Python 3 (recomendado)
python3 -m http.server 8080

# Con Node
npx serve .
```

Abrí `http://localhost:8080` en el navegador.

> El Service Worker requiere HTTPS en producción. En localhost funciona sin HTTPS.

### 2. Probar desde un iPhone en la misma red

1. Averiguá la IP local de tu computadora (p.ej. `192.168.1.50`):
   - macOS: `ipconfig getifaddr en0`
2. Asegurate de que el servidor esté corriendo.
3. En iPhone abrí Safari y navegá a `http://192.168.1.50:8080`.

> El Service Worker **no** se registrará en esta URL porque no es HTTPS ni localhost.
> La app funcionará normalmente; para instalarla como PWA funcional usá la URL de GitHub Pages (HTTPS).

### 3. Desplegar en HTTPS

El proyecto corre en GitHub Pages sin configuración adicional.
En Settings → Pages, configurá "Deploy from branch: main, folder: / (root)".

La URL resultante será `https://<usuario>.github.io/<repo>/` y soportará todas las funciones PWA.

### 4. Instalar en iPhone

1. Abrí la URL de GitHub Pages en **Safari** en tu iPhone.
2. Tocá el botón de compartir (⬆) en la barra de Safari.
3. Seleccioná **"Agregar a pantalla de inicio"** (Add to Home Screen).
4. Confirmá el nombre "PlanDental" y tocá **Agregar**.

La app aparecerá en la pantalla de inicio con el ícono azul, se abrirá en modo pantalla completa (sin barra de Safari) y recordará tu sesión de GitHub.

### 5. Sistema de actualizaciones

El Service Worker usa un cache versionado (`plandental-v1` en `sw.js`).

**Flujo cuando desplegás una nueva versión:**
1. El navegador detecta que `sw.js` cambió.
2. Instala el nuevo Service Worker en segundo plano.
3. Gracias a `skipWaiting()` + `clientsClaim()`, el nuevo SW se activa inmediatamente.
4. Los caches viejos se eliminan automáticamente en el evento `activate`.
5. La próxima carga de página usa los assets nuevos.

**Para forzar la invalidación del cache al desplegar cambios importantes:**
- Abrí `sw.js` y cambiá `CACHE_NAME = 'plandental-v1'` a `'plandental-v2'` (o el número siguiente).
- Hacé commit y push.
- El browser descargará todos los assets nuevamente.

No es necesario desinstalar la PWA del iPhone.

### 6. Modo offline

**Qué funciona offline:**
- La interfaz completa (HTML, CSS, JS).
- El catálogo de recetas (`data/recipes.json`) — cacheado en la primera visita.
- Los datos nutricionales se leen solo de Supabase (`nutrition_data`); `data/nutrition.json` es únicamente la semilla del script de migración.
- El plan semanal guardado localmente en `localStorage`.

**Qué requiere Internet:**
- Sincronización del plan y recetas con GitHub (se omite silenciosamente si no hay red).
- La primera carga de la app si nunca se visitó antes.

El Service Worker NO cachea llamadas a `api.github.com` para proteger el token de autenticación y evitar datos desactualizados.

### 7. Cambiar el ícono o nombre de la aplicación

**Nombre:** editá `manifest.webmanifest` → campos `name` y `short_name`.
También actualizá `<meta name="apple-mobile-web-app-title">` en `index.html`.

**Ícono:** reemplazá los archivos en `icons/` con tus propios PNG:
- `icons/icon-192.png` — 192×192 px
- `icons/icon-512.png` — 512×512 px
- `icons/apple-touch-icon.png` — 180×180 px
- `icons/favicon.ico` — 32×32 px

Para regenerar los íconos de placeholder (fondo azul con "PD"):
```bash
node scripts/generate-icons.js
```

> iOS cachea agresivamente los `apple-touch-icon`. Si cambiás el ícono y no se actualiza en el iPhone, desinstalá la app de la pantalla de inicio y volvé a agregarla desde Safari.

### 8. Incrementar la versión del cache

Cada vez que desplegues cambios importantes en el código o los assets:

1. Abrí `sw.js`.
2. Cambiá la línea:
   ```js
   const CACHE_NAME = 'plandental-v1';
   ```
   a `'plandental-v2'`, `'plandental-v3'`, etc.
3. Hacé commit y push.

Esto garantiza que todos los dispositivos descarguen la versión nueva completa y eliminen los caches anteriores.

---

## Perfil y progreso

Al hacer click en el nombre de usuario se abre **Perfil y progreso**, con tres pestañas y una sección plegable "Mi cuenta" (contraseña, administración, cerrar sesión).

- **Datos:** altura, edad, sexo, meta (bajar / mantener / subir), actividad, déficit (20% por defecto), peso objetivo, calorías y macros, "Calcular con fórmulas" (muestra el desarrollo), registro de peso (una fila por día; cargar el mismo día sobrescribe) e historial de recálculos con botón "Revertir".
- **Dashboard:** calorías por día contra objetivo y mantenimiento, peso con tendencia, macros promedio y balance semanal. Ventanas de 7 / 30 / 90 días.
- **Sugerencias:** evaluación de proteína (g/kg), grasa, calorías, ritmo de pérdida y estancamiento, con fuente en cada una, y comparación de metas actuales contra recomendadas.

**La ingesta es el plan.** Toda comida planificada para hoy o días anteriores se considera consumida; los días sin ninguna comida son "sin datos" (no cero) y los días futuros no cuentan.

### Fórmulas (unidades métricas, energía en kcal)

| Concepto | Regla |
|---|---|
| BMR | Mifflin-St Jeor: `10·kg + 6,25·cm − 5·edad + 5` (hombre) / `− 161` (mujer) |
| Mantenimiento | BMR × factor (sedentario 1,2 · ligero 1,375 · moderado 1,55 · alto 1,725 · atleta 1,9) |
| Objetivo | bajar: mantenimiento × (1 − déficit%) · mantener: × 1,00 · subir: × 1,10 |
| Proteína | 2,0 g/kg al bajar, 1,6 al mantener, 1,8 al subir |
| Grasa | 25% de las calorías, mínimo 0,5 g/kg |
| Carbohidratos | el resto de las calorías (4 kcal/g proteína y carbohidratos, 9 kcal/g grasa) |
| Tendencia de peso | regresión lineal en 28 días, mínimo 3 pesajes que abarquen 14 días |
| Mantenimiento real | ingesta promedio − pendiente (kg/día) × 7700; ventana ≥ 21 días con ≥ 70% de días con comidas; solo días anteriores a hoy |

El objetivo nunca baja de la tasa basal ni de 1200 kcal (mujer) / 1500 kcal (hombre). Todo es orientativo y no reemplaza el asesoramiento médico.

### Recálculo automático

Corre al registrar un peso y al abrir el perfil, como máximo **una vez por semana por persona** (lo garantiza un índice único en la base, aun con dos dispositivos a la vez). Mezcla la fórmula con el mantenimiento real (más peso al historial cuanto más datos hay) y limita cada cambio a ±5% o ±150 kcal, lo menor. Cada cambio queda en el historial con su motivo y se puede revertir; un cambio revertido no vuelve a aplicarse hasta la semana siguiente. Se desactiva por persona con el interruptor "Recalcular automáticamente".

### Migración

Antes de usar la UI nueva, aplicá `supabase/migrations/20261111000100_weight_log_and_goals.sql` (requiere Postgres 15+ por `security_invoker`). Crea `weight_log`, `targets_history`, la vista `person_daily_intake`, nuevas columnas en `nutrition_data`, los triggers de peso y las RPC `apply_targets_change` / `revert_targets_change`. Es idempotente. El peso inicial se siembra desde `nutrition_data.weight_kg` con fecha aproximada (`updated_at`).

### Tests

```bash
node scripts/test-nutrition.mjs
node scripts/test-servings.mjs
node scripts/verify-recipe-versions.js
```

---

## Porciones, slot-card clickeable y slots extra

### Porciones comidas

En el detalle del día, cada comida tiene un control de porciones (−, valor editable, +) con paso de 0,25. El rango es de 0,25 a 10 (0,25 / 0,5 / 1 / 2 / 3…); un valor tipeado fuera de rango se ajusta al más cercano y acepta coma o punto decimal. En la vista Familia hay un control por integrante, también en la tarjeta de la comida compartida.

- `servings` es un multiplicador de la porción de la receta, sin caso especial para recetas de 1 porción: 0,5 de un Café Latte es la mitad de los macros; 2 es el doble.
- Los macros guardados en la comida siguen siendo **por porción**; se multiplican por `servings` al calcular el slot-card, el resumen del día, las barras del calendario, el dashboard y el recálculo automático.
- La pastilla del calendario muestra "×N" cuando `servings ≠ 1`.
- **Lista de compras:** se suman las porciones comidas por receta y versión, y se cocinan `ceil(Σ porciones / porciones de la receta)` tandas (la suma se redondea a 2 decimales antes del `ceil`). Ejemplos: Café Latte con Pablo 1 + Juli 1 → 2 porciones; cheesecake de 4 porciones con 2 + 2 → 1 tanda, con 2 + 3 → 2 tandas.
- `servings` no forma parte del snapshot de la receta, así que cambiarlo no pierde la versión guardada.
- El autoplanner (`js/planner.js`) no cambia: siempre asigna 1 porción.

### Slot-card clickeable

En el detalle del día, al hacer click en una comida (nombre y macros) se abre la receta **guardada en ese día y slot** (snapshot), no la versión actual del recetario. Las comidas anteriores al snapshot abren la receta actual del catálogo. En Familia, la comida compartida y cada fila por integrante abren el snapshot de esa persona. Es navegable con teclado (Enter / Espacio); los botones y controles (Quitar, porciones, período) no abren el modal.

### Slots extra ("Snack extra")

Además de los 5 slots fijos, cada día admite comidas extra sin tope:

- El botón **+ Agregar una comida**, al final del detalle del día, crea un "Snack extra" con un selector de período (mañana / tarde / noche; por defecto, tarde). Acepta cualquier receta, por arrastre o con "+ Agregar".
- El extra se muestra justo después del slot fijo de su período: mañana → después de Desayuno, tarde → después de Snack tarde, noche → después de Snack noche. Varios extras del mismo período se ordenan por número. Al cambiar el período, el orden se actualiza.
- Se identifican como `extra_1`, `extra_2`… (único por día y compartido por los integrantes en Familia). Un extra sin receta vive solo en memoria y desaparece al recargar; quitar la última comida de un extra lo elimina.
- Cuentan en pastillas, totales, lista de compras, aplicar la semana por defecto y guardar como semana por defecto. Los selectores de slot (arrastrar a un día, picker) incluyen "Snack extra".

### Migración

Antes de usar la UI nueva, aplicá `supabase/migrations/20261112000100_servings_and_extra_slots.sql`. Agrega a `plans` y `default_week` las columnas `servings` (`numeric`, default 1, entre 0,25 y 10) y `slot_period` (`manana` / `tarde` / `noche`, nulo en los slots fijos); reemplaza el check de `slot_id` para aceptar los 5 slots fijos o `extra_<n>` (los extras exigen `slot_period`); y recrea la vista `person_daily_intake` multiplicando los macros por `servings` (con `security_invoker = true`). Es idempotente, no cambia RLS y deja los datos existentes en `servings = 1`. Sin la migración, guardar y leer el plan falla porque el cliente pide las columnas nuevas.

## Estructura

```
├── index.html
├── manifest.webmanifest      # PWA manifest
├── sw.js                     # Service Worker
├── css/
│   └── style.css
├── js/
│   ├── app.js                # Orquestador principal
│   ├── calendar.js           # Utilidades de fecha y slots
│   ├── charts.js             # Gráficos SVG propios
│   ├── dashboard.js          # Pestaña Dashboard
│   ├── nutrition.js          # Cálculos de nutrición (puros)
│   ├── profile.js            # Modal Perfil y progreso
│   ├── recipes.js            # Carga y búsqueda de recetas
│   ├── storage.js            # GitHub API + localStorage
│   └── ui.js                 # Renderizado
├── icons/
│   ├── apple-touch-icon.png  # iOS home screen icon (180×180)
│   ├── favicon.ico           # Browser tab icon (32×32)
│   ├── icon-192.png          # Manifest icon (192×192)
│   └── icon-512.png          # Manifest icon (512×512)
├── data/
│   ├── nutrition.json        # Objetivos nutricionales por persona
│   ├── recipes.json          # Catálogo de recetas
│   └── plan.json             # Plan semanal guardado (generado, no versionado)
└── scripts/
    ├── generate-icons.js     # Genera los íconos de placeholder
    ├── test-nutrition.mjs    # Tests de js/nutrition.js
    └── test-servings.mjs     # Tests de porciones, slots extra y lista de compras
```

## GitHub Pages

En Settings → Pages, configurá "Deploy from branch: main, folder: / (root)".
