/**
 * verify-recipe-versions.js — pure-logic check of the versioned-plan scenario.
 * No database, no DOM, no dependencies:   node scripts/verify-recipe-versions.js
 *
 * Scenario: a recipe with 100 g of flour is assigned on Monday; it is then
 * edited to 50 g (macros change too) and assigned on Tuesday.
 */

import assert from 'node:assert/strict';
import {
  mealFromRecipe, copyMealForPlan, sameMealVersion,
  versionFingerprint, buildShoppingItems,
} from '../js/plan-versions.js';
import { computeDayMacros } from '../js/calendar.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

// ── Catalog: recipe "panqueques", version A (100 g) ──────────────────────────
const recipeA = {
  id: 'panqueques',
  receta: {
    nombre: 'Panqueques',
    categoria: 'desayuno',
    descripcion_breve: 'Panqueques de avena',
    porciones: 2,
    macros_por_porcion: { calorias: 400, proteina_g: 20, carbohidratos_g: 60, grasas_g: 8 },
    ingredientes: [
      { item: 'Harina', cantidad: '100', unidad: 'g' },
      { item: 'Huevo',  cantidad: '2',   unidad: 'u' },
      { item: 'Sal',    cantidad: '1',   unidad: 'g' },
    ],
    paso_a_paso: ['Mezclar', 'Cocinar'],
  },
};

// Monday: assigned from version A.
const monday = mealFromRecipe(recipeA);

// The user edits the recipe in the catalog: 50 g of flour, lighter macros.
const recipeB = JSON.parse(JSON.stringify(recipeA));
recipeB.receta.ingredientes[0].cantidad = '50';
recipeB.receta.macros_por_porcion = { calorias: 250, proteina_g: 16, carbohidratos_g: 30, grasas_g: 7 };

// Tuesday: assigned from version B.
const tuesday = mealFromRecipe(recipeB);

// The catalog now only knows version B.
const catalog = { [recipeB.id]: recipeB };
const getRecipeById = id => catalog[id] ?? null;
const isExcluded = name => ['sal', 'agua'].some(ex => name.toLowerCase().includes(ex));

console.log('Escenario 100 g -> 50 g');

check('editing the catalog does not alter Monday\'s snapshot', () => {
  assert.equal(monday.recipeSnapshot.ingredientes[0].cantidad, '100');
  assert.equal(tuesday.recipeSnapshot.ingredientes[0].cantidad, '50');
});

check('snapshot is an independent deep copy of the catalog recipe', () => {
  assert.notEqual(monday.recipeSnapshot, recipeA.receta);
  assert.notEqual(monday.recipeSnapshot.ingredientes, recipeA.receta.ingredientes);
  recipeA.receta.ingredientes[0].cantidad = '999';
  assert.equal(monday.recipeSnapshot.ingredientes[0].cantidad, '100');
  recipeA.receta.ingredientes[0].cantidad = '100';
});

check('(a) Monday and Tuesday macros differ', () => {
  const mon = computeDayMacros({ desayuno: monday });
  const tue = computeDayMacros({ desayuno: tuesday });
  assert.equal(mon.calorias, 400);
  assert.equal(tue.calorias, 250);
  assert.notDeepEqual(mon, tue);
});

check('same recipe in different versions sums different macros in one day', () => {
  const day = computeDayMacros({ desayuno: monday, snack_noche: tuesday });
  assert.equal(day.calorias, 650);
  assert.equal(day.proteina_g, 36);
});

check('(c) sameMealVersion: true for identical copies', () => {
  const copy = mealFromRecipe(recipeA);
  assert.equal(sameMealVersion(monday, copy), true);
  assert.equal(sameMealVersion(monday, JSON.parse(JSON.stringify(monday))), true);
  assert.equal(versionFingerprint(monday.recipeSnapshot), versionFingerprint(copy.recipeSnapshot));
});

check('(c) sameMealVersion: false for different versions of the same recipe', () => {
  assert.equal(monday.recipeId, tuesday.recipeId);
  assert.equal(sameMealVersion(monday, tuesday), false);
});

check('sameMealVersion ignores JSON key order', () => {
  const reordered = {
    ...monday,
    recipeSnapshot: Object.fromEntries(Object.entries(monday.recipeSnapshot).reverse()),
  };
  assert.equal(sameMealVersion(monday, reordered), true);
});

