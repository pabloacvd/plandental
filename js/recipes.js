/**
 * recipes.js — loads and searches the recipe catalog
 */

let _recipes = [];
let _nutrition = {};

/**
 * Replace the in-memory recipes array (called after add/delete to stay in sync).
 */
export function setRecipes(arr) {
  _recipes = arr;
}

/**
 * Generate a URL-safe id from a recipe name.
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function loadData() {
  const [recRes, nutRes] = await Promise.all([
    fetch('./data/recipes.json'),
    fetch('./data/nutrition.json'),
  ]);
  const recData = await recRes.json();
  const nutData = await nutRes.json();
  _recipes   = recData.recetas;
  _nutrition = nutData.nutrition;
  return { recipes: _recipes, nutrition: _nutrition };
}

export function getAllRecipes() {
  return _recipes;
}

export function getNutrition(person) {
  return _nutrition[person] || null;
}

/**
 * Search recipes by query across name, description and ingredients.
 * @param {string} query
 * @param {string} category — 'all' or a category substring
 */
export function searchRecipes(query = '', category = 'all') {
  const q = query.toLowerCase().trim();

  return _recipes.filter(({ receta }) => {
    // Category filter
    if (category !== 'all') {
      const cat = receta.categoria?.toLowerCase() || '';
      if (!cat.includes(category.toLowerCase())) return false;
    }

    // Text filter
    if (!q) return true;

    const nameMatch = receta.nombre?.toLowerCase().includes(q);
    const descMatch = receta.descripcion_breve?.toLowerCase().includes(q);
    const ingrMatch = receta.ingredientes?.some(
      ing => ing.item?.toLowerCase().includes(q)
    );

    return nameMatch || descMatch || ingrMatch;
  });
}

/**
 * Get a single recipe by its id.
 */
export function getRecipeById(id) {
  return _recipes.find(r => r.id === id) || null;
}

/**
 * Add a recipe object to the in-memory list.
 * Returns the updated array.
 */
export function addRecipe(recipeObj) {
  // Ensure unique id
  let id = recipeObj.id || slugify(recipeObj.receta.nombre);
  if (_recipes.find(r => r.id === id)) {
    id = id + '-' + Date.now();
  }
  const entry = { id, receta: recipeObj.receta };
  _recipes = [..._recipes, entry];
  return _recipes;
}

/**
 * Update an existing recipe in-place by id.
 * Returns the updated array.
 */
export function updateRecipe(id, recipeObj) {
  _recipes = _recipes.map(r =>
    r.id === id ? { id, receta: recipeObj.receta } : r
  );
  return _recipes;
}

/**
 * Delete a recipe by id.
 * Returns the updated array.
 */
export function deleteRecipe(id) {
  _recipes = _recipes.filter(r => r.id !== id);
  return _recipes;
}
