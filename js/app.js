/**
 * app.js — main entry point, wires everything together
 */

import { loadData, searchRecipes, getRecipeById, addRecipe, deleteRecipe, getAllRecipes, slugify } from './recipes.js';
import { getWeekDays, toDateKey, toWeekKey, MEAL_SLOTS, MONTH_NAMES } from './calendar.js';
import {
  fetchPlan, savePlan,
  getCredentials, saveCredentials, isAuthenticated,
  testConnection, saveRecipes,
} from './storage.js';
import {
  renderRecipeCard, renderRecipeDetail,
  renderCalendarGrid, updateKcalBars,
  renderDayDetail, renderDaySummary,
  showToast,
} from './ui.js';

// ══════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════

let state = {
  person:    'Pablo',
  anchorDate: new Date(),
  activeDay: null,
  plan:      {},         // full plan object
  nutrition: {},
  recipes:   [],
  searchQuery: '',
  searchCategory: 'all',
  draggingRecipeId: null,
};

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════

async function init() {
  // Load static data
  const { recipes, nutrition } = await loadData();
  state.recipes   = recipes;
  state.nutrition = nutrition;

  // Load saved plan
  state.plan = await fetchPlan();

  // Render sidebar
  renderSidebar();

  // Render calendar
  renderWeek();

  // Auth UI
  updateAuthUI();

  // Wire up controls
  wireControls();
}

// ══════════════════════════════════════════════════════════
// WEEK RENDERING
// ══════════════════════════════════════════════════════════

function renderWeek() {
  const weekDays = getWeekDays(state.anchorDate);
  const weekKey  = toWeekKey(state.anchorDate);

  // Update week label
  const mon = weekDays[0];
  const sun = weekDays[6];
  const sameMonth = mon.getMonth() === sun.getMonth();
  const label = sameMonth
    ? `${MONTH_NAMES[mon.getMonth()]} ${mon.getFullYear()}`
    : `${MONTH_NAMES[mon.getMonth()].slice(0,3)}–${MONTH_NAMES[sun.getMonth()].slice(0,3)} ${sun.getFullYear()}`;
  document.getElementById('week-label').textContent = label;

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

  // For Familia, use Pablo's nutrition for the kcal bar (representative)
  const nutritionForBar = state.person === 'Familia'
    ? state.nutrition['Pablo']
    : state.nutrition[state.person];
  updateKcalBars(weekDays, state.plan, state.person, weekKey, nutritionForBar);

  // Re-open active day panel if one was selected
  if (state.activeDay) {
    refreshDayDetail();
  }
}

// ══════════════════════════════════════════════════════════
// SIDEBAR / SEARCH
// ══════════════════════════════════════════════════════════

