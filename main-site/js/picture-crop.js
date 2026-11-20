// The crop dialog for a picture in a description (rich-editor.js): clicking
// a gallery picture in the editor opens it on the whole picture, with the
// part kept framed. The frame is dragged to move it and by its edges and
// corners to resize it, Word-like, and can be held to a shape: free, the
// picture's own, square, 4:3, 3:4, 16:9 or 9:16. On the keyboard, the arrow
// keys move it (Shift for bigger steps), + and - grow and shrink it, and 0
// takes the whole picture. "Full picture" takes the crop off.
//
// The crop is the description's own (the gallery keeps the whole picture):
// fractions of the picture, js/rich-text.js cropText. So is the size it is
// shown at: its own (up to the full width), or small, medium, large or the
// full width of the text (js/rich-text.js PICTURE_SIZES).

import { t as translate } from '../assets/i18n/i18n.js';
import { openModal, closeModal } from './ui.js';
import { MIN_CROP } from './rich-text.js';

const byId = (id) => document.getElementById(id);
const KEY_STEP = 0.01;
const SHIFT_STEP = 0.05;
const KEY_ZOOM = 1.05;
// The shapes: width over height in pixels, or 0 for free and -1 for the
// picture's own.
const SHAPES = { free: 0, original: -1, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 };

// The whole picture's size in pixels, the frame (fractions of the picture),
// the shape held (as a fraction ratio: width over height in fractions, or 0
// for free), and the drag on its way.
let natural = { width: 1, height: 1 };
let frame = { x: 0, y: 0, width: 1, height: 1 };
let ratio = 0;
let drag = null;
let chosen = null;
let finish = null;
let started = false;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// The smallest frame side, in fractions: MIN_CROP, or 16 pixels.
function minimum(axis) {
  let pixels = natural.width;
  if (axis === 'y') {
    pixels = natural.height;
  }
  return Math.max(MIN_CROP, 16 / pixels);
}

function fits(rect) {
  if (rect.x < -0.0001 || rect.y < -0.0001 || rect.x + rect.width > 1.0001 || rect.y + rect.height > 1.0001) {
    return false;
  }
  if (rect.width < minimum('x') - 0.0001 || rect.height < minimum('y') - 0.0001) {
    return false;
  }
  return true;
}

function draw() {
  const box = byId('pictureCropFrame');
  box.style.left = `${frame.x * 100}%`;
  box.style.top = `${frame.y * 100}%`;
  box.style.width = `${frame.width * 100}%`;
  box.style.height = `${frame.height * 100}%`;
  // The shade over the rest of the picture: above, below, and either side.
  const shades = {
    Top: { left: 0, top: 0, width: 1, height: frame.y },
    Bottom: { left: 0, top: frame.y + frame.height, width: 1, height: 1 - frame.y - frame.height },
    Left: { left: 0, top: frame.y, width: frame.x, height: frame.height },
    Right: { left: frame.x + frame.width, top: frame.y, width: 1 - frame.x - frame.width, height: frame.height },
  };
  for (const [side, place] of Object.entries(shades)) {
    const shade = byId(`pictureCropShade${side}`);
    shade.style.left = `${place.left * 100}%`;
    shade.style.top = `${place.top * 100}%`;
    shade.style.width = `${Math.max(0, place.width) * 100}%`;
    shade.style.height = `${Math.max(0, place.height) * 100}%`;
  }
  const width = Math.round(frame.width * natural.width);
  const height = Math.round(frame.height * natural.height);
  byId('pictureCropSize').textContent = translate('editor.crop-size', { width, height });
}

// The largest frame of the shape held, centred where the frame is now, that
// fits in the picture.
function fitShape() {
  if (!ratio) {
    draw();
    return;
  }
  const centreX = frame.x + frame.width / 2;
  const centreY = frame.y + frame.height / 2;
  let width = 1;
  let height = width / ratio;
  if (height > 1) {
    height = 1;
    width = ratio;
  }
  frame = {
    width,
    height,
    x: clamp(centreX - width / 2, 0, 1 - width),
    y: clamp(centreY - height / 2, 0, 1 - height),
  };
  draw();
}

function setShape(name) {
  let shape = SHAPES[name];
  if (shape === undefined) {
    shape = 0;
  }
  if (shape === -1) {
    shape = natural.width / natural.height;
  }
  // In fractions of the picture: the pixel ratio over the picture's own.
  ratio = 0;
  if (shape > 0) {
    ratio = shape / (natural.width / natural.height);
  }
  fitShape();
}

