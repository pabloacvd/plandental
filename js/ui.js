/**
 * ui.js — rendering helpers (recipe cards, calendar, day detail, modals)
 */

import { MEAL_SLOTS, DAY_NAMES_SHORT, MONTH_NAMES, computeDayMacros, toDateKey } from './calendar.js';

// ── Category → CSS class mapping ─────────────────────────

function catClass(cat = '') {
  const c = cat.toLowerCase();
  if (c.includes('desayuno'))    return 'cat--desayuno';
  if (c.includes('snack'))       return 'cat--snack';
  if (c.includes('liviana'))     return 'cat--liviana';
  if (c.includes('almuerzo'))    return 'cat--almuerzo';
  return 'cat--cena';
}

function catLabel(cat = '') {
  const c = cat.toLowerCase();
  if (c.includes('desayuno'))    return 'Desayuno';
  if (c.includes('snack'))       return 'Snack';
  if (c.includes('liviana'))     return 'Liviana';
  if (c.includes('almuerzo') && c.includes('cena')) return 'Alm/Cena';
  if (c.includes('almuerzo'))    return 'Almuerzo';
  return 'Cena';
}

// ── Recipe Card (sidebar) ─────────────────────────────────

export function renderRecipeCard(recipeObj) {
  const { id, receta } = recipeObj;
  const { nombre, descripcion_breve, categoria, macros_por_porcion } = receta;
  const m = macros_por_porcion;

  const card = document.createElement('div');
  card.className = 'recipe-card';
  card.draggable = true;
  card.dataset.recipeId = id;
  card.dataset.recipeName = nombre;

  card.innerHTML = `
    <span class="recipe-card-cat ${catClass(categoria)}">${catLabel(categoria)}</span>
    <div class="recipe-card-name">${nombre}</div>
    <div class="recipe-card-macros">
      <span>🔥 ${m.calorias} kcal</span>
      <span>💪 ${m.proteina_g}g prot</span>
      <span>🌾 ${m.carbohidratos_g}g carbs</span>
      <span>🧈 ${m.grasas_g}g grasas</span>
    </div>
    <button class="recipe-card-info"   data-info="${id}"   title="Ver receta">ℹ</button>
    <button class="recipe-card-edit"   data-edit="${id}"   title="Editar receta">✏️</button>
    <button class="recipe-card-delete" data-delete="${id}" title="Eliminar receta">🗑</button>
  `;
  return card;
}

// ── Recipe Detail Modal content ───────────────────────────

export function renderRecipeDetail(recipeObj) {
  const { receta } = recipeObj;
  const { nombre, descripcion_breve, porciones, macros_por_porcion: m, ingredientes, paso_a_paso } = receta;

  return `
    <div class="recipe-detail-name">${nombre}</div>
    <div class="recipe-detail-desc">${descripcion_breve}</div>
    <div class="recipe-detail-macros">
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--orange)">${m.calorias}</div>
        <div class="macro-box-lbl">kcal</div>
      </div>
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--accent)">${m.proteina_g}g</div>
        <div class="macro-box-lbl">proteína</div>
      </div>
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--green)">${m.carbohidratos_g}g</div>
        <div class="macro-box-lbl">carbos</div>
      </div>
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--purple)">${m.grasas_g}g</div>
        <div class="macro-box-lbl">grasas</div>
      </div>
    </div>
    <p style="font-size:.75rem;color:var(--text-muted);margin-bottom:10px">Porciones: ${porciones}</p>
    <div class="recipe-detail-section">Ingredientes</div>
    <table class="ingredient-table">
      ${ingredientes.map(ing => `
        <tr>
          <td>${ing.item}</td>
          <td>${ing.cantidad} ${ing.unidad}</td>
        </tr>
      `).join('')}
    </table>
    <div class="recipe-detail-section">Preparación</div>
    <ol class="step-list">
      ${paso_a_paso.map((step, i) => `
        <li><span class="step-num">${i + 1}</span><span>${step}</span></li>
      `).join('')}
    </ol>
  `;
}

// ── Calendar grid ─────────────────────────────────────────

/**
 * For the Familia view we merge both Pablo+Juli entries.
 * If they share the same meal for a slot, show it once; otherwise show both.
 */
