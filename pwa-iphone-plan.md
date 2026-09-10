# PlanDental — PWA / iPhone Plan

## Overview

Convert PlanDental from a plain static web app into a properly installable PWA optimised for
iPhone/Safari. The application is a **serverless static site** with zero build tooling — plain
HTML, CSS, and browser-native ES modules. All changes must be surgical: no framework migration,
no rewrite, no new dependencies.

### Architecture summary (post-inspection)

| Item | Status |
|---|---|
| Stack | Vanilla HTML + CSS + ES modules |
| Build system | None — served as-is |
| Server | None — GitHub Pages or any static server |
| External network | GitHub Contents API (authenticated), `data/*.json` |
| Local persistence | `localStorage` (token, plan cache, recipes cache) |
| Existing manifest | ❌ absent |
| Existing SW | ❌ absent |
| Existing icons | ❌ absent (emoji only) |
| `viewport-fit=cover` | ✅ already present |
| `env(safe-area-inset-bottom)` | ✅ already applied to footer |
| `100vh` issues | ⚠ `body` uses `min-height: 100vh` (line 40); `.app-main` uses it too (line 135) — need `100dvh` fallback on mobile |

---

## Sub-tasks

---

### Sub-task 1 — Icons

**Status:** `[ ] pending`

**Intent**

The app has no raster icons. iOS requires at least one `apple-touch-icon` and the manifest needs
several PNG sizes. We need to create a proper icon set. The app uses 🥗 as its brand icon; the
designed icon should reflect this identity in a solid background that looks good on iOS.

**Approach**

Since there are no design tools available, we will create a minimal but correct set of SVG + PNG
icons programmatically using a simple Node script or by writing the SVG directly and referencing
it. Because iOS ignores SVG for home screen icons, we must produce PNG files.

Create the following files in `icons/`:

| File | Size | Usage |
|---|---|---|
| `icons/icon-192.png` | 192×192 | Android/Chrome manifest |
| `icons/icon-512.png` | 512×512 | Android/Chrome manifest, splash |
| `icons/apple-touch-icon.png` | 180×180 | iOS home screen |
| `icons/favicon.ico` | 32×32 | Browser tab |

Design: `#4f7ef8` (CSS `--accent`) background, white bowl/salad emoji or stylised "PD" text
centred — whichever is achievable without external tools. A solid-colour icon with a simple
letter mark is acceptable and looks clean on iOS.

**Expected outcomes**

- `icons/` directory exists with the four files above.
- All icon paths are reachable from the server root.
- Icons are square and opaque (transparent icons look bad on iOS).

**Relevant context**

- CSS accent colour: `--accent: #4f7ef8` (`css/style.css:14`)
- Existing emoji branding: `index.html:20`

---

### Sub-task 2 — Web App Manifest

**Status:** `[ ] pending`

**Intent**

Create `manifest.webmanifest` at the project root so the browser and iOS Safari can identify this
as an installable PWA with correct name, colours, and icons.

**File to create:** `manifest.webmanifest`

**Required fields:**

```json
{
  "name": "PlanDental — Planner Semanal",
  "short_name": "PlanDental",
  "description": "Planeador semanal de comidas serverless.",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#f4f6f9",
  "theme_color": "#4f7ef8",
  "lang": "es",
  "orientation": "portrait-primary",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

`background_color` matches `--bg` (`#f4f6f9`); `theme_color` matches `--accent` (`#4f7ef8`).

**Expected outcomes**

- `manifest.webmanifest` is valid JSON at the project root.
- Lighthouse and Safari both find the manifest via the `<link>` tag added in sub-task 3.

---

### Sub-task 3 — `index.html` iOS/PWA metadata

**Status:** `[ ] pending`

**Intent**

Patch `index.html` `<head>` to add all PWA/iOS metadata. Keep changes minimal — only add missing
tags, do not remove anything.

**Tags to add (in order, after the existing `<meta name="viewport">`):**

```html
<!-- PWA manifest -->
<link rel="manifest" href="manifest.webmanifest" />

<!-- iOS web-app behaviour -->
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="PlanDental" />
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />

<!-- Theme colour (browser chrome on Android/desktop) -->
<meta name="theme-color" content="#4f7ef8" />

<!-- Favicon -->
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon.ico" />
```

**Notes:**

- `apple-mobile-web-app-status-bar-style: default` keeps the status bar light (matches the app's
  white header). Use `black-translucent` only if we want the app to extend behind the status bar,
  which would require additional `padding-top: env(safe-area-inset-top)` — out of scope unless the
  CSS already handles it (it does not today).