function renderSidebar() {
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

    // Info button
    card.querySelector('.recipe-card-info').addEventListener('click', (e) => {
      e.stopPropagation();
      openRecipeModal(recipe.id);
    });

    // Delete button
    card.querySelector('.recipe-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteRecipe(recipe.id, recipe.receta.nombre);
    });

    list.appendChild(card);
  });
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

  const weekKey  = toWeekKey(new Date(state.activeDay + 'T12:00:00'));

  // For Familia, canonical plan lives under Pablo
  const planPerson = state.person === 'Familia' ? 'Pablo' : state.person;
  const dayEntry   = state.plan?.[planPerson]?.[weekKey]?.[state.activeDay] || {};

  renderDayDetail({
    dateKey:      state.activeDay,
    dayEntry,
    nutrition:    state.person !== 'Familia' ? state.nutrition[state.person] : null,
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

function closeDayDetail() {
  state.activeDay = null;
  document.getElementById('day-detail').classList.add('hidden-panel');
  document.querySelectorAll('.day-cell').forEach(c => c.classList.remove('active'));
}

// ══════════════════════════════════════════════════════════
// SLOT PICKER (when clicking + Agregar without a drag)
// ══════════════════════════════════════════════════════════

let _slotPickerCleanup = null;

function openSlotPicker(slotId) {
  // Use a simple in-app recipe selector panel
  // We'll show a floating picker with all recipes
  const existing = document.querySelector('.slot-picker');
  if (existing) existing.remove();
  if (_slotPickerCleanup) { _slotPickerCleanup(); _slotPickerCleanup = null; }

  const picker = document.createElement('div');
  picker.className = 'slot-picker';

  const slotLabel = MEAL_SLOTS.find(s => s.id === slotId)?.label || slotId;
  const results   = searchRecipes(state.searchQuery, state.searchCategory);

  picker.innerHTML = `<div class="slot-picker-title">Seleccionar para ${slotLabel}</div>`;

  results.slice(0, 30).forEach(recipe => {
    const item = document.createElement('div');
    item.className = 'slot-picker-item';
    item.textContent = recipe.receta.nombre;
    item.addEventListener('click', () => {
      assignMeal(state.activeDay, slotId, recipe.id);
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
 * Familia → both Pablo and Juli get the same meal.
 */
function personsToWrite() {
  if (state.person === 'Familia') return ['Pablo', 'Juli'];
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

  const { receta } = recipe;
  const weekKey  = toWeekKey(new Date(dateKey + 'T12:00:00'));
  const mealData = {
    recipeId,
    recipeName: receta.nombre,
    macros:     { ...receta.macros_por_porcion },
  };

  for (const p of personsToWrite()) {
    setDeep(state.plan, p, weekKey, dateKey, slotId, mealData);
  }

  renderWeek();
  if (state.activeDay === dateKey) refreshDayDetail();

  try {
    const result = await savePlan(state.plan);
    const extra = state.person === 'Familia' ? ' (Pablo + Juli)' : '';
    showToast(
      result.saved === 'github'
        ? `✅ Guardado en GitHub${extra}`
        : `💾 Guardado localmente${extra}`,
      result.saved === 'github' ? 'success' : ''
    );
  } catch (e) {
    showToast('⚠️ Error al guardar: ' + e.message, 'error');
  }
}

async function removeMeal(dateKey, slotId) {
  const weekKey = toWeekKey(new Date(dateKey + 'T12:00:00'));

  for (const p of personsToWrite()) {
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
    const result = await savePlan(state.plan);
    showToast(
      result.saved === 'github' ? '✅ Guardado en GitHub' : '💾 Guardado localmente',
      result.saved === 'github' ? 'success' : ''
    );
  } catch (e) {
    showToast('⚠️ Error al guardar', 'error');
  }
}

// ══════════════════════════════════════════════════════════
// RECIPE MODAL
// ══════════════════════════════════════════════════════════

function openRecipeModal(recipeId) {
  const recipe = getRecipeById(recipeId);
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

  const updated = deleteRecipe(id);
  renderSidebar();
  renderWeek(); // calorie bars might reference this recipe

  try {
    const result = await saveRecipes(updated);
    showToast(
      result.saved === 'github' ? '🗑 Receta eliminada (GitHub)' : '🗑 Receta eliminada (local)',
      ''
    );
  } catch (e) {
    showToast('⚠️ Error al guardar: ' + e.message, 'error');
  }
}

// ── Editor modal ──────────────────────────────────────────

function openRecipeEditor() {
  resetEditorForm();
  document.getElementById('recipe-editor-title').textContent = 'Nueva receta';
  document.getElementById('modal-recipe-editor').classList.remove('hidden');
  // Start with one blank ingredient and one blank step
  addIngredientRow();
  addStepRow();
}

function closeRecipeEditor() {
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

function addIngredientRow(item = '', cantidad = '', unidad = '') {
  const list = document.getElementById('ingredients-list');
  const row  = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <input class="ingr-item"  type="text"   placeholder="Ingrediente" value="${item}" />
    <input class="ingr-qty"   type="number" placeholder="Cant." value="${cantidad}" min="0" step="0.1" />
    <input class="ingr-unit"  type="text"   placeholder="Unidad" value="${unidad}" />
    <button class="btn-del-row" title="Eliminar">✕</button>
  `;
  row.querySelector('.btn-del-row').addEventListener('click', () => row.remove());
  list.appendChild(row);
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

  const updated = addRecipe(data);
  renderSidebar();
  closeRecipeEditor();

  try {
    const result = await saveRecipes(updated);
    showToast(
      result.saved === 'github' ? '✅ Receta guardada (GitHub)' : '💾 Receta guardada (local)',
      'success'
    );
  } catch (e) {
    showToast('⚠️ Error al guardar: ' + e.message, 'error');
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

  // Accept { receta: {...} }, { recetas: [...] }, or bare array
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
    const result = await saveRecipes(updated || getAllRecipes());
    showToast(
      result.saved === 'github'
        ? `✅ ${entries.length} receta(s) guardada(s) en GitHub`
        : `💾 ${entries.length} receta(s) guardada(s) localmente`,
      'success'
    );
  } catch (e) {
    showToast('⚠️ Error al guardar: ' + e.message, 'error');
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

function openAuthModal() {
  const { owner, repo } = getCredentials();
  if (owner) document.getElementById('input-gh-owner').value = owner;
  if (repo)  document.getElementById('input-gh-repo').value  = repo;
  document.getElementById('modal-auth').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('modal-auth').classList.add('hidden');
}

async function saveAuth() {
  const token = document.getElementById('input-gh-token').value.trim();
  const owner = document.getElementById('input-gh-owner').value.trim();
  const repo  = document.getElementById('input-gh-repo').value.trim();

  if (!token || !owner || !repo) {
    showToast('Completá todos los campos', 'error');
    return;
  }

  saveCredentials({ token, owner, repo });

  try {
    await testConnection();
    // Reload plan from GitHub
    state.plan = await fetchPlan();
    renderWeek();
    updateAuthUI();
    closeAuthModal();
    showToast('✅ Conectado a GitHub', 'success');
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}

function updateAuthUI() {
  const btn = document.getElementById('btn-github-auth');
  const status = document.getElementById('auth-status');

  if (isAuthenticated()) {
    const { owner, repo } = getCredentials();
    btn.textContent = '⚡ GitHub conectado';
    btn.classList.add('connected');
    status.textContent = `${owner}/${repo}`;
  } else {
    btn.textContent = 'Conectar GitHub';
    btn.classList.remove('connected');
    status.textContent = '(sin conexión — guardado local)';
  }
}

// ══════════════════════════════════════════════════════════
// CONTROLS WIRING
// ══════════════════════════════════════════════════════════

function wireControls() {
  // Person switcher
  document.querySelectorAll('.person-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.person-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.person = btn.dataset.person;
      state.activeDay = null;
      document.getElementById('day-detail').classList.add('hidden-panel');
      renderWeek();
    });
  });

  // Week navigation
  document.getElementById('btn-prev-week').addEventListener('click', () => {
    state.anchorDate = new Date(state.anchorDate);
    state.anchorDate.setDate(state.anchorDate.getDate() - 7);
    renderWeek();
  });
  document.getElementById('btn-next-week').addEventListener('click', () => {
    state.anchorDate = new Date(state.anchorDate);
    state.anchorDate.setDate(state.anchorDate.getDate() + 7);
    renderWeek();
  });

  // Sidebar toggle — hamburger stays visible when collapsed
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
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

  // Category filter chips
  document.getElementById('filter-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.searchCategory = chip.dataset.cat;
    renderSidebar();
  });

  // Close day detail
  document.getElementById('btn-close-detail').addEventListener('click', closeDayDetail);

  // Recipe modal
  document.getElementById('btn-close-modal').addEventListener('click', closeRecipeModal);
  document.querySelector('#modal-recipe .modal-backdrop').addEventListener('click', closeRecipeModal);

  // Recipe editor
  document.getElementById('btn-add-recipe').addEventListener('click', openRecipeEditor);
  document.getElementById('btn-close-recipe-editor').addEventListener('click', closeRecipeEditor);
  document.querySelector('#modal-recipe-editor .modal-backdrop').addEventListener('click', closeRecipeEditor);
  document.getElementById('btn-save-recipe').addEventListener('click', saveRecipeFromForm);
  document.getElementById('btn-save-json-recipe').addEventListener('click', saveRecipeFromJSON);
  document.getElementById('btn-load-json').addEventListener('click', previewJSON);
  document.getElementById('btn-add-ingredient').addEventListener('click', () => addIngredientRow());
  document.getElementById('btn-add-step').addEventListener('click', () => addStepRow());

  // Editor tabs
  document.querySelectorAll('.editor-tab').forEach(tab => {
    tab.addEventListener('click', () => setEditorTab(tab.dataset.tab));
  });

  // Auth
  document.getElementById('btn-github-auth').addEventListener('click', openAuthModal);
  document.getElementById('btn-close-auth-modal').addEventListener('click', closeAuthModal);
  document.querySelector('#modal-auth .modal-backdrop').addEventListener('click', closeAuthModal);
  document.getElementById('btn-save-auth').addEventListener('click', saveAuth);

  // ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRecipeModal();
      closeAuthModal();
      closeRecipeEditor();
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
