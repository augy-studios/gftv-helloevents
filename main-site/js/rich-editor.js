// The description editor on /manage: a Word-like rich text editor over the
// two descriptions (English and Chinese), one shown at a time, sharing one
// toolbar.
//
// The toolbar: undo and redo; paragraph style (normal text, three heading
// levels, quote); font; size (in points, as in Word); bold, italic,
// underline, strikethrough, subscript, superscript; text colour and
// highlight, each with "Automatic" (follows the site's light or dark theme);
// clear formatting; alignment; bulleted and numbered lists; decrease and
// increase indent; link; picture (the picture dialog, picture-picker.js);
// table, with row and column tools while the cursor is in one; horizontal
// line. Word's shortcuts work: Ctrl+B, I, U, Z, Y, K (link), Tab and
// Shift+Tab in lists and tables.
//
// Pasting keeps the formatting it comes with (js/rich-text.js maps Word's,
// Google Docs' and web pages' markup onto what a description can hold).
// Pictures in a paste are copied into the event's gallery and land where
// they were: a picture from another website through the server, one pasted
// as a file or as data from the browser. Pictures from the gallery and
// stickers are put in with the picture dialog, at the cursor, and can then
// be dragged elsewhere in the text.
//
// The editor's HTML goes to the server as it is; the server cleans it to
// what a description may hold before it is stored (api/_lib/rich-text.js).

import { t as translate } from '../assets/i18n/i18n.js';
import { cleanHtml, cleanElement, richFragment, playStickers, applyInlineStyles } from './rich-dom.js';
import { plainToHtml, markdownToHtml, pasteSource, readableOn, parseCrop, cropText, croppedAddress } from './rich-text.js';
import { cropPicture } from './picture-crop.js';
import { openModal, closeModal, toast } from './ui.js';

const byId = (id) => document.getElementById(id);

// Colours chosen for "Automatic" and "No highlight": no one picks these, so
// once the browser has applied them they are found and taken off again.
const AUTOMATIC_COLOUR = 'rgb(1, 2, 3)';
const AUTOMATIC_HEX = '#010203';
const NO_HIGHLIGHT = 'rgb(254, 253, 252)';
const NO_HIGHLIGHT_HEX = '#fefdfc';
const DEFAULT_FONT = 'helloevents-default-font';
const MAX_INDENT_EM = 20;
const BLOCK_SELECTOR = 'p, h2, h3, h4, li, blockquote, td, th';
// Word's colour grid: theme-free basics and their tints.
export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
  '#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130',
];

// The editors by language, the one shown, the selection last made in it
// (restored before a toolbar command, since a toolbar list or dialog takes
// focus), and what the page does for pictures.
const editors = new Map();
let current = null;
let savedRange = null;
let hooks = {
  onChange: () => {},
  openPicturePicker: () => {},
  uploadFiles: async () => [],
  copyPicture: async () => null,
  canAddPictures: () => false,
};

function exec(command, value = null) {
  return document.execCommand(command, false, value);
}

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

function selectionInside(editor) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) {
    return null;
  }
  return range;
}

function saveSelection() {
  if (!current) {
    return;
  }
  const range = selectionInside(current);
  if (range) {
    savedRange = range.cloneRange();
  }
}

