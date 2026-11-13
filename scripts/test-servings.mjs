/**
 * Minimal checks for meal servings (js/plan-versions.js, js/calendar.js).
 * No dependencies. Run: node scripts/test-servings.mjs
 */
import assert from 'node:assert/strict';
import {
  normalizeServings, mealServings, scaledMacros, mealFromRecipe, copyMealForPlan,
  buildShoppingItems,
} from '../js/plan-versions.js';
import {
  computeDayMacros, MEAL_SLOTS, EXTRA_PERIODS, isExtraSlot, extraAnchorSlot,
  nextExtraId, collectDayExtras, orderedDaySlots,
} from '../js/calendar.js';

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

// ── Extra slots ──────────────────────────────────────────────
const ids = slots => slots.map(s => s.id);
const FIXED = ['desayuno', 'almuerzo', 'snack_tarde', 'cena', 'snack_noche'];

test('MEAL_SLOTS stays the 5 fixed slots; EXTRA_PERIODS has the 3 periods', () => {
  assert.deepEqual(ids(MEAL_SLOTS), FIXED);
  assert.deepEqual(EXTRA_PERIODS.map(p => p.id), ['manana', 'tarde', 'noche']);
});

test('isExtraSlot / extraAnchorSlot', () => {
  assert.equal(isExtraSlot('extra_1'), true);
  assert.equal(isExtraSlot('extra_12'), true);
  assert.equal(isExtraSlot('extra_'), false);
  assert.equal(isExtraSlot('desayuno'), false);
  assert.equal(isExtraSlot(undefined), false);
  assert.equal(extraAnchorSlot('manana'), 'desayuno');
  assert.equal(extraAnchorSlot('tarde'), 'snack_tarde');
  assert.equal(extraAnchorSlot('noche'), 'snack_noche');
});

test('nextExtraId: first, next after the highest, ignores fixed slots', () => {
  assert.equal(nextExtraId([]), 'extra_1');
  assert.equal(nextExtraId(['desayuno', 'cena']), 'extra_1');
  assert.equal(nextExtraId(['extra_1', 'extra_2']), 'extra_3');
  assert.equal(nextExtraId(['extra_3', 'desayuno']), 'extra_4');
  assert.equal(nextExtraId(['extra_2', 'extra_10']), 'extra_11');
});

test('orderedDaySlots: no extras → the 5 fixed slots', () => {
  assert.deepEqual(ids(orderedDaySlots()), FIXED);
  assert.deepEqual(ids(orderedDaySlots([])), FIXED);
});

test('orderedDaySlots: each extra goes right after the fixed slot of its period', () => {
  const slots = orderedDaySlots([
    { id: 'extra_1', period: 'noche' },
    { id: 'extra_2', period: 'manana' },
    { id: 'extra_3', period: 'tarde' },
  ]);
  assert.deepEqual(ids(slots), [
    'desayuno', 'extra_2', 'almuerzo', 'snack_tarde', 'extra_3', 'cena', 'snack_noche', 'extra_1',
  ]);
  const extra = slots.find(s => s.id === 'extra_2');
  assert.equal(extra.isExtra, true);
  assert.equal(extra.label, 'Snack extra');
  assert.equal(extra.icon, EXTRA_PERIODS[0].icon);
});

test('orderedDaySlots: several extras in the same period are ordered by number', () => {
  const slots = orderedDaySlots([
    { id: 'extra_10', period: 'tarde' },
    { id: 'extra_2',  period: 'tarde' },
    { id: 'extra_2',  period: 'tarde' },   // duplicate ignored
  ]);
  assert.deepEqual(ids(slots), [
    'desayuno', 'almuerzo', 'snack_tarde', 'extra_2', 'extra_10', 'cena', 'snack_noche',
  ]);
});

test('orderedDaySlots: bare ids and unknown periods use the default period (tarde)', () => {
  assert.deepEqual(ids(orderedDaySlots(['extra_1'])).indexOf('extra_1'), 3);
  assert.equal(orderedDaySlots([{ id: 'extra_1', period: 'xx' }]).find(s => s.id === 'extra_1').period, 'tarde');
});

test('collectDayExtras: union of members extras (period from the meal) plus pending', () => {
  const extras = collectDayExtras(
    [
      { desayuno: { macros }, extra_1: { macros, slotPeriod: 'manana' } },
      { extra_1: { macros, slotPeriod: 'manana' }, extra_2: { macros, slotPeriod: 'noche' } },
      {},
    ],
    [{ id: 'extra_3', period: 'tarde' }, { id: 'extra_2', period: 'tarde' }],
  );
  assert.deepEqual(extras, [
    { id: 'extra_1', period: 'manana' },
    { id: 'extra_2', period: 'noche' },      // the stored meal wins over the pending one
    { id: 'extra_3', period: 'tarde' },
  ]);
  assert.deepEqual(collectDayExtras(), []);
});

test('computeDayMacros: extras count with their servings', () => {
  const day = {
    desayuno: { macros, servings: 1 },
    extra_1:  { macros, servings: 0.5, slotPeriod: 'manana' },
    extra_2:  { macros, servings: 2,   slotPeriod: 'noche' },
  };
  assert.equal(computeDayMacros(day).calorias, 700);      // 200 + 100 + 400
  assert.equal(computeDayMacros(day).proteina_g, 35);
});

test('shopping: extras are included like any other meal (Σ servings)', () => {
  // Same recipe in a fixed slot and in an extra, 2 persons each → 4 portions of a 4-portion recipe
  const day = {
    snack_tarde: withServings(cheesecake, 1),
    extra_1:     { ...withServings(cheesecake, 3), slotPeriod: 'tarde' },
  };
  assert.equal(qty(shop(Object.values(day)), 'Queso crema'), 400);   // 4 portions → 1 batch
  const more = [...Object.values(day), withServings(cheesecake, 1)];
  assert.equal(qty(shop(more), 'Queso crema'), 800);                  // 5 portions → 2 batches
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
