// The emoji picker in the description editor's toolbar (rich-editor.js):
// every emoji of Unicode's latest edition (assets/emoji/emoji.json, built by
// tools/make-emoji.mjs), by group, with a search by name, a skin tone for
// the emoji that have them, and the ones used lately first. A click puts the
// emoji in at the cursor and leaves the picker open for the next; Escape
// closes it. In the grid, the arrow keys move between emoji.
//
// The emoji are text, so they show in each reader's own device's style;
// emoji a device is too old to have come from the site's copy of Noto Color
// Emoji (assets/fonts/emoji/emoji.css, "GFTV Emoji" in the font list).
//
// The tone and the emoji used lately are remembered in this browser only.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { insertText } from './rich-editor.js';

const byId = (id) => document.getElementById(id);
const DATA_URL = '/assets/emoji/emoji.json';
const RECENT_KEY = 'gftv-helloevents-recent-emoji';
const TONE_KEY = 'gftv-helloevents-emoji-tone';
const RECENT_LIMIT = 32;
// The skin tone buttons: none (the default yellow) and the five tones.
const TONE_SAMPLES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];
// Each group's tab, as an emoji.
const GROUP_ICONS = {
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐻',
  'Food & Drink': '🍔',
  'Travel & Places': '✈️',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '❤️',
  Flags: '🏳️',
};
const GROUP_KEYS = {
  'Smileys & Emotion': 'emoji.group-smileys',
  'People & Body': 'emoji.group-people',
  'Animals & Nature': 'emoji.group-animals',
  'Food & Drink': 'emoji.group-food',
  'Travel & Places': 'emoji.group-travel',
  Activities: 'emoji.group-activities',
  Objects: 'emoji.group-objects',
  Symbols: 'emoji.group-symbols',
  Flags: 'emoji.group-flags',
};

let data = null;
let loading = null;
let group = 'recent';
let tone = 0;
// Every emoji by itself and each of its tones, for showing recent ones.
const byEmoji = new Map();

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value === null) {
      return fallback;
    }
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: remembered for this page only.
  }
}

function recentList() {
  const list = readStored(RECENT_KEY, []);
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((emoji) => {
    if (typeof emoji !== 'string') {
      return false;
    }
    return byEmoji.has(emoji);
  });
}

// An emoji in the tone chosen, when it has tones.
function inTone(item) {
  if (tone > 0 && item[2]) {
    return item[2][tone - 1];
  }
  return item[0];
}

function pick(emoji) {
  insertText(emoji);
  const recent = [emoji, ...recentList().filter((each) => each !== emoji)].slice(0, RECENT_LIMIT);
  store(RECENT_KEY, recent);
}

function emojiButton(emoji, name) {
  const button = createElement('button', { class: 'emoji-item', type: 'button', title: name, 'aria-label': name, tabindex: '-1' });
  button.textContent = emoji;
  button.addEventListener('click', () => pick(emoji));
  return button;
}

// Draws a list of [emoji, name] in the grid, the first one reachable by Tab.
function drawGrid(items, emptyKey) {
  const grid = byId('emojiGrid');
  grid.replaceChildren(...items.map(([emoji, name]) => emojiButton(emoji, name)));
  const first = grid.querySelector('.emoji-item');
  if (first) {
    first.tabIndex = 0;
  }
  byId('emojiEmpty').hidden = items.length > 0;
  byId('emojiEmpty').textContent = translate(emptyKey);
  grid.scrollTop = 0;
}

function showGroup(name) {
  if (!data) {
    return;
  }
  group = name;
  for (const tab of byId('emojiTabs').querySelectorAll('[data-group]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.group === name));
  }
  if (name === 'recent') {
    drawGrid(recentList().map((emoji) => [emoji, byEmoji.get(emoji)]), 'emoji.recent-empty');
    byId('emojiHeading').textContent = translate('emoji.recent');
    return;
  }
  const found = data.groups.find((each) => each.name === name);
  drawGrid(found.emoji.map((item) => [inTone(item), item[1]]), 'emoji.none');
  byId('emojiHeading').textContent = translate(GROUP_KEYS[name]);
}

function search(words) {
  if (!data) {
    return;
  }
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    showGroup(group);
    return;
  }
  const results = [];
  for (const each of data.groups) {
    for (const item of each.emoji) {
      const name = item[1].toLowerCase();
      if (terms.every((term) => name.includes(term))) {
        results.push([inTone(item), item[1]]);
      }
    }
  }
  byId('emojiHeading').textContent = translate('emoji.results');
  drawGrid(results, 'emoji.none');
}

