/**
 * storage.js — Supabase persistence layer
 *
 * Drop-in replacement for the former GitHub API + localStorage layer.
 * Exports the same public API surface so app.js / recipes.js need
 * minimal changes.
 *
 * Auth model:
 *   The user-facing login field is always "username".
 *   Internally, Supabase Auth stores the identity as <username>@app.local.
 *   The helper usernameToEmail() performs that mapping transparently.
 *
 * Data model:
 *   Plans      → public.plans        (one row per person/date/slot)
 *   Recipes    → public.recipes      (shared catalog)
 *   Nutrition  → public.nutrition_data
 *   Persons    → public.persons + public.person_access
 */

import { supabase } from './supabase.js';

// ── Auth ──────────────────────────────────────────────────────

/** Map display username → internal Supabase Auth email */
function usernameToEmail(username) {
  return `${username.toLowerCase().trim()}@app.local`;
}

/**
 * Sign in with username + password.
 * Throws on failure so callers can show the error message.
 */
export async function signIn(username, password) {
  const email = usernameToEmail(username);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.session;
}

/** Sign out the current session. */
export async function signOut() {
  await supabase.auth.signOut();
}

/**
 * Return the current session, or null if not authenticated.
 * Uses the v2 async API — supabase.auth.session() was removed in v2.
 */
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session ?? null;
}

/** True if a valid session exists. */
export async function isAuthenticated() {
  const session = await getSession();
  return !!session?.access_token;
}

/**
 * Return the current user's profile from public.profiles.
 * Accepts the auth user object from the session to skip an extra network round-trip.
 * Falls back to a synthetic profile built from auth metadata if the DB row is missing.
 * Returns null if not authenticated at all.
 *
 * @param {object} [authUser] — user object from supabase.auth.onAuthStateChange session
 */
