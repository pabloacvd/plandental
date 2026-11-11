/**
 * profile.js — "Perfil y progreso" modal: Datos, Dashboard and Sugerencias tabs.
 *
 * app.js owns opening/closing the modal and the app state; this module owns
 * everything inside it. All dynamic DOM is built with el() (textContent only).
 *
 * Wiring (see initProfile): app.js passes accessors for its state and a
 * callback to refresh the calendar when targets change.
 */

import { el, fmtDayFull, fmtNum } from './charts.js';
import {
  fetchNutrition, saveNutritionProfile,
  fetchWeightLog, saveWeightEntry, deleteWeightEntry,
  fetchDailyIntake, fetchTargetsHistory, applyTargetsChange, revertTargetsChange,
} from './storage.js';
import {
  ACTIVITY_LEVELS, GOALS, DEFAULT_DEFICIT_PCT, HEALTH_NOTICE, SOURCES,
  calcFromFormula, proposeTargets, analyzeDiet, buildSuggestions, weightTrend,
  addDays, localDateKey,
} from './nutrition.js';
import { toWeekKey } from './calendar.js';
import { renderDashboard } from './dashboard.js';
import { showToast } from './ui.js';

// ── Module state ──────────────────────────────────────────────

let ctx = null;                       // { getPersons, getNutrition, getActivePerson, setNutrition, onTargetsChanged }
const cache = { personId: null, weights: [] };
const recalcStatus = {};              // personName → text shown under "Recálculo automático"
let activeTab = 'datos';

const F = {
  height:       'input-profile-height',
  age:          'input-profile-age',
  sex:          'input-profile-sex',
  goal:         'input-profile-goal',
  deficit:      'input-profile-deficit',
  activity:     'input-profile-activity',
  targetWeight: 'input-profile-target-weight',
  auto:         'input-profile-auto',
  bmr:          'input-profile-bmr',
  target:       'input-profile-target',
  maintenance:  'input-profile-maintenance',
  protein:      'input-profile-protein',
  carbs:        'input-profile-carbs',
  fat:          'input-profile-fat',
};

const $ = id => document.getElementById(id);

// ── Public API ────────────────────────────────────────────────

/** Wire the modal once. Called from wireControls() in app.js. */
export function initProfile(context) {
  ctx = context;

  fillSelect($(F.goal), GOALS.map(g => [g.id, g.label]));
  fillSelect($(F.activity), ACTIVITY_LEVELS.map(a => [a.id, a.label]));
  $('profile-health-notice').textContent = HEALTH_NOTICE;

  $('input-profile-person')?.addEventListener('change', onPersonChange);
  $(F.goal)?.addEventListener('change', toggleDeficitField);
  $('btn-save-profile')?.addEventListener('click', handleSaveProfile);
  $('btn-calc-formula')?.addEventListener('click', handleCalcFormula);
  $('btn-add-weight')?.addEventListener('click', handleAddWeight);
  $('input-weight-value')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleAddWeight(); });

  const tabs = $('profile-tabs');
  tabs?.addEventListener('click', e => {
    const btn = e.target.closest('[data-ptab]');
    if (btn) setTab(btn.dataset.ptab);
  });
  tabs?.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = [...tabs.querySelectorAll('[data-ptab]')];
    const i = btns.findIndex(b => b.dataset.ptab === activeTab);
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    setTab(next.dataset.ptab);
    next.focus();
  });
}

/** Called by app.js each time the modal opens (after un-hiding is fine too). */
export async function openProfile() {
  const persons = ctx.getPersons();
  populatePersons(persons);
  $('input-weight-date').value = localDateKey();
  $('input-weight-date').max = localDateKey();
  setTab('datos');
  await fillForm();

  const person = selectedPerson();
  if (!person) return;
  const result = await runAutoRecalc(person.name);
  if (selectedPerson()?.id !== person.id) return;
  if (result.status === 'applied') await fillForm(); else renderRecalcStatus();
}

/**
 * Weekly automatic recalculation for one person (see plan, sub-task 6).
 * Never throws: failures become a status text. Returns { status, reason? }.
 * status: 'off' | 'incomplete' | 'applied' | 'done' | 'na' | 'nochange' | 'error'
 */
