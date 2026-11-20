// Event descriptions as rich text, on the server: js/rich-text.js holds the
// rules (shared with the browser); this reads HTML with htmlparser2 and runs
// them.
//
//   cleanDescription(input)     what is stored: { ok, html } or { ok: false }
//   displayDescription(row, value)  what a page gets: stored references
//                               turned into this site's picture addresses
//                               (description-pictures.js loads them)
//   descriptionText(value)      plain text, for link previews
//
// A description saved before descriptions were rich is plain text; it is
// read as paragraphs (plainToHtml).

import { parseDocument } from 'htmlparser2';
import { cleanRichTree, plainToHtml, looksRich, MAX_TEXT, MAX_HTML } from '../../js/rich-text.js';

// htmlparser2's tree, read the way js/rich-text.js asks.
const ADAPTER = {
  type(node) {
    if (node.type === 'text') {
      return 'text';
    }
    if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      return 'element';
    }
    return 'other';
  },
  tag(node) {
    return String(node.name).toLowerCase();
  },
  attr(node, name) {
    if (!node.attribs || !Object.hasOwn(node.attribs, name)) {
      return null;
    }
    return node.attribs[name];
  },
  children(node) {
    if (!Array.isArray(node.children)) {
      return [];
    }
    return node.children;
  },
  text(node) {
    return String(node.data);
  },
};

function parse(html) {
  return parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
}

// The stored form of a description as it arrived: the editor's HTML (or
// plain text, which becomes paragraphs). { ok: true, html } with '' for a
// blank one, or { ok: false } when it is too long or has too many pictures.
export function cleanDescription(input) {
  if (input === null || input === undefined) {
    return { ok: true, html: '' };
  }
  let text = String(input);
  if (text.length > MAX_HTML * 10) {
    return { ok: false };
  }
  if (!looksRich(text)) {
    text = plainToHtml(text);
  }
  const cleaned = cleanRichTree(parse(text), ADAPTER, { mode: 'store' });
  if (cleaned.textLength > MAX_TEXT || cleaned.html.length > MAX_HTML) {
    return { ok: false };
  }
  return { ok: true, html: cleaned.html };
}

// A stored description (rich, or plain from before) as stored HTML.
function storedHtml(value) {
  if (!value) {
    return '';
  }
  if (looksRich(value)) {
    return String(value);
  }
  return plainToHtml(value);
}

// The gallery pictures and stickers a description refers to.
export function descriptionPictureIds(value) {
  const cleaned = cleanRichTree(parse(storedHtml(value)), ADAPTER, { mode: 'store' });
  return { galleryIds: cleaned.galleryIds, stickerIds: cleaned.stickerIds };
}

// A description as a page shows it: each picture reference turned into this
// site's own address, from row.description_pictures (description-pictures.js
// withDescriptionPictures: { gallery, stickers }, each a Map of id to
// { src, width, height, video }). A picture that is no longer there, or a
// row without them, leaves the picture out. '' for none.
export function displayDescription(row, value) {
  const html = storedHtml(value);
  if (!html) {
    return '';
  }
  let pictures = { gallery: new Map(), stickers: new Map() };
  if (row.description_pictures) {
    pictures = row.description_pictures;
  }
  const resolve = (kind, id) => {
    let found;
    if (kind === 'gallery') {
      found = pictures.gallery.get(id);
    } else {
      found = pictures.stickers.get(id);
    }
    if (!found) {
      return null;
    }
    return found;
  };
  return cleanRichTree(parse(html), ADAPTER, { mode: 'display', resolve }).html;
}

// The description as plain text: a line for each block.
export function descriptionText(value) {
  const html = storedHtml(value);
  if (!html) {
    return '';
  }
  const lines = [];
  let line = '';
  const walk = (node) => {
    if (node.type === 'text') {
      line += node.data;
      return;
    }
    if (node.type !== 'tag' && node.type !== 'root') {
      return;
    }
    const block = ['p', 'h2', 'h3', 'h4', 'li', 'blockquote', 'tr', 'hr'].includes(node.name);
    if (node.name === 'br') {
      lines.push(line);
      line = '';
      return;
    }
    for (const child of ADAPTER.children(node)) {
      walk(child);
    }
    if (block) {
      lines.push(line);
      line = '';
    }
  };
  walk(parse(html));
  lines.push(line);
  return lines.map((each) => each.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
