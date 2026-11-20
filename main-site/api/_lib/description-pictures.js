// The pictures an event's descriptions show (rich-text.js
// displayDescription): its gallery pictures and the Telegram stickers the
// descriptions refer to, as this site's own addresses.

import { galleryImageUrl, withGallery } from './gallery.js';
import { stickersByIds, stickerUrl } from './stickers.js';
import { descriptionPictureIds } from './rich-text.js';

// A sticker as a description shows it: its still picture (the WebP itself,
// or a video sticker's still), and the video for browsers that play it.
function stickerView(sticker) {
  if (sticker.format === 'webm') {
    let src = stickerUrl(sticker, 'still');
    if (!src) {
      src = stickerUrl(sticker, 'main');
    }
    return { src, video: stickerUrl(sticker, 'main'), width: sticker.width, height: sticker.height };
  }
  return { src: stickerUrl(sticker, 'main'), video: '', width: sticker.width, height: sticker.height };
}

// Adds row.description_pictures ({ gallery, stickers }, Maps of id to
// { src, width, height, video }) to an event row, loading its gallery
// (unless already there, gallery.js withGallery) and the stickers either
// description refers to.
export async function withDescriptionPictures(row) {
  if (!row) {
    return row;
  }
  if (!Array.isArray(row.gallery)) {
    await withGallery(row);
  }
  const gallery = new Map();
  for (const image of row.gallery) {
    gallery.set(image.id, { src: galleryImageUrl(row.slug, image.path), width: image.width, height: image.height, video: '' });
  }
  const ids = new Set();
  for (const value of [row.description, row.description_zh]) {
    for (const id of descriptionPictureIds(value).stickerIds) {
      ids.add(id);
    }
  }
  const stickers = new Map();
  for (const [id, sticker] of await stickersByIds([...ids])) {
    stickers.set(id, stickerView(sticker));
  }
  row.description_pictures = { gallery, stickers };
  return row;
}
