/**
 * app.js — main entry point, wires everything together
 */

import { loadData, searchRecipes, getRecipeById, addRecipe, updateRecipe, deleteRecipe, getAllRecipes, slugify } from './recipes.js';
import { autoFillWeek } from './planner.js';
import { mealFromRecipe, copyMealForPlan, resolveMealReceta, buildShoppingItems } from './plan-versions.js';
import { getWeekDays, toDateKey, toWeekKey, MEAL_SLOTS, MONTH_NAMES } from './calendar.js';
import {
  fetchPlan, savePlan, removePlanEntry,
  fetchDefaultWeek, saveDefaultWeek, clearDefaultWeek,
  signIn, signOut, isAuthenticated, getMyProfile, getMyPersons,
  fetchShoppingDeselected, saveShoppingDeselected,
  saveRecipes, deleteRecipeFromDB, consumeTokenFromHash,
  saveIngredient, deleteIngredient as deleteIngredientFromStorage,
  changePassword, adminCreateUser, adminResetPassword, adminListFamilies,
  fetchNutrition, saveNutritionProfile,
} from './storage.js';
import { supabase } from './supabase.js';
import {
  renderRecipeCard, renderRecipeDetail,
  renderCalendarGrid, updateKcalBars,
  renderDayDetail, renderDaySummary,
  renderIngredientsSidebar,
  showToast,
} from './ui.js';
import {
  searchIngredients, getIngredientById, getAllIngredients, getIngredientByName,
  addIngredient, updateIngredient, deleteIngredient as deleteIngredientLocal,
  calculateItemMacros, calculateRecipeMacros,
} from './ingredients.js';

// ══════════════════════════════════════════════════════════
// MOBILE DETECTION
// ══════════════════════════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 700;
}

// ══════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════

let state = {
  person:     'Familia',          // default person view
  anchorDate: new Date(),
  activeDay:  toDateKey(new Date()),
  plan:       {},
  defaultWeek: {},               // { personName: { dayIndex: { slotId: meal } } }
  nutrition:  {},
  recipes:    [],
  searchQuery:    '',
  searchCategory: 'all',
  draggingRecipeId: null,
  mobileDayIndex: null,
  // Supabase-specific: resolved at runtime
  persons:        [],          // [{ id, name, owner_id }]
  personNameToId: {},          // { "Pablo": uuid, "Juli": uuid, … }
  showFamilia:    false,       // true when the family has 2+ persons
  profile:        null,        // { id, username, role }
  // Family-wide shopping pre-selections (loaded once per login; null = not loaded yet)
  shoppingDeselectedDefaults: null,
  // Sidebar tabs
  sidebarTab:              'recipes',   // 'recipes' | 'ingredients'
  ingredientSearchCategory: 'all',
};

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════

async function init() {
  // Wire all controls once up-front. Elements inside #app-shell exist in
  // the DOM even while hidden, so getElementById works fine here.
  wireControls();

  // Show login gate immediately so the user never sees a blank screen
  // while we wait for the async auth state event below.
  showLoginGate();

  // Guard against re-entrant concurrent loadAppData() calls.
  // onAuthStateChange can fire multiple times in rapid succession
  // (INITIAL_SESSION + SIGNED_IN), so we only allow one load at a time.
  let loading = false;

  // onAuthStateChange is the single source of truth for auth state.
  // It fires INITIAL_SESSION (with a session) or SIGNED_OUT on page load,
  // then SIGNED_IN / SIGNED_OUT on subsequent auth actions.
  // We never call loadAppData() from anywhere else to avoid double-loads.
  //
  // Only react to SIGNED_OUT for the unauthenticated path. All other
  // null-session events (TOKEN_REFRESHED, INITIAL_SESSION with no session,
  // USER_UPDATED, etc.) are transient and must not hide the app shell while
  // loadAppData() is still in flight — that is what causes the "session
  // flicker" where the login gate flashes on a plain page refresh.
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (session) {
      if (loading) return;
      loading = true;
      try {
        await loadAppData(session.user);
      } finally {
        loading = false;
      }
    } else if (event === 'SIGNED_OUT') {
      // Drop per-family data so the next user on this browser never sees it.
      state.shoppingDeselectedDefaults = null;
      showLoginGate();
    }
  });
}

/**
 * Load all app data once the user is authenticated.
 * Called by onAuthStateChange — never called directly from init().
 * @param {object} [authUser] — the user object from the auth session (avoids a round-trip getUser() call)
 */
async function loadAppData(authUser) {
  // Resolve persons (limited to the user's family by RLS), profile and the
  // family's shopping pre-selections in parallel. Overwritten on every login,
  // so a user switch in the same browser always reloads the new family's list.
  const [persons, profile, shoppingDeselected] = await Promise.all([
    getMyPersons(),
    getMyProfile(authUser),
    fetchShoppingDeselected(),
  ]);

  // null = family has no saved row yet (or network error) → seed list.
  state.shoppingDeselectedDefaults = shoppingDeselected ?? SHOPPING_DESELECT_SEED.slice();

  state.persons        = persons;
  state.personNameToId = Object.fromEntries(persons.map(p => [p.name, p.id]));
  state.showFamilia    = persons.length >= 2;
  state.profile        = profile;

  // Default person selection:
  //  - If familia is available, default to Familia
  //  - Otherwise default to the first (and only) person name
  if (state.showFamilia) {
    state.person = 'Familia';
  } else if (persons.length) {
    state.person = persons[0].name;
  }

  // Load recipes, nutrition, plan, and default week template
  const { recipes, nutrition } = await loadData();
  state.recipes      = recipes;
  state.nutrition    = nutrition;
  state.plan         = await fetchPlan();
  state.defaultWeek  = await fetchDefaultWeek();

  // Show app, hide login gate
  hideLoginGate();
  renderPersonSwitcher();

  // Apply mobile defaults
  if (isMobile()) {
    document.getElementById('sidebar').classList.add('collapsed');
    const weekDays = getWeekDays(state.anchorDate);
    state.mobileDayIndex = weekDays.findIndex(d => toDateKey(d) === toDateKey(new Date()));
    if (state.mobileDayIndex < 0) state.mobileDayIndex = 0;
  }

  // Ensure sidebar tab visibility matches state (handles initial load and reloads)
  setSidebarTab(state.sidebarTab);

  renderWeek();
  updateAuthUI();

  // maintenance_kcal is mandatory: if any of the user's persons lacks it,
  // open "Mi cuenta" so the profile gets completed.
  const missing = personsMissingMaintenance();
  if (missing.length) {
    openAuthModal();
    showToast(`Completá los datos de ${missing.map(p => p.name).join(', ')}`, 'error');
  }
}

// ── Login gate ────────────────────────────────────────────────

