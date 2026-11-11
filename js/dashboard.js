/**
 * dashboard.js — "Dashboard" tab of Perfil y progreso.
 *
 * Reads person_daily_intake and the weight log through the storage layer and
 * draws the charts with the SVG helpers of charts.js. Intake comes from the
 * plan: every meal planned for today or earlier counts as eaten, days without
 * any meal are "sin datos" (never zero) and future days are not considered.
 */

import { el, barChart, lineChart, fmtDay, fmtDayFull, fmtNum } from './charts.js';
import { fetchDailyIntake } from './storage.js';
import {
  analyzeDiet, weightTrend, dayNumber, addDays, localDateKey,
  KCAL_PER_KG, KCAL_TOLERANCE_PCT,
} from './nutrition.js';
import { getISOWeek } from './calendar.js';

const WINDOWS = [7, 30, 90];
let windowDays = 30;
let renderSeq = 0;

/**
 * @param {HTMLElement} root
 * @param {{personId:string, name:string, nutrition:object,
 *          weights:Array<{date_key:string, weight_kg:number}>}} data
 */
export async function renderDashboard(root, data) {
  const token = ++renderSeq;
  root.replaceChildren(el('p', { class: 'dash-note', text: 'Cargando…' }));

  const today = localDateKey();
  const from = addDays(today, -(windowDays - 1));
  const intake = await fetchDailyIntake(data.personId, from, today);
  if (token !== renderSeq) return; // a newer render replaced this one

  const nutrition = data.nutrition || {};
  const weights = data.weights || [];
  const target = Number(nutrition.daily_calories_kcal) || null;
  const maintenance = Number(nutrition.maintenance_kcal) || null;
  const latestKg = weights.length ? weights[weights.length - 1].weight_kg : (Number(nutrition.weight_kg) || null);
  const days = intake.filter(d => d.meals_count > 0);
  const analysis = analyzeDiet(days, nutrition, latestKg);
  const trend = weightTrend(weights, { today });

  const frag = document.createDocumentFragment();
  frag.appendChild(buildControls(root, data));
  frag.appendChild(el('p', {
    class: 'dash-note',
    text: 'La ingesta se toma del plan: las comidas planificadas para hoy o días anteriores se consideran consumidas. Los días sin comidas figuran como "sin datos" y los días futuros no cuentan.',
  }));
  frag.appendChild(buildCards({ weights, windowFrom: from, trend, analysis }));
  frag.appendChild(buildCaloriesChart({ intake, from, today, target, maintenance }));
  frag.appendChild(buildWeightChart({ weights, from, today, trend, targetWeight: Number(nutrition.target_weight_kg) || null }));
  frag.appendChild(buildMacros({ analysis, nutrition, kg: latestKg }));
  frag.appendChild(buildWeeklyBalance({ days, maintenance }));
  root.replaceChildren(frag);
}

// ── Controls ──────────────────────────────────────────────────

function buildControls(root, data) {
  const group = el('div', { class: 'dash-controls', role: 'group', 'aria-label': 'Período' });
  for (const n of WINDOWS) {
    const btn = el('button', {
      type: 'button',
      class: 'dash-window' + (n === windowDays ? ' active' : ''),
      'aria-pressed': n === windowDays ? 'true' : 'false',
      text: `${n} días`,
    });
    btn.addEventListener('click', () => {
      windowDays = n;
      renderDashboard(root, data);
    });
    group.appendChild(btn);
  }
  return group;
}

// ── Summary cards ─────────────────────────────────────────────

function card(label, value, hint) {
  return el('div', { class: 'dash-card' },
    el('div', { class: 'dash-card-label', text: label }),
    el('div', { class: 'dash-card-value', text: value }),
    hint ? el('div', { class: 'dash-card-hint', text: hint }) : null);
}

function buildCards({ weights, windowFrom, trend, analysis }) {
  const latest = weights.length ? weights[weights.length - 1] : null;
  const inWindow = weights.filter(w => w.date_key >= windowFrom);
  let change = '—', changeHint = 'Hacen falta 2 pesajes en el período';
  if (inWindow.length >= 2) {
    const d = inWindow[inWindow.length - 1].weight_kg - inWindow[0].weight_kg;
    change = `${d > 0 ? '+' : ''}${fmtNum(d, 1)} kg`;
    changeHint = `${fmtDay(inWindow[0].date_key)} → ${fmtDay(inWindow[inWindow.length - 1].date_key)}`;
  }
  const pace = trend.ok ? `${trend.kgPerWeek > 0 ? '+' : ''}${fmtNum(trend.kgPerWeek, 2)} kg/sem` : '—';
  const paceHint = trend.ok ? `Tendencia de ${trend.n} pesajes` : trend.reason;
  const adherence = analysis.adherencePct !== null && analysis.adherencePct !== undefined
    ? `${analysis.adherencePct}%` : '—';
  const adherenceHint = analysis.n
    ? `${analysis.daysOnTarget} de ${analysis.n} días dentro de ±${Math.round(KCAL_TOLERANCE_PCT * 100)}%`
    : 'Sin días con comidas en el plan';

  return el('div', { class: 'dash-cards' },
    card('Peso actual', latest ? `${fmtNum(latest.weight_kg, 1)} kg` : '—',
      latest ? fmtDayFull(latest.date_key) : 'Registrá tu peso en la pestaña Datos'),
    card('Cambio en el período', change, changeHint),
    card('Ritmo', pace, paceHint),
    card('Adherencia a calorías', adherence, adherenceHint));
}

