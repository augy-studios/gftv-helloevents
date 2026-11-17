-- 005_description_english_and_chinese.sql
--
-- GFTV HelloEvents, fifth migration. Run once, whole, in the Supabase SQL
-- editor, after 001 to 004.
--
-- Every event has two descriptions, one in English (description) and one in
-- Chinese (description_zh), and the API requires both when an event is
-- saved (api/_lib/event-rules.js). The edit form switches between them; the
-- event page shows the reader's choice.
--
-- 004's description_lang said which one language the single description
-- was in. A description marked Chinese moves to description_zh here, so its
-- English one is asked for at the next save. description_lang is no longer
-- read once this release is deployed; it is left in place so the site
-- running before the deploy keeps working, and can be dropped afterwards
-- (below).
--
-- This file is never edited after it has been run. Changes go in 006 onwards.

begin;

alter table gftvevents_events
  add column if not exists description_zh text;

alter table gftvevents_events drop constraint if exists gftvevents_events_description_zh_check;
alter table gftvevents_events
  add constraint gftvevents_events_description_zh_check
    check (description_zh is null or char_length(description_zh) <= 8000);

update gftvevents_events
   set description_zh = description,
       description = null
 where description_lang = 'zh'
   and description is not null
   and description_zh is null;

commit;

-- Once this release is deployed, description_lang can go:
--
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_description_lang_check,
--   drop column if exists description_lang;
--
-- Rollback, if this ever has to be undone:
--
-- begin;
-- update gftvevents_events set description = description_zh, description_lang = 'zh'
--  where description is null and description_zh is not null;
-- alter table gftvevents_events
--   drop constraint if exists gftvevents_events_description_zh_check,
--   drop column if exists description_zh;
-- commit;
