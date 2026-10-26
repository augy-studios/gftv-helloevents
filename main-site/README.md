# GFTV HelloEvents

events.globalfurry.tv: furmeets and furry conventions, with RSVP for GFTV staff accounts.

Static HTML, CSS and vanilla JavaScript with no build step, plus Node.js serverless functions in
`api/` on Vercel. Data lives in Supabase (the same project as `gftvhello_users`), reached only from
the functions with the service role key. No Supabase Auth, no request signing.

## How it fits together

- **Accounts** are the shared `gftvhello_users` rows (read only here). Anyone with
  `is_approved` can sign in and RSVP; `is_editor` or `is_admin` can create and edit events; only
  `is_admin` can delete one. Roles are re-checked on every request.
- **Sign in** is the password, then a second factor, always. An account with no second factor is
  sent to a set-up step (authenticator app, passkey, or Telegram) before it gets a session. The
  authenticator app from gftv.asia (`gftvhello_users.totp_secret`) and the shared backup codes
  work here, the same way OneLink GFTV reads them. Anything set up here lives in this site's own
  `gftvevents_` tables; nothing is written to `gftvhello_users`.
- **Sessions** are an HttpOnly, Secure, SameSite=Strict `__Host-` cookie; only its SHA-256 is
  stored. Cross-site writes are refused by an Origin check plus a JSON-only body.
- **Data minimisation**: every API answer is built field by field in `api/_lib/serialize.js`.
  Drafts and events with a future release time never reach the public; hidden prices and
  dates "to be announced" go out without the stored values; attendees-only addresses and online
  links go only to people going and to editors; staff notes and attendee lists go only to editors.
  `npm test` checks this.

## Setup, in order

1. **Database.** In the Supabase SQL editor, run each file in `../migrations/` in number order,
   once, whole. Today that is `001_helloevents_schema.sql`. A migration is never edited after it
   has run; changes go in a new numbered file.
2. **Environment variables.** In Vercel, set every name in `.env.example` (Production, and
   Preview if used). Only `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TOTP_ENCRYPTION_KEY`,
   `IP_HASH_SALT` and `CRON_SECRET` are required; Telegram, Turnstile and the WebAuthn overrides are
   optional. Make random values with `openssl rand -hex 32`.
3. **Vercel project.** Root directory `main-site`. `vercel.json` sets the region (sin1), the
   `/e/<slug>` rewrite, security headers and the daily cleanup cron.
4. **Domain.** Add `events.globalfurry.tv` to the Vercel project. Passkeys are bound to this
   hostname (`SITE_URL`), so they do not work on preview URLs; the authenticator app and Telegram
   do.
5. **Telegram (optional).** Make a new bot with @BotFather (not the OneLink one: a bot has one
   webhook), set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET`, deploy,
   then point the bot at the site:

   ```sh
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://events.globalfurry.tv/api/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
   ```

   Check it with `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`. Codes go
   out with `sendRichMessage` (Bot API 10.1 Rich Messages) and fall back to a plain message.
6. **Turnstile (optional).** Add `events.globalfurry.tv` to a Turnstile widget and set both keys.

## Checks

```sh
npm install
npm test             # unit and route tests, no network or database
npm run check-sw     # no skipWaiting() outside the update bar's message handler
npm run check-i18n   # en.json against every data-i18n and t() key
```

Bump `VERSION` in `sw.js` on every deploy that changes a served file, or nobody sees the update bar.

## Icons

`../tools/make-icons.mjs` draws the icon (`../tools/GHE-icon.svg`) and renders `GHE-main.png`,
`GHE-512.png`, `GHE-192.png`, `GHE-180.png`, `favicon.ico` and the small `gftv-flag.png`:
`cd ../tools && npm install && npm run icons`.