function getDayEntry(planData, person, weekKey, dateKey) {
  if (person === 'Familia') {
    const pablo = planData?.['Pablo']?.[weekKey]?.[dateKey] || {};
    const juli  = planData?.['Juli']?.[weekKey]?.[dateKey]  || {};
    const merged = { ...pablo };
    // Add Juli's meals that are different or missing from Pablo
    for (const slotId of Object.keys(juli)) {
      if (!merged[slotId] || merged[slotId].recipeId !== juli[slotId].recipeId) {
        // Different meal — append as a virtual slot so it shows as an extra pill
        merged[`${slotId}_juli`] = juli[slotId];
      }
    }
    return merged;
  }
  return planData?.[person]?.[weekKey]?.[dateKey] || {};
}

export function renderCalendarGrid({
  weekDays,
  planData,
  person,
  weekKey,
  activeDay,
  onDayClick,
  onRemoveMeal,
  onDropDay,
  onRecipeClick,
}) {
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const today = toDateKey(new Date());

  weekDays.forEach((date, idx) => {
    const dateKey  = toDateKey(date);
    const dayEntry = getDayEntry(planData, person, weekKey, dateKey);
    const macros   = computeDayMacros(dayEntry);

    const cell = document.createElement('div');
    cell.className = 'day-cell';
    cell.dataset.dateKey = dateKey;
    if (dateKey === today)     cell.classList.add('today');
    if (dateKey === activeDay) cell.classList.add('active');

    // Header
    const header = document.createElement('div');
    header.className = 'day-cell-header';
    header.innerHTML = `
      <span class="day-name">${DAY_NAMES_SHORT[idx]}</span>
      ${dateKey === today ? '<span class="today-badge">Hoy</span>' : ''}
    `;
    const dateNum = document.createElement('div');
    dateNum.className = 'day-date';
    dateNum.textContent = date.getDate();
    header.appendChild(dateNum);
    cell.appendChild(header);

    // Meal pills
    const mealsDiv = document.createElement('div');
    mealsDiv.className = 'day-meals-summary';

    // Build a quick icon lookup for standard slot IDs
    const slotIconMap = Object.fromEntries(MEAL_SLOTS.map(s => [s.id, s.icon]));

    // Iterate over all keys (including virtual _juli keys from Familia merge)
    Object.entries(dayEntry).forEach(([key, meal]) => {
      if (!meal) return;
      // Derive the base slot id (strip _juli suffix) for the icon
      const baseSlotId = key.endsWith('_juli') ? key.slice(0, -5) : key;
      const icon = slotIconMap[baseSlotId] || '🍽️';
      const pill = document.createElement('div');
      pill.className = 'meal-pill';
      pill.innerHTML = `
        <span class="meal-pill-slot">${icon}</span>
        <span class="meal-pill-name meal-pill-name--link" data-recipe-id="${meal.recipeId}" title="Ver receta: ${meal.recipeName}">${meal.recipeName}</span>
        <button class="meal-pill-remove" data-date="${dateKey}" data-slot="${key}" title="Quitar">✕</button>
      `;
      mealsDiv.appendChild(pill);
    });

    cell.appendChild(mealsDiv);

    // Drop hint
    const dropHint = document.createElement('div');
    dropHint.className = 'day-drop-hint';
    dropHint.textContent = 'Soltar aquí';
    cell.appendChild(dropHint);

    // Calorie bar
    cell.appendChild(buildKcalBar(macros.calorias));

    // Events
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.meal-pill-remove')) return;
      if (e.target.closest('.meal-pill-name--link')) return;
      onDayClick(dateKey);
    });

    // Recipe name clicks inside pills
    mealsDiv.querySelectorAll('.meal-pill-name--link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onRecipeClick && el.dataset.recipeId) onRecipeClick(el.dataset.recipeId);
      });
    });

    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', () => {
      cell.classList.remove('drop-target');
    });
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop-target');
      const recipeId = e.dataTransfer.getData('recipeId');
      if (recipeId) onDropDay(dateKey, recipeId);
    });

    // Remove buttons
    mealsDiv.querySelectorAll('.meal-pill-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onRemoveMeal(btn.dataset.date, btn.dataset.slot);
      });
    });

    grid.appendChild(cell);
  });
}

