# Merging `dev` into `main`: HelloEvents

Context for whoever merges this repo's `dev` branch into `main`. Augy, give this file to Claude: "Read `.claude/merge-dev-into-main.md` and help me merge `dev` into `main`."

- **What's on `dev`:** the readable-refactor chain for help desk #18, one squash commit per job. All 9 jobs have landed.
- **What merging does:** Merging into `main` deploys `main-site/` (pages and API) on Vercel.
- **Kept up to date:** the coordinator (Thomas's workspace) updates this file each time a job lands, and once more just before opening the pull request. Last updated 13 Nov, 20:07 SGT.

## Claude: how to run the merge

Work through these in order, and stop to ask Augy wherever a step says so.

1. **Read first:** this file, then `README.md`. Never read, print or copy a `.env` or `token.env` file; use the `.example` files.
2. **Check `dev` matches this file:** `git fetch origin`, then `git log --oneline origin/main..origin/dev`. Every commit in the Jobs table below should be there. Commits titled "Merge context" only update this file. Read the message of any other commit the table doesn't list (`git show <sha>`) and tell Augy what it is.
3. **Run the tests** on a checkout of `dev` (commands below). All must pass. If one fails, stop and tell Augy; don't fix it on `main`.
4. **Go through "Before merging"** with Augy. Steps marked as his (Vercel settings, the database) are his to do by hand; ask him to confirm each one.
5. **The pull request:** `gh pr list --base main --head dev`. Thomas's side opens it once the last job lands. If Augy wants to ship before that, open it yourself: `gh pr create --base main --head dev`, titled "Help desk #18: readable refactor", with the Jobs table as its body.
6. **Merge with a merge commit, never squash or rebase**: `gh pr merge <number> --merge`. Squashing would drop the one-commit-per-job history, and each commit's `Archived-As` line points to the job's full branch. Ask Augy before running it: **merging is deploying.**
7. **Go through "After merging"**, then the smoke test with Augy (unless this file says to run it before merging).
8. **If something breaks:** in Vercel, promote the previous production deployment to roll back at once. Then revert the merge on `main` through a pull request (`git revert -m 1 <merge sha>`), and tell Thomas. Never force-push.

## Jobs

| Job | What it does | On `dev` |
|---|---|---|
| 01 | Data minimisation and account recovery | `08f8e97` |
| 02 | Playwright harness | `f8eadfb` |
| 03 | Rename the shared short helpers | `1eabdef` |
| 04 | Readability: api/_lib, part 1 | `8d49a04` |
| 05 | Readability: api/_lib, part 2 | `e5027de` |
| 06 | Readability: API routes | `b74050c` |
| 07 | Readability: pages (js/) | `4cbc658` |
| 08 | Readability: service worker, scripts and tools | `32f9a2b` |
| 09 | Lint config and final check | `7f1e2fb` |

Each job's commit message lists what changed and how it was reviewed. The full branch is kept at `refs/archive/<job-id>`: `git fetch origin 'refs/archive/*:refs/archive/*'` to see them.

## Tests

```bash
cd main-site
npm ci
npm test             # unit and route tests, no network
npm run test:e2e     # Playwright; run `npx playwright install chromium` once on a new machine
npm run check-i18n
npm run check-sw
```

They need no `.env`, network or real database.

## Before merging

- **Service worker:** `main-site/sw.js`'s `VERSION` must differ from `main`'s (job 09 bumps it). If it doesn't, bump it in a commit on `dev` first.
- No new environment variables or database migrations come with this chain. If `git diff main dev -- migrations/` shows a new file, it must be run in Supabase before the merge.

## After merging

- Nothing by hand beyond the smoke test.

## Smoke test on the live site

The tests can't reach the real database, logins or messaging, so check these by hand after the deploy:

- The feed and an event page load, signed out.
- Sign in by email and by passkey; RSVP and cancel.
- Staff sign-in with 2FA; create and edit an event.
- Telegram linking and a push notification, if they're in use.
- Account recovery for an unknown name shows the single "if it exists" message.

## What users may notice

- API replies carry fewer fields (only what each page shows). Sign-in, sign-up and recovery no longer return `user`; those pages redirect and ask the session endpoint.
- Account recovery gives every name the same reply.

Open questions and anything left for later are on help desk #18's review page, not here.
