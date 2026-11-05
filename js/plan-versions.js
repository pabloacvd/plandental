/**
 * plan-versions.js — pure helpers for versioned plan meals.
 *
 * No DOM, no Supabase, no imports: importable from the browser and from
 * node (scripts/verify-recipe-versions.js).
 *
 * A plan meal looks like:
 *   { recipeId, recipeName, macros, recipeSnapshot? }
 * `recipeSnapshot` is a deep copy of the recipe's `receta` object as it was
 * when the meal was assigned. Legacy meals may not have it; every consumer
 * falls back to the current catalog recipe in that case.
 */

// ── Cloning ──────────────────────────────────────────────────────────────────

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Build a new plan meal from a catalog recipe { id, receta }.
 * Every call returns an independent copy (own snapshot, own macros), so
 * assigning to several persons never shares references between them.
 */
export function mealFromRecipe(recipe) {
  const snapshot = deepClone(recipe.receta);
  return {
    recipeId:       recipe.id,
    recipeName:     snapshot.nombre,
    macros:         { ...snapshot.macros_por_porcion },
    recipeSnapshot: snapshot,
  };
}

/**
 * Independent copy of an existing meal (used when applying the default week).
 * If the meal has no snapshot yet, one is generated from the current catalog
 * recipe (when it still exists); `macros` is never recomputed.
 */
export function copyMealForPlan(meal, getRecipeById) {
  const copy = deepClone(meal);
  if (!copy.recipeSnapshot && typeof getRecipeById === 'function') {
    const current = getRecipeById(copy.recipeId);
    if (current?.receta) copy.recipeSnapshot = deepClone(current.receta);
  }
  return copy;
}

// ── Fingerprints ─────────────────────────────────────────────────────────────

/** JSON with object keys sorted, so key order never changes the result. */
export function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(v => (v === undefined ? 'null' : canonicalStringify(v))).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const parts = Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort()
      .map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** Version fingerprint of a whole receta (name, macros, ingredients, steps…). */
export function versionFingerprint(receta) {
  return canonicalStringify(receta ?? null);
}

/**
 * Fingerprint used to group shopping batches: only what changes what you buy
 * and how many portions a batch yields.
 */
export function shoppingFingerprint(receta) {
  return canonicalStringify({
    ingredientes: receta?.ingredientes ?? [],
    porciones:    receta?.porciones || 1,
  });
}

/**
 * True when two plan meals are the same recipe in the same version.
 * Meals without a snapshot are only "the same" if neither has one.
 */
export function sameMealVersion(a, b) {
  if (!a || !b) return false;
  if (a.recipeId !== b.recipeId) return false;
  const sa = a.recipeSnapshot;
  const sb = b.recipeSnapshot;
  if (!sa && !sb) return true;
  if (!sa || !sb) return false;
  return versionFingerprint(sa) === versionFingerprint(sb);
}

// ── Resolving the receta behind a plan meal ──────────────────────────────────

/**
 * The receta to show for a plan meal: its snapshot, or (legacy meals / minimal
 * snapshots without ingredients) the current catalog recipe when it exists.
 */
export function resolveMealReceta(meal, getRecipeById) {
  const snap = meal?.recipeSnapshot;
  if (snap && Array.isArray(snap.ingredientes)) return snap;
  const current = meal?.recipeId ? getRecipeById?.(meal.recipeId) : null;
  return current?.receta ?? snap ?? null;
}

// ── Shopping list ────────────────────────────────────────────────────────────

/**
 * Aggregate ingredients for a list of consumed meals (1 meal = 1 portion).
 * Meals are grouped by (recipeId + shopping fingerprint of their version);
 * each group is cooked in its own batches: ceil(portionsConsumed / porciones).
 *
 * @param {object[]} meals  plan meals already de-duplicated by the caller
 * @param {object}   opts   { getRecipeById, isExcluded }
 * @returns {{name:string, qty:string, unit:string}[]}
 */
export function buildShoppingItems(meals, { getRecipeById, isExcluded = () => false } = {}) {
  const groups = new Map(); // key → { receta, consumed }

  for (const meal of meals) {
    if (!meal?.recipeId) continue;
    const receta = resolveMealReceta(meal, getRecipeById);
    if (!Array.isArray(receta?.ingredientes)) continue;

    const key = `${meal.recipeId}::${shoppingFingerprint(receta)}`;
    const group = groups.get(key);
    if (group) group.consumed += 1;
    else groups.set(key, { receta, consumed: 1 });
  }

  const agg = new Map(); // ingredient name → { name, qty, unit, rawQty }

  for (const { receta, consumed } of groups.values()) {
    const batches = Math.ceil(consumed / (receta.porciones || 1));

    for (const ing of receta.ingredientes) {
      if (!ing.item) continue;
      if (isExcluded(ing.item)) continue;

      const aggKey = ing.item.toLowerCase().trim();
      const parsed = parseFloat(ing.cantidad);
      const addQty = isNaN(parsed) ? 0 : parsed * batches;

      if (agg.has(aggKey)) {
        agg.get(aggKey).qty += addQty;
      } else {
        agg.set(aggKey, {
          name:   ing.item,
          qty:    addQty,
          unit:   ing.unidad ?? '',
          rawQty: ing.cantidad ?? '',
        });
      }
    }
  }

  return Array.from(agg.values()).map(e => ({
    name: e.name,
    qty:  e.qty > 0 ? String(e.qty) : e.rawQty,
    unit: e.unit,
  }));
}