// Puts the selection back in the editor shown (at its end when there was
// none), so a command from the toolbar applies where the editor left off.
function restoreSelection() {
  if (!current) {
    return;
  }
  current.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (savedRange && current.contains(savedRange.commonAncestorContainer)) {
    selection.removeAllRanges();
    selection.addRange(savedRange);
    return;
  }
  if (!selectionInside(current)) {
    const range = document.createRange();
    range.selectNodeContents(current);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function closestInEditor(node, selector) {
  if (!current || !node) {
    return null;
  }
  let element = node;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    element = node.parentElement;
  }
  if (!element) {
    return null;
  }
  const found = element.closest(selector);
  if (found && current.contains(found) && found !== current) {
    return found;
  }
  return null;
}

// The innermost blocks the selection touches.
function selectedBlocks() {
  const range = selectionInside(current);
  if (!range) {
    return [];
  }
  const start = closestInEditor(range.startContainer, BLOCK_SELECTOR);
  const blocks = [...current.querySelectorAll(BLOCK_SELECTOR)].filter((block) => {
    if (!range.intersectsNode(block)) {
      return false;
    }
    return !block.querySelector(BLOCK_SELECTOR);
  });
  if (blocks.length === 0 && start) {
    return [start];
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Elements in the editor whose style has property set to value (as the
// browser writes it): what a command with a stand-in value just made.
function styledWith(property, value) {
  return [...current.querySelectorAll('[style]')].filter((element) => element.style.getPropertyValue(property) === value);
}

// Takes a property off elements, and unwraps a span left with no style.
function clearProperty(elements, property) {
  for (const element of elements) {
    element.style.removeProperty(property);
    if (element.getAttribute('style') === '') {
      element.removeAttribute('style');
    }
    if ((element.localName === 'span' || element.localName === 'font') && element.attributes.length === 0) {
      element.replaceWith(...element.childNodes);
    }
  }
}

function applyColour(colour) {
  restoreSelection();
  exec('styleWithCSS', true);
  if (colour) {
    exec('foreColor', colour);
  } else {
    exec('foreColor', AUTOMATIC_HEX);
    clearProperty(styledWith('color', AUTOMATIC_COLOUR), 'color');
    for (const font of current.querySelectorAll(`font[color="${AUTOMATIC_HEX}"]`)) {
      font.replaceWith(...font.childNodes);
    }
  }
  exec('styleWithCSS', false);
  applyInlineStyles(current);
  changed();
}

function applyHighlight(colour) {
  restoreSelection();
  exec('styleWithCSS', true);
  let value = colour;
  if (!colour) {
    value = NO_HIGHLIGHT_HEX;
  }
  if (!exec('hiliteColor', value)) {
    exec('backColor', value);
  }
  if (!colour) {
    clearProperty(styledWith('background-color', NO_HIGHLIGHT), 'background-color');
  }
  exec('styleWithCSS', false);
  // Highlighted text gets a colour it can be read in on the highlight, as
  // the saved description will have (js/rich-text.js).
  for (const element of current.querySelectorAll('[style]')) {
    if (element.style.backgroundColor && !element.style.color) {
      element.style.color = readableOn(element.style.backgroundColor);
    }
  }
  applyInlineStyles(current);
  changed();
}

function applyFont(font) {
  restoreSelection();
  exec('styleWithCSS', true);
  let value = font;
  if (!font) {
    value = DEFAULT_FONT;
  }
  exec('fontName', value);
  exec('styleWithCSS', false);
  const made = [...current.querySelectorAll('[style], font[face]')].filter((element) => {
    if (element.getAttribute('face') === value) {
      return true;
    }
    return element.style.fontFamily.replace(/["']/g, '') === value;
  });
  for (const element of made) {
    // A size inside the new font's text gives way to it.
    clearProperty([...element.querySelectorAll('[style]')], 'font-family');
    if (!font) {
      element.removeAttribute('face');
      clearProperty([element], 'font-family');
    }
  }
  applyInlineStyles(current);
  changed();
}

// The browser can only set sizes 1 to 7: size 7 is set, then each <font
// size="7"> it made becomes a span of the size chosen.
function applySize(pixels) {
  restoreSelection();
  exec('styleWithCSS', false);
  exec('fontSize', '7');
  for (const font of current.querySelectorAll('font[size="7"]')) {
    clearProperty([...font.querySelectorAll('[style]')], 'font-size');
    const span = document.createElement('span');
    if (pixels) {
      span.style.fontSize = `${pixels}px`;
    }
    span.append(...font.childNodes);
    if (pixels) {
      font.replaceWith(span);
    } else {
      font.replaceWith(...span.childNodes);
    }
  }
  for (const element of styledWith('font-size', 'xxx-large')) {
    clearProperty([element], 'font-size');
    if (pixels) {
      element.style.fontSize = `${pixels}px`;
    }
  }
  applyInlineStyles(current);
  changed();
}

function applyBlock(tag) {
  restoreSelection();
  exec('formatBlock', `<${tag}>`);
  changed();
}

// Indent: in a list, a level deeper (or back); elsewhere, the blocks move
// in by 2em steps, up to MAX_INDENT_EM, as Word's indent does.
function indent(step) {
  restoreSelection();
  const range = selectionInside(current);
  if (range && closestInEditor(range.startContainer, 'li')) {
    if (step > 0) {
      exec('indent');
    } else {
      exec('outdent');
    }
    changed();
    return;
  }
  for (const block of selectedBlocks()) {
    if (block.localName === 'td' || block.localName === 'th') {
      continue;
    }
    let now = parseFloat(block.style.marginLeft);
    if (!Number.isFinite(now) || !block.style.marginLeft.endsWith('em')) {
      now = 0;
    }
    const next = Math.min(MAX_INDENT_EM, Math.max(0, now + step * 2));
    if (next === 0) {
      clearProperty([block], 'margin-left');
    } else {
      block.style.marginLeft = `${next}em`;
    }
  }
  changed();
}

// Puts clean HTML in at the selection, as one step undo takes back.
function insertHtml(html) {
  restoreSelection();
  exec('insertHTML', html);
  applyInlineStyles(current);
  saveSelection();
}

// ---------------------------------------------------------------------------
// Links and tables
// ---------------------------------------------------------------------------

// The link the cursor is in, or null.
function linkAtSelection() {
  const range = selectionInside(current);
  if (!range) {
    return null;
  }
  return closestInEditor(range.startContainer, 'a');
}

// A whole number from a field, within low and high (low when blank).
function numberIn(id, low, high) {
  const value = Math.round(Number(byId(id).value));
  if (!Number.isFinite(value)) {
    return low;
  }
  return Math.min(high, Math.max(low, value));
}

function linkAddress(text) {
  let address = String(text).trim();
  if (!address) {
    return '';
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    address = `mailto:${address}`;
  } else if (!/^(https?:|mailto:|tel:)/i.test(address)) {
    address = `https://${address}`;
  }
  if (!/^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d\s()-]+)$/i.test(address)) {
    return '';
  }
  return address;
}

function openLinkDialog() {
  saveSelection();
  const range = selectionInside(current);
  const link = linkAtSelection();
  let text = '';
  if (range) {
    text = range.toString();
  }
  if (link) {
    text = link.textContent;
  }
  byId('linkText').value = text;
  let href = '';
  if (link) {
    href = link.getAttribute('href');
  }
  byId('linkAddress').value = href;
  byId('linkError').textContent = '';
  byId('linkRemove').hidden = !link;
  openModal('linkModal', { initialFocus: byId('linkAddress') });
}

function insertLink() {
  const address = linkAddress(byId('linkAddress').value);
  if (!address) {
    byId('linkError').textContent = translate('editor.link-invalid');
    return;
  }
  closeModal('linkModal');
  restoreSelection();
  const range = selectionInside(current);
  const existing = linkAtSelection();
  let text = byId('linkText').value.trim();
  if (!text) {
    text = address.replace(/^mailto:/i, '');
  }
  if (existing) {
    existing.setAttribute('href', address);
    if (text !== existing.textContent) {
      existing.textContent = text;
    }
  } else if (range && !range.collapsed && range.toString() === text) {
    exec('createLink', address);
  } else {
    const anchor = document.createElement('a');
    anchor.href = address;
    anchor.textContent = text;
    insertHtml(anchor.outerHTML);
  }
  changed();
}

function removeLink() {
  closeModal('linkModal');
  restoreSelection();
  const link = linkAtSelection();
  if (link) {
    const selection = window.getSelection();
    const whole = document.createRange();
    whole.selectNodeContents(link);
    selection.removeAllRanges();
    selection.addRange(whole);
  }
  exec('unlink');
  changed();
}

function insertTable() {
  const rows = numberIn('tableRows', 1, 50);
  const columns = numberIn('tableColumns', 1, 10);
  const header = byId('tableHeader').checked;
  closeModal('tableModal');
  let html = '<table><tbody>';
  for (let row = 0; row < rows; row += 1) {
    let cellTag = 'td';
    if (header && row === 0) {
      cellTag = 'th';
    }
    html += `<tr>${`<${cellTag}><p><br></p></${cellTag}>`.repeat(columns)}</tr>`;
  }
  html += '</tbody></table><p><br></p>';
  insertHtml(html);
  changed();
}

// The cell the cursor is in, its row and its column number.
function currentCell() {
  const range = selectionInside(current);
  if (!range) {
    return null;
  }
  const cell = closestInEditor(range.startContainer, 'td, th');
  if (!cell) {
    return null;
  }
  const row = cell.parentElement;
  return { cell, row, table: cell.closest('table'), column: [...row.children].indexOf(cell) };
}

function emptyCell(tag) {
  const cell = document.createElement(tag);
  cell.innerHTML = '<p><br></p>';
  return cell;
}

function placeCaret(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  saveSelection();
}

function tableCommand(command) {
  restoreSelection();
  const at = currentCell();
  if (!at) {
    return;
  }
  const rows = [...at.table.querySelectorAll('tr')];
  if (command === 'rowAbove' || command === 'rowBelow') {
    const row = document.createElement('tr');
    for (const cell of at.row.children) {
      row.append(emptyCell('td'));
      if (cell.colSpan > 1) {
        row.lastChild.colSpan = cell.colSpan;
      }
    }
    if (command === 'rowAbove') {
      at.row.before(row);
    } else {
      at.row.after(row);
    }
    placeCaret(row.children[Math.min(at.column, row.children.length - 1)]);
  } else if (command === 'columnLeft' || command === 'columnRight') {
    for (const row of rows) {
      const reference = row.children[Math.min(at.column, row.children.length - 1)];
      let tag = 'td';
      if (reference && reference.localName === 'th') {
        tag = 'th';
      }
      const cell = emptyCell(tag);
      if (!reference) {
        row.append(cell);
      } else if (command === 'columnLeft') {
        reference.before(cell);
      } else {
        reference.after(cell);
      }
    }
  } else if (command === 'deleteRow') {
    if (rows.length <= 1) {
      tableCommand('deleteTable');
      return;
    }
    let next = at.row.nextElementSibling;
    if (!next) {
      next = at.row.previousElementSibling;
    }
    at.row.remove();
    placeCaret(next.children[0]);
  } else if (command === 'deleteColumn') {
    if (at.row.children.length <= 1) {
      tableCommand('deleteTable');
      return;
    }
    for (const row of rows) {
      const cell = row.children[at.column];
      if (cell) {
        cell.remove();
      }
    }
    placeCaret(at.row.children[Math.max(0, at.column - 1)]);
  } else if (command === 'deleteTable') {
    const after = document.createElement('p');
    after.innerHTML = '<br>';
    at.table.replaceWith(after);
    placeCaret(after);
  }
  changed();
}

// Tab in a table moves to the next cell (a new row after the last one).
function tabInTable(backwards) {
  const at = currentCell();
  if (!at) {
    return false;
  }
  const cells = [...at.table.querySelectorAll('td, th')];
  const index = cells.indexOf(at.cell);
  let next = cells[index + 1];
  if (backwards) {
    next = cells[index - 1];
  }
  if (!next && !backwards) {
    tableCommand('rowBelow');
    return true;
  }
  if (next) {
    placeCaret(next);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

// A picture's HTML, built and cleaned like any other description HTML.
function pictureHtml(picture) {
  const attributes = [`src="${picture.src.replace(/"/g, '&quot;')}"`];
  if (picture.width && picture.height) {
    attributes.push(`width="${picture.width}"`, `height="${picture.height}"`);
  }
  if (picture.kind === 'sticker') {
    attributes.push('class="rich-sticker"', `data-sticker-id="${picture.id}"`);
    if (picture.video) {
      attributes.push(`data-video="${picture.video.replace(/"/g, '&quot;')}"`);
    }
  } else {
    attributes.push(`data-gallery-id="${picture.id}"`);
    if (picture.crop) {
      attributes.push(`data-crop="${picture.crop}"`);
    }
    if (picture.size) {
      attributes.push(`data-size="${picture.size}"`);
    }
  }
  return cleanHtml(`<img ${attributes.join(' ')}>`, { mode: 'render' }).html.replace(/^<p>|<\/p>$/g, '');
}

// Puts text (an emoji from the emoji picker) in at the cursor, where the
// editor last was, as one step undo takes back. The picker stays open, so
// the selection is kept for the next one.
export function insertText(text) {
  if (!current) {
    return;
  }
  const active = document.activeElement;
  restoreSelection();
  exec('insertText', text);
  saveSelection();
  changed();
  if (active && active !== current && typeof active.focus === 'function') {
    active.focus({ preventScroll: true });
  }
}

// Puts pictures in at the cursor (where the editor last was), in order.
export function insertPictures(pictures) {
  if (!current || pictures.length === 0) {
    return;
  }
  insertHtml(pictures.map(pictureHtml).join(''));
  dropTrailingBreaks();
  playStickers(current);
  changed();
}

// A picture put into an empty line keeps the line break the browser left as
// its placeholder, after it, so text typed next would start a new line: a
// break that is the last thing in its block, right after a picture, goes.
function dropTrailingBreaks() {
  for (const lineBreak of current.querySelectorAll('br')) {
    const before = lineBreak.previousSibling;
    if (lineBreak.nextSibling || !before || before.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    if (before.matches('img[data-gallery-id], img[data-sticker-id], video[data-sticker-id]')) {
      lineBreak.remove();
    }
  }
}

// Clicking a gallery picture in the editor (or Enter with one selected)
// opens the size and crop dialog on the whole picture; the size and crop
// chosen replace the picture in one step that undo takes back. The gallery keeps the whole
// picture: each place a picture is shown has its own crop.
async function adjustCrop(image) {
  const id = image.getAttribute('data-gallery-id');
  const whole = croppedAddress(image.getAttribute('src'), '');
  let size = image.getAttribute('data-size');
  if (!size) {
    size = '';
  }
  const result = await cropPicture(whole, parseCrop(String(image.getAttribute('data-crop'))), size);
  if (!result || !image.isConnected) {
    return;
  }
  const crop = cropText(result.crop);
  let width = result.width;
  let height = result.height;
  if (crop) {
    const part = parseCrop(crop);
    width = Math.max(1, Math.round(result.width * part.width));
    height = Math.max(1, Math.round(result.height * part.height));
  }
  const html = pictureHtml({ kind: 'gallery', id, src: croppedAddress(whole, crop), width, height, crop, size: result.size });
  current = image.closest('.rich-editor');
  current.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNode(image);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  savedRange = range;
  insertHtml(html);
  dropTrailingBreaks();
  changed();
  settled(current);
}

function onPictureClick(event) {
  const image = event.target.closest('img[data-gallery-id]');
  if (!image || !event.currentTarget.contains(image)) {
    return;
  }
  event.preventDefault();
  adjustCrop(image);
}

// The gallery picture the selection is exactly, or null.
function selectedPicture() {
  const range = selectionInside(current);
  if (!range || range.startContainer !== range.endContainer || range.endOffset - range.startOffset !== 1) {
    return null;
  }
  const node = range.startContainer.childNodes[range.startOffset];
  if (node && node.nodeType === Node.ELEMENT_NODE && node.matches('img[data-gallery-id]')) {
    return node;
  }
  return null;
}

// Swaps a placeholder for the gallery picture it became, or takes it out.
function settlePlaceholder(placeholder, image) {
  if (!placeholder.isConnected) {
    return;
  }
  if (!image) {
    placeholder.remove();
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = pictureHtml({ kind: 'gallery', id: image.id, src: image.url, width: image.width, height: image.height });
  placeholder.replaceWith(template.content);
}

// A data: picture as a File, for the gallery upload.
function dataUrlFile(address) {
  const match = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(address);
  if (!match) {
    return null;
  }
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], 'pasted-picture', { type: match[1] });
}

// Copies every pasted picture still waiting (an <img data-pending-src>)
// into the gallery, one at a time, then puts the gallery picture in its
// place. Without a saved event, they are taken out and the editor is told.
async function copyPendingPictures(editor) {
  const placeholders = [...editor.querySelectorAll('img[data-pending-src]')];
  if (placeholders.length === 0) {
    return;
  }
  if (!hooks.canAddPictures()) {
    placeholders.forEach((placeholder) => placeholder.remove());
    toast(translate('editor.pictures-save-first'), 5000);
    changed();
    return;
  }
  let failed = 0;
  for (const placeholder of placeholders) {
    placeholder.classList.add('rich-pending');
    const address = placeholder.getAttribute('data-pending-src');
    let image = null;
    try {
      if (address.startsWith('data:')) {
        const file = dataUrlFile(address);
        if (file) {
          [image] = await hooks.uploadFiles([file]);
        }
      } else {
        image = await hooks.copyPicture(address);
      }
    } catch {
      image = null;
    }
    if (!image) {
      failed += 1;
    }
    settlePlaceholder(placeholder, image);
  }
  if (failed > 0) {
    toast(translate('editor.pictures-not-copied', { count: failed }), 6000);
  }
  changed();
  settled(editor);
}

// Tells the page the description changed without the editor being left (a
// picture landed), so it can be saved.
function settled(editor) {
  editor.dispatchEvent(new CustomEvent('rich-pictures-settled', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Pasting and copying
// ---------------------------------------------------------------------------

function imageFiles(data) {
  return [...data.files].filter((file) => file.type.startsWith('image/'));
}

async function pasteFiles(files) {
  if (!hooks.canAddPictures()) {
    toast(translate('editor.pictures-save-first'), 5000);
    return;
  }
  const images = await hooks.uploadFiles(files);
  const added = images.filter(Boolean);
  insertPictures(added.map((image) => ({ kind: 'gallery', id: image.id, src: image.url, width: image.width, height: image.height })));
  if (added.length < files.length) {
    toast(translate('editor.pictures-not-copied', { count: files.length - added.length }), 6000);
  }
  if (current) {
    settled(current);
  }
}

// Puts cleaned paste HTML in at the cursor. Returns false when it holds
// nothing to put in.
function insertCleaned(editor, cleaned) {
  if (cleaned.html.replace(/<p><br><\/p>/g, '') === '') {
    return false;
  }
  // A single paragraph goes in as inline content, so it joins the
  // paragraph the cursor is in, as pasting a few words does in Word.
  let inserted = cleaned.html;
  const single = /^<p>((?:(?!<\/?p[ >]).)*)<\/p>$/s.exec(inserted);
  if (single) {
    inserted = single[1];
  }
  insertHtml(inserted);
  changed();
  copyPendingPictures(editor);
  return true;
}

function onPaste(event) {
  const data = event.clipboardData;
  if (!data) {
    return;
  }
  event.preventDefault();
  const editor = event.currentTarget;
  saveSelection();
  const html = data.getData('text/html');
  if (html) {
    // From Discord or Telegram Web: without the app's theme (rich-text.js).
    const cleaned = cleanHtml(html, { mode: 'paste', ownCopy: html.includes('data-helloevents-copy'), source: pasteSource(html) });
    if (insertCleaned(editor, cleaned)) {
      return;
    }
  }
  const files = imageFiles(data);
  if (files.length > 0) {
    pasteFiles(files);
    return;
  }
  const text = data.getData('text/plain');
  if (!text) {
    return;
  }
  // Markdown (Discord's "Copy Text", or typed) as formatting, and web
  // addresses (Telegram Desktop writes a link out as its address) as links.
  const marked = markdownToHtml(text);
  if (marked !== null && insertCleaned(editor, cleanHtml(marked, { mode: 'paste' }))) {
    return;
  }
  if (text.includes('\n')) {
    insertHtml(plainToHtml(text));
  } else {
    exec('insertText', text);
  }
  changed();
}

// The selection with the formatting around it (the heading, bold, the
// span it is in), as clean HTML marked as this editor's own: pasted back
// in, its headings are not moved down a level as a paste from Word's are.
function selectionHtml(editor) {
  const range = selectionInside(editor);
  if (!range || range.collapsed) {
    return null;
  }
  let content = range.cloneContents();
  let node = range.commonAncestorContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node = node.parentElement;
  }
  while (node && node !== editor) {
    if (['strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'span', 'font', 'a', 'h2', 'h3', 'h4', 'p', 'blockquote'].includes(node.localName)) {
      const shell = node.cloneNode(false);
      shell.append(content);
      const holder = document.createDocumentFragment();
      holder.append(shell);
      content = holder;
    }
    node = node.parentElement;
  }
  const box = document.createElement('div');
  box.append(content);
  const cleaned = cleanElement(box, { mode: 'render' });
  return { html: `<div data-helloevents-copy="1">${cleaned.html}</div>`, text: range.toString() };
}

function onCopy(event) {
  const copied = selectionHtml(event.currentTarget);
  if (!copied || !event.clipboardData) {
    return;
  }
  event.preventDefault();
  event.clipboardData.setData('text/html', copied.html);
  event.clipboardData.setData('text/plain', copied.text);
  if (event.type === 'cut') {
    exec('delete');
    changed();
  }
}

// Files dropped on the editor go into the gallery and in where they fell.
function onDrop(event) {
  const files = imageFiles(event.dataTransfer);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(event.clientX, event.clientY);
  } else if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  }
  if (range && current.contains(range.startContainer)) {
    savedRange = range;
  }
  pasteFiles(files);
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

const STATE_COMMANDS = ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'];

// Closest option of a <select> to a pixel size, or '' (the default).
function sizeOption(pixels) {
  const select = byId('richSize');
  let best = '';
  let gap = Infinity;
  for (const option of select.options) {
    if (!option.value) {
      continue;
    }
    const difference = Math.abs(Number(option.value) - pixels);
    if (difference < gap) {
      gap = difference;
      best = option.value;
    }
  }
  if (gap > 1) {
    return '';
  }
  return best;
}

// The toolbar shows what is on where the cursor is: the paragraph style,
// font, size, and which buttons are pressed; the table tools show in a table.
function updateToolbar() {
  const range = selectionInside(current);
  if (!range) {
    return;
  }
  for (const command of STATE_COMMANDS) {
    const button = document.querySelector(`#richToolbar [data-command="${command}"]`);
    if (button) {
      let pressed = false;
      try {
        pressed = document.queryCommandState(command);
      } catch {
        pressed = false;
      }
      button.setAttribute('aria-pressed', String(pressed));
    }
  }
  const block = closestInEditor(range.startContainer, 'p, h2, h3, h4, blockquote');
  let blockTag = 'p';
  if (block) {
    blockTag = block.localName;
    if (block.closest('blockquote') && current.contains(block.closest('blockquote'))) {
      blockTag = 'blockquote';
    }
  }
  byId('richBlock').value = blockTag;
  let element = range.startContainer;
  if (element.nodeType !== Node.ELEMENT_NODE) {
    element = element.parentElement;
  }
  const style = getComputedStyle(element);
  byId('richSize').value = '';
  if (closestInEditor(range.startContainer, '[style*="font-size"]')) {
    byId('richSize').value = sizeOption(parseFloat(style.fontSize));
  }
  const fontHolder = closestInEditor(range.startContainer, '[style*="font-family"], font[face]');
  let fontValue = '';
  if (fontHolder) {
    const first = style.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    const option = [...byId('richFont').options].find((each) => each.value.toLowerCase() === first.toLowerCase());
    if (option) {
      fontValue = option.value;
    }
  }
  byId('richFont').value = fontValue;
  byId('richTableTools').hidden = !closestInEditor(range.startContainer, 'td, th');
  const link = closestInEditor(range.startContainer, 'a');
  document.querySelector('#richToolbar [data-command="unlink"]').disabled = !link;
}

// Opens one of the two colour lists under its button.
function togglePalette(name, button) {
  const palette = byId(`${name}Palette`);
  const opening = palette.hidden;
  for (const other of document.querySelectorAll('.rich-palette')) {
    other.hidden = true;
  }
  for (const other of document.querySelectorAll('#richToolbar [aria-haspopup="true"]')) {
    other.setAttribute('aria-expanded', 'false');
  }
  if (opening) {
    saveSelection();
    palette.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    palette.dispatchEvent(new CustomEvent('rich-palette-open'));
    let first = palette.querySelector('[data-autofocus]');
    if (!first) {
      first = palette.querySelector('button');
    }
    first.focus();
  }
}

function closePalettes() {
  for (const palette of document.querySelectorAll('.rich-palette')) {
    palette.hidden = true;
  }
  for (const button of document.querySelectorAll('#richToolbar [aria-haspopup="true"]')) {
    button.setAttribute('aria-expanded', 'false');
  }
}

function fillPalette(name, apply) {
  const palette = byId(`${name}Palette`);
  const grid = palette.querySelector('.rich-swatches');
  for (const colour of PALETTE) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'rich-swatch';
    swatch.style.background = colour;
    swatch.setAttribute('aria-label', colour);
    swatch.title = colour;
    swatch.addEventListener('click', () => {
      closePalettes();
      apply(colour);
      byId(`${name}Bar`).style.background = colour;
    });
    grid.append(swatch);
  }
  palette.querySelector('[data-colour="none"]').addEventListener('click', () => {
    closePalettes();
    apply('');
    byId(`${name}Bar`).style.background = '';
  });
  const custom = palette.querySelector('input[type="color"]');
  custom.addEventListener('change', () => {
    closePalettes();
    apply(custom.value);
    byId(`${name}Bar`).style.background = custom.value;
  });
}

const BUTTON_COMMANDS = {
  undo: () => exec('undo'),
  redo: () => exec('redo'),
  removeFormat: () => {
    exec('removeFormat');
    exec('unlink');
  },
  indent: () => indent(1),
  outdent: () => indent(-1),
  link: () => openLinkDialog(),
  unlink: () => {
    saveSelection();
    removeLink();
  },
  picture: () => {
    saveSelection();
    hooks.openPicturePicker();
  },
  table: () => {
    saveSelection();
    openModal('tableModal', { initialFocus: byId('tableRows') });
  },
  hr: () => exec('insertHorizontalRule'),
};

function startToolbar() {
  const toolbar = byId('richToolbar');
  // A click on a button keeps the editor's selection.
  toolbar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) {
      event.preventDefault();
    }
  });
  toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-command]');
    if (!button || !current) {
      return;
    }
    const command = button.dataset.command;
    if (command === 'colour' || command === 'highlight' || command === 'emoji') {
      togglePalette(command, button);
      return;
    }
    if (command.startsWith('table:')) {
      tableCommand(command.slice(6));
      return;
    }
    restoreSelection();
    if (BUTTON_COMMANDS[command]) {
      BUTTON_COMMANDS[command]();
    } else {
      exec('styleWithCSS', false);
      exec(command);
    }
    changed();
    updateToolbar();
  });
  // A toolbar list takes focus: the selection is kept for it beforehand.
  for (const select of toolbar.querySelectorAll('select')) {
    select.addEventListener('pointerdown', saveSelection);
    select.addEventListener('focus', saveSelection);
  }
  for (const option of byId('richFont').options) {
    if (option.value) {
      option.style.fontFamily = `"${option.value}"`;
    }
  }
  byId('richBlock').addEventListener('change', () => applyBlock(byId('richBlock').value));
  byId('richFont').addEventListener('change', () => applyFont(byId('richFont').value));
  byId('richSize').addEventListener('change', () => applySize(Number(byId('richSize').value)));
  fillPalette('colour', applyColour);
  fillPalette('highlight', applyHighlight);
  document.addEventListener('click', (event) => {
    // A click on something a palette has just redrawn (gone from the page)
    // came from inside it.
    if (!event.target.isConnected) {
      return;
    }
    if (!event.target.closest('.rich-palette, [aria-haspopup="true"]')) {
      closePalettes();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.rich-palette:not([hidden])')) {
      closePalettes();
      restoreSelection();
    }
  });
  document.addEventListener('selectionchange', () => {
    if (current && selectionInside(current)) {
      saveSelection();
      updateToolbar();
    }
  });
  byId('linkForm').addEventListener('submit', (event) => {
    event.preventDefault();
    insertLink();
  });
  byId('linkRemove').addEventListener('click', removeLink);
  byId('tableForm').addEventListener('submit', (event) => {
    event.preventDefault();
    insertTable();
  });
}

// ---------------------------------------------------------------------------
// The editors
// ---------------------------------------------------------------------------

function isEmptyEditor(editor) {
  if (editor.querySelector('img, video, table, hr')) {
    return false;
  }
  return editor.textContent.replace(/\u00a0/g, ' ').trim() === '';
}

// An empty editor holds one empty paragraph, so typing makes paragraphs.
function ensureParagraph(editor) {
  if (editor.childNodes.length === 0 || (isEmptyEditor(editor) && !editor.querySelector('p'))) {
    editor.innerHTML = '<p><br></p>';
  }
}

function changed() {
  for (const editor of editors.values()) {
    editor.classList.toggle('is-empty', isEmptyEditor(editor));
  }
  hooks.onChange();
}

function onKeydown(event) {
  let accel = false;
  if (event.ctrlKey || event.metaKey) {
    accel = true;
  }
  if (event.key === 'Enter' && !accel && !event.shiftKey && selectedPicture()) {
    event.preventDefault();
    adjustCrop(selectedPicture());
    return;
  }
  if (accel && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openLinkDialog();
    return;
  }
  if (event.key === 'Tab' && !accel && !event.altKey) {
    if (tabInTable(event.shiftKey)) {
      event.preventDefault();
      return;
    }
    const range = selectionInside(current);
    if (range && closestInEditor(range.startContainer, 'li')) {
      event.preventDefault();
      if (event.shiftKey) {
        exec('outdent');
      } else {
        exec('indent');
      }
      changed();
    }
  }
}

function startEditor(editor) {
  editor.addEventListener('focus', () => {
    current = editor;
    ensureParagraph(editor);
  });
  editor.addEventListener('input', changed);
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('copy', onCopy);
  editor.addEventListener('cut', onCopy);
  editor.addEventListener('drop', onDrop);
  editor.addEventListener('keydown', onKeydown);
  editor.addEventListener('click', onPictureClick);
  editor.addEventListener('blur', saveSelection);
}

// editorsByLang: { en: element, zh: element }. options: onChange(), what to
// do when something changed; openPicturePicker(), the picture dialog;
// uploadFiles(files) and copyPicture(address), adding to the gallery
// (each resolving to gallery pictures, or null for one that failed);
// canAddPictures(), whether the event has saved, so it has a gallery.
export function startRichEditors(editorsByLang, options) {
  hooks = { ...hooks, ...options };
  for (const [lang, editor] of Object.entries(editorsByLang)) {
    editors.set(lang, editor);
    startEditor(editor);
  }
  current = editors.values().next().value;
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {
    // An older browser makes <div>s; the server makes them paragraphs.
  }
  startToolbar();
  byId('richTableTools').hidden = true;
}

// Shows one language's editor, which the toolbar then works on.
export function showEditor(lang) {
  for (const [each, editor] of editors) {
    editor.hidden = each !== lang;
  }
  current = editors.get(lang);
  savedRange = null;
}

// A saved description (as the server sends it) into an editor.
export function setDescription(lang, html) {
  const editor = editors.get(lang);
  if (html) {
    editor.replaceChildren(richFragment(cleanHtml(html, { mode: 'render' }).html));
  } else {
    editor.replaceChildren();
  }
  ensureParagraph(editor);
  playStickers(editor);
  editor.classList.toggle('is-empty', isEmptyEditor(editor));
  if (editor === current) {
    savedRange = null;
  }
}

// An editor's description as the form sends it: its HTML, '' when blank,
// without pasted pictures still being copied.
export function readDescription(lang) {
  const editor = editors.get(lang);
  if (isEmptyEditor(editor)) {
    return '';
  }
  if (!editor.querySelector('img[data-pending-src]')) {
    return editor.innerHTML;
  }
  const copy = editor.cloneNode(true);
  copy.querySelectorAll('img[data-pending-src]').forEach((placeholder) => placeholder.remove());
  return copy.innerHTML;
}

export function descriptionBlank(lang) {
  return isEmptyEditor(editors.get(lang));
}

// Focuses the editor shown.
export function focusEditor() {
  if (current) {
    current.focus();
  }
}
