/**
 * migrate-to-supabase.js
 * ─────────────────────────────────────────────────────────────
 * One-shot idempotent data migration from local JSON files to Supabase.
 * Safe to run multiple times — uses upserts throughout.
 *
 * Usage (from scripts/):
 *   cp .env.example .env   # fill in your keys
 *   npm install
 *   npm run migrate
 *
 * The script reads:
 *   ../data/recipes.json      → public.recipes
 *   ../data/nutrition.json    → public.nutrition_data
 *   ../data/plan.json         → public.plans
 *     (plan.json is gitignored; if absent the plan migration is skipped)
 *
 * Person IDs are the fixed UUIDs set in seed.sql:
 *   Pablo → 00000000-0000-0000-0000-000000000010
 *   Juli  → 00000000-0000-0000-0000-000000000011
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Config — loaded from .env (gitignored) ────────────────────
// Node 20.6+ supports --env-file; for older Node we read manually.
function loadEnv() {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '.env');
  if (!existsSync(envPath)) {
    console.error('scripts/.env not found. Copy .env.example → .env and fill in your keys.');
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const SUPABASE_URL         = process.env.SUPABASE_URL;
// Service role key — bypasses RLS; never exposed to the browser.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_KEY missing in scripts/.env');
  process.exit(1);
}

// Fixed person UUIDs matching seed.sql
const PERSON_IDS = {
  Pablo: '00000000-0000-0000-0000-000000000010',
  Juli:  '00000000-0000-0000-0000-000000000011',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = resolve(__dirname, '../data');

// ── Supabase client (service role — admin bypass) ─────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Helpers ───────────────────────────────────────────────────

function readJSON(filename) {
  const path = resolve(DATA_DIR, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function log(msg)  { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.warn(`  ⚠  ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

async function dbCheck(label, promise) {
  const { error } = await promise;
  if (error) fail(`${label}: ${error.message}`);
  log(label);
}

// ── 1. Migrate recipes ────────────────────────────────────────

async function migrateRecipes() {
  console.log('\n── recipes ─────────────────────────────────────');
  const raw = readJSON('recipes.json');
  if (!raw) { warn('data/recipes.json not found — skipping'); return; }

  const rows = (raw.recetas || []).map(({ id, receta }) => ({
    id,
    nombre:   receta.nombre   || '',
    categoria: receta.categoria || null,
    receta,                          // full object preserved in JSONB
    updated_at: new Date().toISOString(),
  }));

  if (!rows.length) { warn('No recipes found — skipping'); return; }

  // Upsert in one batch (Supabase limit is 1000 rows per request; we have ~10)
  const { error } = await supabase
    .from('recipes')
    .upsert(rows, { onConflict: 'id' });

  if (error) fail(`recipes upsert: ${error.message}`);
  log(`${rows.length} recipes upserted`);
}

// ── 2. Migrate nutrition data ─────────────────────────────────

async function migrateNutrition() {
  console.log('\n── nutrition_data ──────────────────────────────');
  const raw = readJSON('nutrition.json');
  if (!raw) { warn('data/nutrition.json not found — skipping'); return; }

  const personMap = raw.nutrition || {};

  for (const [personName, data] of Object.entries(personMap)) {
    const personId = PERSON_IDS[personName];
    if (!personId) {
      warn(`Unknown person "${personName}" in nutrition.json — skipping`);
      continue;
    }

    const row = {
      person_id:            personId,
      bmr_kcal:             data.bmr_kcal            ?? null,
      daily_calories_kcal:  data.daily_calories_kcal ?? null,
      protein_g:            data.protein_g            ?? null,
      carbs_g:              data.carbs_g              ?? null,
      fat_g:                data.fat_g                ?? null,
      creatine_g:           data.creatine_g           ?? null,
      whey_g:               data.whey_g               ?? null,
      whey_purity_percent:  data.whey_purity_percent  ?? null,
      notes:                data.notes                ?? null,
      data,                                            // full blob (body_composition, projections, etc.)
      updated_at:           new Date().toISOString(),
    };

    const { error } = await supabase
      .from('nutrition_data')
      .upsert(row, { onConflict: 'person_id' });

    if (error) fail(`nutrition_data for ${personName}: ${error.message}`);
    log(`nutrition_data for ${personName} upserted`);
  }
}

// ── 3. Migrate plan ───────────────────────────────────────────
//
// plan.json structure:
// {
//   "Pablo": {
//     "2025-W27": {
//       "2025-07-07": {
//         "desayuno":    { recipeId, recipeName, macros },
//         "almuerzo":    { ... },
//         "snack_tarde": { ... },
//         "cena":        { ... },
//         "snack_noche": { ... }
//       }
//     }
//   },
//   "Juli": { ... }
// }
//
// Each slot becomes one row in public.plans.

async function migratePlan() {
  console.log('\n── plans ───────────────────────────────────────');
  const raw = readJSON('plan.json');
  if (!raw) {
    warn('data/plan.json not found (it is gitignored) — skipping plan migration.');
    warn('If you have a copy of plan.json, place it in data/ and re-run.');
    return;
  }

  const rows = [];

  for (const [personName, weekMap] of Object.entries(raw)) {
    const personId = PERSON_IDS[personName];
    if (!personId) {
      warn(`Unknown person "${personName}" in plan.json — skipping`);
      continue;
    }

    for (const [weekKey, dayMap] of Object.entries(weekMap)) {
      for (const [dateKey, slotMap] of Object.entries(dayMap)) {
        for (const [slotId, meal] of Object.entries(slotMap)) {
          if (!meal?.recipeId) continue;

          // Validate slot_id against the DB check constraint
          const validSlots = ['desayuno','almuerzo','snack_tarde','cena','snack_noche'];
          if (!validSlots.includes(slotId)) {
            warn(`Unknown slot "${slotId}" for ${personName}/${dateKey} — skipping`);
            continue;
          }

          rows.push({
            person_id:   personId,
            date_key:    dateKey,
            week_key:    weekKey,
            slot_id:     slotId,
            recipe_id:   meal.recipeId,
            recipe_name: meal.recipeName || '',
            macros:      meal.macros     || {},
            updated_at:  new Date().toISOString(),
          });
        }
      }
    }
  }

  if (!rows.length) { warn('plan.json found but contains no meal entries'); return; }

  // Upsert in chunks of 500 to stay well within Supabase limits
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('plans')
      .upsert(chunk, { onConflict: 'person_id,date_key,slot_id' });
    if (error) fail(`plans upsert (chunk ${i}): ${error.message}`);
    total += chunk.length;
  }

  log(`${total} plan entries upserted`);
}

// ── 4. Verification summary ───────────────────────────────────

async function verify() {
  console.log('\n── verification ────────────────────────────────');

  const [rCount, nCount, pCount] = await Promise.all([
    supabase.from('recipes').select('id', { count: 'exact', head: true }),
    supabase.from('nutrition_data').select('id', { count: 'exact', head: true }),
    supabase.from('plans').select('id', { count: 'exact', head: true }),
  ]);

  log(`recipes:        ${rCount.count ?? '?'} rows`);
  log(`nutrition_data: ${nCount.count ?? '?'} rows`);
  log(`plans:          ${pCount.count ?? '?'} rows`);
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('PlanDental → Supabase data migration');
  console.log('=====================================');

  await migrateRecipes();
  await migrateNutrition();
  await migratePlan();
  await verify();

  console.log('\n✅ Migration complete.\n');
  console.log('⚠️  Reminder: change the admin password before the app goes live.\n');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