check('sameMealVersion: different recipeId or missing meal is false', () => {
  assert.equal(sameMealVersion(monday, { ...monday, recipeId: 'otra' }), false);
  assert.equal(sameMealVersion(monday, null), false);
});

check('legacy meals (no snapshot): same only if neither has one', () => {
  const legacy = { recipeId: 'panqueques', recipeName: 'Panqueques', macros: {} };
  assert.equal(sameMealVersion(legacy, { ...legacy }), true);
  assert.equal(sameMealVersion(legacy, monday), false);
});

check('(b) shopping list: separate batches per version', () => {
  // 1 portion of v1 (Monday) + 1 portion of v2 (Tuesday); porciones = 2.
  // Same version would be 1 batch of 100 g or 50 g; two versions = 100 + 50.
  const items = buildShoppingItems([monday, tuesday], { getRecipeById, isExcluded });
  const harina = items.find(i => i.name === 'Harina');
  const huevo  = items.find(i => i.name === 'Huevo');
  assert.equal(harina.qty, '150');
  assert.equal(huevo.qty, '4');            // 2 + 2: one batch of each version
  assert.equal(items.find(i => i.name === 'Sal'), undefined); // excluded
});

check('(b) two portions of the SAME version share one batch', () => {
  const other = mealFromRecipe(recipeA); // identical copy of version A
  const items = buildShoppingItems([monday, other], { getRecipeById, isExcluded });
  assert.equal(items.find(i => i.name === 'Harina').qty, '100');
  assert.equal(items.find(i => i.name === 'Huevo').qty, '2');
});

check('(b) three portions of one version = ceil(3/2) = 2 batches', () => {
  const m = [monday, mealFromRecipe(recipeA), mealFromRecipe(recipeA)];
  const items = buildShoppingItems(m, { getRecipeById, isExcluded });
  assert.equal(items.find(i => i.name === 'Harina').qty, '200');
});

check('legacy meal without snapshot falls back to the current catalog recipe', () => {
  const legacy = { recipeId: 'panqueques', recipeName: 'Panqueques', macros: {} };
  const items = buildShoppingItems([legacy], { getRecipeById, isExcluded });
  assert.equal(items.find(i => i.name === 'Harina').qty, '50'); // current = version B
});

check('minimal snapshot (no ingredients) falls back to the catalog recipe', () => {
  const minimal = {
    recipeId: 'panqueques', recipeName: 'Panqueques', macros: {},
    recipeSnapshot: { nombre: 'Panqueques', macros_por_porcion: {} },
  };
  const items = buildShoppingItems([minimal], { getRecipeById, isExcluded });
  assert.equal(items.find(i => i.name === 'Harina').qty, '50');
});

check('legacy meal whose recipe was deleted is skipped without crashing', () => {
  const orphan = { recipeId: 'borrada', recipeName: 'X', macros: {} };
  assert.deepEqual(buildShoppingItems([orphan], { getRecipeById, isExcluded }), []);
});

check('copyMealForPlan: independent copy, generates a snapshot for legacy defaults', () => {
  const legacy = { recipeId: 'panqueques', recipeName: 'Panqueques', macros: { calorias: 123 } };
  const copy = copyMealForPlan(legacy, getRecipeById);
  assert.equal(copy.recipeSnapshot.ingredientes[0].cantidad, '50');
  assert.equal(copy.macros.calorias, 123);           // macros never recomputed
  assert.equal(legacy.recipeSnapshot, undefined);    // original untouched
  const withSnap = copyMealForPlan(monday, getRecipeById);
  assert.notEqual(withSnap.recipeSnapshot, monday.recipeSnapshot);
  assert.equal(sameMealVersion(withSnap, monday), true);
});

check('assigning to several persons gives each its own copy', () => {
  const pablo = mealFromRecipe(recipeA);
  const juli  = mealFromRecipe(recipeA);
  assert.notEqual(pablo.recipeSnapshot, juli.recipeSnapshot);
  assert.notEqual(pablo.macros, juli.macros);
  assert.equal(sameMealVersion(pablo, juli), true);
});

console.log(`\n${passed} checks passed.`);