export async function runAutoRecalc(personName) {
  const set = (status, text) => { recalcStatus[personName] = text; return { status, reason: text }; };
  try {
    const n = ctx.getNutrition()[personName];
    const person = ctx.getPersons().find(p => p.name === personName);
    if (!person || !n || !n.maintenance_kcal) return set('incomplete', 'Completá primero los datos obligatorios.');
    if (n.auto_recalc === false) return set('off', 'El recálculo automático está desactivado para esta persona.');

    const today = localDateKey();
    const weekKey = toWeekKey(new Date());
    const history = await fetchTargetsHistory(person.id, 20);
    if (history.some(h => h.source === 'auto' && h.week_key === weekKey)) {
      return set('done', `Ya se hizo el recálculo automático de esta semana (${weekKey}). El próximo es la semana siguiente.`);
    }

    const [weights, intake] = await Promise.all([
      fetchWeightLog(person.id),
      fetchDailyIntake(person.id, addDays(today, -35), today),
    ]);
    const proposal = proposeTargets(n, weights, intake, { today });
    if (!proposal.ok) return set('na', `No se pudo recalcular: ${proposal.reason}`);
    if (!proposal.changed) return set('nochange', `Esta semana no hizo falta cambiar las metas. ${proposal.reason}`);

    const row = await applyTargetsChange(person.id, 'auto', proposal.reason, weekKey, proposal.values);
    if (row?.already_applied) return set('done', `Ya se hizo el recálculo automático de esta semana (${weekKey}).`);

    await ctx.setNutrition(await fetchNutrition());
    ctx.onTargetsChanged();
    showToast(`Metas de ${personName} recalculadas: ${proposal.values.daily_calories_kcal} kcal por día`, 'success');
    return set('applied', `Metas recalculadas esta semana. ${proposal.reason}`);
  } catch (e) {
    console.warn('runAutoRecalc:', e.message);
    return set('error', 'No se pudo hacer el recálculo automático. Se reintenta la próxima vez que abras el perfil.');
  }
}

// ── Helpers ───────────────────────────────────────────────────

function fillSelect(select, options) {
  if (!select) return;
  select.replaceChildren(...options.map(([value, label]) => el('option', { value, text: label })));
}

function selectedPerson() {
  const name = $('input-profile-person')?.value;
  const p = ctx.getPersons().find(x => x.name === name);
  return p || null;
}

function setVal(id, v) { $(id).value = v === null || v === undefined ? '' : v; }

function numVal(id) {
  const v = $(id).value.trim();
  return v === '' ? null : Number(v.replace(',', '.'));
}

function latestWeight(n) {
  return cache.weights.length ? cache.weights[cache.weights.length - 1].weight_kg : (Number(n?.weight_kg) || null);
}

function populatePersons(persons) {
  const nutrition = ctx.getNutrition();
  const select = $('input-profile-person');
  const previous = select.value;
  select.replaceChildren();
  for (const p of persons) {
    const missing = !nutrition[p.name]?.maintenance_kcal;
    select.appendChild(el('option', { value: p.name, text: missing ? `${p.name} (datos incompletos)` : p.name }));
  }
  const incomplete = persons.find(p => !nutrition[p.name]?.maintenance_kcal)?.name;
  const active = ctx.getActivePerson();
  const preferred = incomplete
    ?? (persons.some(p => p.name === previous) ? previous : null)
    ?? (persons.some(p => p.name === active) ? active : persons[0]?.name);
  if (preferred) select.value = preferred;

  $('field-profile-person').classList.toggle('hidden', persons.length < 2);
  $('section-nutrition-profile').classList.toggle('hidden', !persons.length);
}

function toggleDeficitField() {
  $('field-profile-deficit').classList.toggle('hidden', $(F.goal).value !== 'bajar');
}

async function onPersonChange() {
  $('formula-breakdown').classList.add('hidden');
  await fillForm();
  const person = selectedPerson();
  if (!person) return;
  const result = await runAutoRecalc(person.name);
  if (selectedPerson()?.id !== person.id) return;
  if (result.status === 'applied') await fillForm(); else renderRecalcStatus();
}

// ── Tabs ──────────────────────────────────────────────────────

