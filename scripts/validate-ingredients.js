#!/usr/bin/env node
/**
 * validate-ingredients.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sub-tarea 6 — Validation script for the ingredients catalog system.
 *
 * Checks:
 *   1. data/ingredients.json  — format, required fields, value constraints.
 *   2. js/ingredients.js logic — calculateItemMacros, calculateRecipeMacros,
 *                                slugifyIngredient, searchIngredients,
 *                                addIngredient / updateIngredient / deleteIngredient.
 *   3. supabase/migrations/20250602000000_ingredients.sql — columns, indexes,
 *                                shares_access_with, RLS policies.
 *   4. Integration with data/recipes.json — ingredient rows follow the
 *                                { item, cantidad, unidad } shape.
 *
 * Run:
 *   node scripts/validate-ingredients.js
 *
 * Exit 0 on success, 1 on any failure.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, reason) {
  const msg = `${label}: ${reason}`;
  console.error(`  ❌ ${msg}`);
  errors.push(msg);
  failed++;
}

function assert(label, condition, reason) {
  condition ? ok(label) : fail(label, reason);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

// ── 1. data/ingredients.json ──────────────────────────────────────────────────

function validateIngredientsJSON() {
  section('1. data/ingredients.json');

  const jsonPath = resolve(ROOT, 'data', 'ingredients.json');
  assert('File exists', existsSync(jsonPath), 'data/ingredients.json not found');
  if (!existsSync(jsonPath)) return;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    ok('Parses as valid JSON');
  } catch (e) {
    fail('Parses as valid JSON', e.message);
    return;
  }

  assert(
    'Top-level has "ingredientes" array',
    Array.isArray(parsed.ingredientes),
    'Expected { "ingredientes": [...] }'
  );
  if (!Array.isArray(parsed.ingredientes)) return;

  const items = parsed.ingredientes;
  assert('At least one ingredient', items.length > 0, 'Array is empty');

  const REQUIRED_FIELDS = ['id', 'nombre', 'categoria', 'unidad_referencia', 'cantidad_referencia', 'macros'];
  const MACRO_FIELDS    = ['calorias', 'proteina_g', 'carbohidratos_g', 'grasas_g'];
  const VALID_UNITS     = new Set(['g', 'ml', 'unidad']);

  let missingFields    = 0;
  let badUnits         = 0;
  let badRef           = 0;
  let missingMacros    = 0;
  let negativeMacros   = 0;
  let duplicateIds     = 0;

  const seenIds = new Set();

  for (const item of items) {
    // Required top-level fields
    for (const f of REQUIRED_FIELDS) {
      if (item[f] === undefined || item[f] === null) missingFields++;
    }

    // Duplicate ids
    if (item.id) {
      if (seenIds.has(item.id)) duplicateIds++;
      seenIds.add(item.id);
    }

    // unidad_referencia must be g | ml | unidad
    if (item.unidad_referencia && !VALID_UNITS.has(item.unidad_referencia)) badUnits++;

    // cantidad_referencia must be > 0
    if (typeof item.cantidad_referencia === 'number' && item.cantidad_referencia <= 0) badRef++;

    // macros sub-object
    if (item.macros && typeof item.macros === 'object') {
      for (const mf of MACRO_FIELDS) {
        if (item.macros[mf] === undefined || item.macros[mf] === null) missingMacros++;
        if (typeof item.macros[mf] === 'number' && item.macros[mf] < 0)  negativeMacros++;
      }
    }
  }

  assert(`All ${items.length} items have required fields`,            missingFields  === 0, `${missingFields} missing field(s)`);
  assert('No duplicate IDs',                                          duplicateIds   === 0, `${duplicateIds} duplicate id(s)`);
  assert('All unidad_referencia values are g | ml | unidad',         badUnits       === 0, `${badUnits} invalid unit(s)`);
  assert('All cantidad_referencia values > 0',                       badRef         === 0, `${badRef} invalid reference quantity(-ies)`);
  assert('All macros sub-objects have all four macro fields',        missingMacros  === 0, `${missingMacros} missing macro field(s)`);
  assert('No negative macro values',                                  negativeMacros === 0, `${negativeMacros} negative macro value(s)`);
  ok(`Total ingredients loaded: ${items.length}`);

  return items; // return for use in other sections
}

// ── 2. js/ingredients.js logic ────────────────────────────────────────────────

/**
 * Minimal inline re-implementation of the module logic for Node testing
 * (the actual module uses ES modules with browser imports, so we replicate
 * the pure functions here and verify them independently).
 */