function showLoginGate() {
  document.getElementById('login-gate').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

function hideLoginGate() {
  document.getElementById('login-gate').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
}

// ══════════════════════════════════════════════════════════
// WEEK RENDERING
// ══════════════════════════════════════════════════════════

/**
 * If the current week has no meals for any of the active persons,
 * pre-populate it from the default week template (in-memory only —
 * persisted only when the user actually edits a slot, just like any
 * other assignment). Returns true if defaults were applied.
 */
function applyDefaultWeekIfEmpty(weekDays, weekKey) {
  const personsToCheck = state.person === 'Familia'
    ? state.persons.map(p => p.name)
    : [state.person];

  // Check if every relevant person has zero slots this week
  const weekIsEmpty = personsToCheck.every(personName => {
    const weekData = state.plan?.[personName]?.[weekKey];
    return !weekData || Object.keys(weekData).length === 0;
  });

  if (!weekIsEmpty) return false;

  // Check that there is at least one default entry to apply
  const hasDefaults = personsToCheck.some(n => {
    const d = state.defaultWeek?.[n];
    return d && Object.keys(d).length > 0;
  });
  if (!hasDefaults) return false;

  // Copy default template into the plan (in-memory)
  for (const personName of personsToCheck) {
    const personDefaults = state.defaultWeek?.[personName];
    if (!personDefaults) continue;

    for (const [dayIndex, slotMap] of Object.entries(personDefaults)) {
      const dateKey = toDateKey(weekDays[Number(dayIndex)]);
      for (const [slotId, meal] of Object.entries(slotMap)) {
        // Independent copy incl. snapshot; legacy defaults without snapshot get
        // one generated from the current recipe (macros stay as stored).
        setDeep(state.plan, personName, weekKey, dateKey, slotId, copyMealForPlan(meal, getRecipeById));
      }
    }
  }
  return true;
}

function renderWeek() {
  const weekDays = getWeekDays(state.anchorDate);
  const weekKey  = toWeekKey(state.anchorDate);

  // Silently pre-fill empty weeks from the default week template
  applyDefaultWeekIfEmpty(weekDays, weekKey);

  // Update navigation label
  if (isMobile() && state.mobileDayIndex !== null) {
    const d = weekDays[state.mobileDayIndex];
    const { DAY_NAMES_SHORT: DNS, MONTH_NAMES: MN } = { DAY_NAMES_SHORT: ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'], MONTH_NAMES };
    document.getElementById('week-label').textContent =
      `${DNS[state.mobileDayIndex]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0,3)}`;
  } else {
    const mon = weekDays[0];
    const sun = weekDays[6];
    const sameMonth = mon.getMonth() === sun.getMonth();
    const label = sameMonth
      ? `${MONTH_NAMES[mon.getMonth()]} ${mon.getFullYear()}`
      : `${MONTH_NAMES[mon.getMonth()].slice(0,3)}–${MONTH_NAMES[sun.getMonth()].slice(0,3)} ${sun.getFullYear()}`;
    document.getElementById('week-label').textContent = label;
  }

  renderCalendarGrid({
    weekDays,
    planData:     state.plan,
    person:       state.person,
    weekKey,
    activeDay:    state.activeDay,
    onDayClick:   openDayDetail,
    onRemoveMeal: removeMeal,
    onDropDay:    (dateKey, recipeId) => handleDrop(dateKey, recipeId),
    onRecipeClick: openRecipeModal,
  });

  // Mobile: mark only the current day as visible
  if (isMobile() && state.mobileDayIndex !== null) {
    applyMobileDayVisibility(weekDays);
  }

  // For Familia, use Pablo's nutrition for the kcal bar (representative)
  const nutritionForBar = state.person === 'Familia'
    ? state.nutrition['Pablo']
    : state.nutrition[state.person];
  updateKcalBars(weekDays, state.plan, state.person, weekKey, nutritionForBar);

  // Always open the active day panel
  if (state.activeDay) {
    const panel = document.getElementById('day-detail');
    panel.classList.remove('hidden-panel');
    refreshDayDetail();
  }
}

/**
 * Mark only the mobile-current day cell as visible.
 * Sync state.activeDay to that day so the detail panel shows it.
 */
function applyMobileDayVisibility(weekDays) {
  const idx     = state.mobileDayIndex ?? 0;
  const dateKey = toDateKey(weekDays[idx]);
  state.activeDay = dateKey;

  document.querySelectorAll('.day-cell').forEach((cell, i) => {
    cell.classList.toggle('mobile-visible', i === idx);
  });
}

// ══════════════════════════════════════════════════════════
// SIDEBAR / SEARCH
// ══════════════════════════════════════════════════════════

function renderSidebar() {
  if (state.sidebarTab === 'ingredients') {
    _renderIngredientsSidebarPanel();
    return;
  }

  const results = searchRecipes(state.searchQuery, state.searchCategory);
  const list    = document.getElementById('recipe-list');
  list.innerHTML = '';

  if (results.length === 0) {
    list.innerHTML = '<p style="font-size:.8rem;color:var(--text-muted);padding:12px">Sin resultados.</p>';
    return;
  }

  results.forEach(recipe => {
    const card = renderRecipeCard(recipe);

    // Drag start
    card.addEventListener('dragstart', (e) => {
      state.draggingRecipeId = recipe.id;
      e.dataTransfer.setData('recipeId', recipe.id);
      card.classList.add('dragging');

      // Custom ghost
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = recipe.receta.nombre;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      setTimeout(() => ghost.remove(), 0);
    });

    card.addEventListener('dragend', () => {
      state.draggingRecipeId = null;
      card.classList.remove('dragging');
    });

    // On mobile: tapping the card body opens the slot picker directly (drag unavailable)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.recipe-card-info') || e.target.closest('.recipe-card-edit') || e.target.closest('.recipe-card-delete')) return;
      if (isMobile() && state.activeDay) {
        // Close sidebar first
        document.getElementById('sidebar').classList.add('collapsed');
        document.getElementById('sidebar-backdrop').classList.add('hidden');
        showSlotPickerForDrop(state.activeDay, recipe.id);
      }
    });

    // Info button
    card.querySelector('.recipe-card-info').addEventListener('click', (e) => {
      e.stopPropagation();
      openRecipeModal(recipe.id);
    });

    // Edit button
    card.querySelector('.recipe-card-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openRecipeEditorForEdit(recipe.id);
    });

    // Delete button
    card.querySelector('.recipe-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteRecipe(recipe.id, recipe.receta.nombre);
    });

    list.appendChild(card);
  });
}

function _renderIngredientsSidebarPanel() {
  // Catalog may have changed (add/edit/delete) — keep recipe editor in sync
  refreshIngredientsDatalist();
  _refreshRecipeEditorRows();

  const cat = state.ingredientSearchCategory;
  const q   = state.searchQuery;

  // Filter by search query and category
  const results = searchIngredients(q, cat);

  const container = document.getElementById('ingredients-sidebar-list');
  renderIngredientsSidebar(
    results,
    container,
    (ing) => openIngredientEditorForEdit(ing.id),
    (id)  => deleteIngredientHandler(id),
  );
}

// ══════════════════════════════════════════════════════════
// SIDEBAR TAB SWITCHING
// ══════════════════════════════════════════════════════════

function setSidebarTab(tab) {
  // Validate tab value
  if (tab !== 'recipes' && tab !== 'ingredients') {
    console.warn('setSidebarTab called with invalid tab:', tab);
    tab = 'recipes';
  }
  state.sidebarTab = tab;

  const isRecipes = tab === 'recipes';

  // Nav tab buttons
  document.querySelectorAll('.sidebar-nav-tab').forEach(btn => {
    const shouldBeActive = btn.dataset.sidebarTab === tab;
    btn.classList.toggle('active', shouldBeActive);
  });

  // Recipe list vs ingredient list visibility
  const recipeList = document.getElementById('recipe-list');
  const ingredientsList = document.getElementById('ingredients-sidebar-list');
  if (recipeList) recipeList.classList.toggle('hidden', !isRecipes);
  if (ingredientsList) ingredientsList.classList.toggle('hidden', isRecipes);

  // Filter chips visibility
  const filterChips = document.getElementById('filter-chips');
  const filterChipsIngredients = document.getElementById('filter-chips-ingredients');
  if (filterChips) filterChips.classList.toggle('hidden', !isRecipes);
  if (filterChipsIngredients) filterChipsIngredients.classList.toggle('hidden', isRecipes);

  // Title text and + button tooltip
  const titleEl  = document.getElementById('sidebar-title-text');
  const addBtn   = document.getElementById('btn-add-sidebar');
  if (titleEl) titleEl.textContent = isRecipes ? 'Recetas' : 'Ingredientes';
  if (addBtn) addBtn.title = isRecipes ? 'Nueva receta' : 'Nuevo ingrediente';

  // Reset search query and re-render
  const searchInput = document.getElementById('recipe-search');
  if (searchInput) searchInput.value = '';
  state.searchQuery = '';
  renderSidebar();
}

// ══════════════════════════════════════════════════════════
// INGREDIENT EDITOR MODAL
// ══════════════════════════════════════════════════════════

let _editingIngredientId = null;

function openIngredientEditor() {
  _editingIngredientId = null;
  _resetIngredientForm();
  document.getElementById('ingredient-editor-title').textContent = 'Nuevo ingrediente';
  document.getElementById('btn-delete-ingredient').classList.add('hidden');
  document.getElementById('modal-ingredient-editor').classList.remove('hidden');
  setIngredientEditorTab('form');
}

function openIngredientEditorForEdit(id) {
  const ing = getIngredientById(id);
  if (!ing) return;
  _editingIngredientId = id;
  _resetIngredientForm();

  document.getElementById('ing-nombre').value       = ing.nombre         || '';
  document.getElementById('ing-categoria').value    = ing.categoria      || '';
  document.getElementById('ing-unidad').value       = ing.unidad_referencia   || 'g';
  document.getElementById('ing-cantidad-ref').value = ing.cantidad_referencia ?? 100;
  document.getElementById('ing-cal').value          = ing.calorias        ?? '';
  document.getElementById('ing-prot').value         = ing.proteina_g      ?? '';
  document.getElementById('ing-carbs').value        = ing.carbohidratos_g ?? '';
  document.getElementById('ing-fat').value          = ing.grasas_g        ?? '';

  // Pre-fill JSON tab
  document.getElementById('ing-json').value = JSON.stringify(ing, null, 2);

  document.getElementById('ingredient-editor-title').textContent = 'Editar ingrediente';
  document.getElementById('btn-delete-ingredient').classList.remove('hidden');
  document.getElementById('modal-ingredient-editor').classList.remove('hidden');
  setIngredientEditorTab('form');
}

function closeIngredientEditor() {
  _editingIngredientId = null;
  document.getElementById('modal-ingredient-editor').classList.add('hidden');
}

function _resetIngredientForm() {
  document.getElementById('ing-nombre').value       = '';
  document.getElementById('ing-categoria').value    = '';
  document.getElementById('ing-unidad').value       = 'g';
  document.getElementById('ing-cantidad-ref').value = '100';
  document.getElementById('ing-cal').value          = '';
  document.getElementById('ing-prot').value         = '';
  document.getElementById('ing-carbs').value        = '';
  document.getElementById('ing-fat').value          = '';
  document.getElementById('ing-json').value         = '';
}

function setIngredientEditorTab(tab) {
  document.querySelectorAll('.ing-editor-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.ingTab === tab);
  });
  document.getElementById('ing-editor-tab-form').classList.toggle('hidden', tab !== 'form');
  document.getElementById('ing-editor-tab-json').classList.toggle('hidden', tab !== 'json');
}

function _collectIngredientFormData() {
  const nombre = document.getElementById('ing-nombre').value.trim();
  if (!nombre) return null;

  return {
    nombre,
    categoria:           document.getElementById('ing-categoria').value   || null,
    unidad_referencia:   document.getElementById('ing-unidad').value      || 'g',
    cantidad_referencia: parseFloat(document.getElementById('ing-cantidad-ref').value) || 100,
    calorias:            parseFloat(document.getElementById('ing-cal').value)   || 0,
    proteina_g:          parseFloat(document.getElementById('ing-prot').value)  || 0,
    carbohidratos_g:     parseFloat(document.getElementById('ing-carbs').value) || 0,
    grasas_g:            parseFloat(document.getElementById('ing-fat').value)   || 0,
  };
}

async function saveIngredientFromForm() {
  const data = _collectIngredientFormData();
  if (!data) {
    showToast('El nombre es obligatorio', 'error');
    return;
  }

  let saved;
  const isEditing = !!_editingIngredientId;

  if (isEditing) {
    saved = updateIngredient(_editingIngredientId, data);
  } else {
    saved = addIngredient(data);
  }

  closeIngredientEditor();
  _renderIngredientsSidebarPanel();

  try {
    const serverData = await saveIngredient(saved);
    // Sync local ingredient with server's UUID
    if (serverData && serverData.id && serverData.id !== saved.id) {
      updateIngredient(saved.id, { id: serverData.id });
    }
    showToast(isEditing ? '✅ Ingrediente actualizado' : '✅ Ingrediente guardado', 'success');
  } catch (e) {
    showToast('❌ Error al guardar: ' + e.message, 'error');
  }
}

