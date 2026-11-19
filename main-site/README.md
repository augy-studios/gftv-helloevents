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
  attendee is a name, a username and staff or not, never an email. Each answer carries only what
  its page shows, plus the ids its buttons need (help desk #18); `tests/response-keys.test.js`
  pins every answer's exact fields, so one can't creep back in. `npm test` checks this.
- **Password reset** gives the same answer for an unknown, suspended or staff-only name, so it
  doesn't reveal which accounts exist; staff are pointed to gftv.asia.
- **Venue sign-ups.** New accounts are limited to 5 an hour per connection. At a meet or con where
  everyone shares the venue's Wi-Fi, a staff member opens `/manage` on that Wi-Fi and raises the
  limit for that connection (its salted IP hash) for 2 to 12 hours, to 50 to 500 an hour. It ends
  by itself or with "End now", and is in the audit log.
- **Cover pictures** are uploaded from `/manage`. Every picture first opens a crop dialog
  (`js/cover-crop.js`) with a frame the shape of the cards' 16:9 thumbnail, starting on the
  middle of the picture, with the strips the wider 21:9 banner on the event page leaves out shaded
  and edged with dashed lines; the editor drags and zooms (slider, wheel, pinch or keyboard) to pick
  the part to show, and "Adjust crop" re-crops the picture chosen in that visit. Besides "Choose
  a picture", a picture copied to the clipboard can be pasted anywhere in the open form (Ctrl+V,
  Cmd+V on a Mac) and goes through exactly the same crop and upload; pasted into a text field
  along with text (an image copied from a web page), the text is pasted instead. The browser
  then converts the part kept to a compressed 16:9 WebP (at most 1600 px wide and 1 MB); the server checks it really is a still WebP within the
  size and dimension limits, re-encodes it (stripping metadata) and puts it in the public-read
  Supabase Storage bucket `gftvevents_covers`. The event keeps the object's path; the old picture is
  deleted when it is replaced or the event is deleted.
- **Managing events** at `/manage`: the event list and the edit form are separate tabs (Event list,
  Manage event). The form saves itself whenever a field is left, a list option picked or a box
  ticked; a pill at the bottom says "Saving…", "All changes saved" or why a change was refused.
  A new event is created once it has a title, both descriptions and a start date. The open event
  is kept in the address (`/manage?slug=...#editor`), so a reload reopens it. The form's sections
  are tabs of their own, stuck under the page header while it scrolls: Basics, When and where,
  Price and RSVP, Meals, and Attendees and notes. When a change is refused, the tab holding the
  field is marked with a dot. Delete (admins only) asks first, and offers "Set to Cancelled
  instead", which keeps the event and its RSVP list and tells the people going.
- **Event links.** The form's "Event link" field is the event's address (`/e/<link>`), made from
  the title when left blank. A typed link is tidied (lowercase, hyphens) and checked
  (`GET /api/manage/events?checkSlug=`) before it is saved; one another event has is not saved,
  and the form offers to add eight random characters to its end or to edit it again.
- **Ticket tiers** (migrations/008). A paid event can sell tickets in tiers: each has a name, a
  price and benefits (one per line). From the second tier on, ticking "Includes everything in
  <previous tier>" (off for a new tier) makes a tier include everything in the tier before it, and the event page either lists those benefits again in full or says
  "Everything in <tier>, plus:". The From and Up to prices then come from the tiers. A hidden
  price hides the tier prices too. Fields in a tier card save when the card is left.
- **Coming just for a meal** (migrations/007). In the edit form's "Coming just for a meal"
  section an editor ticks breakfast, lunch or dinner, and names up to five more ("High tea"). With
  any on, a signed-in person on the event page picks "The whole event" or "I only want to show
  up for the meal" and ticks one or more of the meals; while going they can change it, and it
  saves at once. Meal-only attendees see what attendees see, but take none of the event's spaces
  ("N going", the capacity and "Full" count only people coming to the whole event, through the
  `gftvevents_full_attendees` view, migrations/009). Instead each meal can have its own number of
  places; the event page shows the places left ("Lunch (6 places left)", "Dinner (full)"), and a
  full event still takes people just for a meal while one has room. The attendee list on
  `/manage` says who is coming for which meals, with a count per meal ("Lunch 3 of 10"). Once
  RSVPs close (migrations/010), nobody new joins, but someone going can still change their
  meals, within each meal's places, or go from the whole event to just meals; not the other way,
  which would take a space. A cancelled or finished event takes no changes. A
  meal the editor stops offering drops out of everyone's choice (kept in the database, so ticking
  it again brings it back); someone left with none counts as coming to the whole event.
