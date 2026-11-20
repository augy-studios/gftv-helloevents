// An event's picture gallery (migrations/019): pictures in their own shape,
// uncropped, kept in gftvevents_event_images with their files in the covers
// bucket (covers.js checks and re-encodes each one). The cover is cut from
// one of them in the browser and stored on its own (api/manage/cover.js).
//
// Pages never get a Storage address: a gallery picture is served by
// api/events/gallery-image.js, under the event's slug and the file's own
// random name, with the same rules as the cover.

import { database, TABLES } from './supabase.js';
import { coverVersion, deleteCover } from './covers.js';

// The most pictures one event's gallery holds.
export const GALLERY_LIMIT = 100;

const COLUMNS = 'id, event_id, path, width, height, created_at';

// The event's gallery rows, oldest first (the order they were added in).
export async function galleryRows(eventId) {
  const { data, error } = await database()
    .from(TABLES.eventImages)
    .select(COLUMNS)
    .eq('event_id', eventId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data;
}

// One gallery row of this event, or null.
export async function galleryRow(eventId, imageId) {
  const { data, error } = await database()
    .from(TABLES.eventImages)
    .select(COLUMNS)
    .eq('event_id', eventId)
    .eq('id', imageId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

// Adds the gallery to an event row (row.gallery), for the event page.
export async function withGallery(row) {
  if (!row) {
    return row;
  }
  row.gallery = await galleryRows(row.id);
  return row;
}

// Where the pages load a gallery picture from: this site's own
// api/events/gallery-image.js. The file's own name is in it (v), so an
// address always shows the same picture. null for a path that is not one.
export function galleryImageUrl(slug, path) {
  const version = coverVersion(path);
  if (!version || !slug) {
    return null;
  }
  return `/api/events/gallery-image?slug=${encodeURIComponent(slug)}&v=${encodeURIComponent(version)}`;
}

// Deletes the files of an event's gallery (best effort, as deleteCover),
// for when the event itself is deleted. paths: from galleryRows, read before
// the delete, since the rows go with the event.
export async function deleteGalleryFiles(paths) {
  for (const path of paths) {
    await deleteCover(path);
  }
}
