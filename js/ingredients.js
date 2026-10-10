/**
 * ingredients.js — in-memory catalog of ingredients with CRUD and macro calculations.
 *
 * Data shape:
 *   Each ingredient is a plain object with the following fields:
 *     id                 {string}  — URL-safe slug
 *     nombre             {string}  — display name
 *     categoria          {string|null}
 *     unidad_referencia  {string}  — 'g' | 'ml' | 'unidad'
 *     cantidad_referencia {number} — reference quantity (e.g. 100 for 100 g)
 *     calorias           {number}  — kcal per cantidad_referencia
 *     proteina_g         {number}  — g protein per cantidad_referencia
 *     carbohidratos_g    {number}  — g carbs per cantidad_referencia
 *     grasas_g           {number}  — g fat per cantidad_referencia
 *
 * The static seed file (data/ingredients.json) stores macros in a nested `macros`
 * sub-object. _normalise() flattens that shape so the rest of the module always
 * works with flat fields.
 */

import { fetchIngredients } from './storage.js';

/** @type {object[]} */
let _ingredients = [];

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Flatten a raw ingredient entry that may have a nested `macros` object into
 * the canonical flat shape used internally.
 * @param {object} raw
 * @returns {object}
 */
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

// ── ID generation ─────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe id slug from an ingredient name.
 * @param {string} name
 * @returns {string}
 */
