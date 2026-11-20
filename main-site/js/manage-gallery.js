// The Gallery field of the edit form (migrations/019): the event's pictures,
// each in its own shape, uncropped. "Add pictures" (several at once) or a
// paste anywhere in the form adds them; each is shrunk into a WebP in the
// browser (gallery-upload.js) and uploaded on its own (api/manage/gallery.js),
// one after another. Each picture has "Use as cover", which opens the crop
// dialog (manage.js does that part), and a remove button that asks once more
// before it removes. The picture the cover was cut from is marked "Cover",
// and its button reads "Adjust crop".

import { t as translate } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, errorText } from './ui.js';
import { iconNode } from './icons.js';
import { decodePicture, pictureToWebp } from './gallery-upload.js';

const byId = (id) => document.getElementById(id);

// How long a remove button waits for its second click.
const CONFIRM_MS = 4000;

// The event open in the form ({ id, slug }, or null for a new one), its
// pictures as last answered ([{ id, url, width, height }]) and the most it
// holds, and the picture the cover was cut from ('' for none).
let event = null;
let images = [];
let limit = 30;
let coverSourceId = '';
// Pictures still to upload ({ file, resolve }), and whether the queue is
// being worked through.
const queue = [];
let uploading = false;
let uploadedCount = 0;
let queuedCount = 0;
// A load for an event the form has since left is ignored.
let loadToken = 0;
let useAsCover = () => {};
let onCoverChange = () => {};

// The gallery as last answered.
export function galleryImages() {
  return images;
}

// Whether the open event has saved, so it has a gallery to add to.
export function galleryReady() {
  return Boolean(event);
}

// Lets go of pictures still waiting (the form moved to another event).
function dropQueue() {
  for (const item of queue.splice(0)) {
    item.resolve(null);
  }
}

// The picture with this id, or null.
export function galleryImage(id) {
  const found = images.find((image) => image.id === id);
  if (found) {
    return found;
  }
  return null;
}

// Marks the picture the cover was cut from.
export function setGalleryCover(sourceId) {
  if (sourceId) {
    coverSourceId = sourceId;
  } else {
    coverSourceId = '';
  }
  renderGallery();
}

function showError(text) {
  byId('galleryError').textContent = text;
}

