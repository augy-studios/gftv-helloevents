// The Sticker packs section of /account (migrations/020): the Telegram
// sticker packs on my account, for putting stickers in event descriptions.
// Only for people who edit events. A pack is added from its
// t.me/addstickers link and removed with its bin button, which asks once
// more first.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement, withBusy, errorText } from './ui.js';
import { iconNode } from './icons.js';
import { loadPacks, addPack, removePack, onPacksChange } from './sticker-packs.js';
import { addedText } from './picture-picker.js';

const byId = (id) => document.getElementById(id);
const PREVIEW = 12;
const CONFIRM_MS = 4000;

function removeButton(pack) {
  const label = translate('stickers.remove', { title: pack.title });
  const button = createElement('button', { class: 'icon-btn small gallery-remove', type: 'button', 'aria-label': label, title: label }, [iconNode('trash')]);
  let timer = null;
  button.addEventListener('click', async () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.replaceChildren(iconNode('trash'), createElement('span', { text: translate('manage.gallery-remove-sure') }));
      timer = setTimeout(() => {
        button.classList.remove('armed');
        button.replaceChildren(iconNode('trash'));
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    await withBusy(button, byId('stickerError'), () => removePack(pack.id));
  });
  return button;
}

function renderPacks(packs) {
  byId('stickerNone').hidden = packs.length > 0;
  byId('stickerPacks').replaceChildren(...packs.map((pack) => {
    const previews = pack.stickers.slice(0, PREVIEW).map((sticker) => createElement('img', {
      src: sticker.url, width: sticker.width, height: sticker.height, alt: '', loading: 'lazy', decoding: 'async',
    }));
    return createElement('li', { class: 'sticker-pack' }, [
      createElement('div', { class: 'sticker-pack-head' }, [
        createElement('div', {}, [
          createElement('strong', { text: pack.title }),
          createElement('span', { class: 'small muted', text: translate('stickers.count', { count: pack.stickers.length }) }),
        ]),
        removeButton(pack),
      ]),
      createElement('div', { class: 'sticker-pack-preview' }, previews),
    ]);
  }));
}

// Shows the section to someone who edits events, and loads their packs.
export function startAccountStickers(user) {
  if (!user || (user.editsEvents !== true && user.canManage !== true)) {
    return;
  }
  byId('stickerBox').hidden = false;
  onPacksChange(renderPacks);
  loadPacks().catch((error) => {
    byId('stickerError').textContent = errorText(error);
  });
  byId('stickerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const link = byId('stickerLink').value.trim();
    if (!link) {
      return;
    }
    byId('stickerStatus').textContent = translate('stickers.adding');
    const added = await withBusy(byId('stickerAdd'), byId('stickerError'), () => addPack(link));
    byId('stickerStatus').textContent = '';
    if (added) {
      byId('stickerLink').value = '';
      byId('stickerStatus').textContent = addedText(added);
    }
  });
}
