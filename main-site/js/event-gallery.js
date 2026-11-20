// The event page's gallery (migrations/019): the event's pictures, each in
// its own shape, in columns under "About this event". Each one opens larger
// in a dialog, where Previous and Next (or the left and right arrow keys)
// step through them. Hidden when the event has none.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement, openModal } from './ui.js';

const byId = (id) => document.getElementById(id);

// The pictures shown ([{ url, width, height }]) and the one open in the
// dialog.
let pictures = [];
let shown = 0;
// The pictures last drawn, and in which language, so a redraw with the same
// ones (after an RSVP) leaves the page as it is.
let drawn = '';
let started = false;

function showPicture(index) {
  const count = pictures.length;
  shown = (index + count) % count;
  const picture = pictures[shown];
  const view = byId('galleryView');
  view.src = picture.url;
  view.width = picture.width;
  view.height = picture.height;
  view.alt = translate('event.gallery-picture', { number: shown + 1, count });
  byId('galleryModalTitle').textContent = translate('event.gallery-picture', { number: shown + 1, count });
  byId('galleryNav').hidden = count < 2;
}

function openPicture(index) {
  showPicture(index);
  openModal('galleryModal', { initialFocus: byId('galleryNext') });
}

function start() {
  started = true;
  byId('galleryPrev').addEventListener('click', () => showPicture(shown - 1));
  byId('galleryNext').addEventListener('click', () => showPicture(shown + 1));
  byId('galleryModal').addEventListener('keydown', (event) => {
    if (pictures.length < 2) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showPicture(shown - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      showPicture(shown + 1);
    }
  });
}

function thumbnail(picture, index, count) {
  const image = createElement('img', {
    src: picture.url,
    width: picture.width,
    height: picture.height,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  // A picture that cannot be loaded is left out rather than shown broken.
  image.addEventListener('error', () => {
    image.closest('li').hidden = true;
  }, { once: true });
  const button = createElement('button', {
    class: 'gallery-thumb',
    type: 'button',
    'aria-label': translate('event.gallery-open', { number: index + 1, count }),
  }, [image]);
  button.addEventListener('click', () => openPicture(index));
  return createElement('li', {}, [button]);
}

// Draws the gallery for the event's pictures (event.gallery).
export function renderEventGallery(list) {
  if (!started) {
    start();
  }
  let next = [];
  if (Array.isArray(list)) {
    next = list;
  }
  const key = JSON.stringify([translate('event.gallery'), next]);
  if (key === drawn) {
    return;
  }
  drawn = key;
  pictures = next;
  byId('galleryBox').hidden = pictures.length === 0;
  byId('eventGallery').replaceChildren(...pictures.map((picture, index) => thumbnail(picture, index, pictures.length)));
}
