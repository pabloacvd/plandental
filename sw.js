/**
 * PlanDental — Service Worker
 *
 * Cache strategy:
 *   - App shell (static assets): cache-first, updated on SW version bump.
 *   - data/plan.json: network-first, cache as fallback.
 *   - api.github.com: network-only (never cached — contains auth tokens and mutable data).
 *   - Everything else on origin: cache-first.
 *
 * Versioning:
 *   Bump CACHE_NAME (e.g. plandental-v2) whenever you deploy new assets.
 *   The activate handler deletes all caches that don't match the current name.
 *
 * skipWaiting + clientsClaim:
 *   This is a single-user personal app. Activating the new SW immediately avoids
 *   the user needing to close all tabs before updates take effect.
 */

const CACHE_NAME = 'plandental-v1';

/** Static app shell — all assets needed to boot the app offline. */
const APP_SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/calendar.js',
  'js/planner.js',
  'js/recipes.js',
  'js/storage.js',
  'js/ui.js',
  'data/nutrition.json',
  'data/recipes.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.ico',
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. GitHub API — network-only; never intercept.
  if (url.hostname === 'api.github.com') {
    return; // let the browser handle it normally
  }

  // 2. plan.json — network-first (data can change from GitHub sync).
  if (url.pathname.endsWith('/data/plan.json')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 3. Everything else (app shell + static assets) — cache-first.
  event.respondWith(cacheFirst(request));
});

// ─── Strategies ─────────────────────────────────────────────────────────────

/**
 * Cache-first: serve from cache; fall back to network and store the response.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Network-first: try network; fall back to cache if offline.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Return an empty 503 so the app can handle absence gracefully.
    return new Response(null, { status: 503, statusText: 'Offline' });
  }
}
