# GFTV HelloEvents

[events.globalfurry.tv](https://events.globalfurry.tv): furmeets and furry conventions, with RSVPs,
tickets, check-in and notifications.

Static HTML, CSS and vanilla JavaScript with no build step, plus Node.js serverless functions on
Vercel (region `sin1`). Data lives in Supabase, reached only from the functions. Upstash Redis is used for
Web Push.

## What it does

- **Events.** A feed with search, event pages with rich descriptions, galleries, timetables,
  locations and link previews, in English, Chinese, Malay and Tamil.
- **RSVPs and tickets.** Ticket tiers with their own prices, currencies, limits and ways to pay,
  checkout with payment proof, meal-only and "Just Lepak Only" RSVPs, volunteers, fursuiters,
  registration forms, and an attendee list as CSV.
- **At the door.** Check-in, entry QR codes, and optional ID checks: HelloID (GFTV's own, free, run
  on Vercel), Didit or Veriff.
- **Accounts.** Staff accounts shared with gftv.asia, and public sign-up. 2FA with an authenticator
  app or passkeys, then backup codes, Telegram codes and email codes.
- **Notices.** Web Push, Telegram and email, for changes, reminders and new events, plus alerts to
  admins' and organisers' chats.
- **Managing.** `/manage` for editors and admins: events, editors of one event, ID reviews, name
  filters and password reset codes.

## Repository layout

| Path | What's there |
| --- | --- |
| [`main-site/`](main-site/) | The site, and the Vercel project's root directory: pages, `js/`, `api/`, `assets/`, tests. |
| [`migrations/`](migrations/) | The Supabase SQL, run in number order, once each. |
| [`tools/`](tools/) | Local scripts only, never deployed: the icons, emoji data and manifest screenshots. |
| [`docs/`](docs/) | Portable specs shared between GFTV sites: the theme, the official banner, the update bar, page tours, i18n and others. |
| [`SETUP.md`](SETUP.md) | Step by step: the Telegram bot, Turnstile, ID checks and email. |

## Getting started

Everything about how the site works and how to deploy it is in
[`main-site/README.md`](main-site/README.md):

1. [How it fits together](main-site/README.md#how-it-fits-together): accounts, sessions, data
   minimisation and every feature.
2. [Setup, in order](main-site/README.md#setup-in-order): the database, environment variables
   (from [`main-site/.env.example`](main-site/.env.example)), Redis, the Vercel project and the
   domain.
3. [`SETUP.md`](SETUP.md): the parts set up by hand outside the code.

## Checks

From `main-site/`, with Node 26:

```sh
npm install
npm test             # unit and route tests, no network, database or Redis
npm run test:e2e     # Playwright, against a local server and an in-memory database
npm run lint
npm run check-sw
npm run check-i18n
```

Bump `VERSION` in `main-site/sw.js` on every deploy that changes a served file, or nobody sees the
update bar.

## Licence

[MIT](LICENSE), © 2026 Augy Studios. Contributors follow the [Code of Conduct](CODE_OF_CONDUCT.md).
