/**
 * calendar.js — week / date helpers
 */

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
 * The meal slots for each day, in order.
 */
export const MEAL_SLOTS = [
  { id: 'desayuno',    label: 'Desayuno',       icon: '☀️' },
  { id: 'almuerzo',    label: 'Almuerzo',        icon: '🍽️' },
  { id: 'snack_tarde', label: 'Snack tarde',     icon: '🥤' },
  { id: 'cena',        label: 'Cena',            icon: '🌙' },
  { id: 'snack_noche', label: 'Snack noche',     icon: '🥜' },
];

/**
 * Compute the total macros for a given day entry (object of slotId → meal).
 */
export function computeDayMacros(dayEntry) {
  const totals = { calorias: 0, proteina_g: 0, carbohidratos_g: 0, grasas_g: 0 };
  if (!dayEntry) return totals;

  for (const slotId of Object.keys(dayEntry)) {
    const meal = dayEntry[slotId];
    if (!meal || !meal.macros) continue;
    totals.calorias      += meal.macros.calorias      || 0;
    totals.proteina_g    += meal.macros.proteina_g    || 0;
    totals.carbohidratos_g += meal.macros.carbohidratos_g || 0;
    totals.grasas_g      += meal.macros.grasas_g      || 0;
  }

  // Round to 1 decimal
  for (const k of Object.keys(totals)) {
    totals[k] = Math.round(totals[k] * 10) / 10;
  }
  return totals;
}