export function slugifyIngredient(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load ingredients from Supabase (authenticated) or from the static JSON seed
 * (unauthenticated / fallback).  Populates the in-memory `_ingredients` array.
 *
 * fetchIngredients() in storage.js already handles the fallback to
 * data/ingredients.json when there is no active session.
 *
 * @returns {Promise<object[]>} The loaded ingredients array.
 */
export async function loadIngredients() {
  try {
    const raw = await fetchIngredients();
    _ingredients = raw.map(_normalise);
  } catch (err) {
    console.warn('loadIngredients: fetchIngredients failed, trying static JSON.', err.message);
    try {
      const res  = await fetch('./data/ingredients.json');
      const json = await res.json();
      const arr  = Array.isArray(json) ? json : (json.ingredientes ?? []);
      _ingredients = arr.map(_normalise);
    } catch (fallbackErr) {
      console.error('loadIngredients: static JSON fallback also failed.', fallbackErr.message);
      _ingredients = [];
    }
  }
  return _ingredients;
}

// ── Setters ───────────────────────────────────────────────────────────────────

/**
 * Replace the entire in-memory list (used after bulk operations or external sync).
 * @param {object[]} arr
 */
export function setIngredients(arr) {
  _ingredients = arr.map(_normalise);
}

// ── Getters ───────────────────────────────────────────────────────────────────

/** Return the full in-memory ingredients list. */
export function getAllIngredients() {
  return _ingredients;
}

/**
 * Find a single ingredient by its id.
 * @param {string} id
 * @returns {object|null}
 */
export function getIngredientById(id) {
  return _ingredients.find(i => i.id === id) ?? null;
}

/**
 * Find a single ingredient by its name (case-insensitive, accent-insensitive).
 * @param {string} name
 * @returns {object|null}
 */
export function getIngredientByName(name) {
  const slug = slugifyIngredient(name);
  return _ingredients.find(i => slugifyIngredient(i.nombre) === slug) ?? null;
}

/**
 * Search ingredients by a text query and/or category.
 * @param {string} [query='']  — partial match against nombre
 * @param {string} [category='all'] — exact match against categoria (or 'all')
 * @returns {object[]}
 */
export function searchIngredients(query = '', category = 'all') {
  const q = query.toLowerCase().trim();

  return _ingredients.filter(ing => {
    if (category !== 'all') {
      if ((ing.categoria ?? '').toLowerCase() !== category.toLowerCase()) return false;
    }
    if (!q) return true;
    return ing.nombre.toLowerCase().includes(q);
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Add a new ingredient to the in-memory list.
 * Generates a unique id from the name using `slugifyIngredient`.
 * @param {object} data  — ingredient fields (id is optional; generated if absent)
 * @returns {object} The newly added ingredient entry.
 */
export function addIngredient(data) {
  let id = data.id || slugifyIngredient(data.nombre ?? '');

  // Guarantee uniqueness by appending a timestamp suffix when there is a clash.
  if (_ingredients.find(i => i.id === id)) {
    id = `${id}-${Date.now()}`;
  }

  const entry = _normalise({ ...data, id });
  _ingredients = [..._ingredients, entry];
  return entry;
}

/**
 * Update an existing ingredient in-place by id.
 * @param {string} id
 * @param {object} data  — fields to merge into the existing entry
 * @returns {object} The updated ingredient entry.
 */
export function updateIngredient(id, data) {
  const updated = _normalise({ ...(_ingredients.find(i => i.id === id) ?? {}), ...data, id });
  _ingredients = _ingredients.map(i => i.id === id ? updated : i);
  return updated;
}

/**
 * Remove an ingredient from the in-memory list by id.
 * @param {string} id
 * @returns {object[]} Updated ingredients array.
 */
export function deleteIngredient(id) {
  _ingredients = _ingredients.filter(i => i.id !== id);
  return _ingredients;
}

// ── Macro calculations ────────────────────────────────────────────────────────

/**
 * Calculate the macro contribution of a single ingredient at a given quantity.
 *
 * The proportion is: (cantidad / ingredientObj.cantidad_referencia)
 * The unit parameter is informational — the caller should ensure `cantidad` is
 * expressed in the same unit as `ingredientObj.unidad_referencia`.
 *
 * @param {object} ingredientObj  — a normalised ingredient from this module
 * @param {number} cantidad       — quantity used in the recipe
 * @param {string} [unidad]       — unit label (ignored in computation, for reference)
 * @returns {{ calorias: number, proteina_g: number, carbohidratos_g: number, grasas_g: number }}
 */
export function calculateItemMacros(ingredientObj, cantidad, unidad) { // eslint-disable-line no-unused-vars
  const ref = ingredientObj.cantidad_referencia || 100;
  const ratio = (cantidad ?? 0) / ref;

  return {
    calorias:        round2(ingredientObj.calorias        * ratio),
    proteina_g:      round2(ingredientObj.proteina_g      * ratio),
    carbohidratos_g: round2(ingredientObj.carbohidratos_g * ratio),
    grasas_g:        round2(ingredientObj.grasas_g        * ratio),
  };
}

/**
 * Calculate total and per-serving macros for a recipe ingredient list.
 *
 * Each entry in `ingredientesList` must have:
 *   - item     {string}  — ingredient name (used to look up the catalog)
 *   - cantidad {number}
 *   - unidad   {string}
 *
 * Ingredients not found in the catalog contribute 0 to every macro.
 *
 * @param {object[]} ingredientesList  — recipe's ingredient rows
 * @param {number}   [porciones=1]     — number of servings
 * @returns {{
 *   total:    { calorias: number, proteina_g: number, carbohidratos_g: number, grasas_g: number },
 *   porcion:  { calorias: number, proteina_g: number, carbohidratos_g: number, grasas_g: number }
 * }}
 */
export function calculateRecipeMacros(ingredientesList, porciones = 1) {
  const ZERO = { calorias: 0, proteina_g: 0, carbohidratos_g: 0, grasas_g: 0 };

  const total = (ingredientesList ?? []).reduce((acc, row) => {
    const ing = getIngredientByName(row.item ?? '');
    if (!ing) return acc;

    const contrib = calculateItemMacros(ing, row.cantidad ?? 0, row.unidad);
    return {
      calorias:        acc.calorias        + contrib.calorias,
      proteina_g:      acc.proteina_g      + contrib.proteina_g,
      carbohidratos_g: acc.carbohidratos_g + contrib.carbohidratos_g,
      grasas_g:        acc.grasas_g        + contrib.grasas_g,
    };
  }, { ...ZERO });

  const n = porciones > 0 ? porciones : 1;
  const porcion = {
    calorias:        round2(total.calorias        / n),
    proteina_g:      round2(total.proteina_g      / n),
    carbohidratos_g: round2(total.carbohidratos_g / n),
    grasas_g:        round2(total.grasas_g        / n),
  };

  return { total, porcion };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}
