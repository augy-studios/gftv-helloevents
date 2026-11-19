// The crop dialog for a cover picture: a 16:9 frame, the shape of the event
// cards' thumbnail, showing the part of the picture that will be kept. It
// starts on the middle of the picture at no zoom (the widest 16:9 area that
// fits); the editor drags to move it, and zooms with the slider, the mouse
// wheel or a pinch. On the keyboard, the arrow keys move it (Shift for
// bigger steps), + and - zoom, and 0 goes back to the middle.
//
// The crop can never leave the picture, so a cover is never padded out with
// empty space, and it cannot zoom in past where the kept part would be
// narrower than MIN_WIDTH pixels.
//
// The event page's banner is wider than the cards (BANNER_RATIO), so it
// shows only the middle band of the cover: the strips above and below that
// band are shaded in the frame, with a dashed line at their edge, so faces
// and text can be kept inside it. The shading is only drawn in the frame,
// never into the cover itself.

import { t as translate } from '../assets/i18n/i18n.js';
import { openModal, closeModal } from './ui.js';
import { COVER_RATIO, BANNER_RATIO, MIN_WIDTH, widestCrop } from './cover-upload.js';

const MAX_ZOOM = 4;
const WHEEL_ZOOM = 0.0015;
const KEY_ZOOM = 1.1;

const byId = (id) => document.getElementById(id);

// The picture being cropped and where the crop is: zoom (1 = the widest
// area) and the picture point at the middle of the frame, in its pixels.
let picture = null;
let widest = null;
let maxZoom = 1;
let zoom = 1;
let centreX = 0;
let centreY = 0;
// The crop chosen with "Use this crop", read when the dialog closes.
let chosen = null;
let finish = null;
// Pointers down on the frame, for dragging and pinching.
const pointers = new Map();
let pinchDistance = 0;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// The kept area at the current zoom and centre, in picture pixels.
function cropRect() {
  const width = widest.width / zoom;
  const height = width / COVER_RATIO;
  return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}

// Keeps the zoom in range and the kept area inside the picture.
function settle() {
  zoom = clamp(zoom, 1, maxZoom);
  const { width, height } = cropRect();
  centreX = clamp(centreX, width / 2, picture.width - width / 2);
  centreY = clamp(centreY, height / 2, picture.height - height / 2);
}

// Draws the kept area into the frame, sharp on high-density screens, and
// moves the slider to the zoom.
function draw() {
  settle();
  const canvas = byId('cropCanvas');
  let ratio = window.devicePixelRatio;
  if (!ratio) {
    ratio = 1;
  }
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.round(width / COVER_RATIO);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const crop = cropRect();
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, width, height);
  context.drawImage(picture, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  drawBannerGuides(context, width, height, ratio);
  byId('cropZoom').value = String(zoom);
}

// Shades the strips of the frame the event page's banner leaves out, and
// dashes the banner's top and bottom edges.
function drawBannerGuides(context, width, height, ratio) {
  const strip = (height - width / BANNER_RATIO) / 2;
  context.save();
  context.fillStyle = 'rgba(0, 0, 0, 0.35)';
  context.fillRect(0, 0, width, strip);
  context.fillRect(0, height - strip, width, strip);
  context.setLineDash([8 * ratio, 6 * ratio]);
  context.lineWidth = Math.max(1, ratio);
  context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  context.beginPath();
  context.moveTo(0, strip);
  context.lineTo(width, strip);
  context.moveTo(0, height - strip);
  context.lineTo(width, height - strip);
  context.stroke();
  context.restore();
}

// Back to the middle of the picture, at no zoom.
function reset() {
  zoom = 1;
  centreX = picture.width / 2;
  centreY = picture.height / 2;
  draw();
}

// Moves the picture under the frame by a distance on screen (dx, dy in CSS
// pixels): the kept area moves the other way.
function panBy(dx, dy) {
  const perPixel = cropRect().width / byId('cropCanvas').clientWidth;
  centreX -= dx * perPixel;
  centreY -= dy * perPixel;
  draw();
}

function zoomTo(value) {
  zoom = value;
  draw();
}

function distance() {
  const [first, second] = [...pointers.values()];
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function startCrop() {
  const canvas = byId('cropCanvas');

  // Captured, so a drag that ends outside the frame still ends here (and
  // does not count as a click on the backdrop, which closes the dialog).
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      pinchDistance = distance();
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    const last = pointers.get(event.pointerId);
    if (!last || !picture) {
      return;
    }
    const now = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, now);
    if (pointers.size === 1) {
      panBy(now.x - last.x, now.y - last.y);
    } else if (pointers.size === 2 && pinchDistance > 0) {
      const next = distance();
      zoomTo(zoom * (next / pinchDistance));
      pinchDistance = next;
    }
  });
  const lift = (event) => {
    pointers.delete(event.pointerId);
    pinchDistance = 0;
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);

  canvas.addEventListener('wheel', (event) => {
    if (!picture) {
      return;
    }
    event.preventDefault();
    zoomTo(zoom * Math.exp(-event.deltaY * WHEEL_ZOOM));
  }, { passive: false });

  canvas.addEventListener('keydown', (event) => {
    if (!picture) {
      return;
    }
    let step = 10;
    if (event.shiftKey) {
      step = 50;
    }
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      event.preventDefault();
      panBy(...moves[event.key]);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomTo(zoom * KEY_ZOOM);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomTo(zoom / KEY_ZOOM);
    } else if (event.key === '0') {
      event.preventDefault();
      reset();
    }
  });

  byId('cropZoom').addEventListener('input', () => zoomTo(Number(byId('cropZoom').value)));
  byId('cropReset').addEventListener('click', reset);
  byId('cropUse').addEventListener('click', () => {
    const crop = cropRect();
    chosen = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    closeModal('cropModal');
  });
  window.addEventListener('resize', () => {
    if (picture) {
      draw();
    }
  });
}

let started = false;

// Opens the dialog for a decoded picture. start: an earlier crop to begin
// from (for "Adjust crop"); otherwise the middle. Resolves the crop
// ({ x, y, width, height } in picture pixels) on "Use this crop", or null
// when the dialog is closed without it.
export function cropCover(bitmap, start = null) {
  if (!started) {
    startCrop();
    started = true;
  }
  picture = bitmap;
  widest = widestCrop(bitmap.width, bitmap.height);
  maxZoom = clamp(widest.width / MIN_WIDTH, 1, MAX_ZOOM);
  byId('cropZoom').max = String(maxZoom);
  byId('cropZoom').disabled = maxZoom <= 1;
  let ledeKey = 'manage.crop-lede-wide';
  if (bitmap.width / bitmap.height < COVER_RATIO) {
    ledeKey = 'manage.crop-lede-narrow';
  }
  if (bitmap.height >= bitmap.width) {
    ledeKey = 'manage.crop-lede-tall';
  }
  byId('cropLede').textContent = translate(ledeKey);
  chosen = null;
  pointers.clear();

  return new Promise((resolve) => {
    finish = resolve;
    openModal('cropModal', {
      initialFocus: byId('cropCanvas'),
      onClose: () => {
        picture = null;
        finish(chosen);
      },
    });
    // Drawn once the dialog is shown, so the frame has its size.
    if (start) {
      zoom = widest.width / start.width;
      centreX = start.x + start.width / 2;
      centreY = start.y + start.height / 2;
      draw();
    } else {
      reset();
    }
  });
}
