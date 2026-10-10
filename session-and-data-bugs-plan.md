# Plan: Fix Session Flicker and Ingredient Data Loss

## Overview

Two independent bugs have been confirmed by reading the source code:

1. **Session flicker** — `onAuthStateChange` in `js/app.js` can fire a null-session event
   (e.g. `TOKEN_REFRESHED` or a network delay) **while** `loadAppData()` is still running.
   When that happens the `else` branch calls `showLoginGate()` immediately, showing the login
   screen even though the JWT is still valid in localStorage. A second refresh resolves it
   because the guard is gone and `loadAppData()` completes normally.

2. **Ingredient saves never reach Supabase** — `addIngredient()` and `updateIngredient()` in
   `js/ingredients.js` both return **the entire `_ingredients` array**, not the single ingredient
   that was just added/edited. In `saveIngredientFromForm()` and `saveIngredientFromJSON()` in
   `js/app.js` the return value is passed directly to `saveIngredient()`, which expects a **single
   ingredient object**. Passing an array means `ingObj.nombre`, `ingObj.owner_id`, etc. are all
   `undefined`, causing the Supabase upsert to send garbage and either throw a constraint error
   (silently caught) or insert a blank row that is invisible to the user.

Recipes are unaffected: `addRecipe()` also returns the full array, but it is fed into
`saveRecipes()` which explicitly iterates it, so the design is correct there.

---

## Sub-Tasks

---

### Sub-Task 1 — Fix the `onAuthStateChange` race condition

**Status:** `[x] done`

**Intent**

Stop `showLoginGate()` from being called while `loadAppData()` is still in flight. The fix is
to gate the `else` branch with the same `loading` flag already used for the `if (session)` side.

**Root Cause (exact lines)**

[`js/app.js` lines 86–98](js/app.js):

```
supabase.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    if (loading) return;          // ← guards re-entrant load
    loading = true;
    try {
      await loadAppData(session.user);
    } finally {
      loading = false;
    }
  } else {
    showLoginGate();              // ← NOT guarded; fires while loadAppData() is running
  }
});
```

**Expected Outcome**

After the fix a `TOKEN_REFRESHED` or any transient null-session event that arrives while
`loadAppData()` is still awaiting data will be silently ignored instead of hiding the app shell.
The "Iniciar sesión" screen will no longer flash on a plain page refresh.

**Todo List**

- [ ] In `init()` in `js/app.js`, change the `else` branch so that `showLoginGate()` is only
  called when `event === 'SIGNED_OUT'`. All other null-session events (e.g. `TOKEN_REFRESHED`,
  `INITIAL_SESSION` with no session, `USER_UPDATED`) are silently ignored. This is the most
  robust approach: it reacts only to an explicit sign-out, not to transient auth lifecycle events.

**Relevant Context**

- File: [`js/app.js`](js/app.js), function `init()`, lines 86–98
- The `loading` flag is declared on line 80 and used correctly for the `if (session)` side.

---

### Sub-Task 2 — Fix ingredient save: wrong object passed to `saveIngredient()`

**Status:** `[x] done`

**Intent**

Ensure that `saveIngredientFromForm()` and `saveIngredientFromJSON()` pass a **single ingredient
object** to `saveIngredient()`, not the full `_ingredients` array.

**Root Cause (exact lines)**

`addIngredient()` in [`js/ingredients.js` line 167](js/ingredients.js) returns `_ingredients`
(the full array). `updateIngredient()` on line 180 does the same.

In `saveIngredientFromForm()` in [`js/app.js` lines 499–509](js/app.js):

```js
saved = addIngredient(data);       // ← returns _ingredients (array), not the new ingredient
// ...
await saveIngredient(saved);       // ← receives the array → boom
```

In `saveIngredientFromJSON()` in [`js/app.js` lines 537–550](js/app.js):

```js
savedEntries.push(addIngredient(entry));  // ← pushes the full array each time
// ...
for (const saved of savedEntries) {
  await saveIngredient(saved);            // ← saved is the full array, not one ingredient
}
```

**Expected Outcome**

After the fix, every ingredient saved via the form or JSON import is correctly persisted to
Supabase with the right `owner_id`, `nombre`, and macro values. The ingredient appears in the
sidebar after a page reload.

**Todo List**

There are two valid fix strategies. Strategy A is the minimal, surgical change:

**Chosen approach: Strategy B — fix the contract in `ingredients.js`**

- [ ] In `ingredients.js`, change `addIngredient()` to return `entry` (the single new object)
  instead of `_ingredients`.
- [ ] In `ingredients.js`, change `updateIngredient()` to return the updated single item instead
  of `_ingredients`.
- [ ] Audit every call site of `addIngredient()` and `updateIngredient()` in `app.js`.
  The return value is currently used in two places:
  - `saveIngredientFromForm()` → passes result to `saveIngredient()` → **must now receive the single item** (this is the bug fix).
  - `saveIngredientFromJSON()` → pushes result into `savedEntries`, then iterates and calls `saveIngredient()` on each → **must now receive the single item** (this is the bug fix).
  Neither call site uses the return value as the full array for rendering; both feed it directly
  into `saveIngredient()`. No other usages of the return value need changing.

**Relevant Context**

- [`js/ingredients.js`](js/ingredients.js) — `addIngredient()` line 157, `updateIngredient()` line 176
- [`js/app.js`](js/app.js) — `saveIngredientFromForm()` lines 489–514, `saveIngredientFromJSON()` lines 516–556
- [`js/storage.js`](js/storage.js) — `saveIngredient()` lines 567–601 (expects a single ingredient object)
- Compare with recipes: `addRecipe()` in `js/recipes.js` also returns the full array, and its
  callers correctly pass that array to `saveRecipes()` (which iterates it). Ingredients should
  mirror this but currently do not.

---

## Out of Scope

- Transactional batch-save (all-or-nothing for JSON imports) — real Supabase transactions require
  server-side RPC functions. The current sequential-save approach is acceptable; the priority is
  fixing the data-not-reaching-Supabase bug first.
- Recipe ownership — recipes are intentionally globally shared, no change needed.
- Plan chunked-upsert partial failures — separate concern; plans save correctly today.
