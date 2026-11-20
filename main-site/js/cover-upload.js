// Turning a chosen picture into a compressed WebP cover in the browser,
// before it is uploaded (api/manage/cover.js checks and re-encodes it again).
//
// Every cover is cut to the shape of the event cards' thumbnail, 16:9
// (COVER_RATIO), from one of the event's gallery pictures (gallery-upload.js
// fetchPicture reads it back): the crop dialog (cover-crop.js) picks the
// part to keep, and cropToWebp draws that part at
// most MAX_SIDE wide, then steps the quality down until the file fits
// MAX_BYTES. A browser that cannot encode WebP from a canvas (canvas.toBlob
// gives back PNG instead) is told so rather than sending something else.

export const COVER_RATIO = 16 / 9;
// The event page's banner is wider (.event-cover.large in style.css): it
// shows the middle band of a cover, trimming its top and bottom.
export const BANNER_RATIO = 21 / 9;
export const MAX_SIDE = 1600;
export const MAX_BYTES = 1_000_000;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 180;
const QUALITIES = [0.82, 0.72, 0.6, 0.5];

const fail = (code) => Object.assign(new Error(code), { code });

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(fail('cover_invalid'));
    reader.readAsDataURL(blob);
  });
}

// The widest 16:9 area that fits in a picture of this size, in its pixels:
// the crop at no zoom.
export function widestCrop(width, height) {
  const cropWidth = Math.min(width, height * COVER_RATIO);
  return { width: cropWidth, height: cropWidth / COVER_RATIO };
}

// { dataUrl, width, height, bytes } for the part of the picture inside crop
// ({ x, y, width, height } in its pixels, 16:9): drawn at most MAX_SIDE wide,
// then each quality in QUALITIES tried, best first, keeping the first WebP
// that fits MAX_BYTES.
export async function cropToWebp(bitmap, crop) {
  const width = Math.max(MIN_WIDTH, Math.min(MAX_SIDE, Math.round(crop.width)));
  const height = Math.round(width / COVER_RATIO);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

  for (const quality of QUALITIES) {
    const blob = await toBlob(canvas, quality);
    if (!blob || blob.type !== 'image/webp') {
      throw fail('cover_browser_no_webp');
    }
    if (blob.size <= MAX_BYTES) {
      const dataUrl = await toDataUrl(blob);
      return { dataUrl, width, height, bytes: blob.size };
    }
  }
  throw fail('cover_too_large');
}
