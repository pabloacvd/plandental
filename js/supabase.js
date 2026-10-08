/**
 * supabase.js — Supabase client singleton
 *
 * Keys are loaded from js/config.js which is gitignored.
 * Copy js/config.example.js → js/config.js and fill in your values.
 *
 * Session config:
 *   persistSession: true  → JWT stored in localStorage; survives reloads.
 *   autoRefreshToken: true → silently refreshes before expiry.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: false,
    storage:            localStorage,
  },
});
