# GFTV HelloEvents

events.globalfurry.tv: furmeets and furry conventions, with RSVP and notifications.

Static HTML, CSS and vanilla JavaScript with no build step, plus Node.js serverless functions in
`api/` on Vercel. Data lives in Supabase (the same project as `gftvhello_users`), reached only from
the functions with the service role key. No Supabase Auth, no request signing.

## How it fits together

- **Two kinds of account**, both rows in `gftvevents_accounts` (migrations/002):
  - **Staff**: the shared `gftvhello_users` accounts, read only here. Sign-in always needs a
    second factor; a staff account with none is told to set an authenticator up on gftv.asia
    first, as OneLink GFTV does. The gftv.asia authenticator and shared backup codes work here.
    Passkeys and Telegram can be added here afterwards. Passwords are reset on gftv.asia.
  - **Public**: anyone can sign up at `/signup` (username, display name, email, password, agreeing
    to the Terms of Use and Privacy Policy) to RSVP and get notifications. Passwords are bcrypt,
    cost 12. 2FA is optional: an authenticator app or a passkey switches it on, comes with ten
    backup codes, and then Telegram codes and backup codes are accepted too. No email is ever sent
    (emails are only for signing in and are not verified). A forgotten password is reset at
    `/reset` in one of three ways: a code sent to the linked Telegram chat (plus the second factor
    when 2FA is on), one backup code (when 2FA is on), or a one-time code an admin makes in
    `/manage` for a member with neither, after checking who they are. A staff code on an account
    with 2FA only sets the password; signing in still needs the second step.
  - **Names**: usernames and display names may not contain words that look like the team (staff,
    official, admin, GFTV, moderator, ...), compared after folding case, spacing, accents,
    look-alike Cyrillic and Greek letters and numbers used as letters. Admins add their own words
    in `/manage`; names that already match are listed there for follow-up, not changed.
- **Who can do what.** Any signed-in account can RSVP. Staff with `is_editor` or `is_admin` (and
  `is_approved`) manage events at `/manage`; only `is_admin` deletes. Roles are re-checked on every
  request. Anything set up on this site lives in `gftvevents_` tables; nothing is written to
  `gftvhello_users`.
- **Sessions** are an HttpOnly, Secure, SameSite=Strict `__Host-` cookie lasting 7 days; only its
  SHA-256 is stored. Cross-site writes are refused by an Origin check plus a JSON-only body.
- **Data minimisation**: every API answer is built field by field in `api/_lib/serialize.js`.
  Drafts and events with a future release time never reach the public; hidden prices and dates
  "to be announced" go out without the stored values; attendees-only addresses and online links go
  only to people going and to editors; staff notes and attendee lists go only to editors, and an
  attendee is a name, a username and staff or not, never an email. `npm test` checks this.
- **Venue sign-ups.** New accounts are limited to 5 an hour per connection. At a meet or con where
  everyone shares the venue's Wi-Fi, a staff member opens `/manage` on that Wi-Fi and raises the
  limit for that connection (its salted IP hash) for 2 to 12 hours, to 50 to 500 an hour. It ends
  by itself or with "End now", and is in the audit log.
- **Cover pictures** are uploaded from `/manage`. The browser converts the picture to a compressed
  WebP (longest side 1600 px, at most 1 MB); the server checks it really is a still WebP within the
  size and dimension limits, re-encodes it (stripping metadata) and puts it in the public-read
  Supabase Storage bucket `gftvevents_covers`. The event keeps the object's path; the old picture is
  deleted when it is replaced or the event is deleted.
- **Notifications**, chosen on the account page: changes of time or place (or a cancellation) of
  events you are going to, a reminder the day before, and, off by default, new events. They go by
  Web Push to the browsers you switch on (subscriptions stored in Upstash Redis) and, if you choose,
  to your linked Telegram chat. A notice carries only what the public event page shows. Reminders
  and new-event notices come from the hourly cron `/api/cron/notify`.

## Setup, in order

The Telegram bot (made with @BotFather) and Cloudflare Turnstile have their own step-by-step guide,
[`../SETUP.md`](../SETUP.md). Steps 6 and 7 below are the short version.

1. **Database.** In the Supabase SQL editor, run each file in `../migrations/` in number order,
   once, whole: `001_helloevents_schema.sql`, then `002_public_accounts_covers_notifications.sql`,
   then `003_resets_signup_allowances_name_filters.sql`.
   A migration is never edited after it has run; changes go in a new numbered file. 002 also
   creates the `gftvevents_covers` Storage bucket.
2. **Environment variables.** In Vercel, set every name in `.env.example` (Production, and Preview
   if used). Required: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TOTP_ENCRYPTION_KEY`, `IP_HASH_SALT`,
   `CRON_SECRET`, and in Production `TURNSTILE_SECRET` and `TURNSTILE_HOSTNAMES` (step 7). Optional:
   Telegram, Web Push (`VAPID_*`) and Redis. Make random values
   with `openssl rand -hex 32`, and the push keys with `npx web-push generate-vapid-keys`.
3. **Redis (for push).** Vercel > Storage > Upstash for Redis (Marketplace), create a database and
   connect it to this project. Vercel sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   Redeploy afterwards.
4. **Vercel project.** Root directory `main-site`. `vercel.json` sets the region (sin1), the
   `/e/<slug>` rewrite, security headers, the daily cleanup cron and the hourly notification cron.
5. **Domain.** Add `events.globalfurry.tv` to the Vercel project. Passkeys are bound to this
   hostname (`SITE_URL`), so they do not work on preview URLs.
6. **Telegram (optional).** Make a new bot with @BotFather (not the OneLink one: a bot has one
   webhook; [`../SETUP.md`](../SETUP.md) walks through BotFather, the command list and testing),
   set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET`, deploy, then
   point the bot at the site:

   ```sh
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://events.globalfurry.tv/api/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
   ```

   Check it with `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`. Messages
   go out with `sendRichMessage` (Bot API 10.1 Rich Messages) and fall back to a plain message.
   Without Telegram, members reset a forgotten password with a backup code or a code from an admin.
7. **Turnstile.** The widget exists and its site key is built in (`api/_lib/turnstile.js`). In
   Cloudflare, check `events.globalfurry.tv` is on the widget's hostnames; in Vercel (Production)
   set `TURNSTILE_SECRET` to the widget's secret and `TURNSTILE_HOSTNAMES=events.globalfurry.tv`,
   then redeploy. It guards sign-in, sign-up and starting a password reset (actions `login`,
   `signup`, `reset`). Production without the secret refuses those forms (fail closed); local and
   preview deploys without it skip the check and show no widget. See [`../SETUP.md`](../SETUP.md)
   section 6.
8. **Android app link.** `.well-known/assetlinks.json` names `tv.globalfurry.events`; replace the
   placeholder fingerprint with the app signing key's SHA-256 before it is relied on.

## Checks

```sh
npm install
npm test             # unit and route tests, no network, database or Redis
npm run check-sw     # no skipWaiting() outside the update bar's message handler
npm run check-i18n   # en.json against every data-i18n and t() key
```

Bump `VERSION` in `sw.js` on every deploy that changes a served file, or nobody sees the update bar.

## Icons

`../tools/make-icons.mjs` draws the icon (`../tools/GHE-icon.svg`) and renders `GHE-main.png`,
`GHE-512.png`, `GHE-192.png`, `GHE-180.png`, `favicon.ico` and the small `gftv-flag.png`:
`cd ../tools && npm install && npm run icons`.