export async function getMyProfile(authUser) {
  // Prefer the already-resolved user from the session; fall back to a network call.
  let user = authUser;
  if (!user) {
    const { data, error: uErr } = await supabase.auth.getUser();
    if (uErr || !data?.user) return null;
    user = data.user;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, role')
    .eq('id', user.id)
    .single();

  if (error || !data) {
    console.warn('getMyProfile:', error ? error.message : 'No profile data returned');
    // Return a synthetic profile so the UI always shows something after login.
    const fallbackUsername =
      user.user_metadata?.username ||
      user.user_metadata?.full_name ||
      (user.email ? user.email.split('@')[0] : null) ||
      'usuario';
    return { id: user.id, username: fallbackUsername, role: 'user' };
  }
  return data;
}

// ── Persons & access ─────────────────────────────────────────

/**
 * Fetch all persons the current user has approved access to.
 * Returns array of { id, name, owner_id }.
 */
export async function getMyPersons() {
  const { data, error } = await supabase
    .from('person_access')
    .select('person_id, status, persons(id, name, owner_id)')
    .eq('status', 'approved');

  if (error) { console.warn('getMyPersons:', error.message); return []; }
  return (data || []).map(row => row.persons).filter(Boolean);
}

/**
 * Return the familia_flag for the current user.
 * { show_familia: boolean, approved_count: number }
 */
export async function getFamiliaFlag(authUser) {
  let user = authUser;
  if (!user) {
    const { data } = await supabase.auth.getUser();
    user = data?.user;
  }
  if (!user) return { show_familia: false, approved_count: 0 };

  const { data, error } = await supabase
    .from('familia_flag')
    .select('show_familia, approved_count')
    .eq('profile_id', user.id)
    .maybeSingle();

  if (error) { console.warn('getFamiliaFlag:', error.message); }
  return data ?? { show_familia: false, approved_count: 0 };
}

/**
 * Create a new person and grant the caller immediate approved access.
 * Returns the new person_id (uuid).
 */
export async function createPerson(name) {
  const { data, error } = await supabase.rpc('create_person_with_access', {
    p_name: name,
  });
  if (error) throw new Error(error.message);
  return data; // uuid
}

/**
 * Request access to an existing person (creates a 'pending' record).
 * Returns the new person_access id.
 */
export async function requestPersonAccess(personId) {
  const { data, error } = await supabase.rpc('request_person_access', {
    p_person_id: personId,
  });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Approve an incoming access request (the caller must be granted_to).
 */
export async function approvePersonAccess(accessId) {
  const { error } = await supabase.rpc('approve_person_access', {
    p_access_id: accessId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Reject / cancel an access request.
 */
export async function rejectPersonAccess(accessId) {
  const { error } = await supabase.rpc('reject_person_access', {
    p_access_id: accessId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Fetch pending incoming access requests for the current user
 * (i.e., someone wants access to one of the caller's persons).
 */
export async function getPendingAccessRequests() {
  const { data, error } = await supabase
    .from('person_access')
    .select('id, person_id, granted_to, status, created_at, persons(name), profiles!person_access_granted_to_fkey(username)')
    .eq('status', 'pending');

  if (error) { console.warn('getPendingAccessRequests:', error.message); return []; }
  return data || [];
}

// ── Plan ─────────────────────────────────────────────────────

/**
 * Fetch the full plan for all accessible persons and return it in
 * the legacy nested format expected by the rest of the app:
 *
 *   {
 *     "Pablo": { "2025-W27": { "2025-07-07": { "desayuno": { recipeId, recipeName, macros } } } },
 *     "Juli":  { ... }
 *   }
 *
 * Falls back to an empty object on error.
 */
export async function fetchPlan() {
  const persons = await getMyPersons();
  if (!persons.length) return {};

  const personIds = persons.map(p => p.id);

  const { data, error } = await supabase
    .from('plans')
    .select('person_id, date_key, week_key, slot_id, recipe_id, recipe_name, macros')
    .in('person_id', personIds);

  if (error) {
    console.warn('fetchPlan:', error.message);
    return {};
  }

  // Build the legacy nested structure
  const plan = {};
  const personById = Object.fromEntries(persons.map(p => [p.id, p.name]));

  for (const row of (data || [])) {
    const personName = personById[row.person_id];
    if (!personName) continue;

    plan[personName]                                          ??= {};
    plan[personName][row.week_key]                            ??= {};
    plan[personName][row.week_key][row.date_key]              ??= {};
    plan[personName][row.week_key][row.date_key][row.slot_id]  = {
      recipeId:   row.recipe_id,
      recipeName: row.recipe_name,
      macros:     row.macros,
    };
  }

  return plan;
}

/**
 * Save the full plan object to Supabase.
 * Accepts the same nested format fetchPlan() returns.
 * Uses upsert to safely overwrite or insert.
 *
 * personNameToId is a map { "Pablo": uuid, "Juli": uuid } built at
 * runtime from the persons list so we can resolve the FK correctly.
 */
export async function savePlan(plan, personNameToId) {
  const rows = [];

  for (const [personName, weekMap] of Object.entries(plan)) {
    const personId = personNameToId?.[personName];
    if (!personId) {
      console.warn(`savePlan: no person_id found for "${personName}" — skipping`);
      continue;
    }

    for (const [weekKey, dayMap] of Object.entries(weekMap)) {
      for (const [dateKey, slotMap] of Object.entries(dayMap)) {
        for (const [slotId, meal] of Object.entries(slotMap)) {
          if (!meal?.recipeId) continue;
          rows.push({
            person_id:   personId,
            date_key:    dateKey,
            week_key:    weekKey,
            slot_id:     slotId,
            recipe_id:   meal.recipeId,
            recipe_name: meal.recipeName || '',
            macros:      meal.macros     || {},
            updated_at:  new Date().toISOString(),
          });
        }
      }
    }
  }

  if (!rows.length) return { saved: 'supabase' };

  // Upsert in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('plans')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'person_id,date_key,slot_id' });
    if (error) throw new Error(error.message);
  }

  return { saved: 'supabase' };
}

/**
 * Remove a single meal slot from Supabase.
 * personNameToId: { "Pablo": uuid, ... }
 */
export async function removePlanEntry(personName, dateKey, slotId, personNameToId) {
  const personId = personNameToId?.[personName];
  if (!personId) throw new Error(`No person_id for "${personName}"`);

  const { error } = await supabase
    .from('plans')
    .delete()
    .eq('person_id', personId)
    .eq('date_key',  dateKey)
    .eq('slot_id',   slotId);

  if (error) throw new Error(error.message);
}

// ── Recipes ───────────────────────────────────────────────────

/**
 * Fetch all recipes from Supabase.
 * Returns array in the legacy format: [{ id, receta }, …]
 */
export async function fetchRecipes() {
  const { data, error } = await supabase
    .from('recipes')
    .select('id, receta')
    .order('nombre');

  if (error) {
    console.warn('fetchRecipes:', error.message);
    return null;
  }
  // Wrap in { recetas: [...] } to match the legacy format recipes.js expects
  return { recetas: (data || []).map(r => ({ id: r.id, receta: r.receta })) };
}

/**
 * Save (upsert) a single recipe to Supabase.
 */
export async function saveRecipe(recipeObj) {
  const { id, receta } = recipeObj;
  const { error } = await supabase
    .from('recipes')
    .upsert({
      id,
      nombre:    receta.nombre    || '',
      categoria: receta.categoria || null,
      receta,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (error) throw new Error(error.message);
}

/**
 * Save the entire recipes array to Supabase.
 * Legacy interface kept for compatibility with app.js → saveRecipes().
 */
export async function saveRecipes(recipesArray) {
  for (const recipe of recipesArray) {
    await saveRecipe(recipe);
  }
  return { saved: 'supabase' };
}

/**
 * Delete a recipe by id.
 */
export async function deleteRecipeFromDB(id) {
  const { error } = await supabase
    .from('recipes')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Nutrition data ────────────────────────────────────────────

/**
 * Fetch nutrition data for all accessible persons.
 * Returns the legacy format: { "Pablo": { bmr_kcal, …, body_composition: … }, … }
 */
export async function fetchNutrition() {
  const persons = await getMyPersons();
  if (!persons.length) return {};

  const personIds  = persons.map(p => p.id);
  const personById = Object.fromEntries(persons.map(p => [p.id, p.name]));

  const { data, error } = await supabase
    .from('nutrition_data')
    .select('*')
    .in('person_id', personIds);

  if (error) {
    console.warn('fetchNutrition:', error.message);
    return {};
  }

  const result = {};
  for (const row of (data || [])) {
    const name = personById[row.person_id];
    if (!name) continue;
    // Spread the flat columns back onto the data blob so existing
    // code that reads nutrition.bmr_kcal, nutrition.protein_g etc. still works.
    result[name] = {
      bmr_kcal:           row.bmr_kcal,
      daily_calories_kcal: row.daily_calories_kcal,
      protein_g:          row.protein_g,
      carbs_g:            row.carbs_g,
      fat_g:              row.fat_g,
      creatine_g:         row.creatine_g,
      whey_g:             row.whey_g,
      whey_purity_percent: row.whey_purity_percent,
      notes:              row.notes,
      ...(row.data || {}),  // body_composition, weight_loss_projection, etc.
    };
  }
  return result;
}

// ── Default Week ─────────────────────────────────────────────

/**
 * Fetch the default week template for all accessible persons.
 * Returns { personName: { dayIndex: { slotId: { recipeId, recipeName, macros } } } }
 * dayIndex is 0 (Monday) … 6 (Sunday).
 */
export async function fetchDefaultWeek() {
  const persons = await getMyPersons();
  if (!persons.length) return {};

  const personIds  = persons.map(p => p.id);
  const personById = Object.fromEntries(persons.map(p => [p.id, p.name]));

  const { data, error } = await supabase
    .from('default_week')
    .select('person_id, day_index, slot_id, recipe_id, recipe_name, macros')
    .in('person_id', personIds);

  if (error) {
    console.warn('fetchDefaultWeek:', error.message);
    return {};
  }

  const result = {};
  for (const row of (data || [])) {
    const personName = personById[row.person_id];
    if (!personName) continue;
    result[personName]                           ??= {};
    result[personName][row.day_index]            ??= {};
    result[personName][row.day_index][row.slot_id] = {
      recipeId:   row.recipe_id,
      recipeName: row.recipe_name,
      macros:     row.macros,
    };
  }
  return result;
}

/**
 * Save the current week as the default week template for the given persons.
 * weekData: { dayIndex: { slotId: { recipeId, recipeName, macros } } }
 * personNames: string[]
 * personNameToId: { name: uuid }
 */
export async function saveDefaultWeek(weekData, personNames, personNameToId) {
  const rows = [];

  for (const personName of personNames) {
    const personId = personNameToId?.[personName];
    if (!personId) continue;

    for (const [dayIndex, slotMap] of Object.entries(weekData)) {
      for (const [slotId, meal] of Object.entries(slotMap)) {
        if (!meal?.recipeId) continue;
        rows.push({
          person_id:   personId,
          day_index:   Number(dayIndex),
          slot_id:     slotId,
          recipe_id:   meal.recipeId,
          recipe_name: meal.recipeName || '',
          macros:      meal.macros     || {},
          updated_at:  new Date().toISOString(),
        });
      }
    }
  }

  if (!rows.length) return;

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('default_week')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'person_id,day_index,slot_id' });
    if (error) throw new Error(error.message);
  }
}

/**
 * Remove all default week entries for the given persons.
 * Used before a full overwrite so stale slots are cleared.
 */
export async function clearDefaultWeek(personNames, personNameToId) {
  for (const personName of personNames) {
    const personId = personNameToId?.[personName];
    if (!personId) continue;
    const { error } = await supabase
      .from('default_week')
      .delete()
      .eq('person_id', personId);
    if (error) throw new Error(error.message);
  }
}

// ── Ingredients ───────────────────────────────────────────────

/**
 * Fetch all ingredients visible to the current user.
 *
 * Authenticated  → queries public.ingredients via Supabase RLS.
 *                  Returns own rows + any rows owned by users who
 *                  share approved person_access with the caller.
 * Unauthenticated → falls back to data/ingredients.json (static
 *                  seed file served alongside the app), or [] if
 *                  the file is not yet present.
 *
 * @returns {Promise<Array>} Array of ingredient objects.
 */
export async function fetchIngredients() {
  const session = await getSession();

  if (session) {
    const { data, error } = await supabase
      .from('ingredients')
      .select('id, owner_id, nombre, categoria, unidad_referencia, cantidad_referencia, calorias, proteina_g, carbohidratos_g, grasas_g, created_at, updated_at')
      .order('nombre');

    if (error) {
      console.warn('fetchIngredients (supabase):', error.message);
      return [];
    }
    return data ?? [];
  }

  // Unauthenticated fallback: load from static JSON seed file.
  try {
    const res = await fetch('./data/ingredients.json');
    if (!res.ok) return [];
    const json = await res.json();
    // Accept either a plain array or { ingredientes: [...] }
    return Array.isArray(json) ? json : (json.ingredientes ?? []);
  } catch (err) {
    console.warn('fetchIngredients (local):', err.message);
    return [];
  }
}

/**
 * Save (upsert) a single ingredient to Supabase.
 *
 * Authenticated  → upserts into public.ingredients.
 *                  owner_id is set to the current user's id;
 *                  passing a different owner_id is ignored unless
 *                  the caller is an admin (enforced by RLS).
 * Unauthenticated → no-op; returns the object unchanged so
 *                  callers can still work in offline mode.
 *
 * @param {object} ingObj — ingredient data (id is optional for new rows)
 * @returns {Promise<object>} The saved row as returned by Supabase.
 */
/**
 * Check if a string is a valid UUID.
 */
function _isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export async function saveIngredient(ingObj) {
  const session = await getSession();

  if (!session) {
    // Offline: caller is responsible for persisting locally.
    return ingObj;
  }

  const { data: { user } } = await supabase.auth.getUser();

  const row = {
    nombre:              ingObj.nombre              ?? '',
    categoria:           ingObj.categoria           ?? null,
    unidad_referencia:   ingObj.unidad_referencia   ?? 'g',
    cantidad_referencia: ingObj.cantidad_referencia ?? 100,
    calorias:            ingObj.calorias            ?? 0,
    proteina_g:          ingObj.proteina_g          ?? 0,
    carbohidratos_g:     ingObj.carbohidratos_g     ?? 0,
    grasas_g:            ingObj.grasas_g            ?? 0,
    owner_id:            ingObj.owner_id            ?? user.id,
    updated_at:          new Date().toISOString(),
  };

  // Only include id in the upsert if it's a valid UUID (server-generated).
  // Local slug IDs (e.g. "pollo") must NOT be sent — let Postgres generate the UUID.
  if (ingObj.id && _isUUID(ingObj.id)) row.id = ingObj.id;

  const { data, error } = await supabase
    .from('ingredients')
    .upsert(row, { onConflict: 'owner_id,nombre' })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Bulk-save an array of ingredients.
 * Calls saveIngredient() sequentially to respect RLS per-row checks.
 *
 * @param {Array} ingArray — array of ingredient objects
 * @returns {Promise<{ saved: number }>}
 */
export async function saveIngredients(ingArray) {
  for (const ing of ingArray) {
    await saveIngredient(ing);
  }
  return { saved: ingArray.length };
}

/**
 * Delete an ingredient by id.
 *
 * Authenticated  → deletes from Supabase (RLS enforces owner or admin).
 * Unauthenticated → no-op.
 *
 * @param {string} id — UUID of the ingredient to delete
 */
export async function deleteIngredient(id) {
  const session = await getSession();
  if (!session) return;

  const { error } = await supabase
    .from('ingredients')
    .delete()
    .eq('id', id);

  if (error) throw new Error(error.message);
}

// ── Legacy compatibility shims ────────────────────────────────
// app.js still calls getCredentials() / clearCredentials() /
// consumeTokenFromHash() in a few places. These stubs satisfy the
// import without breaking anything.

export function getCredentials()        { return {}; }
export function saveCredentials()       { /* no-op */ }
export function clearCredentials()      { signOut(); }
export function consumeTokenFromHash()  { /* no-op */ }
export function testConnection()        { return Promise.resolve(true); }