// A remove button: the first click asks, the second (within CONFIRM_MS)
// removes.
function removeButton(image, number) {
  const label = translate('manage.gallery-remove', { number });
  const button = createElement('button', { class: 'icon-btn small gallery-remove', type: 'button', 'aria-label': label, title: label }, [iconNode('trash')]);
  let timer = null;
  button.addEventListener('click', async () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      const sure = translate('manage.gallery-remove-sure');
      button.replaceChildren(iconNode('trash'), createElement('span', { text: sure }));
      button.setAttribute('aria-label', sure);
      timer = setTimeout(() => {
        button.classList.remove('armed');
        button.replaceChildren(iconNode('trash'));
        button.setAttribute('aria-label', label);
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    showError('');
    try {
      const data = await post('/api/manage/gallery', { id: event.id, remove: image.id });
      images = data.images;
      limit = data.limit;
      onCoverChange(data.event);
    } catch (error) {
      showError(errorText(error));
    }
    renderGallery();
  });
  return button;
}

function galleryItem(image, index) {
  const isCover = image.id === coverSourceId;
  let itemClass = 'gallery-item';
  if (isCover) {
    itemClass = 'gallery-item is-cover';
  }
  const picture = createElement('img', {
    src: image.url,
    width: image.width,
    height: image.height,
    alt: translate('manage.gallery-picture', { number: index + 1 }),
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  let coverLabel = 'manage.gallery-use-cover';
  let coverIcon = 'star';
  if (isCover) {
    coverLabel = 'manage.cover-adjust';
    coverIcon = 'edit';
  }
  const coverButton = createElement('button', { class: 'btn btn-small gallery-use-cover', type: 'button' }, [
    iconNode(coverIcon),
    createElement('span', { i18n: coverLabel }),
  ]);
  coverButton.addEventListener('click', () => useAsCover(image, coverButton));
  const children = [picture];
  if (isCover) {
    children.push(createElement('span', { class: 'chip gallery-cover-chip' }, [iconNode('star'), createElement('span', { i18n: 'manage.gallery-cover' })]));
  }
  children.push(createElement('div', { class: 'gallery-item-actions' }, [coverButton, removeButton(image, index + 1)]));
  return createElement('li', { class: itemClass }, children);
}

function renderCount() {
  let text = '';
  if (uploading) {
    text = translate('manage.gallery-uploading', { number: Math.min(uploadedCount + 1, queuedCount), count: queuedCount });
  } else if (event && images.length > 0) {
    text = translate('manage.gallery-count', { count: images.length, limit });
  }
  byId('galleryCount').textContent = text;
}

export function renderGallery() {
  const list = byId('galleryList');
  list.replaceChildren(...images.map((image, index) => galleryItem(image, index)));
  list.hidden = images.length === 0;
  byId('galleryPick').hidden = !event;
  byId('galleryPasteHint').hidden = !event;
  byId('gallerySaveFirst').hidden = Boolean(event);
  let full = false;
  if (event && images.length >= limit) {
    full = true;
  }
  byId('galleryFile').disabled = full;
  byId('galleryPick').classList.toggle('disabled', full);
  renderCount();
}

// The gallery of the event now open (null for a new one, which has none
// until it has saved).
// The same event again (its link changed) keeps the pictures on their way.
export async function loadGallery(open) {
  let sameEvent = false;
  if (open && event && open.id === event.id) {
    sameEvent = true;
  }
  if (!sameEvent) {
    loadToken += 1;
    dropQueue();
    images = [];
    showError('');
  }
  const token = loadToken;
  if (open) {
    event = { id: open.id, slug: open.slug };
  } else {
    event = null;
  }
  renderGallery();
  if (!event) {
    return;
  }
  try {
    const data = await api(`/api/manage/gallery?id=${encodeURIComponent(event.id)}`);
    if (token !== loadToken) {
      return;
    }
    images = data.images;
    limit = data.limit;
  } catch (error) {
    showError(errorText(error));
  }
  renderGallery();
}

// Uploads the queued pictures one at a time. A picture that cannot be used
// is named in the error box, and the rest still go.
async function workQueue() {
  if (uploading) {
    return;
  }
  uploading = true;
  const problems = [];
  const token = loadToken;
  while (queue.length > 0 && token === loadToken) {
    renderCount();
    const { file, resolve } = queue.shift();
    let bitmap = null;
    let added = null;
    try {
      if (images.length >= limit) {
        throw Object.assign(new Error('gallery_full'), { code: 'gallery_full' });
      }
      bitmap = await decodePicture(file);
      const { dataUrl } = await pictureToWebp(bitmap);
      const data = await post('/api/manage/gallery', { id: event.id, image: dataUrl });
      added = data.image;
      if (token === loadToken) {
        images = data.images;
        limit = data.limit;
        renderGallery();
      }
    } catch (error) {
      let name = file.name;
      if (!name) {
        name = translate('manage.gallery-pasted');
      }
      problems.push(translate('manage.gallery-failed', { name, reason: errorText(error) }));
    } finally {
      if (bitmap) {
        bitmap.close();
      }
      resolve(added);
    }
    uploadedCount += 1;
  }
  uploading = false;
  uploadedCount = 0;
  queuedCount = 0;
  if (token === loadToken) {
    showError(problems.join(' '));
    renderGallery();
    if (problems.length === 0) {
      byId('manageNotice').textContent = translate('manage.gallery-saved');
    }
  }
}

// Adds pictures (Files) to the gallery of the open event. Resolves the
// gallery pictures they became, in order, with null for any that failed.
export function addGalleryFiles(files) {
  if (!event) {
    return Promise.resolve([]);
  }
  const pictures = [...files].filter(Boolean);
  if (pictures.length === 0) {
    return Promise.resolve([]);
  }
  showError('');
  const done = pictures.map((file) => new Promise((resolve) => {
    queue.push({ file, resolve });
  }));
  queuedCount += pictures.length;
  renderCount();
  workQueue();
  return Promise.all(done);
}

// Copies a picture from another website into the gallery (a description
// pasted with pictures in it). Resolves the gallery picture, or null.
export async function copyGalleryPicture(address) {
  if (!event) {
    return null;
  }
  const token = loadToken;
  try {
    const data = await post('/api/manage/gallery', { id: event.id, imageUrl: address });
    if (token === loadToken) {
      images = data.images;
      limit = data.limit;
      renderGallery();
    }
    return data.image;
  } catch {
    return null;
  }
}

// options.useAsCover(image, button): what "Use as cover" does (manage.js).
// options.onCoverChange(cover): the cover as the server now has it, after a
// removal (taking out the cover's source picture forgets it).
export function startGallery(options) {
  useAsCover = options.useAsCover;
  onCoverChange = options.onCoverChange;
  byId('galleryFile').addEventListener('change', () => {
    const files = [...byId('galleryFile').files];
    byId('galleryFile').value = '';
    addGalleryFiles(files);
  });
}
