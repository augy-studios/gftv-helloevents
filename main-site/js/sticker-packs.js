// My Telegram sticker packs (api/me/stickers.js), for the picture dialog on
// /manage and the Sticker packs section of /account.
//
// A video sticker's still (what Safari shows) starts as Telegram's small
// preview. Whenever the packs are loaded in a browser that plays WebM with
// its transparency, each such sticker's first frame is drawn here at full
// size and sent back as a WebP, one at a time in the background, so the
// still is sharp without anything extra being stored.

import { api, post } from './api.js';
import { playsTransparentWebm } from './rich-dom.js';

let packs = null;
let upgrading = false;
const listeners = new Set();

function changed() {
  for (const listener of listeners) {
    listener(packs);
  }
}

// Calls listener(packs) whenever the packs change (an upgraded still, say).
export function onPacksChange(listener) {
  listeners.add(listener);
}

// My packs ([{ id, name, title, stickers: [{ id, url, video, width,
// height, emoji, needsFrame }] }]), loaded once unless fresh is asked for.
export async function loadPacks({ fresh = false } = {}) {
  if (packs && !fresh) {
    return packs;
  }
  const data = await api('/api/me/stickers');
  packs = data.packs;
  changed();
  upgradeStills();
  return packs;
}

// Adds a pack from its link. Resolves { added: { copied, skipped } }.
export async function addPack(link) {
  const data = await post('/api/me/stickers', { action: 'add', link });
  packs = data.packs;
  changed();
  upgradeStills();
  return data.added;
}

export async function removePack(id) {
  const data = await post('/api/me/stickers', { action: 'remove', id });
  packs = data.packs;
  changed();
}

// The first frame of a video sticker as a WebP data: address, at its own
// size, or null when it cannot be drawn with its transparency.
function firstFrame(sticker) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const done = (value) => {
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 10000);
    video.addEventListener('error', () => {
      clearTimeout(timer);
      done(null);
    }, { once: true });
    video.addEventListener('loadeddata', () => {
      clearTimeout(timer);
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        done(null);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, width, height);
      // A frame with no transparent pixel at all was drawn without its
      // transparency (or the sticker has none): Telegram's preview stays.
      const pixels = context.getImageData(0, 0, width, height).data;
      let transparent = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] < 250) {
          transparent = true;
          break;
        }
      }
      if (!transparent) {
        done(null);
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob || blob.type !== 'image/webp') {
          done(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => done(reader.result);
        reader.onerror = () => done(null);
        reader.readAsDataURL(blob);
      }, 'image/webp', 0.9);
    }, { once: true });
    video.src = sticker.video;
  });
}

// Sends the first frame of every video sticker still on Telegram's preview.
async function upgradeStills() {
  if (upgrading || !packs || !playsTransparentWebm()) {
    return;
  }
  upgrading = true;
  try {
    const waiting = packs.flatMap((pack) => pack.stickers).filter((sticker) => {
      if (!sticker.needsFrame) {
        return false;
      }
      return Boolean(sticker.video);
    });
    for (const sticker of waiting) {
      const image = await firstFrame(sticker);
      if (!image) {
        continue;
      }
      try {
        const data = await post('/api/me/stickers', { action: 'still', id: sticker.id, image });
        packs = data.packs;
        changed();
      } catch {
        // Tried again the next time the packs are loaded.
      }
    }
  } finally {
    upgrading = false;
  }
}