- Do NOT use `black-translucent` to avoid needing `safe-area-inset-top` everywhere.

**CSS fix for `100vh` on mobile:**

The existing CSS uses `min-height: 100vh` on `body` (line 40) and `height: calc(100vh - var(--header-h))` inside `.app-main` (line 135). In standalone PWA mode on iOS, `100vh` includes the hidden browser chrome — this means content may overflow.

Add a targeted override in `css/style.css` inside the existing `@media (max-width: …)` mobile block or as a new block at the bottom:

```css
/* PWA standalone: use dvh instead of vh for reliable full-screen layout */
@supports (height: 100dvh) {
  body { min-height: 100dvh; }
  .app-main { height: calc(100dvh - var(--header-h)); }
}
```

This replaces the two `100vh` rules with `100dvh` only when supported, without breaking older
browsers. The mobile-specific `100dvh` rules at lines 1119 and 1127 already exist and are correct.

**Expected outcomes**

- Safari shows the manifest icon when "Add to Home Screen" is triggered.
- App opens in standalone mode (no browser chrome).
- App name shows as "PlanDental" on the home screen.
- Status bar is light (white background compatible).
- No visual regression on desktop or existing mobile layout.

**Relevant context**

- `index.html:5` — existing viewport tag (viewport-fit=cover already present)
- `css/style.css:40` — `min-height: 100vh`
- `css/style.css:135` — `height: calc(100vh - var(--header-h))`

---

### Sub-task 4 — Service Worker

**Status:** `[ ] pending`

**Intent**

Create `sw.js` at the project root implementing a versioned cache strategy that:

1. Caches the **app shell** (static assets needed to boot) on install.
2. Serves the app shell from cache on subsequent loads (cache-first for static assets).
3. **Never** caches GitHub API responses (they contain private tokens and mutable data).
4. Handles cache invalidation by bumping `CACHE_NAME` version.
5. Activates cleanly by deleting old caches on activation.
6. Uses `skipWaiting()` + `clientsClaim()` for fast updates without requiring a tab close.

**Cache versioning strategy:**

```js
const CACHE_NAME = 'plandental-v1';
```

When assets change, the developer bumps this to `plandental-v2`, etc. The `activate` handler
deletes all caches whose names do not match the current `CACHE_NAME`.

**Assets to precache (app shell):**

```
/                        (index.html served as root)
index.html
css/style.css
js/app.js
js/calendar.js
js/planner.js
js/recipes.js
js/storage.js
js/ui.js
data/nutrition.json
data/recipes.json
icons/icon-192.png
icons/icon-512.png
icons/apple-touch-icon.png
manifest.webmanifest
```

**Fetch strategy:**

| Request | Strategy |
|---|---|
| App shell assets above | Cache-first; fall back to network |
| `data/plan.json` | Network-first; fall back to cache |
| `https://api.github.com/*` | Network-only (never cache) |
| Anything else on origin | Cache-first |

**Why `skipWaiting()` + `clientsClaim()`:**

This is a single-user personal app with no collaborative sessions. Using `skipWaiting()` means
the new SW activates immediately after install without waiting for all tabs to close. Using
`clientsClaim()` means open tabs get the new SW without reload. This is appropriate here because:
- The user is the only user of the app.
- There is no risk of a peer seeing an inconsistent state from a mixed SW version.
- The alternative (waiting for tab close) would confuse a non-technical user.

**Why NOT cache GitHub API calls:**

The GitHub token is stored in localStorage and appended to request headers. Caching those
responses would risk storing auth data or stale plan data in the cache. The app already has its
own localStorage fallback for offline plan data, so the SW does not need to duplicate that.

**Expected outcomes**

- SW registers without errors in the browser console.
- App loads from cache when offline (after first visit).
- GitHub API calls are not intercepted or cached.
- Bumping `CACHE_NAME` and redeploying causes old cache to be deleted and new assets fetched.

**Registration:**

Add a registration script to `index.html` just before the closing `</body>`:

```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    });
  }
</script>
```

Note: Register from `/sw.js` (absolute path), not `./sw.js`, to ensure the SW scope covers the
entire origin when hosted on GitHub Pages at the root.

**Relevant context**

- External calls: `js/storage.js:101-115` — GitHub API with auth headers
- Local JSON: `js/recipes.js:42` — `fetch('./data/nutrition.json')`
- `data/plan.json` is gitignored but may exist locally — do not precache it