- **A meal held somewhere else.** Under each meal offered, "Held somewhere else" opens up to three
  location cards like the ones in "Where" (a Google Maps link fills them in), each labelled as the
  meal's location, the meeting location, or the editor's own label: dinner at a restaurant after
  the meet, with a meeting point to walk over from. They are kept in that meal's entry in
  `meal_options` as `locations` (the same shape as the event's own, migrations/004), so no
  migration is needed; none means the meal is at the event's place, and unticking the box saves
  none. The event page lists them under "Where" after the event's own places, headed with the
  meal's name ("Dinner", "Dinner · Meeting location"). "Show the street addresses and map links
  only to people going" covers them too. Moving a meal's place, or bringing it back to the event,
  tells the people going, like any change of place.
- **Link previews.** `/e/<slug>` is served by `api/events/page.js`: `event.html` with the event's
  own title, when and where, summary and cover picture in its Open Graph and Twitter tags, so a
  link unfurls as the event in Discord, Telegram, WhatsApp, X and iMessage (the same idea as SG Bus
  Timings' share pages). The cover goes out as a JPEG from `api/events/embed-image.js`, since not
  every app reads WebP. Drafts and events not released yet get the site's own tags.
- **The account page** has the profile at the top and tabs below it: My events,
  Notifications, Security, and (public accounts only) Profile, to rename or delete the account.
  The open tab is kept in the address (`/account#security`).
- **Notifications**, chosen on the account page: changes of time or place (or a cancellation) of
  events you are going to, reminders before them, and, off by default, new events. They go by
  Web Push to the browsers you switch on (subscriptions stored in Upstash Redis) and, if you choose,
  to your linked Telegram chat. A notice carries only what the public event page shows. Reminders
  and new-event notices come from the cron `/api/cron/notify`, every ten minutes. Because the edit
  form autosaves field by field, change notices are batched: they go out about 45 seconds after the
  editor's last save, once, comparing the event with how it was before the first change
  (migrations/006); the cron sends any left over.
- **Reminders** (migrations/011). Each account ticks any of 1 hour, 2 hours, 3 hours, 1 day and
  1 week before (a day before to start with). Each time goes at most once per RSVP, within five
  minutes of it; if two have come at once (a cron that was down), only the closer one goes. A time
  that came before someone said they were going is skipped, and an event whose start time is to
  be confirmed gets only the day and week reminders. The push notification, which can show on a
  locked screen, says only when and where. The Telegram reminder is a rich message (headings and
  tables, with a plain-text fallback) with everything someone going sees on the event page: when it
  starts and ends, the whole event or which meals they are coming for, the online link, every
  place (event location, meeting location, custom ones) with its street address, country and map
  link, and each meal held somewhere else with its own places (just their meals, for someone
  coming only for some), then the event link.

## Setup, in order

The Telegram bot (made with @BotFather) and Cloudflare Turnstile have their own step-by-step guide,
[`../SETUP.md`](../SETUP.md). Steps 6 and 7 below are the short version.

1. **Database.** In the Supabase SQL editor, run each file in `../migrations/` in number order,
   once, whole: `001_helloevents_schema.sql`, then `002_public_accounts_covers_notifications.sql`,
   then `003_resets_signup_allowances_name_filters.sql`, and each later one (004 to 011) in turn.
   Run `006_batched_change_notices.sql` before deploying the autosaving edit form: saving an
   event needs its two columns. Run `007_meal_only_rsvps.sql` before deploying meal-only RSVPs:
   the event page and RSVPs read its columns, and it replaces the RSVP function. Run
   `008_ticket_tiers.sql` before deploying ticket tiers: saving an event writes its columns. Run
   `009_meal_limits.sql` before deploying meal limits: the feed and event pages count spaces
   through its view, and it replaces the RSVP function again. `010_meal_changes_after_close.sql`
   replaces it once more, so people going can change their meals after RSVPs close. Run
   `011_reminder_times.sql` before deploying reminder times: the account page and the cron read
   its columns.
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
   `/e/<slug>` rewrite to the link-preview function (which bundles `event.html`), security headers, the daily cleanup cron and the notification cron (every ten minutes, so an hour-before reminder
   is on time; Vercel's Hobby plan runs crons only once a day, so this needs Pro).
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
npm run check-i18n   # en.json against every data-i18n key and t() call (see below)
npm run lint         # ESLint: the readability rules (no ternaries, ?. or ??)
```

Bump `VERSION` in `sw.js` on every deploy that changes a served file, or nobody sees the update bar.

`check-i18n` runs the shared scanner `assets/i18n/check-keys.js`, which finds keys in `t(` calls.
HelloEvents' own code calls `translate(` since help desk #18's job 03, so keys used only there
aren't checked against `en.json` until the shared scanner also looks for `translate(`.

**End-to-end tests:** `npm ci`, then `npm run test:e2e` (7 tests, about 5 seconds).

- Playwright starts `tests/e2e/server.js`. It serves this folder the way Vercel does (`vercel.json`'s
  clean URLs, the `/e/<slug>` rewrite and the security headers, so the real Content-Security-Policy
  applies). It runs the real API handlers in `api/` against the in-memory database and Redis that
  `npm test` uses.
- It's seeded from `tests/e2e/seed.js` before every test, and picks a free port.
- No `.env`, network, database or Redis is needed. Turnstile runs on Cloudflare's test keys with a
  local stub, every request to another site is answered by the test, Telegram is off, and pushes are
  recorded rather than sent.
- A test fails on any console error, uncaught exception, server error, or API answer carrying a
  field from `tests/harness.js`'s `SECRET_FIELDS`.
- It needs Chromium revision 1254 (`@playwright/test` 1.65.0). On another machine, run
  `npx playwright install chromium` once.
- A failed test leaves a trace in `tests/e2e/output/`: open it with
  `npx playwright show-trace tests/e2e/output/<test>/trace.zip`.
- The seed's upcoming events are dated 2032; move them on before then.

## Icons

`../tools/make-icons.mjs` draws the icon (`../tools/GHE-icon.svg`) and renders `GHE-main.png`,
`GHE-512.png`, `GHE-192.png`, `GHE-180.png`, `favicon.ico` and the small `gftv-flag.png`:
`cd ../tools && npm install && npm run icons`.
