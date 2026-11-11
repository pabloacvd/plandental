/**
 * nutrition.js — pure nutrition calculations (no DOM, no Supabase).
 *
 * Units: kg, g, cm, kcal. Dates are 'YYYY-MM-DD' strings (local calendar days).
 *
 * Functions that can fail to produce a value return `{ ok:false, reason }`
 * (reason in Spanish, shown to the user) instead of throwing.
 *
 * Sources (see profile-progress-plan.md):
 *   - Mifflin-St Jeor for BMR (Ricci et al. 2025, ISSN).
 *   - Protein 1.6–2.2 g/kg (Jäger et al. 2017 ISSN; Morton et al. 2018 BJSM).
 *   - Fat floor 0.5 g/kg/day (Ricci et al. 2025, ISSN).
 */

// ── Constants (formula constants live in code, not in the DB) ─────────────

export const ACTIVITY_LEVELS = [
  { id: 'sedentario', factor: 1.2,   label: 'Sedentario (poco o nada de ejercicio)' },
  { id: 'ligero',     factor: 1.375, label: 'Ligero (1–3 días por semana)' },
  { id: 'moderado',   factor: 1.55,  label: 'Moderado (3–5 días por semana, 30–60 min)' },
  { id: 'alto',       factor: 1.725, label: 'Alto (6–7 días por semana)' },
  { id: 'atleta',     factor: 1.9,   label: 'Atleta (entrenamiento intenso o doble turno)' },
];

export const GOALS = [
  { id: 'bajar',    label: 'Bajar grasa' },
  { id: 'mantener', label: 'Mantener' },
  { id: 'subir',    label: 'Subir de peso' },
];

export const KCAL_PER_KG = 7700;          // kcal per kg of body weight change
export const DEFAULT_DEFICIT_PCT = 20;
export const SURPLUS_FACTOR = 1.10;       // goal "subir": maintenance × 1.10
export const PROTEIN_G_PER_KG = { bajar: 2.0, mantener: 1.6, subir: 1.8 };
export const PROTEIN_MIN_G_PER_KG = 1.6;
export const PROTEIN_MAX_G_PER_KG = 2.2;
export const FAT_PCT_OF_KCAL = 0.25;
export const FAT_MIN_G_PER_KG = 0.5;
export const KCAL_FLOOR = { male: 1500, female: 1200 };

export const TREND_WINDOW_DAYS = 28;
export const TREND_MIN_ENTRIES = 3;
export const TREND_MIN_SPAN_DAYS = 14;
export const ADAPTIVE_MIN_WINDOW_DAYS = 21;
export const ADAPTIVE_MIN_COVERAGE = 0.7;       // heuristic, revisable
export const ADAPTIVE_FULL_WEIGHT_DAYS = 35;    // days of data for max weight
export const ADAPTIVE_MAX_WEIGHT = 0.8;
export const MAX_CHANGE_PCT = 0.05;             // per recalculation
export const MAX_CHANGE_KCAL = 150;
export const MIN_CHANGE_KCAL = 25;              // smaller changes are ignored
export const MAX_LOSS_PCT_PER_WEEK = 0.01;
export const STAGNATION_MIN_SPAN_DAYS = 21;
export const STAGNATION_KG_PER_WEEK = 0.1;      // |slope| below this = stalled
export const KCAL_TOLERANCE_PCT = 0.10;         // "on target" band

export const HEALTH_NOTICE =
  'Esta información es orientativa y no reemplaza el asesoramiento médico ni de un/a nutricionista.';

export const SOURCES = [
  'Jäger et al. 2017, ISSN Position Stand: protein and exercise. J Int Soc Sports Nutr 14:20.',
  'Morton et al. 2018, meta-análisis sobre proteína y masa magra. Br J Sports Med 52:376.',
  'Ricci et al. 2025, ISSN Position Stand (deportes de combate). J Int Soc Sports Nutr 22:2467909.',
  'Mifflin-St Jeor: ecuación de gasto energético en reposo, validada en la posición de Ricci et al. 2025.',
];

// ── Date helpers ──────────────────────────────────────────────────────────