// ── Calories chart ────────────────────────────────────────────

function section(title, ...children) {
  return el('section', { class: 'dash-section' }, el('h5', { text: title }), ...children);
}

function legendItem(cls, text) {
  return el('span', { class: 'ch-legend-item' }, el('span', { class: `ch-swatch ${cls}` }), text);
}

function buildCaloriesChart({ intake, from, today, target, maintenance }) {
  const byDay = new Map(intake.map(d => [d.date_key, d]));
  const series = [];
  for (let k = from; k <= today; k = addDays(k, 1)) {
    const row = byDay.get(k);
    if (!row || row.meals_count <= 0) { series.push({ label: fmtDay(k), value: null }); continue; }
    let cls = 'ch-bar--ok';
    if (target && row.kcal > target * (1 + KCAL_TOLERANCE_PCT)) cls = 'ch-bar--over';
    else if (target && row.kcal < target * (1 - KCAL_TOLERANCE_PCT)) cls = 'ch-bar--under';
    series.push({
      label: fmtDay(k), value: Math.round(row.kcal), cls,
      title: `${fmtDayFull(k)}: ${Math.round(row.kcal)} kcal (${row.meals_count} comidas)`,
    });
  }
  const withData = series.filter(s => s.value !== null);
  if (!withData.length) {
    return section('Calorías por día',
      el('p', { class: 'dash-empty', text: 'No hay días con comidas en el plan para este período. Planificá comidas en el calendario.' }));
  }
  const avg = Math.round(withData.reduce((s, d) => s + d.value, 0) / withData.length);
  const refLines = [];
  if (target) refLines.push({ value: target, label: `Objetivo ${target}`, cls: 'ch-ref--target' });
  if (maintenance) refLines.push({ value: maintenance, label: `Mantenimiento ${maintenance}`, cls: 'ch-ref--maint' });

  return section('Calorías por día',
    barChart({
      data: series, refLines, height: 210,
      ariaLabel: `Calorías por día. Promedio ${avg} kcal en ${withData.length} días con datos.${target ? ` Objetivo ${target} kcal.` : ''}`,
    }),
    el('div', { class: 'ch-legend' },
      legendItem('ch-bar--ok', 'Dentro de ±10%'),
      legendItem('ch-bar--over', 'Por encima'),
      legendItem('ch-bar--under', 'Por debajo')),
    el('p', { class: 'ch-summary', text: `Promedio: ${avg} kcal en ${withData.length} de ${series.length} días con comidas.` }));
}

// ── Weight chart ──────────────────────────────────────────────

function buildWeightChart({ weights, from, today, trend, targetWeight }) {
  const pts = weights.filter(w => w.date_key >= from && w.date_key <= today);
  if (pts.length < 2) {
    return section('Peso',
      el('p', { class: 'dash-empty', text: 'Registrá al menos 2 pesajes en este período para ver el gráfico de peso.' }));
  }
  const xMin = dayNumber(from), xMax = dayNumber(today);
  const ys = pts.map(p => p.weight_kg);
  if (targetWeight) ys.push(targetWeight);
  const yMin = Math.floor(Math.min(...ys) - 0.5);
  const yMax = Math.ceil(Math.max(...ys) + 0.5);

  const xTicks = [];
  const ticksN = 4;
  for (let i = 0; i <= ticksN; i++) {
    const x = Math.round(xMin + ((xMax - xMin) * i) / ticksN);
    xTicks.push({ x, label: fmtDay(new Date(x * 86400000).toISOString().slice(0, 10)) });
  }

  const series = [{
    cls: 'ch-line--weight', dots: true,
    points: pts.map(p => ({ x: dayNumber(p.date_key), y: p.weight_kg, title: `${fmtDayFull(p.date_key)}: ${fmtNum(p.weight_kg, 1)} kg` })),
  }];
  if (trend.ok) {
    series.push({
      cls: 'ch-line--trend',
      points: [
        { x: dayNumber(trend.firstDate), y: trend.startKg },
        { x: dayNumber(trend.lastDate), y: trend.endKg },
      ],
    });
  }
  const refLines = targetWeight
    ? [{ value: targetWeight, label: `Objetivo ${fmtNum(targetWeight, 1)} kg`, cls: 'ch-ref--target' }] : [];

  const first = pts[0], last = pts[pts.length - 1];
  return section('Peso',
    lineChart({
      series, xMin, xMax, yMin, yMax, xTicks, refLines, height: 210,
      format: v => fmtNum(v, 1),
      ariaLabel: `Peso: de ${fmtNum(first.weight_kg, 1)} kg el ${fmtDayFull(first.date_key)} a ${fmtNum(last.weight_kg, 1)} kg el ${fmtDayFull(last.date_key)}.`,
    }),
    el('div', { class: 'ch-legend' },
      legendItem('ch-swatch--weight', 'Pesajes'),
      trend.ok ? legendItem('ch-swatch--trend', 'Tendencia (últimos 28 días)') : null),
    el('p', {
      class: 'ch-summary',
      text: trend.ok
        ? `Tendencia: ${trend.kgPerWeek > 0 ? '+' : ''}${fmtNum(trend.kgPerWeek, 2)} kg/semana.`
        : `Tendencia no disponible: ${trend.reason}`,
    }));
}

