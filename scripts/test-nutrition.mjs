/**
 * Minimal checks for js/nutrition.js (no dependencies).
 * Run: node scripts/test-nutrition.mjs
 */
import assert from 'node:assert/strict';
import {
  bmrMifflin, maintenanceFromFormula, goalCalories, macroTargets, targetsFor,
  calcFromFormula, weightTrend, adaptiveMaintenance, proposeTargets,
  analyzeDiet, buildSuggestions, addDays,
} from '../js/nutrition.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

const TODAY = '2026-06-30';
const day = n => addDays(TODAY, n);

// ── Formulas (reference: fitplan-skill) ──────────────────────
test('base case: male 30y 175cm 75kg moderado → 1699 / 2633 / 2106', () => {
  const bmr = bmrMifflin('male', 75, 175, 30);
  assert.equal(bmr, 1699);
  const m = maintenanceFromFormula(bmr, 'moderado');
  assert.equal(m, 2633);
  assert.equal(goalCalories(m, 'bajar', 20), 2106);
});

test('female BMR uses −161', () => {
  assert.equal(bmrMifflin('female', 60, 165, 30), Math.round(600 + 1031.25 - 150 - 161));
});

test('maintenance 2113 → target 1690 (Juli)', () => {
  assert.equal(goalCalories(2113, 'bajar', 20), 1690);
});

test('mantener and subir', () => {
  assert.equal(goalCalories(2000, 'mantener'), 2000);
  assert.equal(goalCalories(2000, 'subir'), 2200);
});

test('example: 2500 kcal → 2000 kcal → ~0.45 kg/week', () => {
  const t = targetsFor({ bmr: 1700, maintenance: 2500, kg: 80, sex: 'male', goal: 'bajar', deficitPct: 20 });
  assert.equal(t.kcal, 2000);
  assert.equal(t.impliedKgPerWeek, 0.5); // 500 × 7 / 7700 = 0.4545 → one decimal
});

test('macros: protein 2.0 g/kg, fat 25% with floor, carbs the rest', () => {
  const m = macroTargets({ kcal: 2106, kg: 75, goal: 'bajar' });
  assert.equal(m.protein_g, 150);
  assert.equal(m.fat_g, 59);   // 2106×0.25/9 = 58.5
  const kcal = m.protein_g * 4 + m.fat_g * 9 + m.carbs_g * 4;
  assert.ok(Math.abs(kcal - 2106) <= 4, `macro kcal ${kcal}`);
  // fat floor: 0.5 g/kg dominates at very low kcal
  const low = macroTargets({ kcal: 1000, kg: 100, goal: 'bajar' });
  assert.equal(low.fat_g, 50);
});

test('safety floor: target never below BMR/absolute floor', () => {
  const t = targetsFor({ bmr: 1300, maintenance: 1500, kg: 60, sex: 'female', goal: 'bajar', deficitPct: 30 });
  assert.equal(t.kcal, 1300);
  assert.equal(t.floorApplied, true);
  assert.ok(t.warnings.length > 0);
});

test('calcFromFormula reports missing data', () => {
  const r = calcFromFormula({ sex: null, kg: 70, cm: null, age: 30, activityLevel: 'moderado', goal: 'bajar', deficitPct: 20 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sexo/);
  assert.match(r.reason, /altura/);
});

// ── Weight trend with irregular data ─────────────────────────
function weights(pairs) {
  return pairs.map(([d, w]) => ({ date_key: day(d), weight_kg: w }));
}

test('trend: one weigh-in per week', () => {
  // −0.5 kg per week: days −28,−21,−14,−7,0
  const t = weightTrend(weights([[-27, 80], [-20, 79.5], [-13, 79], [-6, 78.5], [0, 78]]), { today: TODAY });
  assert.equal(t.ok, true);
  assert.ok(Math.abs(t.kgPerWeek - (-0.5 * 7 / 6.75)) < 0.2, `slope ${t.kgPerWeek}`);
  assert.ok(t.kgPerWeek < 0);
});

test('trend: two weigh-ins per week and exact slope', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 80 + d * (-0.5 / 7)]); // −0.5 kg/week exactly
  const t = weightTrend(weights(pts), { today: TODAY });
  assert.equal(t.ok, true);
  assert.ok(Math.abs(t.kgPerWeek - (-0.5)) < 1e-9, `slope ${t.kgPerWeek}`);
});

