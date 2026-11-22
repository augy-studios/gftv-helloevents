// Turning a chosen picture into what the checkout uploads take
// (migrations/016; api/_lib/payments.js checks and re-encodes it again):
//
//   qrPicture     a payment QR code, as a PNG at its own shape (no crop, no
//                 fixed aspect ratio), its longest side at most 1200 px.
//                 PNG keeps it lossless, so it still scans.
//   proofPicture  a payment screenshot, as a WebP, its longest side at most
//                 1600 px, the quality stepped down until it fits.
//   registrationPicture  a registration form photo such as a con badge
//                 photo (migrations/024), the same at 1200 px.
//
// Both are kept small on purpose, so the bucket stays small. Each gives a
// data: URL, or throws an Error whose code is an error.* key.

const QR_SIDE = 1200;
const QR_MAX_BYTES = 2_000_000;
const PROOF_SIDE = 1600;
const PROOF_MAX_BYTES = 1_500_000;
const MIN_SIDE = 64;
const QUALITIES = [0.8, 0.7, 0.6, 0.5];

const fail = (code) => Object.assign(new Error(code), { code });

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function toDataUrl(blob, code) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(fail(code));
    reader.readAsDataURL(blob);
  });
}

// The picture drawn on a canvas, its longest side at most maxSide (never
// enlarged), turned the way its camera meant.
async function draw(file, maxSide, code) {
  if (!file || !String(file.type).startsWith('image/') || file.size > 40 * 1024 * 1024) {
    throw fail(`${code}_invalid`);
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw fail(`${code}_invalid`);
  }
  if (bitmap.width < MIN_SIDE || bitmap.height < MIN_SIDE) {
    bitmap.close();
    throw fail(`${code}_size`);
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  // A QR code with transparency scans best on white.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

export async function qrPicture(file) {
  const canvas = await draw(file, QR_SIDE, 'qr');
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) {
    throw fail('qr_invalid');
  }
  if (blob.size > QR_MAX_BYTES) {
    throw fail('qr_too_large');
  }
  return toDataUrl(blob, 'qr_invalid');
}

export async function proofPicture(file) {
  const canvas = await draw(file, PROOF_SIDE, 'proof');
  for (const quality of QUALITIES) {
    const blob = await toBlob(canvas, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') {
      throw fail('proof_webp_unsupported');
    }
    if (blob.size <= PROOF_MAX_BYTES) {
      return toDataUrl(blob, 'proof_invalid');
    }
  }
  throw fail('proof_too_large');
}

// A registration form photo, such as a con badge photo (migrations/024): a
// WebP, its longest side at most 1200 px, stepped down until it fits.
const PHOTO_SIDE = 1200;

export async function registrationPicture(file) {
  const canvas = await draw(file, PHOTO_SIDE, 'photo');
  for (const quality of QUALITIES) {
    const blob = await toBlob(canvas, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') {
      throw fail('photo_webp_unsupported');
    }
    if (blob.size <= PROOF_MAX_BYTES) {
      return toDataUrl(blob, 'photo_invalid');
    }
  }
  throw fail('photo_too_large');
}
