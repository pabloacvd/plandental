/**
 * planner.js — Auto-fill empty week slots with smart recipe selection.
 *
 * Rules:
 *  1. snack_tarde is ALWAYS filled with the Whey-isolate snack specific to each person
 *     (Pablo: 45 g · Juli: 30 g). The matching recipe is found dynamically from
 *     whatever recipes are loaded in the current environment.
 *  2. The remaining slots (desayuno, almuerzo, cena, snack_noche) are filled from
 *     available recipes using a loose knapsack that:
 *       - favours variety (avoids repeating the same recipe in the same week)
 *       - keeps running daily totals close to targets without obsessing over 100%
 *  3. Only EMPTY slots are touched — already-assigned meals are preserved.
 */

import { getAllRecipes, getNutrition } from './recipes.js';
import { getWeekDays, toDateKey, toWeekKey, MEAL_SLOTS } from './calendar.js';

// ── Whey-isolate snack detection ────────────────────────────────────────────

const WHEY_INGREDIENT = 'whey isolate';

/**
 * Return the recipe id whose ingredient list contains "Whey isolate"
 * at the given target grams for the person.
 * Falls back to the first whey recipe found if no exact gram match exists.
 *
 * @param {'Pablo'|'Juli'} person
 * @returns {string|null} recipe id or null
 */
function findWheyRecipeFor(person) {
  const nutrition = getNutrition(person);
  const targetG   = nutrition?.whey_g ?? (person === 'Pablo' ? 45 : 30);

  const allRecipes = getAllRecipes();
  let fallback = null;

  for (const recipe of allRecipes) {
    const wheyIng = recipe.receta.ingredientes?.find(
      ing => ing.item?.toLowerCase().includes(WHEY_INGREDIENT)
    );
    if (!wheyIng) continue;

    if (!fallback) fallback = recipe.id;

    if (Number(wheyIng.cantidad) === targetG) {
      return recipe.id;
    }
  }
  return fallback;
}

// ── Slot → category mapping ──────────────────────────────────────────────────

/**
 * Which recipe categories are acceptable for each slot.
 * The strings are matched with `includes()` against recipe.receta.categoria.
 */
const SLOT_CATEGORY_MAP = {
  desayuno:    ['desayuno'],
  almuerzo:    ['almuerzo', 'cena'],
  snack_tarde: ['snack'],
  cena:        ['almuerzo', 'cena'],
  snack_noche: ['snack', 'desayuno', 'almuerzo', 'cena'], // any if nothing else fits
};

/**
 * Return all recipes whose category matches the given slot.
 * For snack_tarde this should be called only when we can't find a whey snack
 * (safety net — normally it's filled by findWheyRecipeFor).
 */