// The frame after dragging a handle (n, e, s, w, or a corner) by dx, dy
// (fractions), keeping the shape held; null when it would not fit.
function resized(start, handle, dx, dy) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes('w')) {
    left = Math.min(left + dx, right - minimum('x'));
  }
  if (handle.includes('e')) {
    right = Math.max(right + dx, left + minimum('x'));
  }
  if (handle.includes('n')) {
    top = Math.min(top + dy, bottom - minimum('y'));
  }
  if (handle.includes('s')) {
    bottom = Math.max(bottom + dy, top + minimum('y'));
  }
  let rect = { x: left, y: top, width: right - left, height: bottom - top };
  if (ratio) {
    const corner = handle.length === 2;
    let width = rect.width;
    let height = rect.height;
    if (corner) {
      if (width / height > ratio) {
        width = height * ratio;
      } else {
        height = width / ratio;
      }
    } else if (handle === 'e' || handle === 'w') {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
    let shiftedLeft = rect.x;
    let shiftedTop = rect.y;
    if (corner) {
      if (handle.includes('w')) {
        shiftedLeft = right - width;
      }
      if (handle.includes('n')) {
        shiftedTop = bottom - height;
      }
    } else if (handle === 'e' || handle === 'w') {
      if (handle === 'w') {
        shiftedLeft = right - width;
      }
      shiftedTop = start.y + start.height / 2 - height / 2;
    } else {
      if (handle === 'n') {
        shiftedTop = bottom - height;
      }
      shiftedLeft = start.x + start.width / 2 - width / 2;
    }
    rect = { x: shiftedLeft, y: shiftedTop, width, height };
  }
  if (!fits(rect)) {
    return null;
  }
  return rect;
}

// Grows (factor over 1) or shrinks the frame about its centre.
function scaleFrame(factor) {
  const width = clamp(frame.width * factor, minimum('x'), 1);
  let height = clamp(frame.height * factor, minimum('y'), 1);
  if (ratio) {
    height = width / ratio;
  }
  const rect = {
    width,
    height,
    x: clamp(frame.x + frame.width / 2 - width / 2, 0, 1 - width),
    y: clamp(frame.y + frame.height / 2 - height / 2, 0, 1 - height),
  };
  if (fits(rect)) {
    frame = rect;
    draw();
  }
}

// The size picked: '' (the picture's own) or one of PICTURE_SIZES.
function pickedSize() {
  const picked = document.querySelector('input[name="pictureSize"]:checked');
  if (!picked) {
    return '';
  }
  return picked.value;
}

function startDialog() {
  const stage = byId('pictureCropStage');
  stage.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-handle]');
    const onFrame = event.target.closest('#pictureCropFrame');
    if (!handle && !onFrame) {
      return;
    }
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    let kind = 'move';
    if (handle) {
      kind = handle.dataset.handle;
    }
    drag = { kind, id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...frame } };
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    const box = byId('pictureCropImage').getBoundingClientRect();
    const dx = (event.clientX - drag.x) / box.width;
    const dy = (event.clientY - drag.y) / box.height;
    if (drag.kind === 'move') {
      frame = {
        ...drag.start,
        x: clamp(drag.start.x + dx, 0, 1 - drag.start.width),
        y: clamp(drag.start.y + dy, 0, 1 - drag.start.height),
      };
    } else {
      const rect = resized(drag.start, drag.kind, dx, dy);
      if (rect) {
        frame = rect;
      }
    }
    draw();
  });
  const lift = () => {
    drag = null;
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('keydown', (event) => {
    let step = KEY_STEP;
    if (event.shiftKey) {
      step = SHIFT_STEP;
    }
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      frame = { ...frame, x: clamp(frame.x + dx, 0, 1 - frame.width), y: clamp(frame.y + dy, 0, 1 - frame.height) };
      draw();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      scaleFrame(KEY_ZOOM);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      scaleFrame(1 / KEY_ZOOM);
    } else if (event.key === '0') {
      event.preventDefault();
      frame = { x: 0, y: 0, width: 1, height: 1 };
      fitShape();
    }
  });
  byId('pictureCropShape').addEventListener('change', () => setShape(byId('pictureCropShape').value));
  byId('pictureCropUse').addEventListener('click', () => {
    chosen = { ...frame };
    closeModal('pictureCropModal');
  });
  byId('pictureCropFull').addEventListener('click', () => {
    chosen = { x: 0, y: 0, width: 1, height: 1 };
    closeModal('pictureCropModal');
  });
}

// Opens the dialog for a gallery picture: address, its whole picture's
// address; start, its crop now (or null); size, its size now. Resolves
// { crop, width, height, size }: the crop chosen ({ x, y, width, height },
// the whole picture for "Apply without a crop"), the whole picture's size
// in pixels, and the size picked; or null when the dialog is closed without
// one.
export function cropPicture(address, start, size = '') {
  if (!started) {
    startDialog();
    started = true;
  }
  chosen = null;
  drag = null;
  for (const option of document.querySelectorAll('input[name="pictureSize"]')) {
    option.checked = option.value === size;
  }
  return new Promise((resolve) => {
    finish = resolve;
    const image = byId('pictureCropImage');
    const ready = () => {
      natural = { width: image.naturalWidth, height: image.naturalHeight };
      frame = { x: 0, y: 0, width: 1, height: 1 };
      if (start) {
        frame = { ...start };
      }
      byId('pictureCropShape').value = 'free';
      ratio = 0;
      draw();
    };
    image.addEventListener('load', ready, { once: true });
    image.src = address;
    if (image.complete && image.naturalWidth) {
      image.removeEventListener('load', ready);
      ready();
    }
    openModal('pictureCropModal', {
      initialFocus: byId('pictureCropStage'),
      onClose: () => {
        if (!chosen) {
          finish(null);
          return;
        }
        finish({ crop: chosen, width: natural.width, height: natural.height, size: pickedSize() });
      },
    });
  });
}
