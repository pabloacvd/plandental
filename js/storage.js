/**
 * storage.js — GitHub API + localStorage persistence layer
 *
 * Plan data is stored as a single JSON file in the repo:
 *   data/plan.json
 *
 * Custom recipes are stored in:
 *   data/recipes.json  (same file as static recipes, merged on save)
 *
 * Structure:
 * {
 *   "Pablo": {
 *     "2025-W27": {
 *       "2025-07-07": {
 *         "desayuno": { recipeId, recipeName, macros },
 *         "almuerzo": { ... },
 *         "snack":    { ... },
 *         "cena":     { ... },
 *         "snack2":   { ... }
 *       }
 *     }
 *   },
 *   "Juli": { ... }
 * }
 */

const LS_KEY_TOKEN    = 'plandental_gh_token';
const LS_KEY_PLAN     = 'plandental_plan_cache';
const LS_KEY_RECIPES  = 'plandental_recipes_cache';

// Repo is public — hardcoded so every device only needs the token.
const DEFAULT_OWNER = 'pabloacvd';
const DEFAULT_REPO  = 'plandental';

const PLAN_FILE_PATH    = 'data/plan.json';
const RECIPES_FILE_PATH = 'data/recipes.json';

export function getCredentials() {
  return {
    token: localStorage.getItem(LS_KEY_TOKEN),
    owner: DEFAULT_OWNER,
    repo:  DEFAULT_REPO,
  };
}

export function saveCredentials({ token }) {
  localStorage.setItem(LS_KEY_TOKEN, token);
}

export function clearCredentials() {
  localStorage.removeItem(LS_KEY_TOKEN);
}

export function isAuthenticated() {
  const { token } = getCredentials();
  return !!token;
}

/**
 * Read a token from the URL hash (#token=ghp_xxx), persist it to localStorage,
 * then remove it from the URL so it doesn't linger in history.
 * Call once at app startup.
 */
export function consumeTokenFromHash() {
  const hash = window.location.hash;
  if (!hash.startsWith('#token=')) return;
  const token = decodeURIComponent(hash.slice('#token='.length)).trim();
  if (token) {
    localStorage.setItem(LS_KEY_TOKEN, token);
  }
  // Replace history entry so the token is gone from the URL bar
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// ── Local cache helpers ──────────────────────────────────

function loadLocalPlan() {
  try {
    const raw = localStorage.getItem(LS_KEY_PLAN);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalPlan(plan) {
  localStorage.setItem(LS_KEY_PLAN, JSON.stringify(plan));
}

function loadLocalRecipes() {
  try {
    const raw = localStorage.getItem(LS_KEY_RECIPES);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── GitHub API ───────────────────────────────────────────

async function ghFetch(path, options = {}) {
  const { token, owner, repo } = getCredentials();
  if (!token) throw new Error('No GitHub token configured');

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API error ${res.status}`);
  }
  return res.json();
}

async function getFileSha() {
  const data = await ghFetch(PLAN_FILE_PATH);
  if (!data) return null;
  return data.sha;
}

/**
 * Fetch plan from GitHub. Falls back to local cache on failure.
 */
export async function fetchPlan() {
  if (!isAuthenticated()) return loadLocalPlan();

  try {
    const data = await ghFetch(PLAN_FILE_PATH);
    if (!data) return {};
    const content = JSON.parse(atob(data.content.replace(/\n/g, '')));
    saveLocalPlan(content);
    return content;
  } catch (e) {
    console.warn('GitHub fetch failed, using local cache:', e.message);
    return loadLocalPlan();
  }
}

/**
 * Fetch recipes from GitHub. Falls back to local cache, then null (caller fetches static file).
 */
export async function fetchRecipes() {
  if (!isAuthenticated()) return loadLocalRecipes();

  try {
    const data = await ghFetch(RECIPES_FILE_PATH);
    if (!data) return null;
    const content = JSON.parse(atob(data.content.replace(/\n/g, '')));
    // Store under the same key saveRecipes uses so they stay in sync
    localStorage.setItem(LS_KEY_RECIPES, JSON.stringify(content));
    return content;
  } catch (e) {
    console.warn('GitHub recipes fetch failed, using local cache:', e.message);
    return loadLocalRecipes();
  }
}

/**
 * Save plan to both localStorage and GitHub.
 * Throws on GitHub error so callers can surface the failure.
 */
export async function savePlan(plan) {
  saveLocalPlan(plan);

  if (!isAuthenticated()) return { saved: 'local' };

  const sha = await getFileSha();
  const body = {
    message: `update plan ${new Date().toISOString().slice(0, 16)}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(plan, null, 2)))),
    ...(sha ? { sha } : {}),
  };

  await ghFetch(PLAN_FILE_PATH, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return { saved: 'github' };
}

// ── Recipes persistence ──────────────────────────────────

/**
 * Save the full recipes array to localStorage and, if authenticated, to GitHub.
 * Throws on GitHub error so callers can surface the failure.
 */
export async function saveRecipes(recipesArray) {
  const payload = { recetas: recipesArray };
  localStorage.setItem(LS_KEY_RECIPES, JSON.stringify(payload));

  if (!isAuthenticated()) return { saved: 'local' };

  const sha = await (async () => {
    const data = await ghFetch(RECIPES_FILE_PATH);
    return data?.sha || null;
  })();

  const body = {
    message: `update recipes ${new Date().toISOString().slice(0, 16)}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2)))),
    ...(sha ? { sha } : {}),
  };

  await ghFetch(RECIPES_FILE_PATH, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return { saved: 'github' };
}

/**
 * Test GitHub credentials by trying to read repo root.
 */
export async function testConnection() {
  const { token, owner, repo } = getCredentials();
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Error ${res.status}`);
  }
  return res.json();
}
