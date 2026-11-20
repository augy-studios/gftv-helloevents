-- 020: rich text descriptions, and Telegram sticker packs.
--
-- 1. Descriptions are rich text (Word-like: headings, bold, italics,
--    underline, strikethrough, colours, fonts, sizes, alignment, lists,
--    tables, links, and pictures from the event's gallery or the editor's
--    sticker packs). Each is stored as HTML the server has cleaned to that
--    list (api/_lib/rich-text.js, js/rich-text.js), with pictures as
--    references only. HTML is longer than the plain text it holds, so the
--    8000-character limits from 001 and 005 become 100000 (the text itself
--    is limited to 20000 characters by the API). Descriptions saved before
--    are plain text and are read as paragraphs; nothing is rewritten here.
--
-- 2. gftvevents_sticker_packs and gftvevents_stickers: Telegram sticker
--    packs an editor added to their account from a t.me/addstickers link,
--    and copies of their stickers (api/_lib/stickers.js): still stickers as
--    the WebP Telegram keeps them in, video stickers as WebM with a still
--    WebP for browsers that cannot play them with transparency. Animated
--    (Lottie) stickers are not copied. Rows go with the account; the API
--    deletes the files when a pack is removed.
--
-- 3. The gftvevents_stickers Storage bucket, private (pages get stickers
--    from api/stickers/image.js only), WebP and WebM, at most 1 MB a file.
--
-- Run after 019. Safe to run twice.

begin;

-- 1. Longer descriptions.
alter table gftvevents_events drop constraint if exists gftvevents_events_description_check;
alter table gftvevents_events drop constraint if exists gftvevents_events_description_zh_check;
alter table gftvevents_events
  add constraint gftvevents_events_description_check
    check (description is null or char_length(description) <= 100000);
alter table gftvevents_events
  add constraint gftvevents_events_description_zh_check
    check (description_zh is null or char_length(description_zh) <= 100000);

-- 2. Sticker packs and stickers.
create table if not exists gftvevents_sticker_packs (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references gftvevents_accounts (id) on delete cascade,
  name        text not null check (name ~ '^[A-Za-z0-9_]{1,64}$'),
  title       text not null check (char_length(title) between 1 and 128),
  created_at  timestamptz not null default now(),
  unique (account_id, name)
);

create table if not exists gftvevents_stickers (
  id                uuid primary key default gen_random_uuid(),
  pack_id           uuid not null references gftvevents_sticker_packs (id) on delete cascade,
  account_id        uuid not null references gftvevents_accounts (id) on delete cascade,
  path              text not null unique
                      check (path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{16,64}\.(webp|webm)$'),
  still_path        text unique
                      check (still_path is null or still_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{16,64}\.webp$'),
  still_from_frame  boolean not null default false,
  format            text not null check (format in ('webp', 'webm')),
  width             integer not null check (width between 1 and 1024),
  height            integer not null check (height between 1 and 1024),
  emoji             text check (emoji is null or char_length(emoji) <= 16),
  position          integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists gftvevents_sticker_packs_account_idx on gftvevents_sticker_packs (account_id, created_at);
create index if not exists gftvevents_stickers_pack_idx on gftvevents_stickers (pack_id, position);
create index if not exists gftvevents_stickers_account_idx on gftvevents_stickers (account_id);

alter table gftvevents_sticker_packs enable row level security;
alter table gftvevents_stickers enable row level security;
revoke all on gftvevents_sticker_packs from anon, authenticated;
revoke all on gftvevents_stickers from anon, authenticated;

-- 3. The bucket. No storage policies: only the API (service role key)
-- reads and writes it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gftvevents_stickers', 'gftvevents_stickers', false, 1048576, array['image/webp', 'video/webm'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;

-- Rollback (empty the gftvevents_stickers bucket first in the Storage
-- dashboard; descriptions longer than 8000 characters must be shortened
-- before the old limits can come back):
-- begin;
-- drop table if exists gftvevents_stickers;
-- drop table if exists gftvevents_sticker_packs;
-- delete from storage.buckets where id = 'gftvevents_stickers';
-- alter table gftvevents_events drop constraint if exists gftvevents_events_description_check;
-- alter table gftvevents_events drop constraint if exists gftvevents_events_description_zh_check;
-- alter table gftvevents_events add constraint gftvevents_events_description_check check (description is null or char_length(description) <= 8000);
-- alter table gftvevents_events add constraint gftvevents_events_description_zh_check check (description_zh is null or char_length(description_zh) <= 8000);
-- commit;