function setTab(tab) {
  activeTab = tab;
  for (const btn of document.querySelectorAll('#profile-tabs [data-ptab]')) {
    const on = btn.dataset.ptab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  }
  for (const id of ['datos', 'dashboard', 'sugerencias']) {
    $(`ptab-${id}`).classList.toggle('hidden', id !== tab);
  }
  if (tab === 'dashboard') renderDashboardTab();
  if (tab === 'sugerencias') renderSuggestionsTab();
}

async function dataForTabs() {
  const person = selectedPerson();
  if (!person) return null;
  if (cache.personId !== person.id) await loadWeights(person.id);
  return {
    personId: person.id,
    name: person.name,
    nutrition: ctx.getNutrition()[person.name] || {},
    weights: cache.weights,
  };
}

async function renderDashboardTab() {
  const data = await dataForTabs();
  if (data && activeTab === 'dashboard') await renderDashboard($('dashboard-root'), data);
}

// ── Datos tab ─────────────────────────────────────────────────

async function loadWeights(personId) {
  cache.personId = personId;
  cache.weights = await fetchWeightLog(personId);
}

async function fillForm() {
  const person = selectedPerson();
  if (!person) return;
  const n = ctx.getNutrition()[person.name] || {};

  setVal(F.height, n.height_cm);
  setVal(F.age, n.age_years);
  setVal(F.sex, n.sex);
  $(F.goal).value = n.goal || 'bajar';
  setVal(F.deficit, n.deficit_pct ?? DEFAULT_DEFICIT_PCT);
  $(F.activity).value = n.activity_level || 'moderado';
  setVal(F.targetWeight, n.target_weight_kg);
  $(F.auto).checked = n.auto_recalc !== false;
  setVal(F.bmr, n.bmr_kcal);
  setVal(F.target, n.daily_calories_kcal);
  setVal(F.maintenance, n.maintenance_kcal);
  setVal(F.protein, n.protein_g);
  setVal(F.carbs, n.carbs_g);
  setVal(F.fat, n.fat_g);
  toggleDeficitField();

  await loadWeights(person.id);
  if (selectedPerson()?.id !== person.id) return; // user switched meanwhile
  renderWeights();
  renderRecalcStatus();
  await renderHistory();

  if (activeTab === 'dashboard') renderDashboardTab();
  if (activeTab === 'sugerencias') renderSuggestionsTab();
}

function renderWeights() {
  const person = selectedPerson();
  const n = ctx.getNutrition()[person?.name] || {};
  const w = latestWeight(n);
  $('profile-current-weight').textContent = w ? `${fmtNum(w, 1)} kg` : '—';

  const list = $('weight-list');
  if (!cache.weights.length) {
    list.replaceChildren(el('li', { class: 'weight-empty', text: 'Todavía no registraste ningún peso.' }));
    return;
  }
  const rows = [...cache.weights].reverse().map(w => {
    const del = el('button', {
      type: 'button', class: 'btn-del-row',
      'aria-label': `Borrar el pesaje del ${fmtDayFull(w.date_key)}`, text: '✕',
    });
    del.addEventListener('click', () => handleDeleteWeight(w.date_key));
    return el('li', { class: 'weight-item' },
      el('span', { class: 'weight-item-date', text: fmtDayFull(w.date_key) }),
      el('span', { class: 'weight-item-kg', text: `${fmtNum(w.weight_kg, 1)} kg` }),
      del);
  });
  list.replaceChildren(...rows);
}