---

### Sub-task 5 — Safe-area / iPhone layout audit

**Status:** `[ ] pending`

**Intent**

Review the complete CSS for layout issues that would appear in PWA standalone mode on iPhone
(notch, Dynamic Island, Home Indicator). Fix only what is broken or missing.

**Known items from inspection:**

| Item | Current state | Fix needed |
|---|---|---|
| `viewport-fit=cover` | ✅ present | None |
| `safe-area-inset-bottom` on footer | ✅ present | None |
| `safe-area-inset-top` on header | ❌ missing | Add |
| `100vh` body + main | ⚠ partial | Covered in sub-task 3 |

**Fix for `safe-area-inset-top`:**

In standalone PWA mode on iPhone, the app extends behind the status bar when `viewport-fit=cover`
is set. The `.app-header` must push down to avoid the Dynamic Island / notch.

Add to the `.app-header` rule or via a separate `@supports (padding: env(safe-area-inset-top))` block:

```css
.app-header {
  padding-top: env(safe-area-inset-top, 0px);
  height: calc(var(--header-h) + env(safe-area-inset-top, 0px));
}
```

Also update any rule that offsets by `--header-h` to use the same computed height. The CSS
currently positions `.sidebar` with `top: var(--header-h)` (line 1125) — this needs to match:

```css
.sidebar {
  top: calc(var(--header-h) + env(safe-area-inset-top, 0px));
}
```

**Approach:** Add a new CSS custom property `--safe-top` defaulting to
`env(safe-area-inset-top, 0px)` in `:root`, then use `--safe-top` where needed. This keeps all
env() calls in one place.

**Expected outcomes**

- Header is not obscured by the Dynamic Island on iPhone 14 Pro or newer.
- Sidebar is anchored correctly below the header.
- App content is not clipped at the bottom by the Home Indicator.
- No layout regressions on desktop.

---

### Sub-task 6 — README: PWA/iPhone section

**Status:** `[ ] pending`

**Intent**

Update [`README.md`](README.md) to include a `## PWA / iPhone` section that documents all new
PWA behaviour. Do not remove or rewrite existing sections.

**Section must cover:**

1. Running locally.
2. Testing from iPhone on the same network.
3. Deploying to HTTPS (GitHub Pages instructions already in README — reference them).
4. Installing on iPhone: Safari → Share → Add to Home Screen.
5. How the update system works (`CACHE_NAME` versioning).
6. How offline mode works and what is available offline.
7. How to change the icon or app name.
8. How to increment the cache version.

---

### Sub-task 7 — Verification

**Status:** `[ ] pending`

**Intent**

After all previous sub-tasks are complete, perform a manual verification pass:

- Serve the app locally with `python3 -m http.server 8080` or `npx serve .`.
- Confirm manifest is reachable at `/manifest.webmanifest`.
- Confirm SW registers in DevTools → Application → Service Workers.
- Confirm icon files are reachable at their declared paths.
- Confirm no JS console errors.
- Confirm offline behaviour: disable network, reload → app should load from cache.
- Confirm existing functionality is not broken: recipe drag, plan save, auth modal.

Any issues found during verification should be fixed before marking this sub-task complete.

---

## Implementation order

```
Sub-task 1 → Sub-task 2 → Sub-task 3 → Sub-task 4 → Sub-task 5 → Sub-task 6 → Sub-task 7
```

Each sub-task builds on the previous. Sub-tasks 2–5 can reference icon paths created in
sub-task 1. Sub-task 6 documents behaviour established in sub-tasks 1–5.

---

## Files to be created

| File | Sub-task |
|---|---|
| `icons/icon-192.png` | 1 |
| `icons/icon-512.png` | 1 |
| `icons/apple-touch-icon.png` | 1 |
| `icons/favicon.ico` | 1 |
| `manifest.webmanifest` | 2 |
| `sw.js` | 4 |

## Files to be modified

| File | Sub-task | Change |
|---|---|---|
| `index.html` | 3, 4 | Add PWA meta tags + SW registration script |
| `css/style.css` | 3, 5 | `100dvh` fix, `--safe-top` custom property, header/sidebar safe-area offsets |
| `README.md` | 6 | Add `## PWA / iPhone` section |

## Files NOT to be modified

- `js/app.js`
- `js/calendar.js`
- `js/planner.js`
- `js/recipes.js`
- `js/storage.js`
- `js/ui.js`
- `data/nutrition.json`
- `data/recipes.json`
- `data/plan.json`
- `.gitignore`