/** Day number (days since epoch, UTC) of a 'YYYY-MM-DD' key. */
export function dayNumber(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function addDays(dateKey, n) {
  const dt = new Date((dayNumber(dateKey) + n) * 86400000);
  return dt.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' of a Date in local time. */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const round = n => Math.round(n);
const round1 = n => Math.round(n * 10) / 10;

// ── Formulas ──────────────────────────────────────────────────────────────

/** Mifflin-St Jeor BMR (kcal/day). sex: 'male' | 'female'. */
export function bmrMifflin(sex, kg, cm, age) {
  const base = 10 * kg + 6.25 * cm - 5 * age;
  return round(sex === 'male' ? base + 5 : base - 161);
}

export function activityFactor(activityLevel) {
  return (ACTIVITY_LEVELS.find(a => a.id === activityLevel) || ACTIVITY_LEVELS[2]).factor;
}

export function maintenanceFromFormula(bmr, activityLevel) {
  return round(bmr * activityFactor(activityLevel));
}

/** Calorie goal from maintenance. deficitPct is a percentage (20 = 20%). */
export function goalCalories(maintenance, goal, deficitPct = DEFAULT_DEFICIT_PCT) {
  if (goal === 'bajar')  return round(maintenance * (1 - deficitPct / 100));
  if (goal === 'subir')  return round(maintenance * SURPLUS_FACTOR);
  return round(maintenance);
}

/**
 * Macro targets: protein by g/kg, fat 25% of kcal (floor 0.5 g/kg),
 * carbohydrates as the remainder. 4 kcal/g protein and carbs, 9 kcal/g fat.
 */
export function macroTargets({ kcal, kg, goal }) {
  const protein = round(kg * (PROTEIN_G_PER_KG[goal] ?? PROTEIN_G_PER_KG.mantener));
  const fat = round(Math.max((kcal * FAT_PCT_OF_KCAL) / 9, kg * FAT_MIN_G_PER_KG));
  const carbs = Math.max(0, round((kcal - protein * 4 - fat * 9) / 4));
  return { protein_g: protein, fat_g: fat, carbs_g: carbs };
}

/**
 * Daily target from a maintenance value, with safety floor and warnings.
 * The floor (max of BMR and 1200/1500 kcal) only applies to goal "bajar".
 */
export function targetsFor({ bmr, maintenance, kg, sex, goal, deficitPct }) {
  const warnings = [];
  let kcal = goalCalories(maintenance, goal, deficitPct);
  let floorApplied = false;
  if (goal === 'bajar') {
    const floor = Math.max(bmr || 0, KCAL_FLOOR[sex] ?? KCAL_FLOOR.female);
    if (kcal < floor) {
      kcal = floor;
      floorApplied = true;
      warnings.push(
        `Con un déficit del ${deficitPct}% las calorías quedarían debajo del mínimo seguro; se usa ${floor} kcal.`);
    }
    const kgPerWeek = ((maintenance - kcal) * 7) / KCAL_PER_KG;
    if (kg && kgPerWeek > kg * MAX_LOSS_PCT_PER_WEEK) {
      warnings.push(
        `El ritmo implícito de pérdida (${round1(kgPerWeek)} kg/semana) supera el 1% del peso corporal por semana.`);
    }
  }
  const macros = macroTargets({ kcal, kg, goal });
  return {
    kcal, floorApplied, warnings,
    impliedKgPerWeek: round1(((maintenance - kcal) * 7) / KCAL_PER_KG),
    ...macros,
  };
}

/**
 * Full formula calculation with a step-by-step explanation (for the UI).
 * @param {{sex:string, kg:number, cm:number, age:number, activityLevel:string,
 *          goal:string, deficitPct:number}} p
 */
export function calcFromFormula(p) {
  const missing = [];
  if (p.sex !== 'male' && p.sex !== 'female') missing.push('sexo');
  if (!(p.kg > 0))  missing.push('peso');
  if (!(p.cm > 0))  missing.push('altura');
  if (!(p.age > 0)) missing.push('edad');
  if (missing.length) {
    return { ok: false, reason: `Faltan datos para calcular: ${missing.join(', ')}.` };
  }
  const bmr = bmrMifflin(p.sex, p.kg, p.cm, p.age);
  const factor = activityFactor(p.activityLevel);
  const maintenance = maintenanceFromFormula(bmr, p.activityLevel);
  const t = targetsFor({
    bmr, maintenance, kg: p.kg, sex: p.sex, goal: p.goal, deficitPct: p.deficitPct,
  });
  const steps = [
    `Tasa metabólica basal (Mifflin-St Jeor): 10 × ${p.kg} kg + 6,25 × ${p.cm} cm − 5 × ${p.age} años ${p.sex === 'male' ? '+ 5' : '− 161'} = ${bmr} kcal`,
    `Mantenimiento: ${bmr} × ${factor} (actividad ${p.activityLevel}) = ${maintenance} kcal`,
    p.goal === 'bajar'
      ? `Objetivo: ${maintenance} × (1 − ${p.deficitPct}%) = ${goalCalories(maintenance, 'bajar', p.deficitPct)} kcal`
      : p.goal === 'subir'
        ? `Objetivo: ${maintenance} × ${SURPLUS_FACTOR} = ${t.kcal} kcal`
        : `Objetivo: igual al mantenimiento = ${t.kcal} kcal`,
    ...(t.floorApplied ? [`Mínimo seguro aplicado: ${t.kcal} kcal`] : []),
    `Proteína: ${PROTEIN_G_PER_KG[p.goal] ?? 1.6} g/kg × ${p.kg} kg = ${t.protein_g} g`,
    `Grasa: 25% de las calorías (mínimo 0,5 g/kg) = ${t.fat_g} g`,
    `Carbohidratos: el resto de las calorías = ${t.carbs_g} g`,
  ];
  return {
    ok: true, bmr, maintenance, factor,
    daily_calories_kcal: t.kcal,
    protein_g: t.protein_g, carbs_g: t.carbs_g, fat_g: t.fat_g,
    warnings: t.warnings, steps,
  };
}

// ── Weight trend ──────────────────────────────────────────────────────────

/**
 * Linear regression over date and weight in the last 28 days.
 * Tolerates irregular weigh-ins; needs ≥3 entries spanning ≥14 days.
 * @param {Array<{date_key:string, weight_kg:number}>} entries
 * @param {{today?:string}} [opts]
 */
export function weightTrend(entries, { today = localDateKey() } = {}) {
  const t1 = dayNumber(today);
  const t0 = t1 - (TREND_WINDOW_DAYS - 1);
  const pts = (entries || [])
    .map(e => ({ x: dayNumber(e.date_key), y: Number(e.weight_kg), key: e.date_key }))
    .filter(p => Number.isFinite(p.y) && p.x >= t0 && p.x <= t1)
    .sort((a, b) => a.x - b.x);

  if (pts.length < TREND_MIN_ENTRIES) {
    return { ok: false, reason: `Hacen falta al menos ${TREND_MIN_ENTRIES} pesajes en los últimos ${TREND_WINDOW_DAYS} días (hay ${pts.length}).` };
  }
  const first = pts[0], last = pts[pts.length - 1];
  const span = last.x - first.x;
  if (span < TREND_MIN_SPAN_DAYS) {
    return { ok: false, reason: `Los pesajes tienen que abarcar al menos ${TREND_MIN_SPAN_DAYS} días (abarcan ${span}).` };
  }

  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;                 // kg/day
  const fitAt = x => my + slope * (x - mx);

  return {
    ok: true,
    slopeKgPerDay: slope,
    kgPerWeek: slope * 7,
    n, spanDays: span,
    firstDate: first.key, lastDate: last.key,
    startKg: fitAt(first.x), endKg: fitAt(last.x),
    latestKg: last.y,
    intercept: my - slope * mx, // weight = intercept + slope × dayNumber(date)
  };
}

// ── Intake helpers ────────────────────────────────────────────────────────

/** Rows with at least one meal and date ≤ cutoff (inclusive). */
export function validIntakeDays(intakeByDay, cutoffDateKey) {
  return (intakeByDay || []).filter(d =>
    d.meals_count > 0 && d.date_key <= cutoffDateKey);
}

/**
 * Real (adaptive) maintenance: average intake − slope × 7700, over the weight
 * trend period, using only days before today. Needs a window ≥21 days with
 * ≥70% of days having at least one meal. A day with a single small meal counts
 * as-is; days without any meal are "no data" and enter no average.
 */
export function adaptiveMaintenance({ intakeByDay, trend, today = localDateKey() }) {
  if (!trend?.ok) {
    return { ok: false, reason: trend?.reason || 'No hay tendencia de peso.' };
  }
  const yesterday = addDays(today, -1);
  const start = trend.firstDate;
  const end = trend.lastDate < yesterday ? trend.lastDate : yesterday;
  const windowDays = dayNumber(end) - dayNumber(start) + 1;
  if (windowDays < ADAPTIVE_MIN_WINDOW_DAYS) {
    return { ok: false, reason: `Hace falta una ventana de al menos ${ADAPTIVE_MIN_WINDOW_DAYS} días (hay ${Math.max(windowDays, 0)}).` };
  }
  const days = (intakeByDay || []).filter(d =>
    d.meals_count > 0 && d.date_key >= start && d.date_key <= end);
  const coverage = days.length / windowDays;
  if (coverage < ADAPTIVE_MIN_COVERAGE) {
    return {
      ok: false,
      reason: `Solo ${Math.round(coverage * 100)}% de los días tiene comidas en el plan (se necesita ${Math.round(ADAPTIVE_MIN_COVERAGE * 100)}%).`,
    };
  }
  const avgIntake = days.reduce((s, d) => s + d.kcal, 0) / days.length;
  const maintenance = avgIntake - trend.slopeKgPerDay * KCAL_PER_KG;
  return {
    ok: true,
    maintenance: round(maintenance),
    avgIntake: round(avgIntake),
    coverage, windowDays, daysWithData: days.length,
  };
}

// ── Recalculation proposal ────────────────────────────────────────────────

/**
 * Combine formula and adaptive maintenance and apply safety limits.
 *
 * @param {object} profile nutrition row: sex, height_cm, age_years,
 *        activity_level, goal, deficit_pct, maintenance_kcal,
 *        daily_calories_kcal, protein_g, weight_kg
 * @param {Array} weightLog [{date_key, weight_kg}]
 * @param {Array} intakeByDay [{date_key, kcal, meals_count, …}]
 * @param {{today?:string, limit?:boolean}} [opts] limit=false skips the ±5% cap
 *        (manual application of the recommended values).
 */
export function proposeTargets(profile, weightLog, intakeByDay, { today = localDateKey(), limit = true } = {}) {
  const sorted = [...(weightLog || [])].sort((a, b) => a.date_key.localeCompare(b.date_key));
  const latest = sorted.length ? sorted[sorted.length - 1].weight_kg : null;
  const kg = latest ?? Number(profile.weight_kg) ?? null;
  const goal = profile.goal || 'bajar';
  const deficitPct = profile.deficit_pct ?? DEFAULT_DEFICIT_PCT;
  const activityLevel = profile.activity_level || 'moderado';

  const f = calcFromFormula({
    sex: profile.sex, kg, cm: Number(profile.height_cm), age: Number(profile.age_years),
    activityLevel, goal, deficitPct,
  });
  if (!f.ok) return { ok: false, reason: f.reason };

  const trend = weightTrend(sorted, { today });
  const adaptive = adaptiveMaintenance({ intakeByDay, trend, today });

  let weight = 0;
  let blended = f.maintenance;
  if (adaptive.ok) {
    weight = Math.min(ADAPTIVE_MAX_WEIGHT, adaptive.daysWithData / ADAPTIVE_FULL_WEIGHT_DAYS);
    blended = f.maintenance * (1 - weight) + adaptive.maintenance * weight;
  }

  const current = Number(profile.maintenance_kcal) || null;
  let maintenance = round(blended);
  let capped = false;
  if (limit && current) {
    const cap = Math.min(current * MAX_CHANGE_PCT, MAX_CHANGE_KCAL);
    const delta = maintenance - current;
    if (Math.abs(delta) > cap) {
      maintenance = round(current + Math.sign(delta) * cap);
      capped = true;
    }
  }

  const t = targetsFor({
    bmr: f.bmr, maintenance, kg, sex: profile.sex, goal, deficitPct,
  });
  const values = {
    maintenance_kcal: maintenance,
    daily_calories_kcal: t.kcal,
    bmr_kcal: f.bmr,
    protein_g: t.protein_g,
    carbs_g: t.carbs_g,
    fat_g: t.fat_g,
  };

  const changed =
    !current ||
    Math.abs(maintenance - current) >= MIN_CHANGE_KCAL ||
    Math.abs(t.kcal - (Number(profile.daily_calories_kcal) || 0)) >= MIN_CHANGE_KCAL ||
    Math.abs(t.protein_g - (Number(profile.protein_g) || 0)) >= 5;

  const parts = [];
  if (adaptive.ok) {
    parts.push(
      `Mantenimiento por fórmula ${f.maintenance} kcal y por tu historial ${adaptive.maintenance} kcal ` +
      `(ingesta promedio ${adaptive.avgIntake} kcal, tendencia ${round1(trend.kgPerWeek)} kg/semana); ` +
      `se combinan con ${Math.round(weight * 100)}% de peso al historial.`);
  } else {
    parts.push(`Se usó la fórmula (${f.maintenance} kcal). Historial: ${adaptive.reason}`);
  }
  if (capped) {
    parts.push(`El cambio se limitó a ±${Math.round(MAX_CHANGE_PCT * 100)}% (máx. ${MAX_CHANGE_KCAL} kcal) por recálculo.`);
  }

  return {
    ok: true, changed, values,
    reason: parts.join(' '),
    warnings: [...f.warnings, ...t.warnings.filter(w => !f.warnings.includes(w))],
    breakdown: {
      formulaMaintenance: f.maintenance,
      adaptive, trend, adaptiveWeight: weight, capped, kg,
    },
  };
}

// ── Diet analysis ─────────────────────────────────────────────────────────

/**
 * @param {Array} days rows with at least one meal (already filtered)
 * @param {{daily_calories_kcal?:number, maintenance_kcal?:number}} targets
 * @param {number} kg current weight
 */
export function analyzeDiet(days, targets, kg) {
  const rows = days || [];
  const n = rows.length;
  if (!n) return { n: 0 };
  const avg = key => rows.reduce((s, d) => s + (d[key] || 0), 0) / n;
  const kcal = avg('kcal'), p = avg('protein_g'), c = avg('carbs_g'), f = avg('fat_g');
  const macroKcal = p * 4 + c * 4 + f * 9;
  const target = Number(targets?.daily_calories_kcal) || null;

  let daysOver = 0, daysUnder = 0, daysOnTarget = 0;
  if (target) {
    for (const d of rows) {
      if (d.kcal > target * (1 + KCAL_TOLERANCE_PCT)) daysOver++;
      else if (d.kcal < target * (1 - KCAL_TOLERANCE_PCT)) daysUnder++;
      else daysOnTarget++;
    }
  }
  return {
    n,
    avgKcal: round(kcal), avgProtein: round1(p), avgCarbs: round1(c), avgFat: round1(f),
    proteinPerKg: kg ? Math.round((p / kg) * 100) / 100 : null,
    fatPerKg: kg ? Math.round((f / kg) * 100) / 100 : null,
    pctProtein: macroKcal ? Math.round((p * 4 / macroKcal) * 100) : null,
    pctCarbs:   macroKcal ? Math.round((c * 4 / macroKcal) * 100) : null,
    pctFat:     macroKcal ? Math.round((f * 9 / macroKcal) * 100) : null,
    avgMeals: round1(avg('meals_count')),
    target,
    kcalVsTargetPct: target ? Math.round(((kcal - target) / target) * 100) : null,
    daysOver, daysUnder, daysOnTarget,
    adherencePct: target ? Math.round((daysOnTarget / n) * 100) : null,
  };
}

// ── Suggestions ───────────────────────────────────────────────────────────

const SRC_JAGER  = 'Jäger et al. 2017 (ISSN)';
const SRC_MORTON = 'Morton et al. 2018 (BJSM)';
const SRC_RICCI  = 'Ricci et al. 2025 (ISSN)';

/**
 * @returns {Array<{id:string, severity:'info'|'atencion'|'alerta', title:string,
 *                  detail:string, causes?:string[], source:string}>}
 */
export function buildSuggestions(analysis, trend, goal, ctx = {}) {
  const out = [];
  const a = analysis || { n: 0 };
  const add = s => out.push(s);

  if (!a.n) {
    add({
      id: 'no-data', severity: 'info',
      title: 'Todavía no hay días con comidas en el período',
      detail: 'Planificá comidas en el calendario para poder evaluar tu dieta. La ingesta se toma del plan.',
      source: 'PlanDental',
    });
  } else {
    // Protein
    if (a.proteinPerKg !== null) {
      if (a.proteinPerKg < 1.2) {
        add({
          id: 'protein-low', severity: 'alerta',
          title: `Proteína baja: ${a.proteinPerKg} g/kg`,
          detail: `El mínimo recomendado es ${PROTEIN_MIN_G_PER_KG} g/kg (objetivo ${PROTEIN_G_PER_KG[goal] ?? 1.6} g/kg al ${goal === 'bajar' ? 'bajar grasa' : 'sostener tu objetivo'}). Con déficit calórico, más proteína ayuda a conservar masa magra.`,
          source: SRC_JAGER,
        });
      } else if (a.proteinPerKg < PROTEIN_MIN_G_PER_KG) {
        add({
          id: 'protein-low', severity: 'atencion',
          title: `Proteína algo baja: ${a.proteinPerKg} g/kg`,
          detail: `Apuntá a ${PROTEIN_MIN_G_PER_KG}–${PROTEIN_MAX_G_PER_KG} g/kg. Sumá una porción de proteína en las comidas que menos tienen.`,
          source: SRC_JAGER,
        });
      } else if (a.proteinPerKg > PROTEIN_MAX_G_PER_KG) {
        add({
          id: 'protein-high', severity: 'info',
          title: `Proteína alta: ${a.proteinPerKg} g/kg`,
          detail: `Por encima de ~${PROTEIN_MAX_G_PER_KG} g/kg no hay beneficio adicional demostrado para conservar masa magra. Podés reemplazar parte por carbohidratos o grasas saludables.`,
          source: SRC_MORTON,
        });
      } else {
        add({
          id: 'protein-ok', severity: 'info',
          title: `Proteína en rango: ${a.proteinPerKg} g/kg`,
          detail: `Está dentro del rango recomendado (${PROTEIN_MIN_G_PER_KG}–${PROTEIN_MAX_G_PER_KG} g/kg).`,
          source: SRC_JAGER,
        });
      }
    }

    // Fat floor
    if (a.fatPerKg !== null && a.fatPerKg < FAT_MIN_G_PER_KG) {
      add({
        id: 'fat-low', severity: 'alerta',
        title: `Grasa por debajo del mínimo: ${a.fatPerKg} g/kg`,
        detail: `Mantené al menos ${FAT_MIN_G_PER_KG} g/kg por día de grasa (aceite de oliva, frutos secos, palta, huevo, pescado).`,
        source: SRC_RICCI,
      });
    }

    // Calories vs target
    if (a.target) {
      if (a.kcalVsTargetPct > 15) {
        add({
          id: 'kcal-over', severity: 'alerta',
          title: `Calorías ${a.kcalVsTargetPct}% por encima del objetivo`,
          detail: `El promedio del plan es ${a.avgKcal} kcal contra un objetivo de ${a.target} kcal. ${goal === 'bajar' ? 'Así no se genera el déficit buscado.' : ''}`.trim(),
          source: 'PlanDental',
        });
      } else if (a.kcalVsTargetPct > 5) {
        add({
          id: 'kcal-over', severity: 'atencion',
          title: `Calorías ${a.kcalVsTargetPct}% por encima del objetivo`,
          detail: `Promedio ${a.avgKcal} kcal contra ${a.target} kcal de objetivo. Revisá las porciones o los snacks.`,
          source: 'PlanDental',
        });
      } else if (a.kcalVsTargetPct < -15) {
        add({
          id: 'kcal-under', severity: 'atencion',
          title: `Calorías ${Math.abs(a.kcalVsTargetPct)}% por debajo del objetivo`,
          detail: `Promedio ${a.avgKcal} kcal contra ${a.target} kcal. Comer mucho menos de lo planificado puede aumentar la pérdida de masa magra y el cansancio.`,
          source: SRC_JAGER,
        });
      }
      if (a.daysOver + a.daysUnder > 0 && a.n >= 5) {
        add({
          id: 'adherence', severity: 'info',
          title: `${a.adherencePct}% de los días dentro de ±${Math.round(KCAL_TOLERANCE_PCT * 100)}% del objetivo`,
          detail: `${a.daysOver} días por encima y ${a.daysUnder} por debajo del rango.`,
          source: 'PlanDental',
        });
      }
    }

    // Protein distribution
    add({
      id: 'protein-distribution', severity: 'info',
      title: 'Repartí la proteína en varias comidas',
      detail: `Lo ideal son 20–40 g de proteína por toma, cada 3–4 horas${a.avgMeals && a.avgMeals < 3 ? `. Tu plan promedia ${a.avgMeals} comidas por día: sumar tomas ayuda a repartirla` : ''}.`,
      source: SRC_JAGER,
    });
  }

  // Rate of loss
  if (trend?.ok && ctx.kg) {
    const lossPerWeek = -trend.kgPerWeek;
    if (lossPerWeek > ctx.kg * MAX_LOSS_PCT_PER_WEEK) {
      add({
        id: 'rate-high', severity: 'alerta',
        title: `Ritmo de pérdida alto: ${round1(lossPerWeek)} kg/semana`,
        detail: 'Superás el 1% del peso corporal por semana. Un ritmo más lento conserva mejor la masa magra: considerá reducir el déficit.',
        source: SRC_JAGER,
      });
    }
  }

  // Stagnation / wrong direction (needs ≥3 weeks of trend)
  if (goal === 'bajar') {
    if (!trend?.ok) {
      add({
        id: 'trend-missing', severity: 'info',
        title: 'Faltan pesajes para evaluar la tendencia',
        detail: trend?.reason || 'Registrá tu peso 1 o 2 veces por semana.',
        source: 'PlanDental',
      });
    } else if (trend.spanDays < STAGNATION_MIN_SPAN_DAYS) {
      add({
        id: 'trend-short', severity: 'info',
        title: 'Tendencia todavía corta',
        detail: `Con ${trend.spanDays} días de datos no se puede hablar de estancamiento: hacen falta al menos 3 semanas. Mientras recomponés, la balanza puede avanzar más lento.`,
        source: 'PlanDental',
      });
    } else if (trend.kgPerWeek > -STAGNATION_KG_PER_WEEK) {
      const rising = trend.kgPerWeek > STAGNATION_KG_PER_WEEK;
      add({
        id: 'stagnation', severity: 'atencion',
        title: rising ? 'Tu peso viene subiendo' : 'Tu peso está estancado',
        detail: `La tendencia de las últimas ${Math.round(trend.spanDays / 7)} semanas es ${round1(trend.kgPerWeek)} kg/semana. Causas probables:`,
        causes: [
          'Tracking inexacto: porciones reales distintas de las del plan, o comidas que no se registraron.',
          'Retención de agua: sueño, estrés, sal, ciclo menstrual o inicio de entrenamiento enmascaran la pérdida.',
          'Adaptación metabólica: después de 8 semanas o más de déficit conviene una semana en mantenimiento.',
          'Mantenimiento real mayor al estimado: el recálculo automático lo corrige de a poco.',
        ],
        source: 'personal-trainer-skill (nutrition.md)',
      });
    }
    add({
      id: 'strength', severity: 'info',
      title: 'Sumá trabajo de fuerza',
      detail: 'Para bajar grasa conservando músculo se combinan déficit moderado, proteína alta y entrenamiento de fuerza 2–3 veces por semana. La app controla los dos primeros.',
      source: SRC_JAGER,
    });
  }

  return out;
}