async function handleAddWeight() {
  const person = selectedPerson();
  if (!person) { showToast('Elegí una persona', 'error'); return; }
  const dateKey = $('input-weight-date').value;
  const kg = numVal('input-weight-value');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) { showToast('Elegí una fecha', 'error'); return; }
  if (dateKey > localDateKey()) { showToast('La fecha no puede ser futura', 'error'); return; }
  if (!Number.isFinite(kg) || kg < 20 || kg > 400) { showToast('Ingresá un peso entre 20 y 400 kg', 'error'); return; }

  const btn = $('btn-add-weight');
  btn.disabled = true;
  try {
    await saveWeightEntry(person.id, dateKey, Math.round(kg * 10) / 10);
    $('input-weight-value').value = '';
    // The DB trigger syncs nutrition_data.weight_kg → reload it.
    await ctx.setNutrition(await fetchNutrition());
    showToast('Peso registrado', 'success');
    const result = await runAutoRecalc(person.name);
    await fillForm();
    if (result.status === 'applied') renderRecalcStatus();
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleDeleteWeight(dateKey) {
  const person = selectedPerson();
  if (!person) return;
  try {
    await deleteWeightEntry(person.id, dateKey);
    await ctx.setNutrition(await fetchNutrition());
    await fillForm();
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}

async function handleSaveProfile() {
  const person = selectedPerson();
  if (!person) { showToast('Elegí una persona', 'error'); return; }

  const p = {
    bmr_kcal:            numVal(F.bmr),
    daily_calories_kcal: numVal(F.target),
    maintenance_kcal:    numVal(F.maintenance),
    height_cm:           numVal(F.height),
    age_years:           numVal(F.age),
    sex:                 $(F.sex).value || null,
    goal:                $(F.goal).value,
    activity_level:      $(F.activity).value,
    deficit_pct:         numVal(F.deficit) ?? DEFAULT_DEFICIT_PCT,
    target_weight_kg:    numVal(F.targetWeight),
    auto_recalc:         $(F.auto).checked,
  };
  for (const [key, id] of [['protein_g', F.protein], ['carbs_g', F.carbs], ['fat_g', F.fat]]) {
    const v = numVal(id);
    if (v !== null) p[key] = v;
  }

  const required = [
    [p.bmr_kcal,            'la tasa metabólica basal'],
    [p.daily_calories_kcal, 'las calorías objetivo'],
    [p.maintenance_kcal,    'las calorías de mantenimiento'],
  ];
  for (const [value, label] of required) {
    if (!Number.isFinite(value) || value <= 0) { showToast(`Ingresá ${label}`, 'error'); return; }
  }
  for (const key of ['height_cm', 'age_years', 'target_weight_kg', 'protein_g', 'carbs_g', 'fat_g']) {
    if (p[key] !== null && p[key] !== undefined && (!Number.isFinite(p[key]) || p[key] <= 0)) {
      showToast('Altura, edad, peso objetivo y macros deben ser números positivos', 'error');
      return;
    }
  }
  if (p.age_years !== null && (!Number.isInteger(p.age_years) || p.age_years > 120)) {
    showToast('La edad debe ser un entero entre 1 y 120', 'error');
    return;
  }
  if (!Number.isFinite(p.deficit_pct) || p.deficit_pct < 0 || p.deficit_pct > 30) {
    showToast('El déficit debe estar entre 0 y 30%', 'error');
    return;
  }
  if (p.target_weight_kg !== null && p.target_weight_kg >= 500) {
    showToast('El peso objetivo no es válido', 'error');
    return;
  }

  const btn = $('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    await saveNutritionProfile(person.id, p);
    // Reload from the DB so the UI reflects exactly what is stored.
    await ctx.setNutrition(await fetchNutrition());
    populatePersons(ctx.getPersons());
    $('input-profile-person').value = person.name;
    ctx.onTargetsChanged();
    await fillForm();
    showToast('✅ Datos guardados', 'success');
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar datos';
  }
}

function handleCalcFormula() {
  const person = selectedPerson();
  if (!person) return;
  const n = ctx.getNutrition()[person.name] || {};
  const box = $('formula-breakdown');

  const r = calcFromFormula({
    sex: $(F.sex).value, kg: latestWeight(n), cm: numVal(F.height), age: numVal(F.age),
    activityLevel: $(F.activity).value, goal: $(F.goal).value,
    deficitPct: numVal(F.deficit) ?? DEFAULT_DEFICIT_PCT,
  });
  box.classList.remove('hidden');
  if (!r.ok) {
    box.replaceChildren(el('p', { class: 'formula-error', text: r.reason }));
    return;
  }
  setVal(F.bmr, r.bmr);
  setVal(F.maintenance, r.maintenance);
  setVal(F.target, r.daily_calories_kcal);
  setVal(F.protein, r.protein_g);
  setVal(F.carbs, r.carbs_g);
  setVal(F.fat, r.fat_g);
  box.replaceChildren(
    el('p', { class: 'formula-title', text: 'Desarrollo del cálculo' }),
    el('ol', { class: 'formula-steps' }, ...r.steps.map(s => el('li', { text: s }))),
    ...r.warnings.map(w => el('p', { class: 'formula-warn', text: w })),
    el('p', { class: 'auth-note', text: 'Los valores quedaron cargados en el formulario. Tocá "Guardar datos" para aplicarlos.' }));
}

// ── Recalc status and history ─────────────────────────────────

function renderRecalcStatus() {
  const person = selectedPerson();
  const n = ctx.getNutrition()[person?.name] || {};
  let text = recalcStatus[person?.name];
  if (!text) {
    text = n.auto_recalc === false
      ? 'El recálculo automático está desactivado para esta persona.'
      : 'El recálculo corre al registrar un peso y al abrir el perfil, como máximo una vez por semana.';
  }
  $('recalc-status').textContent = text;
}

const CHANGE_LABELS = {
  maintenance_kcal: ['Mantenimiento', 'kcal'],
  daily_calories_kcal: ['Objetivo', 'kcal'],
  bmr_kcal: ['Tasa basal', 'kcal'],
  protein_g: ['Proteína', 'g'],
  carbs_g: ['Carbohidratos', 'g'],
  fat_g: ['Grasas', 'g'],
};

function changeSummary(h) {
  return Object.keys(h.new || {})
    .filter(k => CHANGE_LABELS[k])
    .map(k => {
      const [label, unit] = CHANGE_LABELS[k];
      const prev = h.previous?.[k];
      return `${label}: ${prev !== undefined && prev !== null ? fmtNum(Number(prev), 0) : '—'} → ${fmtNum(Number(h.new[k]), 0)} ${unit}`;
    })
    .join(' · ');
}

async function renderHistory() {
  const person = selectedPerson();
  const list = $('targets-history-list');
  if (!person) { list.replaceChildren(); return; }
  const history = await fetchTargetsHistory(person.id, 10);
  if (selectedPerson()?.id !== person.id) return;
  if (!history.length) {
    list.replaceChildren(el('li', { class: 'weight-empty', text: 'Todavía no hay cambios de metas registrados.' }));
    return;
  }
  const latestActive = history.find(h => !h.reverted_at);
  list.replaceChildren(...history.map(h => {
    const when = new Date(h.created_at).toLocaleDateString('es-AR');
    const head = el('div', { class: 'history-head' },
      el('span', { class: `history-badge history-badge--${h.source}`, text: h.source === 'auto' ? 'Automático' : 'Manual' }),
      el('span', { class: 'history-date', text: `${when} · ${h.week_key}` }),
      h.reverted_at ? el('span', { class: 'history-reverted', text: 'Revertido' }) : null);
    const item = el('li', { class: 'history-item' + (h.reverted_at ? ' is-reverted' : '') },
      head,
      el('div', { class: 'history-change', text: changeSummary(h) }),
      h.reason ? el('div', { class: 'history-reason', text: h.reason }) : null);
    if (latestActive && h.id === latestActive.id) {
      const btn = el('button', { type: 'button', class: 'btn-secondary btn-small', text: 'Revertir' });
      btn.addEventListener('click', () => handleRevert(h.id, btn));
      item.appendChild(btn);
    }
    return item;
  }));
}

async function handleRevert(historyId, btn) {
  if (!confirm('¿Volver a las metas anteriores a este cambio?')) return;
  const person = selectedPerson();
  btn.disabled = true;
  try {
    await revertTargetsChange(historyId);
    await ctx.setNutrition(await fetchNutrition());
    ctx.onTargetsChanged();
    if (person) recalcStatus[person.name] = 'Cambio revertido. El recálculo automático no se vuelve a aplicar hasta la semana siguiente.';
    await fillForm();
    showToast('Metas anteriores restauradas', 'success');
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
    btn.disabled = false;
  }
}

// ── Sugerencias tab ───────────────────────────────────────────

const SEVERITY_ORDER = { alerta: 0, atencion: 1, info: 2 };
const SEVERITY_LABEL = { alerta: 'Alerta', atencion: 'Atención', info: 'Info' };
const SUGGESTION_DAYS = 28;

async function renderSuggestionsTab() {
  const root = $('suggestions-root');
  const data = await dataForTabs();
  if (!data) { root.replaceChildren(); return; }
  root.replaceChildren(el('p', { class: 'dash-note', text: 'Cargando…' }));

  const today = localDateKey();
  const intake = await fetchDailyIntake(data.personId, addDays(today, -(SUGGESTION_DAYS - 1)), today);
  if (activeTab !== 'sugerencias' || selectedPerson()?.id !== data.personId) return;

  const n = data.nutrition;
  const kg = latestWeight(n);
  const days = intake.filter(d => d.meals_count > 0);
  const analysis = analyzeDiet(days, n, kg);
  const trend = weightTrend(cache.weights, { today });
  const suggestions = buildSuggestions(analysis, trend, n.goal || 'bajar', { kg })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const proposal = proposeTargets(n, cache.weights, intake, { today, limit: false });

  root.replaceChildren(
    el('p', { class: 'dash-note', text: `Se evalúan los últimos ${SUGGESTION_DAYS} días del plan (${analysis.n || 0} con comidas).` }),
    ...suggestions.map(suggestionCard),
    comparisonSection(n, proposal, data),
    el('section', { class: 'dash-section' },
      el('h5', { text: 'Fuentes' }),
      el('ul', { class: 'sources-list' }, ...SOURCES.map(s => el('li', { text: s })))));
}

function suggestionCard(s) {
  return el('article', { class: `suggestion suggestion--${s.severity}` },
    el('div', { class: 'suggestion-head' },
      el('span', { class: 'suggestion-badge', text: SEVERITY_LABEL[s.severity] }),
      el('h5', { class: 'suggestion-title', text: s.title })),
    el('p', { class: 'suggestion-detail', text: s.detail }),
    s.causes ? el('ul', { class: 'suggestion-causes' }, ...s.causes.map(c => el('li', { text: c }))) : null,
    el('p', { class: 'suggestion-source', text: `Fuente: ${s.source}` }));
}

function comparisonSection(n, proposal, data) {
  const section = el('section', { class: 'dash-section' }, el('h5', { text: 'Metas actuales y recomendadas' }));
  if (!proposal.ok) {
    section.appendChild(el('p', { class: 'dash-empty', text: proposal.reason }));
    return section;
  }
  const rows = [
    ['Mantenimiento (kcal)', n.maintenance_kcal, proposal.values.maintenance_kcal],
    ['Objetivo (kcal)', n.daily_calories_kcal, proposal.values.daily_calories_kcal],
    ['Tasa basal (kcal)', n.bmr_kcal, proposal.values.bmr_kcal],
    ['Proteína (g)', n.protein_g, proposal.values.protein_g],
    ['Carbohidratos (g)', n.carbs_g, proposal.values.carbs_g],
    ['Grasas (g)', n.fat_g, proposal.values.fat_g],
  ];
  section.appendChild(el('table', { class: 'compare-table' },
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col', text: 'Meta' }),
      el('th', { scope: 'col', text: 'Actual' }),
      el('th', { scope: 'col', text: 'Recomendada' }))),
    el('tbody', {}, ...rows.map(([label, cur, rec]) => el('tr', {},
      el('th', { scope: 'row', text: label }),
      el('td', { text: cur === null || cur === undefined ? '—' : fmtNum(Number(cur), 0) }),
      el('td', { class: Number(cur) !== rec ? 'compare-diff' : '', text: fmtNum(rec, 0) }))))));
  section.appendChild(el('p', { class: 'suggestion-detail', text: proposal.reason }));
  for (const w of proposal.warnings) section.appendChild(el('p', { class: 'formula-warn', text: w }));

  if (!proposal.changed) {
    section.appendChild(el('p', { class: 'auth-note', text: 'Tus metas actuales ya coinciden con las recomendadas.' }));
    return section;
  }
  const btn = el('button', { type: 'button', class: 'btn-primary', text: 'Aplicar meta recomendada' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await applyTargetsChange(data.personId, 'manual', proposal.reason, toWeekKey(new Date()), proposal.values);
      await ctx.setNutrition(await fetchNutrition());
      ctx.onTargetsChanged();
      showToast('✅ Metas aplicadas', 'success');
      await fillForm();
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
      btn.disabled = false;
    }
  });
  section.appendChild(btn);
  return section;
}