async function saveIngredientFromJSON() {
  const raw = document.getElementById('ing-json').value.trim();
  if (!raw) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    showToast('JSON inválido', 'error');
    return;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (!entries.every(e => e.nombre)) {
    showToast('Cada ingrediente debe tener al menos "nombre"', 'error');
    return;
  }

  const isEditing = !!_editingIngredientId && entries.length === 1;
  const savedEntries = [];

  if (isEditing) {
    savedEntries.push(updateIngredient(_editingIngredientId, entries[0]));
  } else {
    for (const entry of entries) {
      savedEntries.push(addIngredient(entry));
    }
  }

  closeIngredientEditor();
  _renderIngredientsSidebarPanel();

  try {
    for (const saved of savedEntries) {
      const serverData = await saveIngredient(saved);
      // Sync local ingredient with server's UUID
      if (serverData && serverData.id && serverData.id !== saved.id) {
        updateIngredient(saved.id, { id: serverData.id });
      }
    }
    showToast(`✅ ${entries.length} ingrediente(s) guardado(s)`, 'success');
  } catch (e) {
    showToast('❌ Error al guardar: ' + e.message, 'error');
  }
}

function previewIngredientJSON() {
  const raw = document.getElementById('ing-json').value.trim();
  if (!raw) return;
  try {
    const p = JSON.parse(raw);
    document.getElementById('ing-json').value = JSON.stringify(p, null, 2);
    showToast('JSON válido ✓');
  } catch (e) {
    showToast('JSON inválido: ' + e.message, 'error');
  }
}