function recipesForSlot(slotId, excludeIds = []) {
  const accepted = SLOT_CATEGORY_MAP[slotId] ?? ['almuerzo', 'cena'];
  return getAllRecipes().filter(r => {
    if (excludeIds.includes(r.id)) return false;
    const cat = (r.receta.categoria ?? '').toLowerCase();
    return accepted.some(a => cat.includes(a));
  });
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a recipe candidate for a given slot given already-accumulated macros
 * and the person's daily targets.
 *
 * Lower score = better fit.
 * We penalise going significantly over target on any macro.
 * We reward protein contribution.
 *
 * @param {object} recipe    full recipe object { id, receta }
 * @param {object} current   accumulated macros so far { calorias, proteina_g, … }
 * @param {object} targets   { daily_calories_kcal, protein_g, carbs_g, fat_g }
 * @param {Set}    weekUsed  recipe ids already used this week for this person
 * @returns {number}
 */
function scoreRecipe(recipe, current, targets, weekUsed) {
  const m = recipe.receta.macros_por_porcion ?? {};
  const afterCal  = current.calorias          + (m.calorias          ?? 0);
  const afterProt = current.proteina_g        + (m.proteina_g        ?? 0);
  const afterCarb = current.carbohidratos_g   + (m.carbohidratos_g   ?? 0);
  const afterFat  = current.grasas_g          + (m.grasas_g          ?? 0);

  const tCal  = targets.daily_calories_kcal ?? 2000;
  const tProt = targets.protein_g           ?? 150;
  const tCarb = targets.carbs_g             ?? 200;
  const tFat  = targets.fat_g               ?? 60;

  // Penalty for overshooting (heavier weight on calories)
  const overCal  = Math.max(0, afterCal  - tCal)  / tCal;
  const overProt = Math.max(0, afterProt - tProt)  / tProt;
  const overCarb = Math.max(0, afterCarb - tCarb)  / tCarb;
  const overFat  = Math.max(0, afterFat  - tFat)   / tFat;

  let score = overCal * 2 + overProt + overCarb + overFat;

  // Small bonus for protein density
  const protBonus = -(m.proteina_g ?? 0) / Math.max(1, m.calorias ?? 1) * 0.5;
  score += protBonus;

  // Variety penalty: strongly prefer recipes not already used this week
  if (weekUsed.has(recipe.id)) score += 3;

  return score;
}

// ── Core planner ─────────────────────────────────────────────────────────────

/**
 * Build a meal entry object (same shape as assignMeal writes to plan).
 */
function mealEntry(recipeId) {
  const recipe = getAllRecipes().find(r => r.id === recipeId);
  if (!recipe) return null;
  const { receta } = recipe;
  return {
    recipeId,
    recipeName: receta.nombre,
    macros: { ...receta.macros_por_porcion },
  };
}

/**
 * Return accumulated macros for a single person on a given day.
 */
function accumulatedMacros(dayEntry) {
  const totals = { calorias: 0, proteina_g: 0, carbohidratos_g: 0, grasas_g: 0 };
  if (!dayEntry) return totals;
  for (const meal of Object.values(dayEntry)) {
    if (!meal?.macros) continue;
    totals.calorias          += meal.macros.calorias          ?? 0;
    totals.proteina_g        += meal.macros.proteina_g        ?? 0;
    totals.carbohidratos_g   += meal.macros.carbohidratos_g   ?? 0;
    totals.grasas_g          += meal.macros.grasas_g          ?? 0;
  }
  return totals;
}

/**
 * Pick the best recipe for a slot from a candidate list.
 *
 * @param {string}  slotId
 * @param {object}  current   accumulated macros already planned for the day (per person)
 * @param {object}  targets   nutrition targets for the person
 * @param {Set}     weekUsed  recipe ids used this week for this person
 * @param {string[]}exclude   ids to skip (e.g. the whey snack)
 * @returns {string|null} best recipe id
 */
function pickBest(slotId, current, targets, weekUsed, exclude = []) {
  const candidates = recipesForSlot(slotId, exclude);
  if (!candidates.length) return null;

  let best = null;
  let bestScore = Infinity;

  for (const r of candidates) {
    const s = scoreRecipe(r, current, targets, weekUsed);
    if (s < bestScore) {
      bestScore = s;
      best = r.id;
    }
  }
  return best;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fill empty slots for the current week in `plan` (mutates it in-place).
 *
 * @param {object}   plan        The full plan object (state.plan)
 * @param {Date}     anchorDate  Any date within the target week
 * @returns {object}  The mutated plan (same reference)
 */
export function autoFillWeek(plan, anchorDate) {
  const weekDays = getWeekDays(anchorDate);
  const weekKey  = toWeekKey(anchorDate);

  const persons  = ['Pablo', 'Juli'];
  const slots    = MEAL_SLOTS.map(s => s.id);

  // Find each person's whey snack recipe once
  const wheyRecipeId = {
    Pablo: findWheyRecipeFor('Pablo'),
    Juli:  findWheyRecipeFor('Juli'),
  };

  // Track which recipe ids were used this week, per person (for variety)
  const weekUsed = {
    Pablo: new Set(),
    Juli:  new Set(),
  };

  // Seed weekUsed with what's already planned
  for (const person of persons) {
    const personPlan = plan[person]?.[weekKey] ?? {};
    for (const dayEntry of Object.values(personPlan)) {
      for (const meal of Object.values(dayEntry)) {
        if (meal?.recipeId) weekUsed[person].add(meal.recipeId);
      }
    }
  }

  for (const day of weekDays) {
    const dateKey = toDateKey(day);

    for (const person of persons) {
      // Ensure nested structure exists
      if (!plan[person])                   plan[person] = {};
      if (!plan[person][weekKey])          plan[person][weekKey] = {};
      if (!plan[person][weekKey][dateKey]) plan[person][weekKey][dateKey] = {};

      const dayEntry = plan[person][weekKey][dateKey];
      const targets  = getNutrition(person) ?? {};

      for (const slotId of slots) {
        // Skip if already filled
        if (dayEntry[slotId]) continue;

        let recipeId;

        if (slotId === 'snack_tarde') {
          // Always use the whey snack for this person
          recipeId = wheyRecipeId[person];
        } else {
          // Compute accumulated macros considering meals already set (including
          // whey snack we may have just written for snack_tarde)
          const current = accumulatedMacros(dayEntry);
          const exclude = wheyRecipeId[person] ? [wheyRecipeId[person]] : [];
          recipeId = pickBest(slotId, current, targets, weekUsed[person], exclude);
        }

        if (!recipeId) continue;

        const entry = mealEntry(recipeId);
        if (!entry) continue;

        dayEntry[slotId] = entry;
        weekUsed[person].add(recipeId);
      }
    }
  }

  return plan;
}
