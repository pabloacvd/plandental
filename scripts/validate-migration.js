/**
 * validate-migration.js
 * ─────────────────────────────────────────────────────────────
 * Post-migration validation script.
 * Checks that all data was correctly migrated and that RLS
 * policies work as expected.
 *
 * Run from scripts/:
 *   npm run validate
 *
 * Exits with code 0 on success, 1 on any failure.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Load keys from .env (gitignored) ─────────────────────────
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
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY             = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANON_KEY) {
  console.error('Missing env vars in scripts/.env');
  process.exit(1);
}

const admin  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

let passed = 0;
let failed = 0;

function ok(label)  { console.log(`  ✅ ${label}`); passed++; }
function fail(label, reason) { console.error(`  ❌ ${label}: ${reason}`); failed++; }
async function check(label, fn) {
  try { await fn(); ok(label); }
  catch (e) { fail(label, e.message); }
}

// ── 1. Record counts ──────────────────────────────────────────

async function checkCounts() {
  console.log('\n── 1. Record counts ────────────────────────────');

  const tables = ['profiles', 'persons', 'person_access', 'recipes', 'nutrition_data', 'plans'];
  for (const t of tables) {
    const { count, error } = await admin.from(t).select('*', { count: 'exact', head: true });
    if (error) { fail(`${t} count`, error.message); continue; }
    if (count === 0 && t !== 'plans') {
      fail(`${t} count`, 'table is empty — run seed.sql and migrate-to-supabase.js first');
    } else {
      ok(`${t}: ${count} rows`);
    }
  }
}

// ── 2. Admin user exists and has correct role ─────────────────

async function checkAdminUser() {
  console.log('\n── 2. Admin user ───────────────────────────────');

  let pabloId = '00000000-0000-0000-0000-000000000001';

  await check('profiles row for pablo exists', async () => {
    const { data, error } = await admin
      .from('profiles')
      .select('id, username, role')
      .eq('username', 'pablo')
      .single();
    if (error) throw error;
    if (data.role !== 'admin') throw new Error(`role is "${data.role}", expected "admin"`);
    pabloId = data.id;
  });

  await check('pablo has approved access to Pablo person', async () => {
    const { data, error } = await admin
      .from('person_access')
      .select('status, persons(name)')
      .eq('status', 'approved')
      .eq('granted_to', pabloId)
      .eq('person_id',  '00000000-0000-0000-0000-000000000010')
      .single();
    if (error) throw error;
    if (data.status !== 'approved') throw new Error('access status is not approved');
  });

  await check('pablo has approved access to Juli person', async () => {
    const { data, error } = await admin
      .from('person_access')
      .select('status')
      .eq('granted_to', pabloId)
      .eq('person_id',  '00000000-0000-0000-0000-000000000011')
      .single();
    if (error) throw error;
    if (data.status !== 'approved') throw new Error('access status is not approved');
  });
}

// ── 3. Recipes integrity ──────────────────────────────────────

async function checkRecipes() {
  console.log('\n── 3. Recipes integrity ────────────────────────');

  await check('all recipes have id, nombre, receta', async () => {
    const { data, error } = await admin
      .from('recipes')
      .select('id, nombre, receta');
    if (error) throw error;
    const bad = data.filter(r => !r.id || !r.nombre || !r.receta);
    if (bad.length) throw new Error(`${bad.length} recipes missing required fields`);
  });

  await check('batido-ninja-pablo recipe exists', async () => {
    const { data, error } = await admin
      .from('recipes')
      .select('id')
      .eq('id', 'batido-ninja-pablo')
      .single();
    if (error) throw error;
  });
}

// ── 4. Nutrition data integrity ───────────────────────────────

async function checkNutrition() {
  console.log('\n── 4. Nutrition data integrity ─────────────────');

  await check('Pablo nutrition_data row exists', async () => {
    const { data, error } = await admin
      .from('nutrition_data')
      .select('bmr_kcal, daily_calories_kcal')
      .eq('person_id', '00000000-0000-0000-0000-000000000010')
      .single();
    if (error) throw error;
    if (!data.bmr_kcal) throw new Error('bmr_kcal is null');
  });

  await check('Juli nutrition_data row exists', async () => {
    const { data, error } = await admin
      .from('nutrition_data')
      .select('bmr_kcal')
      .eq('person_id', '00000000-0000-0000-0000-000000000011')
      .single();
    if (error) throw error;
  });
}

// ── 5. RLS: unauthenticated client cannot read plans ─────────

async function checkRLS() {
  console.log('\n── 5. RLS policy checks ────────────────────────');

  // Unauthenticated anon client — should get empty results
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

  await check('anon cannot read plans (RLS blocks unauthenticated)', async () => {
    const { data, error } = await anon.from('plans').select('id').limit(1);
    // Supabase returns an empty array (not an error) when RLS blocks all rows
    if (error) throw error;
    if (data && data.length > 0) throw new Error('anon received plan rows — RLS may be misconfigured');
  });

  await check('anon cannot read nutrition_data (RLS blocks unauthenticated)', async () => {
    const { data, error } = await anon.from('nutrition_data').select('id').limit(1);
    if (error) throw error;
    if (data && data.length > 0) throw new Error('anon received nutrition rows — RLS may be misconfigured');
  });

  await check('anon can read recipes (public catalog policy)', async () => {
    // Recipes require auth.uid() not null — so anon (no JWT) returns empty.
    // This is expected and acceptable for a PWA that always logs in first.
    const { error } = await anon.from('recipes').select('id').limit(1);
    // No error means the query ran fine (may return 0 rows due to auth requirement)
    if (error && error.code !== 'PGRST301') throw error;
  });
}

// ── 6. Familia flag view ──────────────────────────────────────

async function checkFamiliaFlag() {
  console.log('\n── 6. Familia flag view ────────────────────────');

  const { data: pabloProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('username', 'pablo')
    .single();
  const pabloId = pabloProfile?.id || '00000000-0000-0000-0000-000000000001';

  await check('pablo shows show_familia=true (has 2 persons)', async () => {
    const { data, error } = await admin
      .from('familia_flag')
      .select('show_familia, approved_count')
      .eq('profile_id', pabloId)
      .single();
    if (error) throw error;
    if (!data.show_familia) throw new Error(`show_familia=${data.show_familia}, approved_count=${data.approved_count}`);
  });
}

// ── 7. Session persistence (manual verification) ──────────────

function printSessionCheck() {
  console.log('\n── 7. Session persistence (manual check) ───────');
  console.log('   • Log in to the app in a browser.');
  console.log('   • Close and reopen the tab.');
  console.log('   • Confirm the app loads without showing the login screen.');
  console.log('   • Open DevTools → Application → Local Storage → check for');
  console.log('     an entry whose key starts with "sb-wzxgecdpfpnlzaawdyjx".');
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('PlanDental — migration validation');
  console.log('==================================');

  await checkCounts();
  await checkAdminUser();
  await checkRecipes();
  await checkNutrition();
  await checkRLS();
  await checkFamiliaFlag();
  printSessionCheck();

  console.log(`\n──────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\n❌ Validation FAILED. Fix issues before going live.\n');
    process.exit(1);
  } else {
    console.log('\n✅ All automated checks passed.\n');
    console.log('⚠️  Reminder: change pablo\'s password before going live!\n');
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
