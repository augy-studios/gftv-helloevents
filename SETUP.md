# Setting up the Telegram bot (and Turnstile)

A step-by-step guide to the parts of GFTV HelloEvents that are set up by hand
outside the code: the Telegram bot, made with @BotFather, and Cloudflare
Turnstile. Everything else (the database migrations, the other Vercel
variables, Redis, the domain) is in
[`main-site/README.md`, "Setup, in order"](main-site/README.md#setup-in-order).
Do that first, up to and including the first deploy to
`events.globalfurry.tv`, then come back here.

**Secrets never go in a file, a chat or a ticket.** The bot token, the webhook
secret and the Turnstile secret go straight into Vercel, and nowhere else.
Below they are written as placeholders like `<your-bot-token>`: type the real
value only where a step says so.

## What the bot does here

- **Codes.** It sends six-digit codes to a member's linked chat: for signing in
  (when the account has 2FA on) and for resetting a forgotten password at
  `/reset`. The site sends no email, so for members without 2FA, Telegram is
  the main way back into an account.
- **Event notices**, for members who tick "Also send these to my linked
  Telegram chat" on their account page: changes of time or place, reminders
  and, if they asked, new events.
- **Commands** in a private chat with the bot: `/start` (linking, from the
  account page), `/unlink`, and anything else gets a help message.

It only ever talks in private chats. It does not use groups, inline mode or
the Telegram Login Widget.

Telegram is optional. Without it the site works, the Telegram options do not
appear, and members reset a password with a backup code or a code from an
admin.

## 1. Make the bot with @BotFather

Make a **new** bot for this site. Do not reuse the OneLink GFTV bot: a bot has
exactly one webhook, and that one already points at `links.gftv.asia`.

In Telegram, open [@BotFather](https://t.me/BotFather) and:

1. Send `/newbot`.
2. **Name** (shown at the top of the chat; can be changed later), for example:
   `GFTV HelloEvents`
3. **Username** (permanent, must end in `bot`), for example:
   `gftvhelloevents_bot`. Note it down without the `@`.
4. BotFather answers with the **token** (it looks like
   `123456789:AA...`). Copy it, and go straight to section 2 to put it in
   Vercel. Do not paste it anywhere else, and delete BotFather's message
   afterwards if you like (you can see it again with `/token`).

Then, still in BotFather, tidy the bot up. Each command asks you to pick the
bot first:

| Send | Then send |
| --- | --- |
| `/setdescription` | `Sign-in and password reset codes, and event notices, for GFTV HelloEvents at events.globalfurry.tv.` |
| `/setabouttext` | `Codes and event notices for events.globalfurry.tv` |
| `/setuserpic` | the picture `main-site/GHE-512.png` from this repository |
| `/setcommands` | the three lines below, as one message |
| `/setjoingroups` | choose **Disable** |

The command list for `/setcommands`, exactly what the bot handles
(`main-site/api/telegram/webhook.js`):

```text
start - Link this chat, from your account page
unlink - Stop receiving codes and notices in this chat
help - What this bot does
```

`/start` on its own (and `/help`, or any other message) answers with the help
message; `/start` with a link token is what linking sends.

**Leave these alone**, since the bot does not use them:

- `/setdomain`: only for the Telegram Login Widget. This site links accounts
  with a `t.me` link instead, so no domain is needed.
- `/setinline`: inline mode is not used. Leave it off.
- `/setprivacy`: privacy mode only matters in groups, and with joining groups
  disabled the bot is never in one. Leave it as it is.

## 2. Put the three Telegram values in Vercel

Vercel, the HelloEvents project, **Settings > Environment Variables**. Add
these for **Production** (and Preview only if you test Telegram on previews;
the webhook can point at one deploy only):

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token from BotFather. Tick **Sensitive**. |
| `TELEGRAM_BOT_USERNAME` | the username, without the `@`, for example `gftvhelloevents_bot` |
| `TELEGRAM_WEBHOOK_SECRET` | a new random value, made as below. Tick **Sensitive**. |

Make the webhook secret on your own machine (it is any 1 to 256 characters
from `A-Z a-z 0-9 _ -`; hex is safe):

```sh
openssl rand -hex 32
```

Paste the output into Vercel only, and keep the terminal open for section 3,
where it is needed once more.

All three must be set, or Telegram stays off. Then **redeploy** (Deployments,
the latest production deploy, the menu, **Redeploy**), so the functions see the
new values.

## 3. Point the bot at the site (the webhook)

Telegram has to be told where to send messages: the site's webhook,
`https://events.globalfurry.tv/api/telegram/webhook`. With it goes the
webhook secret: Telegram then sends it back in the
`X-Telegram-Bot-Api-Secret-Token` header on every call, and the site refuses
any call without it (answering 401).

Run this once, after the redeploy, in a terminal (macOS, Linux, or Git Bash on
Windows). The two `read` lines ask for the token and the secret without
showing them or saving them in your shell history: paste each and press Enter.

```sh
read -rs BOT_TOKEN      # paste <your-bot-token>, press Enter
read -rs HOOK_SECRET    # paste <your-webhook-secret>, press Enter
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://events.globalfurry.tv/api/telegram/webhook" \
  --data-urlencode "secret_token=${HOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]' \
  --data-urlencode "drop_pending_updates=true"
```

The answer should be `{"ok":true,"result":true,"description":"Webhook was set"}`.

Check it, in the same terminal:

```sh
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

`url` is the address above, `pending_update_count` is 0, and there is no
`last_error_message`. (`main-site/README.md` step 6 has the same call written
as JSON; either works.)

When done, close the terminal, or run `unset BOT_TOKEN HOOK_SECRET`.

## 4. Check it works

1. **Help.** Open your bot in Telegram (`t.me/<your-bot-username>`), press
   **Start** or send any message. It answers with the help: a heading, a table
   of commands and how to link an account.
2. **Linking.** Make a test account at `https://events.globalfurry.tv/signup`.
   On the account page, under **Security**, press **Link Telegram**. Telegram
   opens on the bot; press **Start**. The bot answers "Linked to the account
   ...", and back on the site the account page says "Linked to @you". The link
   lasts 10 minutes; after that, press **Link Telegram** again.
3. **A code.** Sign out, open `/reset`, type the test account's username,
   choose **Telegram**, press **Send me a code**, and type the code the bot
   sends with a new password. You are signed in with the new password.
4. **A notice (optional).** On the account page, under **Notifications**, tick
   "Also send these to my linked Telegram chat" and press **Send a test**.
5. **Unlink.** Send `/unlink` to the bot: it answers "Unlinked", and the
   account page shows "Not linked".
6. Delete the test account afterwards from its account page.

The code and help messages are Telegram rich messages (Bot API 10.1, sent with
`sendRichMessage`). There is nothing to switch on for them in BotFather. If
Telegram ever refuses a rich message, the same text goes out as a plain
message instead, and Vercel's function logs show `rich send failed, falling
back`: nobody misses a code, but the line means the rich path wants a look.

## 5. Troubleshooting the bot

| What you see | Likely cause, and the fix |
| --- | --- |
| The bot does not answer at all | Run `getWebhookInfo` (section 3). A `last_error_message` of "Wrong response from the webhook: 401" means the secret in Telegram and `TELEGRAM_WEBHOOK_SECRET` in Vercel differ: run `setWebhook` again with the value Vercel has. |
| `getWebhookInfo` shows an empty `url` | `setWebhook` was not run, or was run for another bot's token. Run section 3 again. |
| The account page has no Telegram section | One of the three `TELEGRAM_` variables is missing, or they were added without a redeploy. |
| "That link has expired or was already used" | The link from **Link Telegram** lasts 10 minutes and works once. Press it again. |
| Codes do not arrive | The member blocked the bot, or linked a different Telegram account. Unlink and link again from the account page. |
| Vercel's logs say `telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set` | The variable is missing on the deploy Telegram calls (Production). Add it and redeploy. |
| OneLink GFTV's bot stopped working | `setWebhook` was run with the OneLink bot's token. Run OneLink's own `setWebhook` again (its `SETUP.md`), and use this site's own bot here. |

**Turning Telegram off:** clear the three `TELEGRAM_` variables, redeploy, then
remove the webhook with
`curl "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"`. Linked chats
stay on record and work again if it is switched back on.

**A leaked token:** in BotFather send `/revoke`, pick the bot, put the new token
in `TELEGRAM_BOT_TOKEN`, make a new `TELEGRAM_WEBHOOK_SECRET` too, redeploy, and
run section 3 again.

## 6. Cloudflare Turnstile

Turnstile is Cloudflare's "are you a person" check. Here it guards the three
public forms anyone can send without being signed in: **sign-in**
(`/login`), **sign-up** (`/signup`) and **starting a password reset**
(`/reset`). It adds to the rate limits, the venue sign-up allowances and the
name filter; it does not replace them.

The widget already exists in Cloudflare, and its site key
(`0x4AAAAAAFoBqV14BTwQSjRX`, public by design) is built into the site. Only the
secret and the hostname list are set by hand.

**Set it before or with the first production deploy.** In production, a
missing secret makes those three forms refuse with "The are-you-a-person check
is not working on our side right now" (fail closed). Local runs and Vercel
previews without the secret skip the check and show no widget.

1. **Cloudflare:** [dash.cloudflare.com](https://dash.cloudflare.com),
   **Turnstile** (under **Application security** in newer dashboards), open the
   widget whose site key is `0x4AAAAAAFoBqV14BTwQSjRX`. Under **Hostname
   management**, make sure `events.globalfurry.tv` is listed; add it if not.
   Widget mode **Managed** is right. Save.
2. **Copy the Secret key** shown on the same widget page. It goes only into
   Vercel, in the next step.
3. **Vercel,** **Settings > Environment Variables**, for **Production**:

   | Variable | Value |
   | --- | --- |
   | `TURNSTILE_SECRET` | the widget's secret key. Tick **Sensitive**. |
   | `TURNSTILE_HOSTNAMES` | `events.globalfurry.tv` |

   Leave `TURNSTILE_SITE_KEY` unset: the built-in key is the right one.
   Don't set the secret for Preview unless you also add the preview's
   `*.vercel.app` hostname to the widget in Cloudflare and to a Preview-only
   `TURNSTILE_HOSTNAMES`; otherwise every check on a preview fails.
4. **Redeploy** the latest production deploy.

**Check:**

- `https://events.globalfurry.tv/api/public/config` answers with
  `"turnstileSiteKey":"0x4AAAAAAFoBqV14BTwQSjRX"`.
- `/signup`, `/login` and `/reset` show a Cloudflare box under the form that
  turns to a tick within a second or two (sometimes it asks for a click), and
  the forms work as before.
- A request with no check is refused. From any terminal:

  ```sh
  curl -X POST https://events.globalfurry.tv/api/auth/login \
    -H "Origin: https://events.globalfurry.tv" -H "Content-Type: application/json" \
    -d '{"identifier":"nobody","password":"not a real password"}'
  ```

  The answer is `{"ok":false,"error":"human_check_failed"}`.
- The widget's **Analytics** in Cloudflare shows the checks.

| What you see | Likely cause |
| --- | --- |
| "The are-you-a-person check is not working on our side" on every try | `TURNSTILE_SECRET` is not set in Production, or was added without a redeploy. |
| The box never turns to a tick, or shows an error | `events.globalfurry.tv` is not on the widget's hostname list in Cloudflare. |
| The box ticks, but the form still says the check did not pass | `TURNSTILE_HOSTNAMES` does not include `events.globalfurry.tv` (the logs say `not in TURNSTILE_HOSTNAMES`), or the secret belongs to another widget (the logs show `turnstile: invalid-input-secret`). See Vercel, the deploy, **Logs**. |

**A leaked secret:** in Cloudflare, open the widget, **Rotate secret key**, put
the new one in `TURNSTILE_SECRET`, and redeploy.
