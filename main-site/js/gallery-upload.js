// Turning a chosen picture into a compressed WebP for an event's gallery, in
// the browser, before it is uploaded (api/manage/gallery.js checks and
// re-encodes it again, covers.js).
//
// A gallery picture keeps its own shape: nothing is cropped. It is only
// shrunk to at most MAX_SIDE on its longer side, then the quality is stepped
// down until the file fits MAX_BYTES; if even the lowest quality does not
// fit, it is shrunk a little more and tried again. The cover is cut from a
// gallery picture later, in the crop dialog (cover-crop.js).

export const MAX_SIDE = 2000;
export const MAX_BYTES = 1_000_000;
export const MIN_LONG = 320;
export const MIN_SHORT = 100;
const QUALITIES = [0.85, 0.75, 0.65, 0.55];
// Each further try is this much smaller on each side.
const SHRINK = 0.8;

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

// The decoded picture (an ImageBitmap, turned the way its camera meant) for
// a File. Refuses anything that is not a picture, over 40 MB, or smaller than
// MIN_LONG on its longer side or MIN_SHORT on its shorter one.
export async function decodePicture(file) {
  if (!file || !String(file.type).startsWith('image/')) {
    throw fail('cover_invalid');
  }
  if (file.size > 40 * 1024 * 1024) {
    throw fail('cover_too_large');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw fail('cover_invalid');
  }
  const longer = Math.max(bitmap.width, bitmap.height);
  const shorter = Math.min(bitmap.width, bitmap.height);
  if (longer < MIN_LONG || shorter < MIN_SHORT) {
    bitmap.close();
    throw fail('gallery_too_small');
  }
  return bitmap;
}

// The picture drawn at scale (at most 1) on a canvas of its own shape.
function drawScaled(bitmap, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// { dataUrl, width, height, bytes } for the whole picture, uncropped, at
// most MAX_SIDE on its longer side and MAX_BYTES in size.
export async function pictureToWebp(bitmap) {
  let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const canvas = drawScaled(bitmap, scale);
    if (Math.max(canvas.width, canvas.height) < MIN_LONG) {
      break;
    }
    for (const quality of QUALITIES) {
      const blob = await toBlob(canvas, quality);
      if (!blob || blob.type !== 'image/webp') {
        throw fail('cover_browser_no_webp');
      }
      if (blob.size <= MAX_BYTES) {
        const dataUrl = await toDataUrl(blob);
        return { dataUrl, width: canvas.width, height: canvas.height, bytes: blob.size };
      }
    }
    scale *= SHRINK;
  }
  throw fail('cover_too_large');
}

// The decoded picture behind a gallery address (this site's own, sent with
// the editor's cookie, so an unreleased event's picture loads too), for
// cutting a cover from it.
export async function fetchPicture(url) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin' });
  } catch {
    throw fail('offline');
  }
  if (!response.ok) {
    throw fail('gallery_image_gone');
  }
  try {
    return await createImageBitmap(await response.blob());
  } catch {
    throw fail('cover_invalid');
  }
}
