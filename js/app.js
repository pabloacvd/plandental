/**
 * app.js — main entry point, wires everything together
 */

import { loadData, searchRecipes, getRecipeById, addRecipe, updateRecipe, deleteRecipe, getAllRecipes, slugify } from './recipes.js';
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
// MOBILE DETECTION
// ══════════════════════════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 700;
}

// ══════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════

let state = {
  person:     'Familia',          // default
  anchorDate: new Date(),
  activeDay:  toDateKey(new Date()), // open today by default
  plan:       {},
  nutrition:  {},
  recipes:    [],
  searchQuery:    '',
  searchCategory: 'all',
  draggingRecipeId: null,
  // Mobile-only: which day index (0–6 in week) is shown
  mobileDayIndex: null,
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

  // Apply mobile defaults
  if (isMobile()) {
    // Collapse sidebar
    document.getElementById('sidebar').classList.add('collapsed');
    // Familia already in state; mark it in UI
    document.querySelectorAll('.person-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.person === 'Familia');
    });
    // Set mobile day index to today
    const weekDays = getWeekDays(state.anchorDate);
    state.mobileDayIndex = weekDays.findIndex(d => toDateKey(d) === toDateKey(new Date()));
    if (state.mobileDayIndex < 0) state.mobileDayIndex = 0;
  }

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

async function removeMeal(dateKey, slotId, targetPerson = null) {
  const weekKey = toWeekKey(new Date(dateKey + 'T12:00:00'));
  // If targetPerson is given (family individual remove), only remove for that person.
  // Otherwise use personsToWrite() which respects the current state.person.
  const persons = targetPerson ? [targetPerson] : personsToWrite();

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
    const result = await savePlan(state.plan);
    showToast(
      result.saved === 'github' ? '✅ Guardado en GitHub' : '💾 Guardado localmente',
      result.saved === 'github' ? 'success' : ''
    );
  } catch (e) {
    showToast('⚠️ Error al guardar', 'error');
  }
}

/**
 * Assign a meal to a single specific person (used in Familia mode per-person slots).
 */
async function assignMealForPerson(dateKey, slotId, recipeId, targetPerson) {
  const recipe = getRecipeById(recipeId);
  if (!recipe) return;
  const { receta } = recipe;
  const weekKey  = toWeekKey(new Date(dateKey + 'T12:00:00'));
  const mealData = { recipeId, recipeName: receta.nombre, macros: { ...receta.macros_por_porcion } };
  const persons  = targetPerson ? [targetPerson] : ['Pablo', 'Juli'];
  for (const p of persons) {
    setDeep(state.plan, p, weekKey, dateKey, slotId, mealData);
  }
  renderWeek();
  if (state.activeDay === dateKey) refreshDayDetail();
  try {
    const result = await savePlan(state.plan);
    showToast(
      result.saved === 'github' ? `✅ Guardado (${persons.join('+')})` : `💾 Guardado localmente`,
      result.saved === 'github' ? 'success' : ''
    );
  } catch (e) {
    showToast('⚠️ Error al guardar: ' + e.message, 'error');
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

// null when creating a new recipe; recipe id string when editing an existing one
let _editingRecipeId = null;

function openRecipeEditor() {
  _editingRecipeId = null;
  resetEditorForm();
  document.getElementById('recipe-editor-title').textContent = 'Nueva receta';
  document.getElementById('modal-recipe-editor').classList.remove('hidden');
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
  (receta.ingredientes || []).forEach(ing => {
    addIngredientRow(ing.item, ing.cantidad, ing.unidad);
  });
  if (!(receta.ingredientes || []).length) addIngredientRow();

  // Steps
  (receta.paso_a_paso || []).forEach(step => addStepRow(step));
  if (!(receta.paso_a_paso || []).length) addStepRow();

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

  const isEditing = !!_editingRecipeId;
  const updated   = isEditing
    ? updateRecipe(_editingRecipeId, data)
    : addRecipe(data);

  renderSidebar();
  renderWeek(); // refresh kcal bars in case macros changed
  closeRecipeEditor();

  try {
    const result = await saveRecipes(updated);
    showToast(
      result.saved === 'github'
        ? (isEditing ? '✅ Receta actualizada (GitHub)' : '✅ Receta guardada (GitHub)')
        : (isEditing ? '💾 Receta actualizada (local)'  : '💾 Receta guardada (local)'),
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
      const result = await saveRecipes(updated);
      showToast(
        result.saved === 'github' ? '✅ Receta actualizada (GitHub)' : '💾 Receta actualizada (local)',
        'success'
      );
    } catch (e) {
      showToast('⚠️ Error al guardar: ' + e.message, 'error');
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
  const connected = isAuthenticated();
  const { owner, repo } = connected ? getCredentials() : {};

  // Desktop header button
  const btn    = document.getElementById('btn-github-auth');
  const status = document.getElementById('auth-status');
  if (connected) {
    btn.textContent = '⚡ GitHub conectado';
    btn.classList.add('connected');
    status.textContent = `${owner}/${repo}`;
  } else {
    btn.textContent = 'Conectar GitHub';
    btn.classList.remove('connected');
    status.textContent = '(sin conexión — guardado local)';
  }

  // Footer button (mobile)
  const btnF    = document.getElementById('btn-github-auth-footer');
  const statusF = document.getElementById('auth-status-footer');
  if (connected) {
    btnF.textContent = '⚡ Conectado';
    btnF.classList.add('connected');
    statusF.textContent = `${owner}/${repo}`;
  } else {
    btnF.textContent = 'Conectar GitHub';
    btnF.classList.remove('connected');
    statusF.textContent = '';
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
      if (!isMobile()) {
        state.activeDay = null;
        document.getElementById('day-detail').classList.add('hidden-panel');
      }
      renderWeek();
    });
  });

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

  // Sidebar toggle — hamburger; on mobile also shows/hides overlay
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    const sidebar  = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    sidebar.classList.toggle('collapsed');
    if (isMobile()) {
      backdrop.classList.toggle('hidden', sidebar.classList.contains('collapsed'));
    }
  });

  // Sidebar backdrop tap → close sidebar
  document.getElementById('sidebar-backdrop').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-backdrop').classList.add('hidden');
  });

  // Footer auth button (mobile)
  document.getElementById('btn-github-auth-footer').addEventListener('click', openAuthModal);

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