function buildKcalBar(kcal) {
  const wrapper = document.createElement('div');
  wrapper.className = 'day-kcal-bar';
  if (kcal === 0) return wrapper;

  wrapper.innerHTML = `
    <div class="kcal-label">
      <span>Kcal</span>
      <span>${Math.round(kcal)}</span>
    </div>
    <div class="kcal-track">
      <div class="kcal-fill" style="width:0%"></div>
    </div>
  `;
  return wrapper;
}

/**
 * Update calorie bar widths after rendering (needs nutrition data).
 * In Familia mode we show Pablo's bar (they eat the same).
 */
export function updateKcalBars(weekDays, planData, person, weekKey, nutrition) {
  const effectivePerson = person === 'Familia' ? 'Pablo' : person;
  const target = nutrition?.daily_calories_kcal || 2000;

  weekDays.forEach(date => {
    const dateKey  = toDateKey(date);
    const dayEntry = planData?.[effectivePerson]?.[weekKey]?.[dateKey] || {};
    const macros   = computeDayMacros(dayEntry);
    const pct      = Math.min((macros.calorias / target) * 100, 100);

    const cell = document.querySelector(`.day-cell[data-date-key="${dateKey}"]`);
    if (!cell) return;

    const fill = cell.querySelector('.kcal-fill');
    if (!fill) return;

    fill.style.width = pct + '%';
    fill.classList.toggle('over',  macros.calorias > target * 1.05);
    fill.classList.toggle('close', macros.calorias > target * 0.9 && macros.calorias <= target * 1.05);
  });
}

// ── Day detail panel ──────────────────────────────────────

export function renderDayDetail({
  dateKey,
  dayEntry,
  pabloEntry,   // only set in Familia mode
  juliEntry,    // only set in Familia mode
  nutrition,
  person,
  nutritionAll,
  onRemoveMeal,
  onAddMealToSlot,
}) {
  const date  = new Date(dateKey + 'T12:00:00');
  const label = `${DAY_NAMES_SHORT[(date.getDay() + 6) % 7]} ${date.getDate()} de ${MONTH_NAMES[date.getMonth()]}`;

  document.getElementById('detail-day-label').textContent =
    person === 'Familia' ? `👨‍👩 ${label}` : label;

  const slotsEl   = document.getElementById('meal-slots');
  const summaryEl = document.getElementById('day-summary');
  slotsEl.innerHTML = '';

  if (person === 'Familia') {
    // ── Family mode: show all slots that have a meal for either person ──
    MEAL_SLOTS.forEach(slot => {
      const pMeal = pabloEntry?.[slot.id] || null;
      const jMeal = juliEntry?.[slot.id]  || null;

      // Only show the slot if at least one person has something, OR always show all slots
      const hasMeal = pMeal || jMeal;
      const sameRecipe = pMeal && jMeal && pMeal.recipeId === jMeal.recipeId;

      const card = document.createElement('div');
      card.className = 'slot-card' + (hasMeal ? ' has-meal' : '');
      card.dataset.slot = slot.id;

      const titleEl = `<div class="slot-title">${slot.icon} ${slot.label}</div>`;

      if (sameRecipe) {
        // Same meal for both — show once with a "los dos" label
        const m = pMeal.macros || {};
        card.innerHTML = `
          ${titleEl}
          <div class="slot-family-shared">
            <span class="slot-family-badge shared-badge">🏋️🌸 Los dos</span>
            <div class="slot-meal-name">${pMeal.recipeName}</div>
            <div class="slot-meal-macros">
              <span>🔥 ${m.calorias || 0} kcal</span>
              <span>💪 ${m.proteina_g || 0}g</span>
            </div>
          </div>
          <div class="slot-actions">
            <button class="slot-btn remove" data-person="both">Quitar a los dos</button>
          </div>
        `;
        card.querySelector('.slot-btn.remove').addEventListener('click', () => {
          onRemoveMeal(dateKey, slot.id, null); // null = both
        });
      } else {
        // Different meals (or only one has a meal) — show two rows
        card.innerHTML = `
          ${titleEl}
          <div class="slot-family-rows">
            ${buildPersonMealHTML(pMeal, 'Pablo', 'pablo', slot.id)}
            ${buildPersonMealHTML(jMeal, 'Juli',  'juli',  slot.id)}
          </div>
        `;
        card.querySelector('.slot-btn-remove-pablo')?.addEventListener('click', () => {
          onRemoveMeal(dateKey, slot.id, 'Pablo');
        });
        card.querySelector('.slot-btn-remove-juli')?.addEventListener('click', () => {
          onRemoveMeal(dateKey, slot.id, 'Juli');
        });
        card.querySelector('.slot-btn-add-pablo')?.addEventListener('click', () => {
          onAddMealToSlot(slot.id, null, 'Pablo');
        });
        card.querySelector('.slot-btn-add-juli')?.addEventListener('click', () => {
          onAddMealToSlot(slot.id, null, 'Juli');
        });
      }

      // Drop zone — assigns to both when dragged in family mode
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drop-target');
        const recipeId = e.dataTransfer.getData('recipeId');
        if (recipeId) onAddMealToSlot(slot.id, recipeId, null); // null = both
      });

      slotsEl.appendChild(card);
    });

    renderFamilySummary(pabloEntry, juliEntry, nutritionAll, summaryEl);

  } else {
    // ── Single person mode ──
    MEAL_SLOTS.forEach(slot => {
      const meal = dayEntry?.[slot.id];
      const card = document.createElement('div');
      card.className = 'slot-card' + (meal ? ' has-meal' : '');
      card.dataset.slot = slot.id;

      if (meal) {
        const m = meal.macros || {};
        card.innerHTML = `
          <div class="slot-title">${slot.icon} ${slot.label}</div>
          <div class="slot-meal-name">${meal.recipeName}</div>
          <div class="slot-meal-macros">
            <span>🔥 ${m.calorias || 0} kcal</span>
            <span>💪 ${m.proteina_g || 0}g</span>
            <span>🌾 ${m.carbohidratos_g || 0}g</span>
            <span>🧈 ${m.grasas_g || 0}g</span>
          </div>
          <div class="slot-actions">
            <button class="slot-btn remove" data-slot="${slot.id}">Quitar</button>
          </div>
        `;
        card.querySelector('.slot-btn.remove').addEventListener('click', () => {
          onRemoveMeal(dateKey, slot.id);
        });
      } else {
        card.innerHTML = `
          <div class="slot-title">${slot.icon} ${slot.label}</div>
          <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:.75rem;">
            Arrastrá una receta aquí
          </div>
          <div class="slot-actions">
            <button class="slot-btn add-btn" data-slot="${slot.id}">+ Agregar</button>
          </div>
        `;
        card.querySelector('.add-btn').addEventListener('click', () => {
          onAddMealToSlot(slot.id);
        });
      }

      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drop-target');
        const recipeId = e.dataTransfer.getData('recipeId');
        if (recipeId) onAddMealToSlot(slot.id, recipeId);
      });

      slotsEl.appendChild(card);
    });

    renderDaySummary(dayEntry, nutrition, summaryEl);
  }
}

