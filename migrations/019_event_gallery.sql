-- 019: a picture gallery for every event, and covers cut from it.
--
-- An editor adds any number of pictures (up to 30, api/_lib/gallery.js) to
-- an event's gallery. They are kept in their own shape, never cropped: the
-- browser only shrinks each one (at most 2000 pixels on its longest side)
-- into a WebP, and the server re-encodes it, as for covers. The event page
-- shows them below "About this event".
--
-- The cover is no longer uploaded on its own: the editor picks a gallery
-- picture with "Use as cover", crops it to 16:9 in the crop dialog, and the
-- cropped part is stored as the cover (cover_image_path, as before), which is
-- also the cards' thumbnail. The event remembers which gallery picture the
-- cover came from and the crop, so "Adjust crop" can start from it in any
-- later visit. Removing that gallery picture keeps the cover (a file of its
-- own) and forgets where it came from.
--
-- gftvevents_event_images: one row per gallery picture. The files live in
-- the gftvevents_covers bucket (migrations/002), under the event's id, like
-- the cover: "<event id>/<random>.webp". The bucket's 1 MB and WebP-only
-- limits apply to them too. Rows go with the event; the API deletes the files.
--
-- Run after 018. Safe to run twice.

begin;

create table if not exists gftvevents_event_images (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references gftvevents_events (id) on delete cascade,
  path        text not null unique
                check (path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{16,64}\.webp$'),
  width       integer not null check (width between 1 and 4000),
  height      integer not null check (height between 1 and 4000),
  created_by  uuid references gftvevents_accounts (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists gftvevents_event_images_event_idx on gftvevents_event_images (event_id, created_at);

alter table gftvevents_event_images enable row level security;
revoke all on gftvevents_event_images from anon, authenticated;

-- Where the cover was cut from: the gallery picture, and the crop in its
-- pixels ({ "x", "y", "width", "height" }).
alter table gftvevents_events
  add column if not exists cover_source_image_id uuid
    references gftvevents_event_images (id) on delete set null,
  add column if not exists cover_crop jsonb
    check (cover_crop is null or jsonb_typeof(cover_crop) = 'object');

commit;

-- Rollback (empty the event folders' gallery files from the bucket first, or
-- leave them: nothing reads them once the table is gone):
-- begin;
-- alter table gftvevents_events drop column if exists cover_source_image_id, drop column if exists cover_crop;
-- drop table if exists gftvevents_event_images;
-- commit;
