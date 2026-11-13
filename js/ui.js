/**
 * ui.js — rendering helpers (recipe cards, calendar, day detail, modals)
 */

import { MEAL_SLOTS, DAY_NAMES_SHORT, MONTH_NAMES, computeDayMacros, toDateKey } from './calendar.js';
import {
  sameMealVersion, mealServings, scaledMacros, normalizeServings,
  SERVINGS_MIN, SERVINGS_MAX, SERVINGS_STEP,
} from './plan-versions.js';

/** Escape text before interpolating it into innerHTML (recipe data comes from the DB). */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Numeric value for display: anything that is not a finite number becomes 0. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Display value rounded to 1 decimal (scaled macros can be fractional). */
function num1(value) {
  return Math.round(num(value) * 10) / 10;
}

/** Servings for display with a decimal comma: 0.25 → "0,25". */
function formatServings(servings) {
  return String(servings).replace('.', ',');
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
    <div class="recipe-card-name">${esc(nombre)}</div>
    <div class="recipe-card-macros">
      <span>🔥 ${num(m.calorias)} kcal</span>
      <span>💪 ${num(m.proteina_g)}g prot</span>
      <span>🌾 ${num(m.carbohidratos_g)}g carbs</span>
      <span>🧈 ${num(m.grasas_g)}g grasas</span>
    </div>
    <button class="recipe-card-info"   data-info="${esc(id)}"   title="Ver receta">ℹ</button>
    <button class="recipe-card-edit"   data-edit="${esc(id)}"   title="Editar receta">✏️</button>
    <button class="recipe-card-delete" data-delete="${esc(id)}" title="Eliminar receta">🗑</button>
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

/** Number of distinct member colours (see .member-badge-N / .member-col-N in the CSS). */
const MEMBER_COLORS = 5;

/**
 * Group the meals members have for one slot by recipe version.
 * Members that share the same version end up in one group, in member order.
 *
 * @param {Array<{member:{id:string,name:string}, entry:object}>} memberEntries
 * @param {string} slotId
 * @returns {Array<{meal:object, personIds:string[], servings:number[]}>}
 *          `servings[i]` belongs to `personIds[i]` (servings do not affect grouping).
 */
function groupSlotMeals(memberEntries, slotId) {
  const groups = [];
  for (const { member, entry } of memberEntries) {
    const meal = entry?.[slotId];
    if (!meal) continue;
    const group = groups.find(g => sameMealVersion(g.meal, meal));
    if (group) {
      group.personIds.push(member.id);
      group.servings.push(mealServings(meal));
    } else {
      groups.push({ meal, personIds: [member.id], servings: [mealServings(meal)] });
    }
  }
  return groups;
}

/**
 * One pill per distinct meal version per slot (in MEAL_SLOTS order).
 * Members sharing a meal show a single pill.
 */
function buildDayPills(memberEntries) {
  return MEAL_SLOTS.flatMap(slot =>
    groupSlotMeals(memberEntries, slot.id).map(g => ({ slotId: slot.id, ...g }))
  );
}

export function renderCalendarGrid({
  weekDays,
  planData,
  person,
  members,
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
  const isFamily = person === 'Familia';
  const nameById = Object.fromEntries(members.map(m => [m.id, m.name]));

  weekDays.forEach((date, idx) => {
    const dateKey = toDateKey(date);
    const memberEntries = members.map(member => ({
      member,
      entry: planData?.[member.name]?.[weekKey]?.[dateKey] || {},
    }));

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

    buildDayPills(memberEntries).forEach(({ slotId, meal, personIds, servings }) => {
      const icon = slotIconMap[slotId] || '🍽️';
      // In Familia, say who eats the meal when it is not shared by everyone.
      const who = isFamily && personIds.length < members.length
        ? ` (${personIds.map(id => nameById[id]).join(', ')})`
        : '';
      // "×N" when the portions differ from 1; mixed portions list each person in the title.
      const distinct = [...new Set(servings)];
      const mixed    = distinct.length > 1;
      const servingsTag = mixed
        ? `×${distinct.map(formatServings).join('/')}`
        : (distinct[0] !== 1 ? `×${formatServings(distinct[0])}` : '');
      const servingsTitle = mixed
        ? ` — ${personIds.map((id, i) => `${nameById[id]} ×${formatServings(servings[i])}`).join(', ')}`
        : (servingsTag ? ` — ${servingsTag}` : '');
      const pill = document.createElement('div');
      pill.className = 'meal-pill';
      pill.innerHTML = `
        <span class="meal-pill-slot">${icon}</span>
        <span class="meal-pill-name meal-pill-name--link" data-recipe-id="${esc(meal.recipeId)}" title="Ver receta: ${esc(meal.recipeName)}${esc(who)}${esc(servingsTitle)}">${esc(meal.recipeName)}</span>
        ${servingsTag ? `<span class="meal-pill-servings" title="Porciones${esc(servingsTitle)}">${esc(servingsTag)}</span>` : ''}
        <button class="meal-pill-remove" data-date="${esc(dateKey)}" data-slot="${esc(slotId)}" data-person-ids="${esc(personIds.join(','))}" title="Quitar">✕</button>
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

    // Calorie bar(s): one per member in Familia, a single one otherwise
    cell.appendChild(buildKcalBar(memberEntries, isFamily));

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
        onRemoveMeal(btn.dataset.date, btn.dataset.slot, btn.dataset.personIds.split(','));
      });
    });

    grid.appendChild(cell);
  });
}

/**
 * One row per member that has calories that day. The label reads "Kcal" in
 * single-person mode; in Familia it shows the member name on the left and
 * "Kcal N" on the right, with that member's bar below.
 */
function buildKcalBar(memberEntries, isFamily) {
  const wrapper = document.createElement('div');
  wrapper.className = 'day-kcal-bar';

  for (const { member, entry } of memberEntries) {
    const kcal = computeDayMacros(entry).calorias;
    if (kcal === 0) continue;

    const left  = isFamily ? esc(member.name) : 'Kcal';
    const right = isFamily ? `Kcal ${Math.round(kcal)}` : `${Math.round(kcal)}`;

    const row = document.createElement('div');
    row.className = 'kcal-row';
    row.dataset.personId = member.id;
    row.innerHTML = `
      <div class="kcal-label">
        <span>${left}</span>
        <span>${right}</span>
      </div>
      <div class="kcal-track">
        <div class="kcal-fill" style="width:0%"></div>
      </div>
    `;
    wrapper.appendChild(row);
  }
  return wrapper;
}

/**
 * Update calorie bar widths after rendering (needs nutrition data).
 * Each member's bar is measured against that member's own daily target.
 */
export function updateKcalBars(weekDays, planData, members, weekKey, nutritionAll) {
  weekDays.forEach(date => {
    const dateKey = toDateKey(date);
    const cell = document.querySelector(`.day-cell[data-date-key="${dateKey}"]`);
    if (!cell) return;

    for (const member of members) {
      const fill = [...cell.querySelectorAll('.kcal-row')]
        .find(row => row.dataset.personId === member.id)
        ?.querySelector('.kcal-fill');
      if (!fill) continue;

      const target   = nutritionAll?.[member.name]?.daily_calories_kcal || 2000;
      const dayEntry = planData?.[member.name]?.[weekKey]?.[dateKey] || {};
      const kcal     = computeDayMacros(dayEntry).calorias;

      fill.style.width = Math.min((kcal / target) * 100, 100) + '%';
      fill.classList.toggle('over',  kcal > target * 1.05);
      fill.classList.toggle('close', kcal > target * 0.9 && kcal <= target * 1.05);
    }
  });
}

// ── Day detail panel ──────────────────────────────────────

/**
 * @param {Array<{member:{id:string,name:string}, entry:object}>} [memberEntries]
 *        Familia mode only: every family member with their entry for the day.
 * onRemoveMeal(dateKey, slotId, personIds|null)  — null = everyone in view
 * onAddMealToSlot(slotId, recipeId, personId|null) — null = everyone in view
 * onSetServings(dateKey, slotId, personId|null, servings) — null = the single viewed person
 */
export function renderDayDetail({
  dateKey,
  dayEntry,
  memberEntries,
  nutrition,
  person,
  nutritionAll,
  onRemoveMeal,
  onAddMealToSlot,
  onRecipeClick,
  onSetServings,
}) {
  const date  = new Date(dateKey + 'T12:00:00');
  const label = `${DAY_NAMES_SHORT[(date.getDay() + 6) % 7]} ${date.getDate()} de ${MONTH_NAMES[date.getMonth()]}`;

  document.getElementById('detail-day-label').textContent =
    person === 'Familia' ? `👨‍👩 ${label}` : label;

  const slotsEl   = document.getElementById('meal-slots');
  const summaryEl = document.getElementById('day-summary');
  slotsEl.innerHTML = '';

  if (person === 'Familia') {
    // ── Family mode: one row per member for every slot ──
    const members = memberEntries.map(me => me.member);

    MEAL_SLOTS.forEach(slot => {
      const meals = memberEntries.map(({ entry }) => entry?.[slot.id] || null);
      const hasMeal = meals.some(Boolean);
      // Everyone has a meal and it is the same version for all of them
      const sharedMeal = meals.every(Boolean)
        && meals.every(m => sameMealVersion(m, meals[0]))
        ? meals[0] : null;

      const card = document.createElement('div');
      card.className = 'slot-card' + (hasMeal ? ' has-meal' : '');
      card.dataset.slot = slot.id;

      const titleEl = `<div class="slot-title">${slot.icon} ${slot.label}</div>`;

      if (sharedMeal && members.length > 1) {
        // Same meal for everyone — show once
        // Header macros only make sense when everyone ate the same portions;
        // otherwise each member's kcal is shown next to their stepper.
        const sameServings = meals.every(x => mealServings(x) === mealServings(meals[0]));
        const m = scaledMacros(sharedMeal);
        const everyone = members.length === 2 ? 'Los dos' : 'Todos';
        card.innerHTML = `
          ${titleEl}
          <div class="slot-family-shared slot-meal-clickable" role="button" tabindex="0" data-recipe-id="${esc(sharedMeal.recipeId)}" title="Ver receta: ${esc(sharedMeal.recipeName)}">
            <span class="slot-family-badge shared-badge">👥 ${everyone}</span>
            <div class="slot-meal-name">${esc(sharedMeal.recipeName)}</div>
            ${sameServings ? `<div class="slot-meal-macros">
              <span>🔥 ${num1(m.calorias)} kcal</span>
              <span>💪 ${num1(m.proteina_g)}g</span>
            </div>` : ''}
          </div>
          <div class="slot-servings-list">
            ${members.map((member, i) => `
              <div class="slot-servings-row">
                ${memberBadgeHTML(member, i)}
                ${servingsStepperHTML(meals[i], member.id)}
                <span class="slot-meal-kcal">${num1(scaledMacros(meals[i]).calorias)} kcal</span>
              </div>`).join('')}
          </div>
          <div class="slot-actions">
            <button class="slot-btn remove">Quitar a ${everyone === 'Los dos' ? 'los dos' : 'todos'}</button>
          </div>
        `;
        const clickableEl = card.querySelector('.slot-family-shared');
        if (clickableEl) clickableEl.mealRef = sharedMeal;

        card.querySelector('.slot-btn.remove').addEventListener('click', () => {
          onRemoveMeal(dateKey, slot.id, null); // null = everyone
        });
      } else {
        // Different meals (or some members have none) — one row per member
        card.innerHTML = `
          ${titleEl}
          <div class="slot-family-rows">
            ${members.map((member, i) => buildPersonMealHTML(meals[i], member, i)).join('')}
          </div>
        `;
        card.querySelectorAll('.slot-family-person-meal').forEach(el => {
          const idx = Number(el.dataset.memberIdx);
          if (meals[idx]) el.mealRef = meals[idx];
        });
        card.querySelectorAll('.slot-btn-remove').forEach(btn => {
          btn.addEventListener('click', () => {
            onRemoveMeal(dateKey, slot.id, [btn.dataset.personId]);
          });
        });
        card.querySelectorAll('.slot-btn-add-sm').forEach(btn => {
          btn.addEventListener('click', () => {
            onAddMealToSlot(slot.id, null, btn.dataset.personId);
          });
        });
      }

      // Drop zone — assigns to everyone when dragged in family mode
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drop-target');
        const recipeId = e.dataTransfer.getData('recipeId');
        if (recipeId) onAddMealToSlot(slot.id, recipeId, null); // null = everyone
      });

      slotsEl.appendChild(card);
    });

    renderFamilySummary(memberEntries, nutritionAll, summaryEl);

  } else {
    // ── Single person mode ──
    MEAL_SLOTS.forEach(slot => {
      const meal = dayEntry?.[slot.id];
      const card = document.createElement('div');
      card.className = 'slot-card' + (meal ? ' has-meal' : '');
      card.dataset.slot = slot.id;

      if (meal) {
        const m = scaledMacros(meal);
        card.innerHTML = `
          <div class="slot-title">${slot.icon} ${slot.label}</div>
          <div class="slot-meal-info slot-meal-clickable" role="button" tabindex="0" data-recipe-id="${esc(meal.recipeId)}" title="Ver receta: ${esc(meal.recipeName)}">
            <div class="slot-meal-name">${esc(meal.recipeName)}</div>
            <div class="slot-meal-macros">
              <span>🔥 ${num1(m.calorias)} kcal</span>
              <span>💪 ${num1(m.proteina_g)}g</span>
              <span>🌾 ${num1(m.carbohidratos_g)}g</span>
              <span>🧈 ${num1(m.grasas_g)}g</span>
            </div>
          </div>
          ${servingsStepperHTML(meal)}
          <div class="slot-actions">
            <button class="slot-btn remove" data-slot="${slot.id}">Quitar</button>
          </div>
        `;
        const clickableEl = card.querySelector('.slot-meal-info');
        if (clickableEl) clickableEl.mealRef = meal;

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

  // Servings steppers (outside the clickable zones, so they never open the modal)
  slotsEl.querySelectorAll('.servings-stepper').forEach(stepper => {
    wireServingsStepper(stepper, slotsEl, dateKey, onSetServings);
  });

  // Clickable meal slots (open recipe snapshot modal)
  slotsEl.querySelectorAll('.slot-meal-clickable').forEach(el => {
    const handleOpen = (e) => {
      if (e.target.closest('button, input, select')) return;
      if (onRecipeClick && el.dataset.recipeId) {
        onRecipeClick(el.dataset.recipeId, el.mealRef);
      }
    };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      handleOpen(e);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        handleOpen(e);
      }
    });
  });
}

function memberBadgeHTML(member, index) {
  return `<span class="slot-family-badge member-badge-${index % MEMBER_COLORS}">${esc(member.name)}</span>`;
}

/**
 * Servings control: − / editable value / + (step 0,25, range 0,25–10).
 * `personId` is empty in single-person mode.
 */
function servingsStepperHTML(meal, personId = '') {
  const s = mealServings(meal);
  return `
    <div class="servings-stepper" role="group" aria-label="Porciones" data-person-id="${esc(personId)}" data-servings="${s}">
      <button type="button" class="servings-btn" data-step="-1" aria-label="Menos porciones"${s <= SERVINGS_MIN ? ' disabled' : ''}>−</button>
      <input type="text" class="servings-input" inputmode="decimal" autocomplete="off" aria-label="Porciones comidas" value="${esc(formatServings(s))}">
      <button type="button" class="servings-btn" data-step="1" aria-label="Más porciones"${s >= SERVINGS_MAX ? ' disabled' : ''}>+</button>
    </div>
  `;
}

/**
 * Hook up one stepper. The callback updates the state and re-renders the
 * panel synchronously, so keyboard focus is restored on the new button.
 */
function wireServingsStepper(stepper, slotsEl, dateKey, onSetServings) {
  if (!onSetServings) return;
  const slotId   = stepper.closest('.slot-card')?.dataset.slot;
  const personId = stepper.dataset.personId || null;
  const input    = stepper.querySelector('.servings-input');
  const current  = () => Number(stepper.dataset.servings) || 1;

  const commit = (value, focusStep = null) => {
    onSetServings(dateKey, slotId, personId, normalizeServings(value));
    if (!focusStep) return;
    const again = [...slotsEl.querySelectorAll('.slot-card')]
      .find(c => c.dataset.slot === slotId)
      ?.querySelectorAll('.servings-stepper');
    [...(again || [])]
      .find(s => (s.dataset.personId || null) === personId)
      ?.querySelector(`[data-step="${focusStep}"]`)?.focus();
  };

  stepper.querySelectorAll('.servings-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = Number(btn.dataset.step);
      commit(current() + dir * SERVINGS_STEP, btn.dataset.step);
    });
  });

  input.addEventListener('change', () => {
    const typed = parseFloat(input.value.replace(',', '.'));
    if (!Number.isFinite(typed)) {
      input.value = formatServings(current());
      return;
    }
    commit(typed);
  });
}

function buildPersonMealHTML(meal, member, index) {
  const badge = memberBadgeHTML(member, index);
  const pid = esc(member.id);
  if (meal) {
    const m = scaledMacros(meal);
    return `
      <div class="slot-family-person-row has-meal-row">
        ${badge}
        <div class="slot-family-person-meal slot-meal-clickable" role="button" tabindex="0" data-member-idx="${index}" data-recipe-id="${esc(meal.recipeId)}" title="Ver receta: ${esc(meal.recipeName)}">
          <span class="slot-meal-name-sm">${esc(meal.recipeName)}</span>
          <span class="slot-meal-kcal">${num1(m.calorias)} kcal</span>
        </div>
        ${servingsStepperHTML(meal, member.id)}
        <button class="slot-btn-remove slot-btn-icon" data-person-id="${pid}" title="Quitar">✕</button>
      </div>
    `;
  }
  return `
    <div class="slot-family-person-row empty-row">
      ${badge}
      <span class="slot-empty-text">Sin asignar</span>
      <button class="slot-btn-add-sm" data-person-id="${pid}" title="Agregar">+ Agregar</button>
    </div>
  `;
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

// ── Family day summary (one column per member) ────────────

function renderFamilySummary(memberEntries, nutritionAll, container) {
  const cols = memberEntries.map(({ member, entry }) => {
    const n = nutritionAll?.[member.name] || {};
    return {
      member,
      macros: computeDayMacros(entry),
      targets: {
        calorias:        n.daily_calories_kcal,
        proteina_g:      n.protein_g,
        carbohidratos_g: n.carbs_g,
        grasas_g:        n.fat_g,
      },
      bmr:   n.bmr_kcal || null,
      maint: n.maintenance_kcal || null,
    };
  });

  const rows = [
    { label: 'Calorías', key: 'calorias',        unit: 'kcal', color: 'var(--orange)' },
    { label: 'Proteína', key: 'proteina_g',      unit: 'g',    color: 'var(--accent)' },
    { label: 'Carbos',   key: 'carbohidratos_g', unit: 'g',    color: 'var(--green)'  },
    { label: 'Grasas',   key: 'grasas_g',        unit: 'g',    color: 'var(--purple)' },
  ];

  const disp = (val, unit) => unit === 'kcal' ? `${Math.round(val)} ${unit}` : `${val} ${unit}`;

  const remDisp = (val, target, unit) => {
    if (!target) return '';
    const rem   = target - val;
    const round = unit === 'kcal' ? Math.round(rem) : Math.round(rem * 10) / 10;
    const color = rem < 0 ? 'var(--red)' : 'var(--green)';
    const label = rem < 0 ? `Exceso: ${Math.abs(round)} ${unit}` : `Disponible: ${round} ${unit}`;
    return `<div class="family-row-remaining" style="color:${color}">${label}</div>`;
  };

  container.innerHTML = `
    <div class="family-summary" style="--family-cols:${cols.length}">
      <div class="family-summary-header">
        <div></div>
        ${cols.map((c, i) => `<div class="family-col-label member-col-${i % MEMBER_COLORS}">${esc(c.member.name)}</div>`).join('')}
      </div>
      ${rows.map(r => {
        const isCal = r.key === 'calorias';
        const cells = cols.map(c => {
          const val    = c.macros[r.key] ?? 0;
          const target = c.targets[r.key];
          // Calories: maintenance is 100%. Macros: the target is 100%.
          const base = isCal ? c.maint : target;
          const bar  = summaryBarHTML(val, base, r.color, isCal ? calorieMarks(target, c.bmr) : []);
          const sub  = isCal
            ? `<div class="family-row-sub">${calorieSubText({ bmr: c.bmr, target, maint: c.maint })}</div>`
            : target ? `<div class="family-row-sub">meta: ${target} ${r.unit}</div>` : '';
          return `
            <div class="family-row-cell">
              <div class="family-row-value">${disp(val, r.unit)}</div>
              ${sub}
              ${bar}
              ${remDisp(val, target, r.unit)}
            </div>
          `;
        }).join('');
        return `
          <div class="family-summary-row">
            <div class="family-row-label" style="color:${r.color}">${r.label}</div>
            ${cells}
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
    ? `<span class="ingredient-card-cat">${esc(ingredient.categoria)}</span>`
    : '';

  const ref = esc(`${ingredient.cantidad_referencia} ${ingredient.unidad_referencia}`);

  card.innerHTML = `
    <div class="ingredient-card-actions">
      <button class="ingredient-card-edit" title="Editar">✏️</button>
      <button class="ingredient-card-delete" title="Eliminar">🗑</button>
    </div>
    <div class="ingredient-card-name">${esc(ingredient.nombre)}</div>
    ${cat}
    <div class="ingredient-card-ref">Por ${ref}</div>
    <div class="ingredient-macros">
      <span class="ingredient-macro-badge ing-badge--kcal">${num(ingredient.calorias)} kcal</span>
      <span class="ingredient-macro-badge ing-badge--prot">P ${num(ingredient.proteina_g)}g</span>
      <span class="ingredient-macro-badge ing-badge--carb">C ${num(ingredient.carbohidratos_g)}g</span>
      <span class="ingredient-macro-badge ing-badge--fat">G ${num(ingredient.grasas_g)}g</span>
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