function buildPersonMealHTML(meal, personName, cls, slotId) {
  if (meal) {
    const m = meal.macros || {};
    return `
      <div class="slot-family-person-row has-meal-row">
        <span class="slot-family-badge ${cls}-badge">${personName === 'Pablo' ? '🏋️' : '🌸'} ${personName}</span>
        <span class="slot-meal-name-sm">${meal.recipeName}</span>
        <span class="slot-meal-kcal">${m.calorias || 0} kcal</span>
        <button class="slot-btn-remove-${cls} slot-btn-icon" title="Quitar">✕</button>
      </div>
    `;
  } else {
    return `
      <div class="slot-family-person-row empty-row">
        <span class="slot-family-badge ${cls}-badge">${personName === 'Pablo' ? '🏋️' : '🌸'} ${personName}</span>
        <span class="slot-empty-text">Sin asignar</span>
        <button class="slot-btn-add-${cls} slot-btn-add-sm" title="Agregar">+ Agregar</button>
      </div>
    `;
  }
}

// ── Single-person day summary ─────────────────────────────

export function renderDaySummary(dayEntry, nutrition, container) {
  const macros = computeDayMacros(dayEntry);

  const stats = [
    {
      label: 'Calorías',
      value: `${Math.round(macros.calorias)} kcal`,
      target: nutrition?.daily_calories_kcal || null,
      current: macros.calorias,
      unit: 'kcal',
      color: 'var(--orange)',
    },
    {
      label: 'Proteína',
      value: `${macros.proteina_g} g`,
      target: nutrition?.protein_g || null,
      current: macros.proteina_g,
      unit: 'g',
      color: 'var(--accent)',
    },
    {
      label: 'Carbohidratos',
      value: `${macros.carbohidratos_g} g`,
      target: nutrition?.carbs_g || null,
      current: macros.carbohidratos_g,
      unit: 'g',
      color: 'var(--green)',
    },
    {
      label: 'Grasas',
      value: `${macros.grasas_g} g`,
      target: nutrition?.fat_g || null,
      current: macros.grasas_g,
      unit: 'g',
      color: 'var(--purple)',
    },
  ];

  container.innerHTML = stats.map(s => {
    const pct = s.target ? Math.min((s.current / s.target) * 100, 100) : null;
    return `
      <div class="summary-stat">
        <div class="summary-stat-label">${s.label}</div>
        <div class="summary-stat-value" style="color:${s.color}">${s.value}</div>
        ${s.target ? `<div class="summary-stat-sub">meta: ${s.target} ${s.unit}</div>` : ''}
        ${pct !== null ? `
          <div class="summary-stat-bar">
            <div class="summary-stat-bar-fill"
                 style="width:${pct.toFixed(1)}%;background:${s.color}">
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ── Family day summary (Pablo + Juli side by side) ────────

function renderFamilySummary(pabloEntry, juliEntry, nutritionAll, container) {
  const pMacros = computeDayMacros(pabloEntry);
  const jMacros = computeDayMacros(juliEntry);
  const pablo   = nutritionAll?.Pablo || {};
  const juli    = nutritionAll?.Juli  || {};

  const rows = [
    { label: 'Calorías',      key: 'calorias',           pabloTarget: pablo.daily_calories_kcal, juliTarget: juli.daily_calories_kcal, unit: 'kcal', color: 'var(--orange)' },
    { label: 'Proteína',      key: 'proteina_g',          pabloTarget: pablo.protein_g,           juliTarget: juli.protein_g,           unit: 'g',    color: 'var(--accent)' },
    { label: 'Carbohidratos', key: 'carbohidratos_g',     pabloTarget: pablo.carbs_g,             juliTarget: juli.carbs_g,             unit: 'g',    color: 'var(--green)'  },
    { label: 'Grasas',        key: 'grasas_g',            pabloTarget: pablo.fat_g,               juliTarget: juli.fat_g,               unit: 'g',    color: 'var(--purple)' },
  ];

  const pct  = (val, target) => target ? Math.min((val / target) * 100, 100).toFixed(1) : 0;
  const disp = (val, unit)   => unit === 'kcal' ? `${Math.round(val)} ${unit}` : `${val} ${unit}`;

  container.innerHTML = `
    <div class="family-summary">
      <div class="family-summary-header">
        <div></div>
        <div class="family-col-label pablo-col">🏋️ Pablo</div>
        <div class="family-col-label juli-col">🌸 Juli</div>
      </div>
      ${rows.map(r => {
        const pVal  = pMacros[r.key] ?? 0;
        const jVal  = jMacros[r.key] ?? 0;
        const pPct  = pct(pVal, r.pabloTarget);
        const jPct  = pct(jVal, r.juliTarget);
        return `
          <div class="family-summary-row">
            <div class="family-row-label" style="color:${r.color}">${r.label}</div>
            <div class="family-row-cell">
              <div class="family-row-value">${disp(pVal, r.unit)}</div>
              ${r.pabloTarget ? `<div class="family-row-sub">meta: ${r.pabloTarget} ${r.unit}</div>` : ''}
              ${r.pabloTarget ? `<div class="summary-stat-bar"><div class="summary-stat-bar-fill" style="width:${pPct}%;background:${r.color}"></div></div>` : ''}
            </div>
            <div class="family-row-cell">
              <div class="family-row-value">${disp(jVal, r.unit)}</div>
              ${r.juliTarget ? `<div class="family-row-sub">meta: ${r.juliTarget} ${r.unit}</div>` : ''}
              ${r.juliTarget ? `<div class="summary-stat-bar"><div class="summary-stat-bar-fill" style="width:${jPct}%;background:${r.color}"></div></div>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ── Toast ─────────────────────────────────────────────────

let _toastTimer = null;

export function showToast(message, type = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${type ? ' ' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 3000);
}
