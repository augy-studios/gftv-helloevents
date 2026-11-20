// The picture dialog of the description editor (rich-editor.js): put one of
// the event's gallery pictures, or a sticker from my Telegram sticker
// packs, in at the cursor. "Upload pictures" adds new pictures to the
// gallery and puts them all in. A sticker pack is added here from its link
// as well as on /account.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement, openModal, closeModal, errorText, withBusy } from './ui.js';
import { loadPacks, addPack, onPacksChange } from './sticker-packs.js';

const byId = (id) => document.getElementById(id);

let options = {
  galleryImages: () => [],
  canAddPictures: () => false,
  uploadFiles: async () => [],
  insert: () => {},
};

// "Added 12 stickers." and, when some were left out, how many.
export function addedText(added) {
  let text = translate('stickers.added', { count: added.copied });
  if (added.skipped > 0) {
    text = `${text} ${translate('stickers.skipped', { count: added.skipped })}`;
  }
  return text;
}

function pick(pictures) {
  closeModal('pictureModal');
  options.insert(pictures);
}

function galleryPicture(image) {
  return { kind: 'gallery', id: image.id, src: image.url, width: image.width, height: image.height };
}

function renderGallery() {
  const images = options.galleryImages();
  const list = byId('pickerGallery');
  list.replaceChildren(...images.map((image, index) => {
    const button = createElement('button', {
      class: 'picker-item',
      type: 'button',
      'aria-label': translate('editor.picker-gallery-item', { number: index + 1 }),
    }, [createElement('img', { src: image.url, width: image.width, height: image.height, alt: '', loading: 'lazy', decoding: 'async' })]);
    button.addEventListener('click', () => pick([galleryPicture(image)]));
    return createElement('li', {}, [button]);
  }));
  const canAdd = options.canAddPictures();
  let emptyHidden = true;
  if (images.length === 0 && canAdd) {
    emptyHidden = false;
  }
  byId('pickerGalleryEmpty').hidden = emptyHidden;
  byId('pickerSaveFirst').hidden = canAdd;
  byId('pickerUpload').hidden = !canAdd;
}

function stickerPicture(sticker) {
  return { kind: 'sticker', id: sticker.id, src: sticker.url, width: sticker.width, height: sticker.height, video: sticker.video };
}

function renderPacks(packs) {
  const holder = byId('pickerPacks');
  if (!packs) {
    return;
  }
  byId('pickerNoPacks').hidden = packs.length > 0;
  holder.replaceChildren(...packs.map((pack) => createElement('section', { class: 'picker-pack' }, [
    createElement('h3', { text: pack.title }),
    createElement('ul', { class: 'picker-grid picker-stickers' }, pack.stickers.map((sticker) => {
      let label = translate('editor.picker-sticker');
      if (sticker.emoji) {
        label = translate('editor.picker-sticker-emoji', { emoji: sticker.emoji });
      }
      const button = createElement('button', { class: 'picker-item picker-sticker', type: 'button', 'aria-label': label, title: sticker.emoji }, [
        createElement('img', { src: sticker.url, width: sticker.width, height: sticker.height, alt: '', loading: 'lazy', decoding: 'async' }),
      ]);
      button.addEventListener('click', () => pick([stickerPicture(sticker)]));
      return createElement('li', {}, [button]);
    })),
  ])));
}

function showTab(name) {
  for (const tab of ['gallery', 'stickers']) {
    const selected = tab === name;
    byId(`pickerTab-${tab}`).setAttribute('aria-selected', String(selected));
    let tabIndex = -1;
    if (selected) {
      tabIndex = 0;
    }
    byId(`pickerTab-${tab}`).tabIndex = tabIndex;
    byId(`pickerPanel-${tab}`).hidden = !selected;
  }
  if (name === 'stickers') {
    byId('pickerStickerError').textContent = '';
    loadPacks().then(renderPacks, (error) => {
      byId('pickerStickerError').textContent = errorText(error);
    });
  }
}

export function openPicturePicker() {
  renderGallery();
  byId('pickerUploadError').textContent = '';
  openModal('pictureModal', { initialFocus: byId('pickerTab-gallery') });
  showTab('gallery');
}

// opts.galleryImages(), the gallery as it stands; opts.canAddPictures(),
// whether the event has saved; opts.uploadFiles(files), adding to the
// gallery (resolves the gallery pictures, null for one that failed);
// opts.insert(pictures), putting pictures in at the cursor.
export function startPicturePicker(opts) {
  options = { ...options, ...opts };
  for (const tab of ['gallery', 'stickers']) {
    byId(`pickerTab-${tab}`).addEventListener('click', () => showTab(tab));
  }
  byId('pickerTabs').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    let next = 'gallery';
    if (byId('pickerTab-gallery').getAttribute('aria-selected') === 'true') {
      next = 'stickers';
    }
    showTab(next);
    byId(`pickerTab-${next}`).focus();
  });
  byId('pickerFile').addEventListener('change', async () => {
    const files = [...byId('pickerFile').files];
    byId('pickerFile').value = '';
    if (files.length === 0) {
      return;
    }
    const images = await withBusy(byId('pickerUpload'), byId('pickerUploadError'), () => options.uploadFiles(files));
    if (!images) {
      return;
    }
    const added = images.filter(Boolean);
    if (added.length < files.length) {
      byId('pickerUploadError').textContent = translate('editor.pictures-not-copied', { count: files.length - added.length });
    }
    if (added.length > 0) {
      pick(added.map(galleryPicture));
    }
  });
  byId('pickerPackForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const link = byId('pickerPackLink').value.trim();
    if (!link) {
      return;
    }
    byId('pickerPackStatus').textContent = translate('stickers.adding');
    const added = await withBusy(byId('pickerPackAdd'), byId('pickerStickerError'), () => addPack(link));
    byId('pickerPackStatus').textContent = '';
    if (added) {
      byId('pickerPackLink').value = '';
      byId('pickerPackStatus').textContent = addedText(added);
    }
  });
  onPacksChange(renderPacks);
}