function drawTones() {
  byId('emojiTones').replaceChildren(...TONE_SAMPLES.map((sample, index) => {
    const button = createElement('button', {
      class: 'emoji-tone',
      type: 'button',
      'aria-pressed': String(index === tone),
      'aria-label': translate(`emoji.tone-${index}`),
      title: translate(`emoji.tone-${index}`),
    });
    button.textContent = sample;
    button.addEventListener('click', () => {
      tone = index;
      store(TONE_KEY, tone);
      for (const each of byId('emojiTones').children) {
        each.setAttribute('aria-pressed', String(each === button));
      }
      search(byId('emojiSearch').value);
    });
    return button;
  }));
}

function drawTabs() {
  const tabs = [['recent', '🕘', 'emoji.recent'], ...data.groups.map((each) => [each.name, GROUP_ICONS[each.name], GROUP_KEYS[each.name]])];
  byId('emojiTabs').replaceChildren(...tabs.map(([name, icon, key]) => {
    const tab = createElement('button', { class: 'emoji-tab', type: 'button', 'data-group': name, 'aria-label': translate(key), title: translate(key) });
    tab.textContent = icon;
    tab.addEventListener('click', () => {
      byId('emojiSearch').value = '';
      showGroup(name);
    });
    return tab;
  }));
}

async function load() {
  if (data) {
    return data;
  }
  if (!loading) {
    loading = fetch(DATA_URL, { credentials: 'same-origin' }).then((response) => {
      if (!response.ok) {
        throw new Error('emoji data');
      }
      return response.json();
    });
  }
  try {
    data = await loading;
  } catch (error) {
    loading = null;
    throw error;
  }
  for (const each of data.groups) {
    for (const item of each.emoji) {
      byEmoji.set(item[0], item[1]);
      if (item[2]) {
        for (const toned of item[2]) {
          byEmoji.set(toned, item[1]);
        }
      }
    }
  }
  byId('emojiVersion').textContent = translate('emoji.version', { version: data.version });
  return data;
}

async function open() {
  byId('emojiEmpty').hidden = true;
  // Cleared now, not after loading: what is typed while the emoji load is
  // searched for once they have.
  byId('emojiSearch').value = '';
  try {
    await load();
  } catch {
    byId('emojiEmpty').hidden = false;
    byId('emojiEmpty').textContent = translate('emoji.load-failed');
    return;
  }
  tone = Number(readStored(TONE_KEY, 0));
  if (!Number.isInteger(tone) || tone < 0 || tone > 5) {
    tone = 0;
  }
  drawTabs();
  drawTones();
  if (recentList().length === 0 && group === 'recent') {
    group = data.groups[0].name;
  }
  if (byId('emojiSearch').value.trim()) {
    for (const tab of byId('emojiTabs').querySelectorAll('[data-group]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.group === group));
    }
    search(byId('emojiSearch').value);
    return;
  }
  showGroup(group);
}

// The arrow keys move between emoji in the grid, row by row as it is laid
// out.
function moveInGrid(event) {
  const items = [...byId('emojiGrid').querySelectorAll('.emoji-item')];
  const index = items.indexOf(document.activeElement);
  if (index < 0) {
    return;
  }
  const top = items[0].offsetTop;
  const columns = Math.max(1, items.findIndex((item) => item.offsetTop !== top));
  let perRow = columns;
  if (items.every((item) => item.offsetTop === top)) {
    perRow = items.length;
  }
  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow, Home: -index, End: items.length - 1 - index };
  if (!(event.key in steps)) {
    return;
  }
  event.preventDefault();
  const next = items[Math.min(items.length - 1, Math.max(0, index + steps[event.key]))];
  items[index].tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

export function startEmojiPicker() {
  byId('emojiPalette').addEventListener('rich-palette-open', open);
  byId('emojiSearch').addEventListener('input', () => search(byId('emojiSearch').value));
  byId('emojiSearch').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const first = byId('emojiGrid').querySelector('.emoji-item');
      if (first) {
        event.preventDefault();
        if (event.key === 'Enter') {
          first.click();
        } else {
          first.focus();
        }
      }
    }
  });
  byId('emojiGrid').addEventListener('keydown', moveInGrid);
}