test('trend: gaps are tolerated', () => {
  const t = weightTrend(weights([[-26, 80], [-25, 80.1], [-3, 79], [0, 78.8]]), { today: TODAY });
  assert.equal(t.ok, true);
  assert.ok(t.kgPerWeek < 0);
});

test('trend: fewer than 3 entries → null with reason', () => {
  const t = weightTrend(weights([[-20, 80], [0, 79]]), { today: TODAY });
  assert.equal(t.ok, false);
  assert.match(t.reason, /al menos 3/);
});

test('trend: span under 14 days → null with reason', () => {
  const t = weightTrend(weights([[-10, 80], [-6, 79.8], [0, 79.5]]), { today: TODAY });
  assert.equal(t.ok, false);
  assert.match(t.reason, /14 días/);
});

test('trend: entries older than 28 days are ignored', () => {
  const t = weightTrend(weights([[-60, 90], [-50, 89], [-40, 88], [-5, 80]]), { today: TODAY });
  assert.equal(t.ok, false);
});

// ── Adaptive maintenance ─────────────────────────────────────
function intake(from, to, kcal, skip = () => false) {
  const rows = [];
  for (let d = from; d <= to; d++) {
    if (skip(d)) continue;
    rows.push({ date_key: day(d), kcal, protein_g: 120, carbs_g: 200, fat_g: 60, meals_count: 4 });
  }
  return rows;
}

test('adaptive: intake 2000, losing 0.5 kg/week → maintenance ≈ 2550', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 80 + d * (-0.5 / 7)]);
  const trend = weightTrend(weights(pts), { today: TODAY });
  const a = adaptiveMaintenance({ intakeByDay: intake(-27, -1, 2000), trend, today: TODAY });
  assert.equal(a.ok, true);
  // 2000 − (−0.5/7 × 7700) = 2550
  assert.ok(Math.abs(a.maintenance - 2550) <= 1, `maintenance ${a.maintenance}`);
});

test('adaptive: coverage under 70% → null with reason', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 80]);
  const trend = weightTrend(weights(pts), { today: TODAY });
  const a = adaptiveMaintenance({ intakeByDay: intake(-27, -1, 2000, d => d % 2 === 0), trend, today: TODAY });
  assert.equal(a.ok, false);
  assert.match(a.reason, /%/);
});

test('adaptive: a day with one low-calorie meal counts as-is; days without meals are no data', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 80]);
  const trend = weightTrend(weights(pts), { today: TODAY });
  const rows = intake(-27, -1, 2000);
  rows[3] = { ...rows[3], kcal: 300, meals_count: 1 };
  rows.splice(10, 1); // day without any meal → not in the view
  const a = adaptiveMaintenance({ intakeByDay: rows, trend, today: TODAY });
  assert.equal(a.ok, true);
  assert.equal(a.daysWithData, rows.length);
  const expected = Math.round(rows.reduce((s, r) => s + r.kcal, 0) / rows.length);
  assert.equal(a.avgIntake, expected);
});

test('adaptive: today is excluded', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 80]);
  const trend = weightTrend(weights(pts), { today: TODAY });
  const rows = [...intake(-27, -1, 2000), { date_key: day(0), kcal: 9999, protein_g: 0, carbs_g: 0, fat_g: 0, meals_count: 1 }];
  const a = adaptiveMaintenance({ intakeByDay: rows, trend, today: TODAY });
  assert.equal(a.avgIntake, 2000);
});