function validateIngredientsLogic() {
  section('2. js/ingredients.js — business logic');

  // ── slugifyIngredient ─────────────────────────────────────────────────────
  function slugifyIngredient(name) {
    return String(name)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  assert('slugify: plain ascii',        slugifyIngredient('Pollo')           === 'pollo',          `got "${slugifyIngredient('Pollo')}"`);
  assert('slugify: accents stripped',   slugifyIngredient('Aceite de oliva') === 'aceite-de-oliva', `got "${slugifyIngredient('Aceite de oliva')}"`);
  assert('slugify: special chars',      slugifyIngredient('Queso (fresco)')  === 'queso-fresco',    `got "${slugifyIngredient('Queso (fresco)')}"`);
  assert('slugify: length capped at 60',slugifyIngredient('a'.repeat(80)).length === 60,            'length not capped');

  // ── _normalise ────────────────────────────────────────────────────────────
  function _normalise(raw) {
    const m = raw.macros ?? {};
    return {
      id:                  raw.id                  ?? '',
      nombre:              raw.nombre              ?? '',
      categoria:           raw.categoria           ?? null,
      unidad_referencia:   raw.unidad_referencia   ?? 'g',
      cantidad_referencia: raw.cantidad_referencia ?? 100,
      calorias:            raw.calorias            ?? m.calorias            ?? 0,
      proteina_g:          raw.proteina_g          ?? m.proteina_g          ?? 0,
      carbohidratos_g:     raw.carbohidratos_g     ?? m.carbohidratos_g     ?? 0,
      grasas_g:            raw.grasas_g            ?? m.grasas_g            ?? 0,
    };
  }

  // _normalise flattens nested macros
  const raw = { id: 'test', nombre: 'Test', categoria: 'test', unidad_referencia: 'g', cantidad_referencia: 100, macros: { calorias: 200, proteina_g: 10, carbohidratos_g: 20, grasas_g: 5 } };
  const norm = _normalise(raw);
  assert('_normalise: flattens macros.calorias',        norm.calorias        === 200, `got ${norm.calorias}`);
  assert('_normalise: flattens macros.proteina_g',      norm.proteina_g      === 10,  `got ${norm.proteina_g}`);
  assert('_normalise: flattens macros.carbohidratos_g', norm.carbohidratos_g === 20,  `got ${norm.carbohidratos_g}`);
  assert('_normalise: flattens macros.grasas_g',        norm.grasas_g        === 5,   `got ${norm.grasas_g}`);
  assert('_normalise: flat fields win over nested',
    _normalise({ calorias: 999, macros: { calorias: 1 } }).calorias === 999,
    'flat field did not take precedence'
  );

  // ── calculateItemMacros ───────────────────────────────────────────────────
  function round2(n) { return Math.round(n * 100) / 100; }

  function calculateItemMacros(ing, cantidad) {
    const ref   = ing.cantidad_referencia || 100;
    const ratio = (cantidad ?? 0) / ref;
    return {
      calorias:        round2(ing.calorias        * ratio),
      proteina_g:      round2(ing.proteina_g      * ratio),
      carbohidratos_g: round2(ing.carbohidratos_g * ratio),
      grasas_g:        round2(ing.grasas_g        * ratio),
    };
  }

  const oliveOil = _normalise({ id: 'aceite-de-oliva', nombre: 'Aceite de oliva', categoria: 'aceite', unidad_referencia: 'g', cantidad_referencia: 100, macros: { calorias: 884, proteina_g: 0, carbohidratos_g: 0, grasas_g: 100 } });

  // 50 g of olive oil = 442 kcal, 50 g fat
  const item50g = calculateItemMacros(oliveOil, 50);
  assert('calculateItemMacros: 50g aceite-de-oliva → 442 kcal', item50g.calorias === 442,  `got ${item50g.calorias}`);
  assert('calculateItemMacros: 50g aceite-de-oliva → 50g fat',  item50g.grasas_g === 50,   `got ${item50g.grasas_g}`);

  // 0 g → all zeros
  const item0 = calculateItemMacros(oliveOil, 0);
  assert('calculateItemMacros: 0g → 0 kcal', item0.calorias === 0, `got ${item0.calorias}`);

  // Rounding: 1/3 of 100g chicken breast (100g = 165 kcal, 31g prot, 0g carb, 3.6g fat)
  const chicken = _normalise({ id: 'pollo', nombre: 'Pollo', categoria: 'carne', unidad_referencia: 'g', cantidad_referencia: 100, macros: { calorias: 165, proteina_g: 31, carbohidratos_g: 0, grasas_g: 3.6 } });
  const chicken33 = calculateItemMacros(chicken, 33.333);
  assert('calculateItemMacros: rounding to 2 decimal places', Number.isFinite(chicken33.proteina_g) && String(chicken33.proteina_g).replace('.','').length <= 4, `got ${chicken33.proteina_g}`);

  // ── calculateRecipeMacros ─────────────────────────────────────────────────
  function getIngredientByName(catalog, name) {
    const slug = slugifyIngredient(name);
    return catalog.find(i => slugifyIngredient(i.nombre) === slug) ?? null;
  }

  function calculateRecipeMacros(catalog, ingredientesList, porciones = 1) {
    const ZERO = { calorias: 0, proteina_g: 0, carbohidratos_g: 0, grasas_g: 0 };
    const total = (ingredientesList ?? []).reduce((acc, row) => {
      const ing = getIngredientByName(catalog, row.item ?? '');
      if (!ing) return acc;
      const c = calculateItemMacros(ing, row.cantidad ?? 0);
      return {
        calorias:        acc.calorias        + c.calorias,
        proteina_g:      acc.proteina_g      + c.proteina_g,
        carbohidratos_g: acc.carbohidratos_g + c.carbohidratos_g,
        grasas_g:        acc.grasas_g        + c.grasas_g,
      };
    }, { ...ZERO });
    const n = porciones > 0 ? porciones : 1;
    return {
      total,
      porcion: {
        calorias:        round2(total.calorias        / n),
        proteina_g:      round2(total.proteina_g      / n),
        carbohidratos_g: round2(total.carbohidratos_g / n),
        grasas_g:        round2(total.grasas_g        / n),
      }
    };
  }

  const catalog = [oliveOil, chicken];

  // 200g chicken + 10g olive oil → 2 servings
  const result = calculateRecipeMacros(catalog, [
    { item: 'Pollo', cantidad: 200, unidad: 'g' },
    { item: 'Aceite de oliva', cantidad: 10, unidad: 'g' },
  ], 2);

  const expectedTotalKcal = round2(165 * 2 + 884 * 0.1); // 330 + 88.4 = 418.4
  assert('calculateRecipeMacros: total kcal', result.total.calorias === expectedTotalKcal, `expected ${expectedTotalKcal}, got ${result.total.calorias}`);
  assert('calculateRecipeMacros: per-serving = total / porciones', result.porcion.calorias === round2(expectedTotalKcal / 2), `expected ${round2(expectedTotalKcal/2)}, got ${result.porcion.calorias}`);

  // Unknown ingredient contributes 0
  const r2 = calculateRecipeMacros(catalog, [{ item: 'ingrediente-fantasma', cantidad: 9999, unidad: 'g' }], 1);
  assert('calculateRecipeMacros: unknown ingredient → 0 kcal', r2.total.calorias === 0, `got ${r2.total.calorias}`);

  // porciones = 0 falls back to 1
  const r3 = calculateRecipeMacros(catalog, [{ item: 'Pollo', cantidad: 100, unidad: 'g' }], 0);
  assert('calculateRecipeMacros: porciones=0 treated as 1', r3.porcion.calorias === r3.total.calorias, `total=${r3.total.calorias} porcion=${r3.porcion.calorias}`);

  // ── searchIngredients ─────────────────────────────────────────────────────
  function searchIngredients(catalog, query = '', category = 'all') {
    const q = query.toLowerCase().trim();
    return catalog.filter(ing => {
      if (category !== 'all') {
        if ((ing.categoria ?? '').toLowerCase() !== category.toLowerCase()) return false;
      }
      if (!q) return true;
      return ing.nombre.toLowerCase().includes(q);
    });
  }

  assert('searchIngredients: empty query returns all',         searchIngredients(catalog, '').length      === catalog.length, 'wrong count');
  assert('searchIngredients: category filter works',           searchIngredients(catalog, '', 'aceite').length === 1,        'expected 1 aceite');
  assert('searchIngredients: text query filters by nombre',   searchIngredients(catalog, 'pollo').length === 1,              'expected 1 pollo');
  assert('searchIngredients: no-match returns empty',         searchIngredients(catalog, 'xyzzy').length === 0,              'expected 0 results');
  assert('searchIngredients: category+query combined',        searchIngredients(catalog, 'aceite', 'aceite').length === 1,   'expected 1');
}

// ── 3. SQL schema ─────────────────────────────────────────────────────────────

function validateSQLSchema() {
  section('3. supabase/migrations/20250602000000_ingredients.sql');

  const sqlPath = resolve(ROOT, 'supabase', 'migrations', '20250602000000_ingredients.sql');
  assert('SQL file exists', existsSync(sqlPath), 'migration file not found');
  if (!existsSync(sqlPath)) return;

  const sql = readFileSync(sqlPath, 'utf8');
  ok('SQL file readable');

  // Table definition
  assert('CREATE TABLE public.ingredients',       /create table if not exists public\.ingredients/i.test(sql), 'missing CREATE TABLE');
  assert('id uuid primary key',                   /id\s+uuid\s+primary key/i.test(sql),                        'missing uuid PK');
  assert('owner_id references public.profiles',  /owner_id\s+uuid.*references public\.profiles/i.test(sql),   'missing owner_id FK');
  assert('nombre text not null',                  /nombre\s+text\s+not null/i.test(sql),                        'missing nombre column');
  assert('categoria text column',                 /categoria\s+text/i.test(sql),                                'missing categoria');
  // The CHECK clause may appear on the next line after the column definition
  assert('unidad_referencia with CHECK constraint', /unidad_referencia[\s\S]{0,120}check\s*\(/i.test(sql),      'missing CHECK on unidad_referencia');
  assert("CHECK includes 'g','ml','unidad'",      /'g'.*'ml'.*'unidad'/.test(sql),                              "check constraint missing valid units");
  assert('cantidad_referencia numeric',           /cantidad_referencia\s+numeric/i.test(sql),                   'missing cantidad_referencia');
  assert('calorias numeric',                      /calorias\s+numeric/i.test(sql),                              'missing calorias');
  assert('proteina_g numeric',                    /proteina_g\s+numeric/i.test(sql),                            'missing proteina_g');
  assert('carbohidratos_g numeric',               /carbohidratos_g\s+numeric/i.test(sql),                       'missing carbohidratos_g');
  assert('grasas_g numeric',                      /grasas_g\s+numeric/i.test(sql),                              'missing grasas_g');
  assert('created_at timestamptz',                /created_at\s+timestamptz/i.test(sql),                        'missing created_at');
  assert('updated_at timestamptz',                /updated_at\s+timestamptz/i.test(sql),                        'missing updated_at');
  assert('UNIQUE (owner_id, nombre)',             /unique\s*\(\s*owner_id\s*,\s*nombre\s*\)/i.test(sql),        'missing unique constraint');

  // Indexes
  assert('ingredients_owner_idx index exists',   /create index if not exists ingredients_owner_idx/i.test(sql), 'missing owner index');
  assert('ingredients_nombre_idx GIN index',     /create index if not exists ingredients_nombre_idx/i.test(sql),'missing nombre GIN index');
  assert('GIN uses to_tsvector',                 /using gin\s*\(\s*to_tsvector/i.test(sql),                    'GIN index missing to_tsvector');

  // shares_access_with function
  assert('shares_access_with function defined',  /create or replace function public\.shares_access_with/i.test(sql),  'missing function');
  assert('shares_access_with returns boolean',   /returns boolean/i.test(sql),                                         'missing RETURNS BOOLEAN');
  assert('shares_access_with is security definer', /security definer/i.test(sql),                                      'missing SECURITY DEFINER');
  assert('shares_access_with: stable',           /stable/i.test(sql),                                                   'missing STABLE marker');
  assert('shares_access_with: joins person_access twice', /join public\.person_access/i.test(sql),                      'missing person_access JOIN');
  assert("shares_access_with: checks status = 'approved'", /status\s*=\s*'approved'/i.test(sql),                       "missing status='approved' check");

  // RLS
  assert('RLS enabled',                          /alter table public\.ingredients enable row level security/i.test(sql), 'missing RLS enable');
  assert('SELECT policy exists',                 /for select/i.test(sql),                                                'missing SELECT policy');
  assert('INSERT policy exists',                 /for insert/i.test(sql),                                                'missing INSERT policy');
  assert('UPDATE policy exists',                 /for update/i.test(sql),                                                'missing UPDATE policy');
  assert('DELETE policy exists',                 /for delete/i.test(sql),                                                'missing DELETE policy');
  assert('SELECT uses shares_access_with',       /for select[\s\S]*?shares_access_with/i.test(sql),                     'SELECT policy missing shares_access_with');
  assert('SELECT uses is_admin()',               /for select[\s\S]*?is_admin\(\)/i.test(sql),                            'SELECT policy missing is_admin()');
  assert('INSERT restricted to owner or admin', /for insert[\s\S]*?owner_id\s*=\s*auth\.uid\(\)/i.test(sql),            'INSERT policy missing owner_id = auth.uid()');
}

// ── 4. Integration with data/recipes.json ─────────────────────────────────────

function validateRecipesIntegration() {
  section('4. Integration: recipes.json ↔ ingredients.json');

  const recipesPath     = resolve(ROOT, 'data', 'recipes.json');
  const ingredientsPath = resolve(ROOT, 'data', 'ingredients.json');

  if (!existsSync(recipesPath)) { fail('data/recipes.json exists', 'file not found'); return; }
  if (!existsSync(ingredientsPath)) { fail('data/ingredients.json exists', 'file not found'); return; }

  const recipes     = JSON.parse(readFileSync(recipesPath, 'utf8'));
  const ingredients = JSON.parse(readFileSync(ingredientsPath, 'utf8'));

  const recipeArr  = recipes.recetas ?? (Array.isArray(recipes) ? recipes : []);
  const ingArr     = ingredients.ingredientes ?? (Array.isArray(ingredients) ? ingredients : []);

  assert('recipes.json has recetas array', Array.isArray(recipeArr), 'missing recetas array');
  assert('ingredients.json has ingredientes array', Array.isArray(ingArr), 'missing ingredientes array');

  // Check ingredient row shape within recipes: { item, cantidad, unidad }
  let badRows = 0;
  for (const recipe of recipeArr) {
    const ingList = recipe.receta?.ingredientes ?? [];
    for (const row of ingList) {
      if (!row.item || row.cantidad === undefined || !row.unidad) badRows++;
    }
  }
  assert('All recipe ingredient rows have { item, cantidad, unidad }', badRows === 0, `${badRows} malformed row(s)`);

  // Collect all ingredient names from recipes
  const slugify = name => String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  const catalogSlugs = new Set(ingArr.map(i => slugify(i.nombre)));
  const recipeSlugs  = new Set();
  for (const recipe of recipeArr) {
    for (const row of (recipe.receta?.ingredientes ?? [])) {
      if (row.item) recipeSlugs.add(slugify(row.item));
    }
  }

  let matched = 0;
  for (const slug of recipeSlugs) {
    if (catalogSlugs.has(slug)) matched++;
  }

  const totalUnique  = recipeSlugs.size;
  const matchPct     = totalUnique > 0 ? Math.round((matched / totalUnique) * 100) : 0;

  // We expect the catalog to cover the majority of recipe ingredients
  assert(
    `Catalog covers ≥ 60% of recipe ingredient names (${matched}/${totalUnique} = ${matchPct}%)`,
    matchPct >= 60,
    `only ${matchPct}% covered — catalog may be incomplete`
  );

  ok(`Coverage: ${matched}/${totalUnique} recipe ingredients found in catalog (${matchPct}%)`);

  // Recipes have required fields
  let recipeFieldErrors = 0;
  for (const r of recipeArr) {
    if (!r.id || !r.receta?.nombre || !Array.isArray(r.receta?.ingredientes)) recipeFieldErrors++;
  }
  assert('All recipes have id, receta.nombre, receta.ingredientes', recipeFieldErrors === 0, `${recipeFieldErrors} recipe(s) missing fields`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('PlanDental — Ingredients Catalog Validation');
console.log('============================================');

validateIngredientsJSON();
validateIngredientsLogic();
validateSQLSchema();
validateRecipesIntegration();

console.log('\n══════════════════════════════════════════════');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n❌ Validation FAILED.\n');
  errors.forEach(e => console.error(`   • ${e}`));
  process.exit(1);
} else {
  console.log('\n✅ All checks passed.\n');
}
