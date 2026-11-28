-- 029: the language each account uses the site in, so the Telegram bot and
-- the notices speak it too (api/_lib/bot-text.js).
--
-- gftvevents_accounts.locale: one of the site's languages (assets/i18n/
-- locales.js): 'en', 'zh-SG', 'ms' or 'ta'. Null until the site first saves
-- one: the pages save the language in use whenever it differs from the
-- account's (js/app.js, POST /api/me/profile { locale }), so the last one a
-- person picked wins. Everything sent to the account follows it: sign-in and
-- password reset codes, the bot's replies in their linked chat, reminders,
-- changes, joining, payments, HelloID decisions and new events, by Telegram
-- and by Web Push, and the code and reset emails. Null is written as English.
--
-- It can run before or after the code that reads it is deployed: until it
-- has run, api/_lib/locale-column.js leaves the column out and everything
-- goes in English.
--
-- A staff member's row is made the first time it is needed, as for the
-- other per-account settings.
--
-- RLS is already on for this table, with no policies: service role only.

begin;

alter table gftvevents_accounts add column if not exists locale text;
alter table gftvevents_accounts drop constraint if exists gftvevents_accounts_locale_check;
alter table gftvevents_accounts
  add constraint gftvevents_accounts_locale_check check (locale is null or locale in ('en', 'zh-SG', 'ms', 'ta'));

commit;

-- Adding a language: add its code to the check above in a new migration,
-- as well as to assets/i18n/locales.js and api/_lib/bot-text.js.
--
-- Rollback:
-- begin;
-- alter table gftvevents_accounts drop constraint if exists gftvevents_accounts_locale_check;
-- alter table gftvevents_accounts drop column if exists locale;
-- commit;
