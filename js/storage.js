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
 * Returns null if not authenticated.
 */
export async function getMyProfile() {
  // Use getUser() — authoritative server-side check, not the cached session.
  const { data: { user }, error: uErr } = await supabase.auth.getUser();
  if (uErr || !user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, role')
    .eq('id', user.id)
    .single();

  if (error) { console.warn('getMyProfile:', error.message); return null; }
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
export async function getFamiliaFlag() {
  const { data: { user } } = await supabase.auth.getUser();
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

// ── Legacy compatibility shims ────────────────────────────────
// app.js still calls getCredentials() / clearCredentials() /
// consumeTokenFromHash() in a few places. These stubs satisfy the
// import without breaking anything.

export function getCredentials()        { return {}; }
export function saveCredentials()       { /* no-op */ }
export function clearCredentials()      { signOut(); }
export function consumeTokenFromHash()  { /* no-op */ }
export function testConnection()        { return Promise.resolve(true); }