// ── proposeTargets ───────────────────────────────────────────
const profile = {
  sex: 'male', height_cm: 175, age_years: 30, activity_level: 'moderado',
  goal: 'bajar', deficit_pct: 20, maintenance_kcal: 2633, daily_calories_kcal: 2106,
  protein_g: 150, weight_kg: 75,
};

test('proposeTargets: without data falls back to the formula', () => {
  const r = proposeTargets(profile, [{ date_key: day(0), weight_kg: 75 }], [], { today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.values.maintenance_kcal, 2633);
  assert.equal(r.values.daily_calories_kcal, 2106);
  assert.equal(r.values.bmr_kcal, 1699);
  assert.equal(r.changed, false);
});

test('proposeTargets: change is capped at ±5% / 150 kcal', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 75 + d * (-0.5 / 7)]); // losing 0.5 kg/week at 2000 kcal
  const r = proposeTargets({ ...profile, maintenance_kcal: 2300, daily_calories_kcal: 1840 },
    weights(pts), intake(-27, -1, 2000), { today: TODAY });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.values.maintenance_kcal - 2300) <= 115, `maintenance ${r.values.maintenance_kcal}`);
  assert.equal(r.breakdown.capped, true);
});

test('proposeTargets: missing height/age/sex → not applicable', () => {
  const r = proposeTargets({ ...profile, height_cm: null }, [{ date_key: day(0), weight_kg: 75 }], [], { today: TODAY });
  assert.equal(r.ok, false);
  assert.match(r.reason, /altura/);
});

// ── analyzeDiet / suggestions ────────────────────────────────
test('analyzeDiet: g/kg and macro percentages', () => {
  const rows = intake(-6, 0, 2000);
  const a = analyzeDiet(rows, { daily_calories_kcal: 2000 }, 80);
  assert.equal(a.n, 7);
  assert.equal(a.proteinPerKg, 1.5);
  assert.equal(a.pctProtein + a.pctCarbs + a.pctFat >= 99, true);
  assert.equal(a.daysOnTarget, 7);
});

test('buildSuggestions: low protein, low fat, over calories, no stagnation under 3 weeks', () => {
  const rows = [{ date_key: day(0), kcal: 2600, protein_g: 80, carbs_g: 300, fat_g: 30, meals_count: 3 }];
  const a = analyzeDiet(rows, { daily_calories_kcal: 2000 }, 80);
  const trend = weightTrend(weights([[-17, 80], [-10, 80], [0, 80]]), { today: TODAY });
  const s = buildSuggestions(a, trend, 'bajar', { kg: 80 });
  const ids = s.map(x => x.id);
  assert.ok(ids.includes('protein-low'));
  assert.ok(ids.includes('fat-low'));
  assert.ok(ids.includes('kcal-over'));
  assert.ok(ids.includes('trend-short'));
  assert.ok(!ids.includes('stagnation'));
  assert.ok(ids.includes('strength'));
});

test('buildSuggestions: stagnation with 4 causes after ≥3 weeks', () => {
  const trend = weightTrend(weights([[-27, 80], [-18, 80.1], [-9, 79.9], [0, 80]]), { today: TODAY });
  const a = analyzeDiet(intake(-6, 0, 2000), { daily_calories_kcal: 2000 }, 80);
  const s = buildSuggestions(a, trend, 'bajar', { kg: 80 });
  const st = s.find(x => x.id === 'stagnation');
  assert.ok(st);
  assert.equal(st.causes.length, 4);
});

test('buildSuggestions: rate of loss over 1%/week', () => {
  const pts = [];
  for (let d = -27; d <= 0; d += 3) pts.push([d, 80 + d * (-1.2 / 7)]); // −1.2 kg/week = 1.5%
  const trend = weightTrend(weights(pts), { today: TODAY });
  const s = buildSuggestions(analyzeDiet(intake(-6, 0, 1800), { daily_calories_kcal: 1800 }, 80), trend, 'bajar', { kg: 80 });
  assert.ok(s.some(x => x.id === 'rate-high'));
});

console.log(`\n${passed} tests passed`);
