// Turning a chosen picture into a compressed WebP in the browser, before it
// is uploaded (api/manage/cover.js checks and re-encodes it again).
//
// The longest side is cut to MAX_SIDE, then quality steps down until the
// file fits MAX_BYTES. A browser that cannot encode WebP from a canvas
// (canvas.toBlob gives back PNG instead) is told so rather than sending
// something else.

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

// { dataUrl, width, height, bytes } for a File from an <input type=file>.
export async function coverToWebp(file) {
  if (!file || !String(file.type).startsWith('image/')) throw fail('cover_invalid');
  if (file.size > 40 * 1024 * 1024) throw fail('cover_too_large');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw fail('cover_invalid');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) throw fail('cover_too_small');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  for (const quality of QUALITIES) {
    const blob = await toBlob(canvas, quality);
    if (!blob || blob.type !== 'image/webp') throw fail('cover_browser_no_webp');
    if (blob.size <= MAX_BYTES) return { dataUrl: await toDataUrl(blob), width, height, bytes: blob.size };
  }
  throw fail('cover_too_large');
}
