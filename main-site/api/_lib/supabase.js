// Service role client. Server only: the key bypasses RLS, which is enabled on
// every gftvevents_ table with no policies, so nothing else can read them.
// The browser never talks to Supabase directly.

import { createClient } from '@supabase/supabase-js';
import { requiredEnv } from './env.js';

let client = null;

// Tests can run a route against an in-memory stand-in.
export function useTestClient(fake) {
  client = fake;
}

export function db() {
  if (!client) {
    client = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Table names, written once. Everything this app owns carries the
// gftvevents_ prefix (migrations/001_helloevents_schema.sql).
export const T = Object.freeze({
  sessions: 'gftvevents_sessions',
  challenges: 'gftvevents_auth_challenges',
  webauthn: 'gftvevents_webauthn_challenges',
  passkeys: 'gftvevents_passkeys',
  totp: 'gftvevents_totp_secrets',
  backupCodes: 'gftvevents_backup_codes',
  telegram: 'gftvevents_telegram_links',
  telegramTokens: 'gftvevents_telegram_link_tokens',
  events: 'gftvevents_events',
  attendees: 'gftvevents_attendees',
  audit: 'gftvevents_audit_logs',
  rateLimits: 'gftvevents_rate_limits',
  // Owned by gftv.asia and shared by every GFTV site. Read here. The only
  // write is spending a shared backup code, which every GFTV site that
  // accepts them does (gftv-linktree api/admin/auth.js).
  users: 'gftvhello_users',
  sharedBackupCodes: 'gftvhello_backup_codes',
});
