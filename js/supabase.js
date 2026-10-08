/**
 * supabase.js — Supabase client singleton
 *
 * The URL and anon key below are intentionally public.
 * Supabase anon keys are designed to be embedded in browser code —
 * they are not secrets. All data access is protected by Row Level
 * Security policies defined in the database, not by this key.
 *
 * The only key that must stay secret is the SERVICE ROLE key, which
 * lives exclusively in scripts/.env (gitignored) and is never used here.
 *
 * References:
 *   https://supabase.com/docs/guides/api/api-keys
 *   "The anon key is safe to use in a browser or mobile app."
 *
 * Session config:
 *   persistSession: true  → JWT stored in localStorage; survives reloads
 *                           and app restarts. Required for daily use.
 *   autoRefreshToken: true → silently refreshes before expiry.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Public project credentials — safe to commit.
const SUPABASE_URL      = 'https://wzxgecdpfpnlzaawdyjx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6eGdlY2RwZnBubHphYXdkeWp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0NTk1OTMsImV4cCI6MjEwNzAzNTU5M30.V7m7RD_b2TXPsFQaCXKiPm7q2TfDHjXqRzKw4_0NbCU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: false,
    storage:            localStorage,
  },
});