// ── Macros ────────────────────────────────────────────────────

function macroRow({ label, cls, grams, target, kcalPct, perKg }) {
  const pct = target ? Math.min(100, Math.round((grams / target) * 100)) : 0;
  const meter = el('div', { class: 'meter', role: 'presentation' }, el('span', { class: `meter-fill ${cls}` }));
  meter.firstChild.style.width = `${pct}%`;
  return el('div', { class: 'macro-row' },
    el('div', { class: 'macro-row-head' },
      el('span', { class: 'macro-row-label', text: label }),
      el('span', { class: 'macro-row-value', text: `${fmtNum(grams, 0)} g${target ? ` / ${fmtNum(target, 0)} g` : ''}` })),
    target ? meter : null,
    el('div', { class: 'macro-row-sub', text: `${perKg !== null && perKg !== undefined ? `${fmtNum(perKg, 2)} g/kg · ` : ''}${kcalPct !== null ? `${kcalPct}% de las calorías` : ''}` }));
}

function buildMacros({ analysis, nutrition, kg }) {
  if (!analysis.n) {
    return section('Macros promedio',
      el('p', { class: 'dash-empty', text: 'Sin días con comidas en el plan para este período.' }));
  }
  const perKg = g => (kg ? g / kg : null);
  return section('Macros promedio por día',
    macroRow({ label: 'Proteína', cls: 'meter-fill--protein', grams: analysis.avgProtein, target: Number(nutrition.protein_g) || null, kcalPct: analysis.pctProtein, perKg: perKg(analysis.avgProtein) }),
    macroRow({ label: 'Carbohidratos', cls: 'meter-fill--carbs', grams: analysis.avgCarbs, target: Number(nutrition.carbs_g) || null, kcalPct: analysis.pctCarbs, perKg: perKg(analysis.avgCarbs) }),
    macroRow({ label: 'Grasas', cls: 'meter-fill--fat', grams: analysis.avgFat, target: Number(nutrition.fat_g) || null, kcalPct: analysis.pctFat, perKg: perKg(analysis.avgFat) }),
    el('p', { class: 'ch-summary', text: `Promedio de ${analysis.n} días con comidas: ${analysis.avgKcal} kcal.` }));
}

// ── Weekly balance ────────────────────────────────────────────

function buildWeeklyBalance({ days, maintenance }) {
  if (!maintenance) {
    return section('Déficit / superávit semanal',
      el('p', { class: 'dash-empty', text: 'Cargá las calorías de mantenimiento en la pestaña Datos para ver el balance.' }));
  }
  if (!days.length) {
    return section('Déficit / superávit semanal',
      el('p', { class: 'dash-empty', text: 'Sin días con comidas en el plan para este período.' }));
  }
  const weeks = new Map();
  for (const d of days) {
    const { year, week } = getISOWeek(new Date(`${d.date_key}T12:00:00`));
    const key = `${year}-W${String(week).padStart(2, '0')}`;
    const w = weeks.get(key) || { week, sum: 0, count: 0 };
    w.sum += d.kcal - maintenance;
    w.count += 1;
    weeks.set(key, w);
  }
  const data = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, w]) => ({
    label: `S${w.week}`,
    value: Math.round(w.sum),
    cls: w.sum <= 0 ? 'ch-bar--neg' : 'ch-bar--pos',
    title: `Semana ${w.week}: ${Math.round(w.sum)} kcal ≈ ${fmtNum(w.sum / KCAL_PER_KG, 2)} kg (${w.count} días con datos)`,
  }));
  const total = [...weeks.values()].reduce((s, w) => s + w.sum, 0);
  return section('Déficit / superávit semanal',
    barChart({
      data, height: 190,
      ariaLabel: `Balance calórico semanal contra el mantenimiento de ${maintenance} kcal. Total del período ${Math.round(total)} kcal.`,
    }),
    el('div', { class: 'ch-legend' },
      legendItem('ch-bar--neg', 'Déficit (−)'),
      legendItem('ch-bar--pos', 'Superávit (+)')),
    el('p', {
      class: 'ch-summary',
      text: `Acumulado del período: ${total > 0 ? '+' : ''}${Math.round(total)} kcal ≈ ${total > 0 ? '+' : ''}${fmtNum(total / KCAL_PER_KG, 2)} kg estimados (${KCAL_PER_KG} kcal por kg). Solo cuenta los días con comidas.`,
    }));
}
