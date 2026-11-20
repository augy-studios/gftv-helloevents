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

export function database() {
  if (!client) {
    client = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Table names, written once. Everything this app owns carries the
// gftvevents_ prefix (migrations/001_helloevents_schema.sql).
export const TABLES = Object.freeze({
  // Every account this site knows: staff (a pointer to gftvhello_users) or
  // public (its own username, email and password). migrations/002.
  accounts: 'gftvevents_accounts',
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
  // The attendees coming to the whole event, who take its spaces: a view
  // (migrations/009).
  fullAttendees: 'gftvevents_full_attendees',
  audit: 'gftvevents_audit_logs',
  rateLimits: 'gftvevents_rate_limits',
  // migrations/003
  passwordResets: 'gftvevents_password_resets',
  signupAllowances: 'gftvevents_signup_allowances',
  nameFilters: 'gftvevents_name_filters',
  // Who an editor confirmed volunteered at a convention (migrations/012).
  volunteers: 'gftvevents_volunteers',
  // Cover pictures (migrations/002), a public-read Storage bucket that only
  // the API writes to.
  coversBucket: 'gftvevents_covers',
  // migrations/016: payment QR codes and screenshots, private (payments.js).
  paymentsBucket: 'gftvevents_payments',
  // migrations/018: accounts an admin made editors of one event.
  eventEditors: 'gftvevents_event_editors',
  // migrations/019: each event's gallery pictures (files in coversBucket).
  eventImages: 'gftvevents_event_images',
  // migrations/020: Telegram sticker packs added to an account, their
  // stickers, and the private bucket the sticker files are in.
  stickerPacks: 'gftvevents_sticker_packs',
  stickers: 'gftvevents_stickers',
  stickersBucket: 'gftvevents_stickers',
  // Owned by gftv.asia and shared by every GFTV site. Read here. The only
  // write is spending a shared backup code, which every GFTV site that
  // accepts them does (gftv-linktree api/admin/auth.js).
  users: 'gftvhello_users',
  sharedBackupCodes: 'gftvhello_backup_codes',
});