async function deleteIngredientHandler(id) {
  const ing = getIngredientById(id);
  const name = ing ? ing.nombre : id;
  if (!confirm(`¿Eliminar el ingrediente "${name}"?`)) return;

  deleteIngredientLocal(id);
  closeIngredientEditor();
  _renderIngredientsSidebarPanel();

  try {
    await deleteIngredientFromStorage(id);
    showToast('🗑 Ingrediente eliminado', 'success');
  } catch (e) {
    showToast('❌ Error al eliminar: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════
// MOBILE DAY NAVIGATION
// ══════════════════════════════════════════════════════════

function mobilePrevDay() {
  if (state.mobileDayIndex === null) return;
  if (state.mobileDayIndex > 0) {
    state.mobileDayIndex--;
  } else {
    // Go to previous week, land on Sunday (index 6)
    state.anchorDate = new Date(state.anchorDate);
    state.anchorDate.setDate(state.anchorDate.getDate() - 7);
    state.mobileDayIndex = 6;
  }
  renderWeek();
}

function mobileNextDay() {
  if (state.mobileDayIndex === null) return;
  if (state.mobileDayIndex < 6) {
    state.mobileDayIndex++;
  } else {
    // Go to next week, land on Monday (index 0)
    state.anchorDate = new Date(state.anchorDate);
    state.anchorDate.setDate(state.anchorDate.getDate() + 7);
    state.mobileDayIndex = 0;
  }
  renderWeek();
}

// ══════════════════════════════════════════════════════════
// DAY DETAIL PANEL
// ══════════════════════════════════════════════════════════

function openDayDetail(dateKey) {
  state.activeDay = dateKey;

  // Mark active cell
  document.querySelectorAll('.day-cell').forEach(c => {
    c.classList.toggle('active', c.dataset.dateKey === dateKey);
  });

  const panel = document.getElementById('day-detail');
  panel.classList.remove('hidden-panel');

  refreshDayDetail();
}

function refreshDayDetail() {
  if (!state.activeDay) return;

  const weekKey = toWeekKey(new Date(state.activeDay + 'T12:00:00'));

  if (state.person === 'Familia') {
    const pabloEntry = state.plan?.['Pablo']?.[weekKey]?.[state.activeDay] || {};
    const juliEntry  = state.plan?.['Juli']?.[weekKey]?.[state.activeDay]  || {};
    renderDayDetail({
      dateKey:      state.activeDay,
      dayEntry:     pabloEntry,   // still used for compat
      pabloEntry,
      juliEntry,
      nutrition:    null,
      nutritionAll: state.nutrition,
      person:       'Familia',
      onRemoveMeal: (dateKey, slotId, targetPerson) => removeMeal(dateKey, slotId, targetPerson),
      onAddMealToSlot: (slotId, recipeId, targetPerson) => {
        if (recipeId) {
          assignMealForPerson(state.activeDay, slotId, recipeId, targetPerson);
        } else {
          openSlotPickerForPerson(slotId, targetPerson);
        }
      },
    });
  } else {
    const dayEntry = state.plan?.[state.person]?.[weekKey]?.[state.activeDay] || {};
    renderDayDetail({
      dateKey:      state.activeDay,
      dayEntry,
      pabloEntry:   null,
      juliEntry:    null,
      nutrition:    state.nutrition[state.person],
      nutritionAll: state.nutrition,
      person:       state.person,
      onRemoveMeal: removeMeal,
      onAddMealToSlot: (slotId, recipeId) => {
        if (recipeId) {
          assignMeal(state.activeDay, slotId, recipeId);
        } else {
          openSlotPicker(slotId);
        }
      },
    });
  }
}

function closeDayDetail() {
  state.activeDay = null;
  document.getElementById('day-detail').classList.add('hidden-panel');
  document.querySelectorAll('.day-cell').forEach(c => c.classList.remove('active'));
}

// ══════════════════════════════════════════════════════════
// SLOT PICKER (when clicking + Agregar without a drag)
// ══════════════════════════════════════════════════════════

let _slotPickerCleanup = null;

function openSlotPicker(slotId, targetPerson = null) {
  const existing = document.querySelector('.slot-picker');
  if (existing) existing.remove();
  if (_slotPickerCleanup) { _slotPickerCleanup(); _slotPickerCleanup = null; }

  const picker = document.createElement('div');
  picker.className = 'slot-picker';

  const slotLabel = MEAL_SLOTS.find(s => s.id === slotId)?.label || slotId;
  const personLabel = targetPerson ? ` — ${targetPerson}` : '';
  const results = searchRecipes(state.searchQuery, state.searchCategory);

  picker.innerHTML = `<div class="slot-picker-title">Seleccionar para ${slotLabel}${personLabel}</div>`;

  results.slice(0, 30).forEach(recipe => {
    const item = document.createElement('div');
    item.className = 'slot-picker-item';
    item.textContent = recipe.receta.nombre;
    item.addEventListener('click', () => {
      if (targetPerson) {
        assignMealForPerson(state.activeDay, slotId, recipe.id, targetPerson);
      } else {
        assignMeal(state.activeDay, slotId, recipe.id);
      }
      picker.remove();
      _slotPickerCleanup = null;
    });
    picker.appendChild(item);
  });

  // Position near the slot card
  const slotCard = document.querySelector(`.slot-card[data-slot="${slotId}"]`);
  const rect = slotCard?.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.top  = (rect ? rect.bottom + 4 : 200) + 'px';
  picker.style.left = (rect ? rect.left : 200) + 'px';
  picker.style.maxHeight = '260px';
  picker.style.overflowY = 'auto';

  document.body.appendChild(picker);

  const dismiss = (e) => {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener('mousedown', dismiss);
      _slotPickerCleanup = null;
    }
  };
  document.addEventListener('mousedown', dismiss);
  _slotPickerCleanup = () => document.removeEventListener('mousedown', dismiss);
}

// ══════════════════════════════════════════════════════════
// MEAL OPERATIONS
// ══════════════════════════════════════════════════════════

/**
 * Called when a recipe is dropped onto a day cell (without slot context).
 * If the day detail is open for that day, show slot picker.
 * Otherwise open the day detail first, then prompt slot picker.
 */
function handleDrop(dateKey, recipeId) {
  if (state.activeDay !== dateKey) {
    openDayDetail(dateKey);
  }
  // Ask which slot
  showSlotPickerForDrop(dateKey, recipeId);
}

function showSlotPickerForDrop(dateKey, recipeId) {
  const recipe   = getRecipeById(recipeId);
  if (!recipe) return;

  const existing = document.querySelector('.slot-picker');
  if (existing) existing.remove();

  const picker = document.createElement('div');
  picker.className = 'slot-picker';
  picker.innerHTML = `<div class="slot-picker-title">¿En qué comida?<br><small style="font-weight:400;color:var(--text)">${recipe.receta.nombre}</small></div>`;

  MEAL_SLOTS.forEach(slot => {
    const item = document.createElement('div');
    item.className = 'slot-picker-item';
    item.innerHTML = `${slot.icon} ${slot.label}`;
    item.addEventListener('click', () => {
      assignMeal(dateKey, slot.id, recipeId);
      picker.remove();
    });
    picker.appendChild(item);
  });

  picker.style.top  = '50%';
  picker.style.left = '50%';
  picker.style.transform = 'translate(-50%,-50%)';
  picker.style.zIndex = '400';

  document.body.appendChild(picker);

  const dismiss = (e) => {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener('mousedown', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 50);
}

/**
 * Determine which persons to write when assigning.
 * Familia → all persons the user has approved access to.
 * Single-person mode → just that person.
 */
function personsToWrite() {
  if (state.person === 'Familia') return state.persons.map(p => p.name);
  return [state.person];
}

function setDeep(plan, person, weekKey, dateKey, slotId, value) {
  if (!plan[person])                  plan[person] = {};
  if (!plan[person][weekKey])         plan[person][weekKey] = {};
  if (!plan[person][weekKey][dateKey]) plan[person][weekKey][dateKey] = {};
  plan[person][weekKey][dateKey][slotId] = value;
}

async function assignMeal(dateKey, slotId, recipeId) {
  const recipe = getRecipeById(recipeId);
  if (!recipe) return;

  const weekKey = toWeekKey(new Date(dateKey + 'T12:00:00'));

  // Each person gets an independent copy of the recipe version (snapshot).
  for (const p of personsToWrite()) {
    setDeep(state.plan, p, weekKey, dateKey, slotId, mealFromRecipe(recipe));
  }

  renderWeek();
  if (state.activeDay === dateKey) refreshDayDetail();

  try {
    await savePlan(state.plan, state.personNameToId);
    const names = personsToWrite();
    const extra  = names.length > 1 ? ` (${names.join(' + ')})` : '';
    showToast(`✅ Guardado${extra}`, 'success');
  } catch (e) {
    showToast('❌ Error al guardar: ' + e.message, 'error');
  }
}

async function removeMeal(dateKey, slotId, targetPerson = null) {
  const weekKey = toWeekKey(new Date(dateKey + 'T12:00:00'));
  // If targetPerson is given (family individual remove), only remove for that person.
  // Otherwise use personsToWrite() which respects the current state.person.
  const persons = targetPerson ? [targetPerson] : personsToWrite();

  // Remove from local state
  for (const p of persons) {
    const entry = state.plan?.[p]?.[weekKey]?.[dateKey];
    if (!entry) continue;
    delete entry[slotId];
    if (Object.keys(entry).length === 0) {
      delete state.plan[p][weekKey][dateKey];
    }
  }

  renderWeek();
  if (state.activeDay === dateKey) refreshDayDetail();

  try {
    // Delete each slot row from Supabase individually
    for (const p of persons) {
      await removePlanEntry(p, dateKey, slotId, state.personNameToId);
    }
    showToast('✅ Eliminado', 'success');
  } catch (e) {
    showToast('❌ Error al eliminar: ' + e.message, 'error');
  }
}

/**
 * Assign a meal to a single specific person (used in Familia mode per-person slots).
 */
async function assignMealForPerson(dateKey, slotId, recipeId, targetPerson) {
  const recipe = getRecipeById(recipeId);
  if (!recipe) return;
  const weekKey  = toWeekKey(new Date(dateKey + 'T12:00:00'));
  const persons  = targetPerson ? [targetPerson] : state.persons.map(p => p.name);
  for (const p of persons) {
    setDeep(state.plan, p, weekKey, dateKey, slotId, mealFromRecipe(recipe));
  }
  renderWeek();
  if (state.activeDay === dateKey) refreshDayDetail();
  try {
    await savePlan(state.plan, state.personNameToId);
    showToast(`✅ Guardado (${persons.join(' + ')})`, 'success');
  } catch (e) {
    showToast('❌ Error al guardar: ' + e.message, 'error');
  }
}

/**
 * Open slot picker scoped to a specific person in Familia mode.
 */
function openSlotPickerForPerson(slotId, targetPerson) {
  openSlotPicker(slotId, targetPerson);
}

// ══════════════════════════════════════════════════════════
// RECIPE MODAL
// ══════════════════════════════════════════════════════════

/**
 * Open the recipe detail modal.
 * - From the catalog (sidebar): openRecipeModal(recipeId) → current recipe.
 * - From a plan meal: openRecipeModal(recipeId, meal) → the meal's snapshot
 *   (falls back to the current catalog recipe for legacy meals).
 */
function openRecipeModal(recipeId, meal = null) {
  let recipe = null;
  if (meal) {
    const receta = resolveMealReceta(meal, getRecipeById);
    if (receta) recipe = { id: meal.recipeId, receta };
  } else {
    recipe = getRecipeById(recipeId);
  }
  if (!recipe) return;
  document.getElementById('modal-recipe-content').innerHTML = renderRecipeDetail(recipe);
  document.getElementById('modal-recipe').classList.remove('hidden');
}

function closeRecipeModal() {
  document.getElementById('modal-recipe').classList.add('hidden');
}

// ══════════════════════════════════════════════════════════
// RECIPE EDITOR — add / delete
// ══════════════════════════════════════════════════════════

async function handleDeleteRecipe(id, name) {
  if (!confirm(`¿Eliminar "${name}"? Esta acción no se puede deshacer.`)) return;

  deleteRecipe(id);
  renderSidebar();
  renderWeek(); // calorie bars might reference this recipe

  try {
    await deleteRecipeFromDB(id);
    showToast('✅ Receta eliminada', 'success');
  } catch (e) {
    showToast('❌ Error al eliminar: ' + e.message, 'error');
  }
}

// ── Editor modal ──────────────────────────────────────────

// null when creating a new recipe; recipe id string when editing an existing one
let _editingRecipeId = null;

function openRecipeEditor() {
  _editingRecipeId = null;
  resetEditorForm();
  document.getElementById('recipe-editor-title').textContent = 'Nueva receta';
  document.getElementById('modal-recipe-editor').classList.remove('hidden');
  refreshIngredientsDatalist();
  // Start with one blank ingredient and one blank step
  addIngredientRow();
  addStepRow();
}

function openRecipeEditorForEdit(id) {
  const recipe = getRecipeById(id);
  if (!recipe) return;
  _editingRecipeId = id;
  resetEditorForm();

  const { receta } = recipe;
  const m = receta.macros_por_porcion || {};

  // Fill basic fields
  document.getElementById('rf-nombre').value      = receta.nombre || '';
  document.getElementById('rf-descripcion').value = receta.descripcion_breve || '';
  document.getElementById('rf-porciones').value   = receta.porciones || 2;
  document.getElementById('rf-cal').value         = m.calorias      || '';
  document.getElementById('rf-prot').value        = m.proteina_g    || '';
  document.getElementById('rf-carbs').value       = m.carbohidratos_g || '';
  document.getElementById('rf-fat').value         = m.grasas_g      || '';

  // Categoria — find the matching option or fall back to first
  const sel = document.getElementById('rf-categoria');
  const cat = receta.categoria || '';
  const matchingOpt = [...sel.options].find(o => o.value === cat);
  sel.value = matchingOpt ? cat : sel.options[0].value;

  // Ingredients
  refreshIngredientsDatalist();
  (receta.ingredientes || []).forEach(ing => {
    addIngredientRow(ing.nombre ?? ing.item, ing.cantidad, ing.unidad);
  });
  if (!(receta.ingredientes || []).length) addIngredientRow();

  // Steps
  const steps = receta.paso_a_paso || receta.pasos || receta.instrucciones || [];
  steps.forEach(step => addStepRow(step));
  if (!steps.length) addStepRow();

  // Also pre-fill JSON tab with the current recipe JSON
  document.getElementById('rf-json').value = JSON.stringify({ receta: receta }, null, 2);

  document.getElementById('recipe-editor-title').textContent = 'Editar receta';
  document.getElementById('modal-recipe-editor').classList.remove('hidden');
}

function closeRecipeEditor() {
  _editingRecipeId = null;
  document.getElementById('modal-recipe-editor').classList.add('hidden');
}

function resetEditorForm() {
  document.getElementById('rf-nombre').value      = '';
  document.getElementById('rf-descripcion').value = '';
  document.getElementById('rf-categoria').value   = 'almuerzo/cena';
  document.getElementById('rf-porciones').value   = '2';
  document.getElementById('rf-cal').value         = '';
  document.getElementById('rf-prot').value        = '';
  document.getElementById('rf-carbs').value       = '';
  document.getElementById('rf-fat').value         = '';
  document.getElementById('rf-macros-auto').classList.add('hidden');
  document.getElementById('rf-json').value        = '';
  document.getElementById('ingredients-list').innerHTML = '';
  document.getElementById('steps-list').innerHTML       = '';
  // Reset tabs to form
  setEditorTab('form');
}

function setEditorTab(tab) {
  document.querySelectorAll('.editor-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('editor-tab-form').classList.toggle('hidden', tab !== 'form');
  document.getElementById('editor-tab-json').classList.toggle('hidden', tab !== 'json');
}

/** Fill <datalist id="ingredients-datalist"> with every ingredient in the catalog. */
function refreshIngredientsDatalist() {
  const dl = document.getElementById('ingredients-datalist');
  if (!dl) return;
  dl.innerHTML = '';
  const frag = document.createDocumentFragment();
  getAllIngredients()
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    .forEach(ing => {
      const opt = document.createElement('option');
      opt.value = ing.nombre;
      opt.label = `${ing.cantidad_referencia} ${ing.unidad_referencia}`;
      frag.appendChild(opt);
    });
  dl.appendChild(frag);
}

function _fmtMacro(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Update the per-row macro badge for the given ingredient row. */
function updateIngredientRowBadge(row) {
  const badge = row.querySelector('.ingr-row-macros');
  const name  = row.querySelector('.ingr-item').value.trim();
  const ing   = name ? getIngredientByName(name) : null;

  if (!ing) {
    badge.textContent = name ? 'Sin datos en el catálogo' : '';
    badge.classList.toggle('ingr-row-macros--unknown', !!name);
    badge.classList.toggle('hidden', !name);
    badge.removeAttribute('title');
    return;
  }

  const qty = parseFloat(row.querySelector('.ingr-qty').value) || 0;
  const m   = calculateItemMacros(ing, qty, row.querySelector('.ingr-unit').value);
  badge.textContent = `${Math.round(m.calorias)} kcal · ${_fmtMacro(m.proteina_g)}g P · ${_fmtMacro(m.carbohidratos_g)}g C · ${_fmtMacro(m.grasas_g)}g G`;
  badge.title = `Referencia: ${ing.cantidad_referencia} ${ing.unidad_referencia}`;
  badge.classList.remove('ingr-row-macros--unknown', 'hidden');
}

/** Read the recipe editor's ingredient rows as { item, cantidad, unidad }[]. */
function _readEditorIngredientRows() {
  return [...document.querySelectorAll('#ingredients-list .dynamic-row')]
    .map(row => ({
      item:     row.querySelector('.ingr-item').value.trim(),
      cantidad: parseFloat(row.querySelector('.ingr-qty').value) || 0,
      unidad:   row.querySelector('.ingr-unit').value.trim(),
    }))
    .filter(i => i.item);
}

/**
 * Recompute rf-cal / rf-prot / rf-carbs / rf-fat from the ingredient rows.
 * Does nothing when no row matches a catalog ingredient, so recipes with
 * hand-entered macros are never wiped.
 */
function recalculateRecipeEditorMacros() {
  const rows = _readEditorIngredientRows();
  const hasKnown = rows.some(r => getIngredientByName(r.item));
  const autoBadge = document.getElementById('rf-macros-auto');
  if (!hasKnown) {
    autoBadge.classList.add('hidden');
    return;
  }

  const porciones = parseInt(document.getElementById('rf-porciones').value) || 1;
  const { porcion } = calculateRecipeMacros(rows, porciones);

  document.getElementById('rf-cal').value   = Math.round(porcion.calorias);
  document.getElementById('rf-prot').value  = Math.round(porcion.proteina_g * 10) / 10;
  document.getElementById('rf-carbs').value = Math.round(porcion.carbohidratos_g * 10) / 10;
  document.getElementById('rf-fat').value   = Math.round(porcion.grasas_g * 10) / 10;
  autoBadge.classList.remove('hidden');
}

/** Refresh row badges and totals after the catalog changed (editor may be open). */
function _refreshRecipeEditorRows() {
  const modal = document.getElementById('modal-recipe-editor');
  if (modal.classList.contains('hidden')) return;
  document.querySelectorAll('#ingredients-list .dynamic-row').forEach(updateIngredientRowBadge);
  recalculateRecipeEditorMacros();
}

function addIngredientRow(item = '', cantidad = '', unidad = '') {
  const list = document.getElementById('ingredients-list');
  const row  = document.createElement('div');
  row.className = 'dynamic-row dynamic-row--ingr';
  row.innerHTML = `
    <input class="ingr-item"  type="text"   placeholder="Ingrediente" list="ingredients-datalist" autocomplete="off" />
    <input class="ingr-qty"   type="number" placeholder="Cant." min="0" step="0.1" />
    <input class="ingr-unit"  type="text"   placeholder="Unidad" />
    <button class="btn-del-row" title="Eliminar">✕</button>
    <div class="ingr-row-macros hidden"></div>
  `;
  // Set values via DOM properties (no HTML injection from recipe data)
  const itemInput = row.querySelector('.ingr-item');
  const qtyInput  = row.querySelector('.ingr-qty');
  const unitInput = row.querySelector('.ingr-unit');
  itemInput.value = item ?? '';
  qtyInput.value  = cantidad ?? '';
  unitInput.value = unidad ?? '';

  itemInput.addEventListener('input', () => {
    const ing = getIngredientByName(itemInput.value);
    if (ing && !unitInput.value.trim()) unitInput.value = ing.unidad_referencia;
    updateIngredientRowBadge(row);
    recalculateRecipeEditorMacros();
  });
  [qtyInput, unitInput].forEach(el => el.addEventListener('input', () => {
    updateIngredientRowBadge(row);
    recalculateRecipeEditorMacros();
  }));
  row.querySelector('.btn-del-row').addEventListener('click', () => {
    row.remove();
    recalculateRecipeEditorMacros();
  });

  list.appendChild(row);
  updateIngredientRowBadge(row);
}

function addStepRow(text = '') {
  const list = document.getElementById('steps-list');
  const idx  = list.children.length + 1;
  const row  = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <span style="font-size:.75rem;font-weight:700;color:var(--text-muted);min-width:18px">${idx}</span>
    <textarea class="step-text" rows="2" placeholder="Describí el paso…">${text}</textarea>
    <button class="btn-del-row" title="Eliminar">✕</button>
  `;
  row.querySelector('.btn-del-row').addEventListener('click', () => {
    row.remove();
    // Renumber remaining steps
    document.querySelectorAll('#steps-list .dynamic-row').forEach((r, i) => {
      r.querySelector('span').textContent = i + 1;
    });
  });
  list.appendChild(row);
}

function collectFormData() {
  const nombre      = document.getElementById('rf-nombre').value.trim();
  const descripcion = document.getElementById('rf-descripcion').value.trim();
  const categoria   = document.getElementById('rf-categoria').value;
  const porciones   = parseInt(document.getElementById('rf-porciones').value) || 2;
  const calorias    = parseFloat(document.getElementById('rf-cal').value)   || 0;
  const proteina    = parseFloat(document.getElementById('rf-prot').value)  || 0;
  const carbos      = parseFloat(document.getElementById('rf-carbs').value) || 0;
  const grasas      = parseFloat(document.getElementById('rf-fat').value)   || 0;

  if (!nombre) return null;

  const ingredientes = [...document.querySelectorAll('#ingredients-list .dynamic-row')]
    .map(row => ({
      item:     row.querySelector('.ingr-item').value.trim(),
      cantidad: parseFloat(row.querySelector('.ingr-qty').value) || 0,
      unidad:   row.querySelector('.ingr-unit').value.trim() || 'g',
    }))
    .filter(i => i.item);

  const paso_a_paso = [...document.querySelectorAll('#steps-list .step-text')]
    .map(t => t.value.trim())
    .filter(Boolean);

  return {
    receta: {
      nombre,
      descripcion_breve: descripcion,
      categoria,
      porciones,
      macros_por_porcion: {
        calorias,
        proteina_g: proteina,
        carbohidratos_g: carbos,
        grasas_g: grasas,
      },
      ingredientes,
      paso_a_paso,
    },
  };
}

async function saveRecipeFromForm() {
  const data = collectFormData();
  if (!data) {
    showToast('El nombre es obligatorio', 'error');
    return;
  }

  const isEditing = !!_editingRecipeId;
  const updated   = isEditing
    ? updateRecipe(_editingRecipeId, data)
    : addRecipe(data);

  renderSidebar();
  renderWeek(); // refresh kcal bars in case macros changed
  closeRecipeEditor();

  try {
    await saveRecipes(updated);
    showToast(isEditing ? '✅ Receta actualizada' : '✅ Receta guardada', 'success');
  } catch (e) {
    showToast('❌ Error al guardar: ' + e.message, 'error');
  }
}

async function saveRecipeFromJSON() {
  const raw = document.getElementById('rf-json').value.trim();
  if (!raw) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    showToast('JSON inválido', 'error');
    return;
  }

  // When editing a single recipe via JSON tab, accept a bare { receta: {…} }
  // and apply it as an update rather than an insert.
  if (_editingRecipeId) {
    const entry = parsed.receta ? parsed : { receta: parsed };
    if (!entry.receta) {
      showToast('Estructura no reconocida. Usá { "receta": {…} }', 'error');
      return;
    }
    const updated = updateRecipe(_editingRecipeId, entry);
    renderSidebar();
    renderWeek();
    closeRecipeEditor();
    try {
      await saveRecipes(updated);
      showToast('✅ Receta actualizada', 'success');
    } catch (e) {
      showToast('❌ Error al guardar: ' + e.message, 'error');
    }
    return;
  }

  // New recipe(s) — accept { receta: {...} }, { recetas: [...] }, or bare array
  const entries = parsed.recetas
    ? parsed.recetas
    : parsed.receta
      ? [{ receta: parsed.receta }]
      : Array.isArray(parsed)
        ? parsed
        : null;

  if (!entries) {
    showToast('Estructura no reconocida. Usá { "receta": {…} } o { "recetas": […] }', 'error');
    return;
  }

  let updated;
  for (const entry of entries) {
    updated = addRecipe(entry.receta ? entry : { receta: entry });
  }

  renderSidebar();
  closeRecipeEditor();

  try {
    await saveRecipes(updated || getAllRecipes());
    showToast(`✅ ${entries.length} receta(s) guardada(s)`, 'success');
  } catch (e) {
    showToast('❌ Error al guardar: ' + e.message, 'error');
  }
}

function previewJSON() {
  const raw = document.getElementById('rf-json').value.trim();
  if (!raw) return;
  try {
    const p = JSON.parse(raw);
    // Pretty-print it back
    document.getElementById('rf-json').value = JSON.stringify(p, null, 2);
    showToast('JSON válido ✓');
  } catch (e) {
    showToast('JSON inválido: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════
// AUTH MODAL
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// SHOPPING LIST
// ══════════════════════════════════════════════════════════

const DAY_NAMES_ES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

// Ingredients always excluded from the shopping list (case-insensitive substring match)
const SHOPPING_EXCLUDE = [
  'agua', 'hielo', 'whey isolate', 'proteína de suero', 'condimento',
];

// Ingredients deselected by default: initial seed for families without a saved row.
// The family's saved list lives in the DB (shopping_preferences) and in
// state.shoppingDeselectedDefaults after login.
const SHOPPING_DESELECT_SEED = [
  'café', 'cafe', 'aceite', 'sal', 'pimienta', 'vinagre', 'azúcar', 'azucar',
  'orégano', 'oregano', 'ajo en polvo', 'cebolla en polvo', 'pimentón', 'paprika',
  'comino', 'cúrcuma', 'curcuma', 'curry', 'canela', 'nuez moscada',
];

function isExcludedIngredient(name) {
  const lower = name.toLowerCase();
  return SHOPPING_EXCLUDE.some(ex => lower.includes(ex));
}

function isDefaultDeselected(name, deselectedDefaults) {
  const lower = name.toLowerCase();
  return deselectedDefaults.some(ex => lower.includes(ex.toLowerCase()));
}

/**
 * Build the aggregated shopping list from the selected day through next Sunday.
 * Returns a flat array of { name, qty, unit } with quantities summed per ingredient.
 */
function buildShoppingList() {
  const weekDays = getWeekDays(state.anchorDate);
  const weekKey  = toWeekKey(state.anchorDate);
  const todayKey = toDateKey(new Date());

  // Only days from today onwards (inclusive) within the displayed week
  const relevantDays = weekDays.filter(d => toDateKey(d) >= todayKey);

  const persons = state.person === 'Familia' ? ['Pablo', 'Juli'] : [state.person];

  // ── Collect the consumed meals ───────────────────────────────────────────
  // Each slot entry (per person) = 1 portion consumed.
  // We deduplicate within a (person, dateKey, slotId) triple to avoid
  // double-counting when both Pablo and Juli share the same entry in the plan.
  // Grouping by (recipeId + version) and batch math live in
  // buildShoppingItems (plan-versions.js): two versions of the same recipe
  // are cooked as separate batches with their own ingredient quantities.
  const consumedMeals = [];
  const seenSlots = new Set();        // "person__dateKey__slotId" already tallied

  for (const date of relevantDays) {
    const dateKey = toDateKey(date);

    for (const p of persons) {
      const dayEntry = state.plan?.[p]?.[weekKey]?.[dateKey];
      if (!dayEntry) continue;

      for (const slotId of Object.keys(dayEntry)) {
        const meal = dayEntry[slotId];
        if (!meal?.recipeId) continue;

        // Normalise: _juli suffix slots belong to Juli but live under Pablo's
        // plan key in some layouts — strip it so we don't double-count.
        const slotBase   = slotId.replace(/_juli$/, '');
        const personKey  = slotId.endsWith('_juli') ? 'Juli' : p;
        const slotTriple = `${personKey}__${dateKey}__${slotBase}`;
        if (seenSlots.has(slotTriple)) continue;
        seenSlots.add(slotTriple);

        consumedMeals.push(meal);
      }
    }
  }

  // Uses each meal's snapshot (fallback: current catalog recipe).
  return buildShoppingItems(consumedMeals, {
    getRecipeById,
    isExcluded: isExcludedIngredient,
  });
}

/**
 * Render the shopping list modal content and open it.
 */
function openShoppingModal() {
  const items = buildShoppingList();
  const deselectedDefaults = state.shoppingDeselectedDefaults ?? SHOPPING_DESELECT_SEED;

  // Date range label
  const weekDays  = getWeekDays(state.anchorDate);
  const todayKey  = toDateKey(new Date());
  const firstDay  = weekDays.find(d => toDateKey(d) >= todayKey) ?? weekDays[0];
  const lastDay   = weekDays[6];
  const fmt = d => `${d.getDate()}/${d.getMonth() + 1}`;
  document.getElementById('shopping-date-range').textContent =
    `${fmt(firstDay)} – ${fmt(lastDay)}`;

  // Build content
  const container = document.getElementById('shopping-list-content');
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = '<div class="shopping-empty">No hay comidas planificadas desde hoy hasta el domingo 🍽️</div>';
  } else {
    // Sort: checked (selected) first, deselected last; each group alphabetically
    const byName = (a, b) => a.name.localeCompare(b.name, 'es');
    const checked   = items.filter(i => !isDefaultDeselected(i.name, deselectedDefaults)).sort(byName);
    const unchecked = items.filter(i =>  isDefaultDeselected(i.name, deselectedDefaults)).sort(byName);
    const sorted = [...checked, ...unchecked];

    for (const { name, qty, unit } of sorted) {
      const isChecked = !isDefaultDeselected(name, deselectedDefaults);
      const row = document.createElement('label');
      row.className = 'shopping-item' + (isChecked ? '' : ' shopping-item--unchecked');

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.className = 'shopping-cb';
      cb.checked = isChecked;
      cb.dataset.name = name;
      cb.addEventListener('change', () => {
        row.classList.toggle('shopping-item--unchecked', !cb.checked);
        // Re-sort: move unchecked items to bottom
        _reshuffleShoppingList(container);
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'shopping-item-name';
      nameSpan.textContent = name;

      const qtySpan = document.createElement('span');
      qtySpan.className = 'shopping-item-qty';
      qtySpan.textContent = qty ? `${qty}${unit}` : unit;

      row.appendChild(cb);
      row.appendChild(nameSpan);
      row.appendChild(qtySpan);
      container.appendChild(row);
    }
  }

  document.getElementById('modal-shopping').classList.remove('hidden');
}

/**
 * Move unchecked items to the bottom of the container, each group sorted alphabetically.
 */
function _reshuffleShoppingList(container) {
  const rows = Array.from(container.querySelectorAll('.shopping-item'));
  const byName = (a, b) =>
    a.querySelector('.shopping-item-name').textContent
     .localeCompare(b.querySelector('.shopping-item-name').textContent, 'es');
  const checked   = rows.filter(r => !r.classList.contains('shopping-item--unchecked')).sort(byName);
  const unchecked = rows.filter(r =>  r.classList.contains('shopping-item--unchecked')).sort(byName);
  for (const r of [...checked, ...unchecked]) container.appendChild(r);
}

function closeShoppingModal() {
  document.getElementById('modal-shopping').classList.add('hidden');
}

/**
 * Save current checkbox state as the new defaults.
 */
async function saveShoppingPreselections() {
  const container = document.getElementById('shopping-list-content');
  const newDeselected = [];
  container.querySelectorAll('.shopping-cb').forEach(cb => {
    if (!cb.checked) newDeselected.push(cb.dataset.name.toLowerCase());
  });

  const btn = document.getElementById('btn-save-shopping-preselections');
  if (btn) btn.disabled = true;
  try {
    await saveShoppingDeselected(newDeselected);
    // Update the in-memory list only after the DB write succeeded.
    state.shoppingDeselectedDefaults = newDeselected;
    showToast('✅ Pre-selecciones guardadas', 'success');
  } catch (e) {
    console.error('saveShoppingPreselections:', e);
    showToast('❌ No se pudieron guardar las pre-selecciones', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Convert the selected items to plain text for sharing.
 */
function buildShoppingListText() {
  const container = document.getElementById('shopping-list-content');
  const lines = [];
  container.querySelectorAll('.shopping-item').forEach(row => {
    const cb = row.querySelector('.shopping-cb');
    if (!cb || !cb.checked) return;
    const name = row.querySelector('.shopping-item-name')?.textContent ?? '';
    const qty  = row.querySelector('.shopping-item-qty')?.textContent ?? '';
    lines.push(qty ? `${name} ${qty}` : name);
  });
  return lines.join('\n');
}

async function shareShoppingList() {
  const text = buildShoppingListText();
  if (!text) {
    showToast('No hay ingredientes seleccionados para compartir', 'warn');
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Compras del super', text });
    } catch (e) {
      // User cancelled or share failed — ignore AbortError
      if (e.name !== 'AbortError') showToast('❌ No se pudo compartir', 'error');
    }
  } else {
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(text);
      showToast('✅ Lista copiada al portapapeles', 'success');
    } catch {
      showToast('❌ No se pudo copiar', 'error');
    }
  }
}

// ── Auth modal (now: user account info + logout) ──────────────

const PROFILE_FIELDS = {
  bmr_kcal:            'input-profile-bmr',
  daily_calories_kcal: 'input-profile-target',
  maintenance_kcal:    'input-profile-maintenance',
  weight_kg:           'input-profile-weight',
  height_cm:           'input-profile-height',
  age_years:           'input-profile-age',
  sex:                 'input-profile-sex',
};

/** Persons of the current user whose required maintenance_kcal is not loaded yet. */
function personsMissingMaintenance() {
  return state.persons.filter(p => !state.nutrition[p.name]?.maintenance_kcal);
}

/** Fill the profile form with the stored values of the selected person. */
function fillProfileForm(personName) {
  const n = state.nutrition[personName] || {};
  for (const [key, id] of Object.entries(PROFILE_FIELDS)) {
    document.getElementById(id).value = n[key] ?? '';
  }
}

function populateProfileSection() {
  const select = document.getElementById('input-profile-person');
  select.innerHTML = '';
  for (const p of state.persons) {
    const missing = !state.nutrition[p.name]?.maintenance_kcal;
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = missing ? `${p.name} (datos incompletos)` : p.name;
    select.appendChild(opt);
  }
  // Preselect the active person, or the first one still incomplete.
  const incomplete = personsMissingMaintenance()[0]?.name;
  const preferred  = incomplete
    ?? (state.persons.some(p => p.name === state.person) ? state.person : state.persons[0]?.name);
  if (preferred) select.value = preferred;

  document.getElementById('field-profile-person').classList.toggle('hidden', state.persons.length < 2);
  document.getElementById('section-nutrition-profile').classList.toggle('hidden', !state.persons.length);
  if (select.value) fillProfileForm(select.value);
}

async function handleSaveProfile() {
  const personName = document.getElementById('input-profile-person').value;
  const personId   = state.personNameToId[personName];
  if (!personId) { showToast('Elegí una persona', 'error'); return; }

  const num = id => {
    const v = document.getElementById(id).value.trim();
    return v === '' ? null : Number(v);
  };
  const profile = {
    bmr_kcal:            num(PROFILE_FIELDS.bmr_kcal),
    daily_calories_kcal: num(PROFILE_FIELDS.daily_calories_kcal),
    maintenance_kcal:    num(PROFILE_FIELDS.maintenance_kcal),
    weight_kg:           num(PROFILE_FIELDS.weight_kg),
    height_cm:           num(PROFILE_FIELDS.height_cm),
    age_years:           num(PROFILE_FIELDS.age_years),
    sex:                 document.getElementById(PROFILE_FIELDS.sex).value || null,
  };

  // Required: BMR, daily target and maintenance (positive numbers).
  const required = [
    [profile.bmr_kcal,            'la tasa metabólica basal'],
    [profile.daily_calories_kcal, 'las calorías objetivo'],
    [profile.maintenance_kcal,    'las calorías de mantenimiento'],
  ];
  for (const [value, label] of required) {
    if (!Number.isFinite(value) || value <= 0) {
      showToast(`Ingresá ${label}`, 'error');
      return;
    }
  }
  for (const key of ['weight_kg', 'height_cm', 'age_years']) {
    if (profile[key] !== null && (!Number.isFinite(profile[key]) || profile[key] <= 0)) {
      showToast('Peso, altura y edad deben ser números positivos', 'error');
      return;
    }
  }
  if (profile.age_years !== null && (!Number.isInteger(profile.age_years) || profile.age_years > 120)) {
    showToast('La edad debe ser un entero entre 1 y 120', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    await saveNutritionProfile(personId, profile);
    // Reload from the DB so the UI reflects exactly what is stored.
    state.nutrition = await fetchNutrition();
    populateProfileSection();
    renderWeek();
    showToast('✅ Datos guardados', 'success');
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar datos';
  }
}

function openAuthModal() {
  // Populate username display
  const uEl = document.getElementById('auth-username-display');
  if (uEl && state.profile) uEl.textContent = state.profile.username;
  populateProfileSection();
  // Show admin section only for admins
  const adminSection = document.getElementById('section-admin-users');
  if (adminSection) {
    adminSection.classList.toggle('hidden', state.profile?.role !== 'admin');
  }
  // Clear password fields on open
  const np = document.getElementById('input-new-password');
  const cp = document.getElementById('input-confirm-password');
  if (np) np.value = '';
  if (cp) cp.value = '';
  document.getElementById('modal-auth').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('modal-auth').classList.add('hidden');
}

// ── User management modal (admin only) ────────────────────────

const NEW_FAMILY_OPTION = '__new__';

/** Render the family <select> using DOM APIs (textContent only, no innerHTML). */
function renderFamilySelect(families) {
  const sel = document.getElementById('select-new-user-family');
  if (!sel) return;
  sel.replaceChildren();

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Elegí una familia…';
  sel.appendChild(placeholder);

  for (const f of families) {
    const opt = document.createElement('option');
    opt.value = String(f.id);
    const members = Array.isArray(f.members) ? f.members : [];
    opt.textContent = members.length
      ? `${f.name} (${members.join(', ')})`
      : String(f.name);
    sel.appendChild(opt);
  }

  const newOpt = document.createElement('option');
  newOpt.value = NEW_FAMILY_OPTION;
  newOpt.textContent = 'Nueva familia…';
  sel.appendChild(newOpt);

  sel.value = '';
  toggleNewFamilyField();
}

function toggleNewFamilyField() {
  const sel   = document.getElementById('select-new-user-family');
  const field = document.getElementById('field-new-family-name');
  if (!sel || !field) return;
  field.classList.toggle('hidden', sel.value !== NEW_FAMILY_OPTION);
}

async function loadFamiliesForUserMgmt() {
  if (state.profile?.role !== 'admin') return;
  try {
    renderFamilySelect(await adminListFamilies());
  } catch (e) {
    console.error('adminListFamilies failed:', e);
    renderFamilySelect([]);
    showToast('❌ No se pudieron cargar las familias', 'error');
  }
}

function openUserMgmtModal() {
  closeAuthModal();
  const u = document.getElementById('input-new-username');
  const p = document.getElementById('input-new-user-password');
  const n = document.getElementById('input-new-family-name');
  if (u) u.value = '';
  if (p) p.value = '';
  if (n) n.value = '';
  document.getElementById('modal-user-mgmt').classList.remove('hidden');
  loadFamiliesForUserMgmt();
}

function closeUserMgmtModal() {
  document.getElementById('modal-user-mgmt').classList.add('hidden');
}

async function handleChangePassword() {
  const np = document.getElementById('input-new-password')?.value ?? '';
  const cp = document.getElementById('input-confirm-password')?.value ?? '';
  if (!np || !cp) { showToast('Ingresá la nueva contraseña dos veces', 'error'); return; }
  if (np !== cp)  { showToast('Las contraseñas no coinciden', 'error'); return; }
  if (np.length < 6) { showToast('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
  const btn = document.getElementById('btn-change-password');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    await changePassword(np);
    showToast('✅ Contraseña actualizada', 'success');
    document.getElementById('input-new-password').value = '';
    document.getElementById('input-confirm-password').value = '';
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Cambiar contraseña'; }
  }
}

async function handleCreateUser() {
  const username = document.getElementById('input-new-username')?.value.trim() ?? '';
  const password = document.getElementById('input-new-user-password')?.value ?? '';
  if (!username) { showToast('Ingresá un nombre de usuario', 'error'); return; }
  if (password.length < 6) { showToast('La contraseña debe tener al menos 6 caracteres', 'error'); return; }

  const choice = document.getElementById('select-new-user-family')?.value ?? '';
  let family;
  if (choice === NEW_FAMILY_OPTION) {
    const newName = document.getElementById('input-new-family-name')?.value.trim() ?? '';
    if (!newName) { showToast('Ingresá el nombre de la nueva familia', 'error'); return; }
    if (newName.length > 100) { showToast('El nombre de la familia no puede superar los 100 caracteres', 'error'); return; }
    family = { newFamilyName: newName };
  } else if (choice) {
    family = { familyId: choice };
  } else {
    showToast('Elegí una familia o creá una nueva', 'error');
    return;
  }

  const btn = document.getElementById('btn-create-user');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando…'; }
  try {
    await adminCreateUser(username, password, family);
    showToast(`✅ Usuario "${username}" creado`, 'success');
    document.getElementById('input-new-username').value = '';
    document.getElementById('input-new-user-password').value = '';
    const n = document.getElementById('input-new-family-name');
    if (n) n.value = '';
    await loadFamiliesForUserMgmt();
  } catch (e) {
    console.error('adminCreateUser failed:', e);
    showToast('❌ No se pudo crear el usuario. Verificá los datos e intentá de nuevo.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Crear usuario'; }
  }
}

async function handleResetUserPassword() {
  const username = document.getElementById('input-reset-username')?.value.trim() ?? '';
  const password = document.getElementById('input-reset-password')?.value ?? '';
  if (!username) { showToast('Ingresá el nombre de usuario', 'error'); return; }
  if (password.length < 6) { showToast('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
  const btn = document.getElementById('btn-reset-user-password');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    await adminResetPassword(username, password);
    showToast(`✅ Contraseña de "${username}" actualizada`, 'success');
    document.getElementById('input-reset-username').value = '';
    document.getElementById('input-reset-password').value = '';
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Cambiar contraseña'; }
  }
}

async function handleLogout() {
  if (!confirm('¿Cerrar sesión en este dispositivo?')) return;
  await signOut();
  // onAuthStateChange will fire and call showLoginGate()
  closeAuthModal();
  showToast('Sesión cerrada', '');
}

function updateAuthUI() {
  const profile = state.profile;

  // Desktop header button — show username when logged in
  const btn    = document.getElementById('btn-github-auth');
  const status = document.getElementById('auth-status');
  if (profile) {
    btn.textContent = `👤 ${profile.username}`;
    btn.classList.add('connected');
    status.textContent = '';
  } else {
    btn.textContent = 'Iniciar sesión';
    btn.classList.remove('connected');
    status.textContent = '';
  }

  // Footer button (mobile)
  const btnF    = document.getElementById('btn-github-auth-footer');
  const statusF = document.getElementById('auth-status-footer');
  if (profile) {
    btnF.textContent = `👤 ${profile.username}`;
    btnF.classList.add('connected');
    statusF.textContent = '';
  } else {
    btnF.textContent = 'Iniciar sesión';
    btnF.classList.remove('connected');
    statusF.textContent = '';
  }
}

// ══════════════════════════════════════════════════════════
// PERSON SWITCHER (dynamic — built from Supabase persons)
// ══════════════════════════════════════════════════════════

function renderPersonSwitcher() {
  const switcher = document.querySelector('.person-switcher');
  if (!switcher) return;

  switcher.innerHTML = '';

  // Individual person buttons
  for (const p of state.persons) {
    const btn = document.createElement('button');
    btn.className   = 'person-btn';
    btn.dataset.person = p.name;
    btn.textContent = p.name;
    btn.classList.toggle('active', state.person === p.name);
    switcher.appendChild(btn);
  }

  // Familia button — only when show_familia is true
  if (state.showFamilia) {
    const btn = document.createElement('button');
    btn.className   = 'person-btn person-btn--familia';
    btn.dataset.person = 'Familia';
    btn.textContent = '👨‍👩 Familia';
    btn.classList.toggle('active', state.person === 'Familia');
    switcher.appendChild(btn);
  }

  // Re-wire click handlers after rebuild
  switcher.querySelectorAll('.person-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switcher.querySelectorAll('.person-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.person = btn.dataset.person;
      if (!isMobile()) {
        state.activeDay = null;
        document.getElementById('day-detail').classList.add('hidden-panel');
      }
      renderWeek();
    });
  });
}

// ══════════════════════════════════════════════════════════
// AUTO-PLAN
// ══════════════════════════════════════════════════════════

async function handleAutoPlan() {
  const btn = document.getElementById('btn-auto-plan');
  btn.disabled = true;
  btn.textContent = '⏳ Planificando…';

  try {
    autoFillWeek(state.plan, state.anchorDate);
    renderWeek();
    if (state.activeDay) refreshDayDetail();
    await savePlan(state.plan, state.personNameToId);
    showToast('✅ Semana planificada y guardada', 'success');
  } catch (e) {
    showToast('❌ Error al planificar: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Planificar';
  }
}

// ══════════════════════════════════════════════════════════
// DEFAULT WEEK
// ══════════════════════════════════════════════════════════

/**
 * Save the currently visible week as the default week template.
 * Collects meals for the active persons from state.plan and writes
 * them to the default_week table, replacing any previous template.
 */
async function handleSetDefaultWeek() {
  const btn = document.getElementById('btn-set-default-week');
  btn.disabled = true;
  btn.textContent = '⏳ Guardando…';

  try {
    const weekDays  = getWeekDays(state.anchorDate);
    const weekKey   = toWeekKey(state.anchorDate);
    const persons   = personsToWrite();

    // Build { dayIndex: { slotId: meal } } from the current week
    const weekData = {};
    weekDays.forEach((d, i) => {
      const dateKey  = toDateKey(d);
      const daySlots = {};
      for (const personName of persons) {
        const slotMap = state.plan?.[personName]?.[weekKey]?.[dateKey] || {};
        for (const [slotId, meal] of Object.entries(slotMap)) {
          if (meal?.recipeId) daySlots[slotId] = meal;
        }
      }
      if (Object.keys(daySlots).length) weekData[i] = daySlots;
    });

    // Overwrite the stored template (clear first to remove stale slots)
    await clearDefaultWeek(persons, state.personNameToId);
    await saveDefaultWeek(weekData, persons, state.personNameToId);

    // Update in-memory copy so it takes effect immediately on the next empty week
    for (const personName of persons) {
      state.defaultWeek[personName] = weekData;
    }

    showToast('✅ Semana guardada como plantilla', 'success');
  } catch (e) {
    showToast('❌ Error al guardar plantilla: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📌 Usar como predeterminada';
  }
}

// ══════════════════════════════════════════════════════════
// CONTROLS WIRING
// ══════════════════════════════════════════════════════════

function wireControls() {
  // Person switcher is now rendered dynamically by renderPersonSwitcher()
  // — no static wiring needed here.

  // Navigation — single day on mobile, full week on desktop
  document.getElementById('btn-prev-week').addEventListener('click', () => {
    if (isMobile()) {
      mobilePrevDay();
    } else {
      state.anchorDate = new Date(state.anchorDate);
      state.anchorDate.setDate(state.anchorDate.getDate() - 7);
      renderWeek();
    }
  });
  document.getElementById('btn-next-week').addEventListener('click', () => {
    if (isMobile()) {
      mobileNextDay();
    } else {
      state.anchorDate = new Date(state.anchorDate);
      state.anchorDate.setDate(state.anchorDate.getDate() + 7);
      renderWeek();
    }
  });

  // Helper: toggle sidebar open/closed
  function toggleSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    sidebar.classList.toggle('collapsed');
    if (isMobile()) {
      backdrop.classList.toggle('hidden', sidebar.classList.contains('collapsed'));
    }
  }

  // Sidebar toggle — hamburger inside sidebar (desktop)
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);

  // Header hamburger button — open sidebar from mobile header
  document.getElementById('btn-open-sidebar').addEventListener('click', toggleSidebar);

  // Sidebar backdrop tap → close sidebar
  document.getElementById('sidebar-backdrop').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-backdrop').classList.add('hidden');
  });

  // Footer auth button (mobile) → account modal
  document.getElementById('btn-github-auth-footer').addEventListener('click', openAuthModal);

  // Sidebar nav tabs (Recetas / Ingredientes)
  document.getElementById('sidebar-nav-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.sidebar-nav-tab');
    if (!btn) return;
    setSidebarTab(btn.dataset.sidebarTab);
  });

  // + button — opens recipe or ingredient editor depending on active tab
  document.getElementById('btn-add-sidebar').addEventListener('click', () => {
    if (state.sidebarTab === 'ingredients') {
      openIngredientEditor();
    } else {
      openRecipeEditor();
    }
  });

  // Recipe search
  document.getElementById('recipe-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderSidebar();
  });
  document.getElementById('btn-clear-search').addEventListener('click', () => {
    document.getElementById('recipe-search').value = '';
    state.searchQuery = '';
    renderSidebar();
  });

  // Recipe category filter chips
  document.getElementById('filter-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#filter-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.searchCategory = chip.dataset.cat;
    renderSidebar();
  });

  // Ingredient category filter chips
  document.getElementById('filter-chips-ingredients').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#filter-chips-ingredients .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.ingredientSearchCategory = chip.dataset.ingCat;
    renderSidebar();
  });

  // Close day detail
  document.getElementById('btn-close-detail').addEventListener('click', closeDayDetail);

  // Recipe modal
  document.getElementById('btn-close-modal').addEventListener('click', closeRecipeModal);
  document.querySelector('#modal-recipe .modal-backdrop').addEventListener('click', closeRecipeModal);

  // Recipe editor
  document.getElementById('btn-close-recipe-editor').addEventListener('click', closeRecipeEditor);
  document.querySelector('#modal-recipe-editor .modal-backdrop').addEventListener('click', closeRecipeEditor);
  document.getElementById('btn-save-recipe').addEventListener('click', saveRecipeFromForm);
  document.getElementById('btn-save-json-recipe').addEventListener('click', saveRecipeFromJSON);
  document.getElementById('btn-load-json').addEventListener('click', previewJSON);
  document.getElementById('btn-add-ingredient').addEventListener('click', () => addIngredientRow());
  document.getElementById('btn-new-ingredient-quick').addEventListener('click', openIngredientEditor);
  document.getElementById('rf-porciones').addEventListener('input', recalculateRecipeEditorMacros);
  // Manual edits of a macro field mean the values are no longer auto-calculated
  ['rf-cal', 'rf-prot', 'rf-carbs', 'rf-fat'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      document.getElementById('rf-macros-auto').classList.add('hidden');
    });
  });
  document.getElementById('btn-add-step').addEventListener('click', () => addStepRow());

  // Recipe editor tabs
  document.querySelectorAll('.editor-tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => setEditorTab(tab.dataset.tab));
  });

  // Ingredient editor modal
  document.getElementById('btn-close-ingredient-editor').addEventListener('click', closeIngredientEditor);
  document.querySelector('#modal-ingredient-editor .modal-backdrop').addEventListener('click', closeIngredientEditor);
  document.getElementById('btn-save-ingredient-form').addEventListener('click', saveIngredientFromForm);
  document.getElementById('btn-save-ingredient-json').addEventListener('click', saveIngredientFromJSON);
  document.getElementById('btn-preview-ingredient-json').addEventListener('click', previewIngredientJSON);
  document.getElementById('btn-delete-ingredient').addEventListener('click', () => {
    if (_editingIngredientId) deleteIngredientHandler(_editingIngredientId);
  });

  // Ingredient editor tabs
  document.querySelectorAll('.ing-editor-tab').forEach(tab => {
    tab.addEventListener('click', () => setIngredientEditorTab(tab.dataset.ingTab));
  });

  // Auto-plan
  document.getElementById('btn-auto-plan').addEventListener('click', handleAutoPlan);

  // Default week
  document.getElementById('btn-set-default-week').addEventListener('click', handleSetDefaultWeek);

  // Shopping list
  document.getElementById('btn-shopping-list').addEventListener('click', openShoppingModal);
  document.getElementById('btn-shopping-list-footer').addEventListener('click', openShoppingModal);
  document.getElementById('btn-close-shopping-modal').addEventListener('click', closeShoppingModal);
  document.querySelector('#modal-shopping .modal-backdrop').addEventListener('click', closeShoppingModal);
  document.getElementById('btn-share-shopping').addEventListener('click', shareShoppingList);
  document.getElementById('btn-save-shopping-preselections').addEventListener('click', saveShoppingPreselections);

  // Auth — account modal
  document.getElementById('btn-github-auth').addEventListener('click', openAuthModal);
  document.getElementById('btn-close-auth-modal').addEventListener('click', closeAuthModal);
  document.querySelector('#modal-auth .modal-backdrop')?.addEventListener('click', closeAuthModal);
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);
  document.getElementById('btn-change-password')?.addEventListener('click', handleChangePassword);
  document.getElementById('btn-save-profile')?.addEventListener('click', handleSaveProfile);
  document.getElementById('input-profile-person')?.addEventListener('change', e => fillProfileForm(e.target.value));

  // User management modal (admin only)
  document.getElementById('btn-open-user-mgmt')?.addEventListener('click', openUserMgmtModal);
  document.getElementById('btn-close-user-mgmt')?.addEventListener('click', closeUserMgmtModal);
  document.querySelector('#modal-user-mgmt .modal-backdrop')?.addEventListener('click', closeUserMgmtModal);
  document.getElementById('btn-create-user')?.addEventListener('click', handleCreateUser);
  document.getElementById('select-new-user-family')?.addEventListener('change', toggleNewFamilyField);
  document.getElementById('btn-reset-user-password')?.addEventListener('click', handleResetUserPassword);

  // Login gate form — click and Enter key both trigger sign-in
  async function doLogin() {
    const user = document.getElementById('input-username')?.value.trim();
    const pass = document.getElementById('input-password')?.value;
    if (!user || !pass) { showToast('Ingresá usuario y contraseña', 'error'); return; }
    const btn = document.getElementById('btn-login');
    if (btn) { btn.disabled = true; btn.textContent = 'Entrando…'; }
    try {
      await signIn(user, pass);
      // onAuthStateChange fires → loadAppData() runs automatically
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    }
  }
  document.getElementById('btn-login')?.addEventListener('click', doLogin);
  document.getElementById('input-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('input-username')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('input-password')?.focus();
  });

  // ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRecipeModal();
      closeAuthModal();
      closeUserMgmtModal();
      closeRecipeEditor();
      closeIngredientEditor();
      closeShoppingModal();
      const picker = document.querySelector('.slot-picker');
      if (picker) picker.remove();
    }
  });
}

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════

init().catch(err => {
  console.error('Init error:', err);
  showToast('Error al cargar la app', 'error');
});
