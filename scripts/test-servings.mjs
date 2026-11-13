/**
 * Minimal checks for meal servings (js/plan-versions.js, js/calendar.js).
 * No dependencies. Run: node scripts/test-servings.mjs
 */
import assert from 'node:assert/strict';
import {
  normalizeServings, mealServings, scaledMacros, mealFromRecipe, copyMealForPlan,
  buildShoppingItems,
} from '../js/plan-versions.js';
import { computeDayMacros } from '../js/calendar.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

// ── Fixtures ─────────────────────────────────────────────────
const macros = { calorias: 200, proteina_g: 10, carbohidratos_g: 20, grasas_g: 8 };

const latte = {
  id: 'cafe-latte',
  receta: {
    nombre: 'Café Latte', porciones: 1, macros_por_porcion: macros,
    ingredientes: [{ item: 'Leche', cantidad: '200', unidad: 'ml' }],
  },
};
const cheesecake = {
  id: 'cheesecake',
  receta: {
    nombre: 'Cheesecake', porciones: 4, macros_por_porcion: macros,
    ingredientes: [{ item: 'Queso crema', cantidad: '400', unidad: 'g' }],
  },
};

const withServings = (recipe, servings) => ({ ...mealFromRecipe(recipe), servings });
const shop = meals => buildShoppingItems(meals, { getRecipeById: () => null });
const qty  = (items, name) => Number(items.find(i => i.name === name)?.qty);

// ── Helpers ──────────────────────────────────────────────────
test('normalizeServings: default, clamp and step 0.25', () => {
  assert.equal(normalizeServings(undefined), 1);
  assert.equal(normalizeServings('abc'), 1);
  assert.equal(normalizeServings(0), 0.25);
  assert.equal(normalizeServings(99), 10);
  assert.equal(normalizeServings(0.6), 0.5);
  assert.equal(normalizeServings(1.9), 2);
  assert.equal(normalizeServings(0.25), 0.25);
});

test('mealServings: 1 when missing', () => {
  assert.equal(mealServings({}), 1);
  assert.equal(mealServings(null), 1);
  assert.equal(mealServings({ servings: 2.5 }), 2.5);
});

test('scaledMacros: 0.5 / 1 / 2 and missing servings', () => {
  const meal = { macros };
  assert.deepEqual(scaledMacros(meal), macros);
  assert.equal(scaledMacros({ macros, servings: 0.5 }).calorias, 100);
  assert.equal(scaledMacros({ macros, servings: 2 }).proteina_g, 20);
  assert.equal(scaledMacros({ macros: { calorias: 100 }, servings: 2 }).grasas_g, 0);
  assert.equal(scaledMacros(null).calorias, 0);
});

test('mealFromRecipe: servings 1, independent macros; copyMealForPlan keeps servings', () => {
  const meal = mealFromRecipe(latte);
  assert.equal(meal.servings, 1);
  meal.macros.calorias = 1;
  assert.equal(latte.receta.macros_por_porcion.calorias, 200);
  const copy = copyMealForPlan({ ...meal, servings: 1.5 });
  assert.equal(copy.servings, 1.5);
  assert.notEqual(copy, meal);
});

// ── computeDayMacros ─────────────────────────────────────────
test('computeDayMacros: 0.5, 1 and 2 servings', () => {
  const day = {
    desayuno: { macros, servings: 0.5 },
    almuerzo: { macros, servings: 1 },
    cena:     { macros, servings: 2 },
  };
  assert.equal(computeDayMacros(day).calorias, 700);      // 100 + 200 + 400
  assert.equal(computeDayMacros(day).proteina_g, 35);
});

test('computeDayMacros: meals without servings count as 1', () => {
  assert.equal(computeDayMacros({ desayuno: { macros } }).calorias, 200);
});

// ── buildShoppingItems ───────────────────────────────────────
test('shopping: Café Latte, Pablo 1 + Juli 1 → 2 batches', () => {
  const items = shop([withServings(latte, 1), withServings(latte, 1)]);
  assert.equal(qty(items, 'Leche'), 400);
});

test('shopping: cheesecake of 4, 2 + 2 → 1 batch', () => {
  const items = shop([withServings(cheesecake, 2), withServings(cheesecake, 2)]);
  assert.equal(qty(items, 'Queso crema'), 400);
});

test('shopping: cheesecake of 4, 2 + 3 → 2 batches', () => {
  const items = shop([withServings(cheesecake, 2), withServings(cheesecake, 3)]);
  assert.equal(qty(items, 'Queso crema'), 800);
});

test('shopping: 0.5 of a 1-portion recipe → 1 batch', () => {
  const items = shop([withServings(latte, 0.5)]);
  assert.equal(qty(items, 'Leche'), 200);
});

test('shopping: meals without servings weigh 1 (legacy)', () => {
  const legacy = mealFromRecipe(latte);
  delete legacy.servings;
  assert.equal(qty(shop([legacy, { ...legacy }]), 'Leche'), 400);
});

test('shopping: 0.25 + 0.25 + 0.25 + 0.25 of a 1-portion recipe → exactly 1 batch', () => {
  const meals = Array.from({ length: 4 }, () => withServings(latte, 0.25));
  assert.equal(qty(shop(meals), 'Leche'), 200);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
