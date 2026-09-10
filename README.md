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
- Los datos nutricionales (`data/nutrition.json`) — cacheado en la primera visita.
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
    └── generate-icons.js     # Genera los íconos de placeholder
```

## GitHub Pages

En Settings → Pages, configurá "Deploy from branch: main, folder: / (root)".
