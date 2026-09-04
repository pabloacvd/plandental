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

## Estructura

```
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── app.js        # Orquestador principal
│   ├── calendar.js   # Utilidades de fecha y slots
│   ├── recipes.js    # Carga y búsqueda de recetas
│   ├── storage.js    # GitHub API + localStorage
│   └── ui.js         # Renderizado
└── data/
    ├── nutrition.json # Objetivos nutricionales por persona
    ├── recipes.json   # Catálogo de recetas (21 platos)
    └── plan.json      # Plan semanal guardado (generado)
```

## GitHub Pages

En Settings → Pages, configurá "Deploy from branch: main, folder: / (root)".
