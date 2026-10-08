/**
 * PlanDental — Service Worker
 *
 * Cache strategy:
 *   - App shell (static assets): cache-first, updated on SW version bump.
 *   - supabase.co: network-only (auth tokens + live data — never cache).
 *   - cdn.jsdelivr.net: cache-first (Supabase JS ESM bundle).
 *   - Everything else on origin: cache-first.
 *   - Non-http(s) schemes (chrome-extension://, etc.): ignored entirely.
 *
 * Versioning:
 *   Bump CACHE_NAME whenever you deploy new assets.
 *   The activate handler deletes all caches that don't match the current name.
 */

const CACHE_NAME = 'plandental-v4';

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
  'js/supabase.js',
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

  // 1. Only handle http and https — skip chrome-extension://, data://, etc.
  //    Cache.put() throws on any other scheme, which would break extensions.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 2. Supabase API — network-only. Never cache auth tokens or live data.
  if (url.hostname.endsWith('.supabase.co')) return;

  // 3. CDN (Supabase JS bundle) — cache-first so it works offline.
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 4. Everything else on this origin (app shell + static assets) — cache-first.
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
