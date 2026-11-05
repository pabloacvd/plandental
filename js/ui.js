/**
 * ui.js — rendering helpers (recipe cards, calendar, day detail, modals)
 */

import { MEAL_SLOTS, DAY_NAMES_SHORT, MONTH_NAMES, computeDayMacros, toDateKey } from './calendar.js';
import { sameMealVersion } from './plan-versions.js';

/** Escape text before interpolating it into innerHTML (recipe data comes from the DB). */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Category → CSS class mapping ─────────────────────────

function catClass(cat = '') {
  const c = cat.toLowerCase();
  if (c.includes('desayuno'))    return 'cat--desayuno';
  if (c.includes('snack'))       return 'cat--snack';
  if (c.includes('almuerzo'))    return 'cat--almuerzo';
  return 'cat--cena';
}

function catLabel(cat = '') {
  const c = cat.toLowerCase();
  if (c.includes('desayuno'))    return 'Desayuno';
  if (c.includes('snack'))       return 'Snack';
  if (c.includes('almuerzo') && c.includes('cena')) return 'Alm/Cena';
  if (c.includes('almuerzo'))    return 'Almuerzo';
  return 'Cena';
}

// ── Recipe Card (sidebar) ─────────────────────────────────

export function renderRecipeCard(recipeObj) {
  const { id, receta } = recipeObj;
  const nombre = receta?.nombre || receta?.plato || 'Receta sin nombre';
  const categoria = receta?.categoria || '';
  const m = receta?.macros_por_porcion || {
    calorias: receta?.totales?.calorias_kcal || 0,
    proteina_g: receta?.totales?.proteinas_g || 0,
    carbohidratos_g: receta?.totales?.carbohidratos_g || 0,
    grasas_g: receta?.totales?.grasas_g || 0,
  };

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
  const { receta = {} } = recipeObj;
  const nombre = receta.nombre || receta.plato || 'Receta sin nombre';
  const descripcion_breve = receta.descripcion_breve || '';
  const porciones = receta.porciones || 1;
  const m = receta.macros_por_porcion || {
    calorias: receta.totales?.calorias_kcal || 0,
    proteina_g: receta.totales?.proteinas_g || 0,
    carbohidratos_g: receta.totales?.carbohidratos_g || 0,
    grasas_g: receta.totales?.grasas_g || 0,
  };
  const { ingredientes, paso_a_paso, pasos, instrucciones } = receta;
  const safeIngredientes = Array.isArray(ingredientes) ? ingredientes : [];
  const safePasoAPaso   = Array.isArray(paso_a_paso) ? paso_a_paso
                        : Array.isArray(pasos)        ? pasos
                        : Array.isArray(instrucciones) ? instrucciones
                        : [];

  return `
    <div class="recipe-detail-name">${esc(nombre)}</div>
    <div class="recipe-detail-desc">${esc(descripcion_breve)}</div>
    <div class="recipe-detail-macros">
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--orange)">${esc(m.calorias)}</div>
        <div class="macro-box-lbl">kcal</div>
      </div>
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--accent)">${esc(m.proteina_g)}g</div>
        <div class="macro-box-lbl">proteína</div>
      </div>
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--green)">${esc(m.carbohidratos_g)}g</div>
        <div class="macro-box-lbl">carbos</div>
      </div>
      <div class="macro-box">
        <div class="macro-box-val" style="color:var(--purple)">${esc(m.grasas_g)}g</div>
        <div class="macro-box-lbl">grasas</div>
      </div>
    </div>
    <p style="font-size:.75rem;color:var(--text-muted);margin-bottom:10px">Porciones: ${esc(porciones)}</p>
    <div class="recipe-detail-section">Ingredientes</div>
    <table class="ingredient-table">
      ${safeIngredientes.map(ing => `
        <tr>
          <td>${esc(ing.nombre ?? ing.item ?? ing.ingrediente ?? '')}</td>
          <td>${esc(ing.cantidad ?? '')}${ing.unidad ? ' ' + esc(ing.unidad) : ''}</td>
        </tr>
      `).join('')}
    </table>
    <div class="recipe-detail-section">Preparación</div>
    <ol class="step-list">
      ${safePasoAPaso.map((step, i) => `
        <li><span class="step-num">${i + 1}</span><span>${esc(step)}</span></li>
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
      if (!merged[slotId] || !sameMealVersion(merged[slotId], juli[slotId])) {
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

    // Iterate in MEAL_SLOTS order (base slot first, then _juli counterpart if present)
    const orderedKeys = MEAL_SLOTS.flatMap(s => [s.id, `${s.id}_juli`])
      .filter(k => k in dayEntry);
    orderedKeys.forEach(key => {
      const meal = dayEntry[key];
      if (!meal) return;
      // Derive the base slot id (strip _juli suffix) for the icon
      const baseSlotId = key.endsWith('_juli') ? key.slice(0, -5) : key;
      const icon = slotIconMap[baseSlotId] || '🍽️';
      const pill = document.createElement('div');
      pill.className = 'meal-pill';
      pill.innerHTML = `
        <span class="meal-pill-slot">${icon}</span>
        <span class="meal-pill-name meal-pill-name--link" data-recipe-id="${esc(meal.recipeId)}" title="Ver receta: ${esc(meal.recipeName)}">${esc(meal.recipeName)}</span>
        <button class="meal-pill-remove" data-date="${dateKey}" data-slot="${key}" title="Quitar">✕</button>
      `;
      // The click opens THIS meal's version (snapshot), not the current recipe.
      pill.querySelector('.meal-pill-name--link').mealRef = meal;
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
        if (onRecipeClick && el.dataset.recipeId) onRecipeClick(el.dataset.recipeId, el.mealRef);
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
      const sameRecipe = pMeal && jMeal && sameMealVersion(pMeal, jMeal);

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
            <div class="slot-meal-name">${esc(pMeal.recipeName)}</div>
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
          <div class="slot-meal-name">${esc(meal.recipeName)}</div>
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
        <span class="slot-meal-name-sm">${esc(meal.recipeName)}</span>
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

// ── Summary bar helper ────────────────────────────────────

/**
 * Builds a summary bar. The fill is current/base (capped at 100%).
 * Each mark is positioned at value/base and drawn as a vertical line.
 * @param {number} current
 * @param {number|null} base   value that represents 100% of the bar
 * @param {string} color       fill colour
 * @param {Array<{value:?number, cls:string, title:string}>} marks
 */
function summaryBarHTML(current, base, color, marks = []) {
  if (!base) return '';
  const pct = Math.min((current / base) * 100, 100);
  const markHTML = marks
    .filter(m => m.value)
    .map(m => {
      const left = Math.min((m.value / base) * 100, 100).toFixed(1);
      return `<div class="summary-stat-bar-mark ${m.cls}" style="left:${left}%" title="${m.title}"></div>`;
    })
    .join('');
  return `
    <div class="summary-stat-bar">
      <div class="summary-stat-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
      ${markHTML}
    </div>
  `;
}

/** Calorie marks: daily target and minimum (BMR), both relative to maintenance. */
function calorieMarks(target, bmr) {
  return [
    { value: bmr,    cls: 'summary-stat-bar-bmr',    title: `Mínimo (TMB): ${bmr} kcal` },
    { value: target, cls: 'summary-stat-bar-target', title: `Objetivo diario: ${target} kcal` },
  ];
}

/** "TMB: x | meta: y | mant.: z kcal" — shows whichever values exist. */
function calorieSubText(n) {
  return [
    n.bmr    ? `TMB: ${n.bmr}`      : null,
    n.target ? `meta: ${n.target}`  : null,
    n.maint  ? `mant.: ${n.maint}`  : null,
  ].filter(Boolean).join(' &nbsp;|&nbsp; ') + ' kcal';
}

// ── Single-person day summary ─────────────────────────────

export function renderDaySummary(dayEntry, nutrition, container) {
  const macros = computeDayMacros(dayEntry);

  const stats = [
    {
      label: 'Calorías',
      value: `${Math.round(macros.calorias)} kcal`,
      target: nutrition?.daily_calories_kcal || null,
      bmr: nutrition?.bmr_kcal || null,
      maintenance: nutrition?.maintenance_kcal || null,
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
      label: 'Carbos',
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
    const isCal     = s.label === 'Calorías';
    // Calories: maintenance is 100% of the bar. Macros: the target is 100%.
    const base      = isCal ? s.maintenance : s.target;
    const barHTML   = summaryBarHTML(s.current, base, s.color, isCal ? calorieMarks(s.target, s.bmr) : []);
    const remaining = s.target != null ? s.target - s.current : null;
    const remRound  = remaining != null
      ? (s.unit === 'kcal' ? Math.round(remaining) : Math.round(remaining * 10) / 10)
      : null;
    const remColor  = remaining != null && remaining < 0 ? 'var(--red)' : 'var(--green)';
    const remLabel  = remaining != null && remaining < 0
      ? `Exceso: ${Math.abs(remRound)} ${s.unit}`
      : `Disponible: ${remRound} ${s.unit}`;
    const subLine   = isCal
      ? `<div class="summary-stat-sub">${calorieSubText({ bmr: s.bmr, target: s.target, maint: s.maintenance })}</div>`
      : s.target
        ? `<div class="summary-stat-sub">meta: ${s.target} ${s.unit}</div>`
        : '';
    return `
      <div class="summary-stat">
        <div class="summary-stat-label">${s.label}</div>
        <div class="summary-stat-value" style="color:${s.color}">${s.value}</div>
        ${subLine}
        ${barHTML}
        ${remRound !== null ? `<div class="summary-stat-remaining" style="color:${remColor}">${remLabel}</div>` : ''}
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
    { label: 'Calorías',      key: 'calorias',           pabloTarget: pablo.daily_calories_kcal, juliTarget: juli.daily_calories_kcal, pabloBmr: pablo.bmr_kcal || null, juliBmr: juli.bmr_kcal || null, pabloMaint: pablo.maintenance_kcal || null, juliMaint: juli.maintenance_kcal || null, unit: 'kcal', color: 'var(--orange)' },
    { label: 'Proteína',      key: 'proteina_g',          pabloTarget: pablo.protein_g,           juliTarget: juli.protein_g,           unit: 'g',    color: 'var(--accent)' },
    { label: 'Carbos',        key: 'carbohidratos_g',     pabloTarget: pablo.carbs_g,             juliTarget: juli.carbs_g,             unit: 'g',    color: 'var(--green)'  },
    { label: 'Grasas',        key: 'grasas_g',            pabloTarget: pablo.fat_g,               juliTarget: juli.fat_g,               unit: 'g',    color: 'var(--purple)' },
  ];

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
        const isCal = r.key === 'calorias';
        // Calories: maintenance is 100%. Macros: the target is 100%.
        const pBase = isCal ? r.pabloMaint : r.pabloTarget;
        const jBase = isCal ? r.juliMaint  : r.juliTarget;
        const pBar  = summaryBarHTML(pVal, pBase, r.color, isCal ? calorieMarks(r.pabloTarget, r.pabloBmr) : []);
        const jBar  = summaryBarHTML(jVal, jBase, r.color, isCal ? calorieMarks(r.juliTarget,  r.juliBmr)  : []);

        const remDisp = (val, target, unit) => {
          if (!target) return '';
          const rem   = target - val;
          const round = unit === 'kcal' ? Math.round(rem) : Math.round(rem * 10) / 10;
          const color = rem < 0 ? 'var(--red)' : 'var(--green)';
          const label = rem < 0 ? `Exceso: ${Math.abs(round)} ${unit}` : `Disponible: ${round} ${unit}`;
          return `<div class="family-row-remaining" style="color:${color}">${label}</div>`;
        };

        const pSubLine = isCal
          ? `<div class="family-row-sub">${calorieSubText({ bmr: r.pabloBmr, target: r.pabloTarget, maint: r.pabloMaint })}</div>`
          : r.pabloTarget ? `<div class="family-row-sub">meta: ${r.pabloTarget} ${r.unit}</div>` : '';
        const jSubLine = isCal
          ? `<div class="family-row-sub">${calorieSubText({ bmr: r.juliBmr, target: r.juliTarget, maint: r.juliMaint })}</div>`
          : r.juliTarget ? `<div class="family-row-sub">meta: ${r.juliTarget} ${r.unit}</div>` : '';
        return `
          <div class="family-summary-row">
            <div class="family-row-label" style="color:${r.color}">${r.label}</div>
            <div class="family-row-cell">
              <div class="family-row-value">${disp(pVal, r.unit)}</div>
              ${pSubLine}
              ${pBar}
              ${remDisp(pVal, r.pabloTarget, r.unit)}
            </div>
            <div class="family-row-cell">
              <div class="family-row-value">${disp(jVal, r.unit)}</div>
              ${jSubLine}
              ${jBar}
              ${remDisp(jVal, r.juliTarget, r.unit)}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ── Toast ─────────────────────────────────────────────────


// ══════════════════════════════════════════════════════════
// INGREDIENT CARDS
// ══════════════════════════════════════════════════════════

/**
 * Renders a single ingredient card element.
 * @param {object} ingredient  — flat ingredient object from ingredients.js
 * @param {function} onEdit    — called with (ingredient) when the edit button is clicked
 * @param {function} onDelete  — called with (ingredient.id) when the delete button is clicked
 * @returns {HTMLElement}
 */
export function renderIngredientCard(ingredient, onEdit, onDelete) {
  const card = document.createElement('div');
  card.className = 'ingredient-card';
  card.dataset.id = ingredient.id;

  const cat = ingredient.categoria
    ? `<span class="ingredient-card-cat">${ingredient.categoria}</span>`
    : '';

  const ref = `${ingredient.cantidad_referencia} ${ingredient.unidad_referencia}`;

  card.innerHTML = `
    <div class="ingredient-card-actions">
      <button class="ingredient-card-edit" title="Editar">✏️</button>
      <button class="ingredient-card-delete" title="Eliminar">🗑</button>
    </div>
    <div class="ingredient-card-name">${ingredient.nombre}</div>
    ${cat}
    <div class="ingredient-card-ref">Por ${ref}</div>
    <div class="ingredient-macros">
      <span class="ingredient-macro-badge ing-badge--kcal">${ingredient.calorias} kcal</span>
      <span class="ingredient-macro-badge ing-badge--prot">P ${ingredient.proteina_g}g</span>
      <span class="ingredient-macro-badge ing-badge--carb">C ${ingredient.carbohidratos_g}g</span>
      <span class="ingredient-macro-badge ing-badge--fat">G ${ingredient.grasas_g}g</span>
    </div>
  `;

  card.querySelector('.ingredient-card-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    onEdit(ingredient);
  });
  card.querySelector('.ingredient-card-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(ingredient.id);
  });

  return card;
}

/**
 * Renders the full ingredients list into a container element.
 * @param {object[]} ingredients
 * @param {HTMLElement} container
 * @param {function} onEdit
 * @param {function} onDelete
 */
export function renderIngredientsSidebar(ingredients, container, onEdit, onDelete) {
  container.innerHTML = '';

  if (!ingredients.length) {
    container.innerHTML = '<p style="font-size:.8rem;color:var(--text-muted);padding:12px">Sin resultados.</p>';
    return;
  }

  ingredients.forEach(ingredient => {
    container.appendChild(renderIngredientCard(ingredient, onEdit, onDelete));
  });
}


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
