/**
 * calendar.js — week / date helpers
 */

import { scaledMacros } from './plan-versions.js';

/**
 * Return the ISO week number and year for a given date.
 */
export function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return { year: d.getFullYear(), week: weekNum };
}

/**
 * Given a year and ISO week number, return the Monday of that week.
 */
export function mondayOfISOWeek(year, week) {
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

/**
 * Return array of 7 Date objects for the week (Mon–Sun) given an anchor date.
 */
export function getWeekDays(anchorDate) {
  const { year, week } = getISOWeek(anchorDate);
  const monday = mondayOfISOWeek(year, week);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

/**
 * Format a Date as "YYYY-MM-DD" (local time).
 */
export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Return the week key "YYYY-Www".
 */
export function toWeekKey(date) {
  const { year, week } = getISOWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Spanish day names (short)
 */
export const DAY_NAMES_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Spanish month names
 */
export const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
];

/**
 * The 5 fixed meal slots for each day, in order (the autoplanner only uses these).
 */
export const MEAL_SLOTS = [
  { id: 'desayuno',    label: 'Desayuno',       icon: '☀️' },
  { id: 'almuerzo',    label: 'Almuerzo',        icon: '🍽️' },
  { id: 'snack_tarde', label: 'Snack tarde',     icon: '🥤' },
  { id: 'cena',        label: 'Cena',            icon: '🌙' },
  { id: 'snack_noche', label: 'Snack noche',     icon: '🥜' },
];

// ── Extra slots ("Snack extra") ──────────────────────────────
// Extra slots have the id `extra_<n>` and a period; each one is shown right
// after the fixed slot of its period (`anchor`).

export const EXTRA_SLOT_LABEL = 'Snack extra';
export const DEFAULT_EXTRA_PERIOD = 'tarde';
export const EXTRA_PERIODS = [
  { id: 'manana', label: 'Mañana', icon: '🌅', anchor: 'desayuno' },
  { id: 'tarde',  label: 'Tarde',  icon: '🍪', anchor: 'snack_tarde' },
  { id: 'noche',  label: 'Noche',  icon: '🌜', anchor: 'snack_noche' },
];

const EXTRA_ID_RE = /^extra_(\d+)$/;

const extraPeriod = id => EXTRA_PERIODS.find(p => p.id === id)
  || EXTRA_PERIODS.find(p => p.id === DEFAULT_EXTRA_PERIOD);
const extraNumber = id => Number(EXTRA_ID_RE.exec(id)[1]);

/** True for `extra_<n>` slot ids. */
export function isExtraSlot(slotId) {
  return typeof slotId === 'string' && EXTRA_ID_RE.test(slotId);
}

/** Fixed slot id after which the extras of `period` are shown (unknown → default period). */
export function extraAnchorSlot(period) {
  return extraPeriod(period).anchor;
}

/** Next free `extra_<n>` id: highest existing number + 1 (non-extra ids are ignored). */
export function nextExtraId(existingIds = []) {
  const max = existingIds.filter(isExtraSlot).reduce((m, id) => Math.max(m, extraNumber(id)), 0);
  return `extra_${max + 1}`;
}

/**
 * The extras of one day: those that have a meal in any of `dayEntries`
 * (slotId → meal objects) plus the pending (still empty) ones.
 * @returns {Array<{id:string, period:string}>}
 */
export function collectDayExtras(dayEntries = [], pending = []) {
  const byId = new Map();
  for (const entry of dayEntries) {
    for (const [slotId, meal] of Object.entries(entry || {})) {
      if (meal && isExtraSlot(slotId) && !byId.has(slotId)) byId.set(slotId, extraPeriod(meal.slotPeriod).id);
    }
  }
  for (const { id, period } of pending || []) {
    if (isExtraSlot(id) && !byId.has(id)) byId.set(id, extraPeriod(period).id);
  }
  return [...byId].map(([id, period]) => ({ id, period }));
}

/**
 * The 5 fixed slots with the extras interleaved: each extra goes right after the
 * fixed slot of its period; several in the same period are ordered by number.
 * `extras` items are `{ id, period }` or bare ids (bare ids use the default period).
 * @returns {Array<{id:string, label:string, icon:string, isExtra?:boolean, period?:string}>}
 */
export function orderedDaySlots(extras = []) {
  const seen = new Set();
  const list = [];
  for (const item of extras) {
    const id = typeof item === 'string' ? item : item?.id;
    if (!isExtraSlot(id) || seen.has(id)) continue;
    seen.add(id);
    const period = extraPeriod(typeof item === 'string' ? null : item.period);
    list.push({ id, label: EXTRA_SLOT_LABEL, icon: period.icon, isExtra: true, period: period.id, anchor: period.anchor });
  }
  list.sort((a, b) => extraNumber(a.id) - extraNumber(b.id));

  return MEAL_SLOTS.flatMap(slot => [
    slot,
    ...list.filter(e => e.anchor === slot.id).map(({ anchor, ...extra }) => extra),
  ]);
}

/**
 * Compute the total macros for a given day entry (object of slotId → meal).
 * Per-portion macros are multiplied by each meal's `servings`.
 */
export function computeDayMacros(dayEntry) {
  const totals = { calorias: 0, proteina_g: 0, carbohidratos_g: 0, grasas_g: 0 };
  if (!dayEntry) return totals;

  for (const slotId of Object.keys(dayEntry)) {
    const meal = dayEntry[slotId];
    if (!meal || !meal.macros) continue;
    const m = scaledMacros(meal);
    totals.calorias        += m.calorias;
    totals.proteina_g      += m.proteina_g;
    totals.carbohidratos_g += m.carbohidratos_g;
    totals.grasas_g        += m.grasas_g;
  }

  // Round to 1 decimal
  for (const k of Object.keys(totals)) {
    totals[k] = Math.round(totals[k] * 10) / 10;
  }
  return totals;
}
