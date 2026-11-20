// Rich text for event descriptions: the one set of rules for what a
// description may hold, used in the browser (pasting into the editor,
// showing a description) and on the server (api/_lib/rich-text.js, which
// cleans every description before it is stored). Nothing here touches the
// DOM or Node directly: the caller hands in a tree and an adapter that reads
// it (a browser DOM, or htmlparser2's), and gets back HTML built here, every
// text and attribute escaped, holding only what is listed below.
//
// What a description can hold, Word-like:
//   - blocks: paragraphs, three heading levels (h2, h3, h4: the page's own
//     title is the h1), quotes, bulleted and numbered lists (nested),
//     tables, horizontal lines; each may be aligned and indented;
//   - inline: bold, italic, underline, strikethrough, subscript,
//     superscript, links, line breaks, and spans with a colour, a highlight,
//     a font and a size;
//   - pictures: one of the event's gallery pictures, or a Telegram sticker
//     from the editor's sticker packs, stored only as a reference
//     (data-gallery-id, data-sticker-id) and turned into an address when a
//     page asks for the description.
//
// Pasted text keeps its formatting: Word's and Google Docs' markup is mapped
// onto the list above (font-weight 700 becomes bold, Word's numbered
// paragraphs become real lists, and so on). So that a description stays
// readable in dark mode, a near-black text colour (Word's "Automatic") and a
// near-white highlight are left out: that text follows the site's theme.
// Colours chosen on purpose are kept as they are.
//
// Modes (options.mode):
//   'store'    what is saved: pictures as references only (server);
//   'display'  what a page gets: references turned into addresses with
//              options.resolve(kind, id) (server);
//   'render'   showing a description the server sent, or the editor's own
//              content: only pictures from this site's own addresses (browser);
//   'paste'    pasting into the editor: as 'render', plus pictures from
//              elsewhere kept as data-pending-src placeholders for the
//              editor to copy into the gallery (browser).

export const MAX_TEXT = 20000;
export const MAX_HTML = 100000;
export const MAX_PICTURES = 100;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 30;
const MAX_DEPTH = 40;
const MAX_INDENT_EM = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The only picture addresses a description shows (api/events/gallery-image.js,
// api/stickers/image.js).
const PICTURE_PREFIXES = ['/api/events/gallery-image?', '/api/stickers/image?'];

// Elements left out together with everything inside them.
const DROPPED = new Set([
  'script', 'style', 'template', 'head', 'title', 'noscript', 'svg', 'math', 'iframe', 'object', 'embed',
  'textarea', 'select', 'option', 'button', 'input', 'meta', 'link', 'base', 'frame', 'frameset', 'canvas',
  'audio', 'source', 'track', 'map', 'area', 'colgroup', 'col', 'caption', 'xml',
]);
// Elements that hold a block of text, or other blocks.
const BLOCKISH = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'address',
  'figure', 'figcaption', 'dd', 'dt', 'dl', 'form', 'fieldset', 'details', 'summary', 'legend', 'body', 'html',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Elements that start a new block wherever they are.
const BLOCK_LEVEL = new Set([...BLOCKISH, ...HEADINGS, 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'hr', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot']);

// The heading a description keeps for each heading level. A paste from
// elsewhere moves every level down one (its h1, the document title, is the
// description's first level, h2).
const STORED_HEADING = { h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4' };
const PASTED_HEADING = { h1: 'h2', h2: 'h3', h3: 'h4', h4: 'h4', h5: 'h4', h6: 'h4' };

// CSS named colours Word and other editors use.
const NAMED_COLOURS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', teal: '#008080', navy: '#000080',
  fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', windowtext: '#000000',
  darkred: '#8b0000', darkblue: '#00008b', darkgreen: '#006400', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', indigo: '#4b0082', violet: '#ee82ee', crimson: '#dc143c',
};
// <font size="1".."7"> in pixels.
const FONT_TAG_SIZES = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
const SIZE_KEYWORDS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const SERIF_FONTS = /times|georgia|cambria|garamond|serif|palatino|book antiqua|baskerville|didot/i;
const MONO_FONTS = /courier|consolas|mono|menlo|lucida console/i;

export function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Crops of inline pictures
//
// A gallery picture in a description can be cropped where it is shown (the
// gallery keeps the whole picture): data-crop="x,y,width,height", each a
// fraction of the whole picture, four decimals. The page loads the cropped
// part from api/events/gallery-image.js with the same crop.
// ---------------------------------------------------------------------------

const CROP_TEXT = /^(0(\.\d{1,4})?|1(\.0{1,4})?)(,(0(\.\d{1,4})?|1(\.0{1,4})?)){3}$/;
export const MIN_CROP = 0.02;

// { x, y, width, height } from a crop's text, or null for one that is not a
// crop inside the picture.
export function parseCrop(text) {
  const value = String(text).trim();
  if (!CROP_TEXT.test(value)) {
    return null;
  }
  const [left, top, width, height] = value.split(',').map(Number);
  if (width < MIN_CROP || height < MIN_CROP || left + width > 1.0001 || top + height > 1.0001) {
    return null;
  }
  return { x: left, y: top, width, height };
}

// A crop's text, or '' for none (no crop, or one that keeps the whole
// picture).
export function cropText(crop) {
  if (!crop) {
    return '';
  }
  const parts = [crop.x, crop.y, crop.width, crop.height].map((value) => clamp(value, 0, 1));
  if (parts[0] < 0.0005 && parts[1] < 0.0005 && parts[2] > 0.9995 && parts[3] > 0.9995) {
    return '';
  }
  const text = parts.map((value) => value.toFixed(4).replace(/\.?0+$/, '')).join(',');
  if (!parseCrop(text)) {
    return '';
  }
  return text;
}

// The sizes a gallery picture can be shown at in a description, as a share
// of the text's width (style.css); none is its own size, up to the full
// width.
export const PICTURE_SIZES = ['small', 'medium', 'large', 'full'];

// A gallery picture's address for a crop (its text), without any crop it
// had: the whole picture for ''.
export function croppedAddress(address, text) {
  const whole = String(address).replace(/&crop=[^&]*/g, '');
  if (!text) {
    return whole;
  }
  return `${whole}&crop=${encodeURIComponent(text)}`;
}

// A plain-text description (from before descriptions were rich) as rich
// text: a paragraph for each run of lines, a line break for each line.
export function plainToHtml(text) {
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return paragraphs
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph) => `<p>${paragraph.split('\n').map(escapeText).join('<br>')}</p>`)
    .join('');
}

// Whether a description is rich text (HTML) rather than plain text: it
// starts with an element a description or the editor writes. Plain text
// that merely contains a "<" is read as text.
const RICH_START = /^\s*<(p|h[1-6]|ul|ol|li|blockquote|table|hr|div|span|strong|b|em|i|u|s|br|img|a|meta|section|pre|figure|font|html|body)[\s>/]/i;
export function looksRich(value) {
  return RICH_START.test(String(value));
}

// An attribute's value as a string, '' when it is not there.
function attrText(adapter, node, name) {
  const value = adapter.attr(node, name);
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// Whether a node is an element with this tag.
function isElement(adapter, node, tag) {
  if (adapter.type(node) !== 'element') {
    return false;
  }
  return adapter.tag(node) === tag;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// ---------------------------------------------------------------------------
// Colours, sizes and fonts
// ---------------------------------------------------------------------------

function hexPair(number) {
  return clamp(Math.round(number), 0, 255).toString(16).padStart(2, '0');
}

// A CSS colour as { red, green, blue } (0-255), or null for one that is not
// a solid colour this understands (transparent, a variable, a gradient).
function parseColour(value) {
  let text = String(value).trim().toLowerCase();
  if (NAMED_COLOURS[text]) {
    text = NAMED_COLOURS[text];
  }
  let match = /^#([0-9a-f]{3})$/.exec(text);
  if (match) {
    const [red, green, blue] = match[1].split('').map((digit) => parseInt(digit + digit, 16));
    return { red, green, blue };
  }
  match = /^#([0-9a-f]{6})$/.exec(text);
  if (match) {
    return { red: parseInt(match[1].slice(0, 2), 16), green: parseInt(match[1].slice(2, 4), 16), blue: parseInt(match[1].slice(4), 16) };
  }
  match = /^rgba?\(\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (match) {
    if (match[4] !== undefined) {
      let alpha = parseFloat(match[4]);
      if (match[4].endsWith('%')) {
        alpha /= 100;
      }
      if (alpha < 0.5) {
        return null;
      }
    }
    return { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]) };
  }
  return null;
}

// How light a colour is, 0 (black) to 1 (white), and how colourful.
function lightness(colour) {
  const channel = (value) => {
    const scaled = value / 255;
    if (scaled <= 0.03928) {
      return scaled / 12.92;
    }
    return ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour.red) + 0.7152 * channel(colour.green) + 0.0722 * channel(colour.blue);
}

function colourfulness(colour) {
  return (Math.max(colour.red, colour.green, colour.blue) - Math.min(colour.red, colour.green, colour.blue)) / 255;
}

function hex(colour) {
  return `#${hexPair(colour.red)}${hexPair(colour.green)}${hexPair(colour.blue)}`;
}

// A text colour to keep, as #rrggbb, or '' to follow the theme: near-black
// greys (Word's "Automatic") are left out so text stays readable in dark
// mode.
function textColour(value) {
  const colour = parseColour(value);
  if (!colour) {
    return '';
  }
  if (colourfulness(colour) < 0.12 && lightness(colour) < 0.07) {
    return '';
  }
  return hex(colour);
}

// A highlight to keep, or '' for none: white and near-white page
// backgrounds are left out, for the same reason.
function highlightColour(value) {
  const colour = parseColour(value);
  if (!colour) {
    return '';
  }
  if (colourfulness(colour) < 0.08 && lightness(colour) > 0.8) {
    return '';
  }
  return hex(colour);
}

// Text that can be read on a highlight colour (#rrggbb).
export function readableOn(background) {
  const colour = parseColour(background);
  if (!colour || lightness(colour) > 0.35) {
    return '#111111';
  }
  return '#f5f5f5';
}

// A font size in whole pixels (6 to 128), or 0 for one this does not take.
function fontSizePixels(value) {
  const text = String(value).trim().toLowerCase();
  if (SIZE_KEYWORDS[text]) {
    return SIZE_KEYWORDS[text];
  }
  const match = /^([\d.]+)(px|pt|em|rem|%)$/.exec(text);
  if (!match) {
    return 0;
  }
  let pixels = parseFloat(match[1]);
  if (match[2] === 'pt') {
    pixels = (pixels * 4) / 3;
  } else if (match[2] === 'em' || match[2] === 'rem') {
    pixels *= 16;
  } else if (match[2] === '%') {
    pixels = (pixels * 16) / 100;
  }
  if (!Number.isFinite(pixels) || pixels <= 0) {
    return 0;
  }
  return clamp(Math.round(pixels), 6, 128);
}

// A font list to keep (at most three named fonts, then a generic family so
// a reader without them gets the same kind of face, then the emoji fonts),
// or ''.
function fontFamily(value) {
  const names = [];
  for (const part of String(value).split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '').trim();
    if (!/^[A-Za-z0-9 _-]{1,40}$/.test(name)) {
      continue;
    }
    const lower = name.toLowerCase();
    if (['serif', 'sans-serif', 'monospace', 'cursive', 'system-ui', 'inherit', 'initial', 'symbol'].includes(lower) || lower.startsWith('ms ') || lower.startsWith('mso')) {
      continue;
    }
    names.push(name);
    if (names.length === 3) {
      break;
    }
  }
  if (names.length === 0) {
    return '';
  }
  let generic = 'sans-serif';
  if (MONO_FONTS.test(names[0])) {
    generic = 'monospace';
  } else if (SERIF_FONTS.test(names[0]) && !/sans/i.test(names[0])) {
    generic = 'serif';
  }
  // Then the emoji fonts (style.css --emoji-fonts), so an emoji in this
  // text still shows, up to the latest edition, whatever the font.
  return `${names.map((name) => `"${name}"`).join(', ')}, ${generic}, var(--emoji-fonts)`;
}

// An indent in em (steps of half an em, at most MAX_INDENT_EM), or 0.
function indentEm(value) {
  const match = /^(-?[\d.]+)(px|pt|em|rem|cm|mm|in)$/.exec(String(value).trim().toLowerCase());
  if (!match) {
    return 0;
  }
  const amount = parseFloat(match[1]);
  const perEm = { px: 16, pt: 12, em: 1, rem: 1, cm: 0.423, mm: 4.23, in: 0.1667 };
  const em = amount / perEm[match[2]];
  if (!Number.isFinite(em) || em < 0.5) {
    return 0;
  }
  return clamp(Math.round(em * 2) / 2, 0, MAX_INDENT_EM);
}

// The declarations of a style attribute, by property (lowercase), skipping
// any value that could load something or escape the declaration.
function parseStyle(text) {
  const style = {};
  if (!text) {
    return style;
  }
  for (const declaration of String(text).split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/!important/i, '').trim();
    if (!property || !value || /url\(|expression|javascript:|[\\<>{}]|\/\*/i.test(value)) {
      continue;
    }
    style[property] = value;
  }
  return style;
}

// What an element's own markup and style say about its text: the inline
// formatting it turns on, and the colours, font and size it sets.
function inlineFormats(tag, element, adapter) {
  const style = parseStyle(adapter.attr(element, 'style'));
  const formats = { strong: false, em: false, u: false, s: false, sub: false, sup: false };
  const span = {};
  if (tag === 'b' || tag === 'strong') {
    formats.strong = true;
  } else if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'dfn') {
    formats.em = true;
  } else if (tag === 'u' || tag === 'ins') {
    formats.u = true;
  } else if (tag === 's' || tag === 'strike' || tag === 'del') {
    formats.s = true;
  } else if (tag === 'sub') {
    formats.sub = true;
  } else if (tag === 'sup') {
    formats.sup = true;
  } else if (tag === 'mark') {
    span.background = '#ffff00';
  } else if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') {
    span.font = 'monospace';
  } else if (tag === 'font') {
    const colour = adapter.attr(element, 'color');
    if (colour) {
      span.colour = textColour(colour);
    }
    const face = adapter.attr(element, 'face');
    if (face) {
      span.font = fontFamily(face);
    }
    const size = Number(adapter.attr(element, 'size'));
    if (FONT_TAG_SIZES[size]) {
      span.size = FONT_TAG_SIZES[size];
    }
  }
  const weight = style['font-weight'];
  if (weight) {
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) {
      formats.strong = true;
    } else if (weight === 'normal' || weight === 'lighter' || Number(weight) <= 500) {
      // Google Docs wraps everything in <b style="font-weight:normal">.
      formats.strong = false;
    }
  }
  if (style['font-style'] === 'italic' || style['font-style'] === 'oblique') {
    formats.em = true;
  } else if (style['font-style'] === 'normal') {
    formats.em = false;
  }
  let decoration = '';
  for (const property of ['text-decoration', 'text-decoration-line']) {
    if (style[property]) {
      decoration += ` ${style[property]}`;
    }
  }
  if (decoration.includes('underline')) {
    formats.u = true;
  }
  if (decoration.includes('line-through')) {
    formats.s = true;
  }
  if (style['vertical-align'] === 'super') {
    formats.sup = true;
  } else if (style['vertical-align'] === 'sub') {
    formats.sub = true;
  }
  if (style.color) {
    span.colour = textColour(style.color);
  }
  let background = style['background-color'];
  if (!background && style.background && !/url|gradient/i.test(style.background)) {
    background = style.background.split(' ')[0];
  }
  if (background) {
    span.background = highlightColour(background);
  }
  if (style['mso-highlight']) {
    span.background = highlightColour(style['mso-highlight']);
  }
  if (style['font-family']) {
    span.font = fontFamily(style['font-family']);
  }
  // Highlighted text keeps a colour it can be read in on its highlight,
  // whichever theme the page is in: dark on a light highlight, light on a
  // dark one (an "Automatic" text colour would turn white on yellow in
  // dark mode).
  if (span.background && !span.colour) {
    span.colour = readableOn(span.background);
  }
  if (style['font-size']) {
    const size = fontSizePixels(style['font-size']);
    if (size) {
      span.size = size;
    }
  }
  return { formats, span };
}

// A span's style attribute text from its colours, font and size, or ''.
function spanStyle(span) {
  const parts = [];
  if (span.colour) {
    parts.push(`color: ${span.colour}`);
  }
  if (span.background) {
    parts.push(`background-color: ${span.background}`);
  }
  if (span.font) {
    parts.push(`font-family: ${span.font}`);
  }
  if (span.size) {
    parts.push(`font-size: ${span.size}px`);
  }
  return parts.join('; ');
}

// A block's alignment and indent, from its style and align attribute.
function blockLayout(element, adapter, inherited) {
  const style = parseStyle(adapter.attr(element, 'style'));
  let align = inherited.align;
  let alignValue = style['text-align'];
  if (!alignValue) {
    alignValue = adapter.attr(element, 'align');
  }
  if (alignValue) {
    const lower = String(alignValue).trim().toLowerCase();
    if (['left', 'right', 'center', 'justify'].includes(lower)) {
      align = lower;
    } else if (lower === 'start') {
      align = 'left';
    } else if (lower === 'end') {
      align = 'right';
    }
  }
  let indent = 0;
  for (const property of ['margin-left', 'padding-left', 'text-indent']) {
    if (style[property]) {
      indent = Math.max(indent, indentEm(style[property]));
    }
  }
  return { align, indent };
}

function layoutStyle(layout) {
  const parts = [];
  if (layout.align && layout.align !== 'left') {
    parts.push(`text-align: ${layout.align}`);
  }
  if (layout.indent) {
    parts.push(`margin-left: ${layout.indent}em`);
  }
  if (parts.length === 0) {
    return '';
  }
  return ` style="${parts.join('; ')}"`;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

// A Word "list paragraph": Word pastes its lists as paragraphs with a
// mso-list style and the bullet or number as text in a mso-list:Ignore span.
function wordListLevel(element, adapter) {
  const style = attrText(adapter, element, 'style');
  const match = /mso-list:\s*l\d+\s+level(\d+)/i.exec(style);
  if (match) {
    return Number(match[1]);
  }
  if (/MsoListParagraph/i.test(attrText(adapter, element, 'class'))) {
    return 1;
  }
  return 0;
}

function isWordMarker(element, adapter) {
  return /mso-list:\s*ignore/i.test(attrText(adapter, element, 'style'));
}

function textOf(node, adapter) {
  if (adapter.type(node) === 'text') {
    return adapter.text(node);
  }
  if (adapter.type(node) !== 'element') {
    return '';
  }
  return adapter.children(node).map((child) => textOf(child, adapter)).join('');
}

function findWordMarker(node, adapter) {
  if (adapter.type(node) !== 'element') {
    return null;
  }
  if (isWordMarker(node, adapter)) {
    return textOf(node, adapter);
  }
  for (const child of adapter.children(node)) {
    const found = findWordMarker(child, adapter);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

// Cleans the children of root into description HTML. adapter reads the
// tree: type(node) 'text' | 'element' | 'other', tag(node) (lowercase),
// attr(node, name) (string or null), children(node), text(node).
// Returns { html, textLength, pictures, galleryIds, stickerIds }.
export function cleanRichTree(root, adapter, options = {}) {
  let mode = 'store';
  if (options.mode) {
    mode = options.mode;
  }
  let headingMap = STORED_HEADING;
  if (mode === 'paste' && !options.ownCopy) {
    headingMap = PASTED_HEADING;
  }
  const stats = { textLength: 0, pictures: 0, galleryIds: new Set(), stickerIds: new Set() };

  // A picture, as this mode writes it, or ''.
  function picture(element, tag) {
    let galleryId = attrText(adapter, element, 'data-gallery-id');
    let stickerId = attrText(adapter, element, 'data-sticker-id');
    if (!UUID.test(galleryId)) {
      galleryId = '';
    }
    if (!UUID.test(stickerId)) {
      stickerId = '';
    }
    if (galleryId) {
      stickerId = '';
    }
    if (stats.pictures >= MAX_PICTURES) {
      return '';
    }
    // A gallery picture's own crop and size, when it has valid ones.
    let crop = '';
    if (galleryId && parseCrop(attrText(adapter, element, 'data-crop'))) {
      crop = cropText(parseCrop(attrText(adapter, element, 'data-crop')));
    }
    let size = '';
    if (galleryId && PICTURE_SIZES.includes(attrText(adapter, element, 'data-size'))) {
      size = attrText(adapter, element, 'data-size');
    }
    if (mode === 'store') {
      if (galleryId) {
        stats.pictures += 1;
        stats.galleryIds.add(galleryId.toLowerCase());
        let cropAttribute = '';
        if (crop) {
          cropAttribute = ` data-crop="${crop}"`;
        }
        if (size) {
          cropAttribute += ` data-size="${size}"`;
        }
        return `<img data-gallery-id="${galleryId.toLowerCase()}"${cropAttribute}>`;
      }
      if (stickerId) {
        stats.pictures += 1;
        stats.stickerIds.add(stickerId.toLowerCase());
        return `<img data-sticker-id="${stickerId.toLowerCase()}">`;
      }
      return '';
    }
    if (mode === 'display') {
      let kind = 'gallery';
      let id = galleryId;
      if (stickerId) {
        kind = 'sticker';
        id = stickerId;
      }
      if (!id || !options.resolve) {
        return '';
      }
      const found = options.resolve(kind, id.toLowerCase());
      if (!found || !found.src) {
        return '';
      }
      stats.pictures += 1;
      if (crop) {
        const part = parseCrop(crop);
        return pictureTag(kind, id.toLowerCase(), {
          src: croppedAddress(found.src, crop),
          width: Math.max(1, Math.round(found.width * part.width)),
          height: Math.max(1, Math.round(found.height * part.height)),
          crop,
          size,
        });
      }
      return pictureTag(kind, id.toLowerCase(), { ...found, size });
    }
    // 'render' and 'paste': pictures already on this site, as they are.
    let src = attrText(adapter, element, 'src');
    let still = attrText(adapter, element, 'data-still');
    let video = attrText(adapter, element, 'data-video');
    if (tag === 'video') {
      video = src;
      src = still;
    }
    const ownAddress = (address) => PICTURE_PREFIXES.some((prefix) => address.startsWith(prefix));
    if ((galleryId || stickerId) && ownAddress(src)) {
      if (!ownAddress(video)) {
        video = '';
      }
      let kind = 'gallery';
      let id = galleryId;
      if (stickerId) {
        kind = 'sticker';
        id = stickerId;
      }
      stats.pictures += 1;
      return pictureTag(kind, id.toLowerCase(), {
        src,
        video,
        width: Number(adapter.attr(element, 'width')),
        height: Number(adapter.attr(element, 'height')),
        crop,
        size,
      });
    }
    if (mode === 'paste' && tag === 'img') {
      if (/^https?:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(src)) {
        stats.pictures += 1;
        return `<img data-pending-src="${escapeAttribute(src)}" alt="">`;
      }
    }
    return '';
  }

  // Inline content of a list of nodes, under the formats already on.
  function inline(nodes, active, depth, inPre) {
    let html = '';
    for (const node of nodes) {
      html += inlineNode(node, active, depth, inPre);
    }
    return html;
  }

  function inlineNode(node, active, depth, inPre) {
    const type = adapter.type(node);
    if (type === 'text') {
      let text = adapter.text(node);
      if (inPre) {
        stats.textLength += text.length;
        return text.split('\n').map(escapeText).join('<br>');
      }
      text = text.replace(/[\t\n\r\f ]+/g, ' ');
      stats.textLength += text.trim().length;
      return escapeText(text);
    }
    if (type !== 'element' || depth > MAX_DEPTH) {
      return '';
    }
    const tag = adapter.tag(node);
    if (DROPPED.has(tag) && tag !== 'video') {
      return '';
    }
    if (isWordMarker(node, adapter)) {
      return '';
    }
    if (tag === 'br') {
      return '<br>';
    }
    if (tag === 'img' || tag === 'video') {
      return picture(node, tag);
    }
    if (tag === 'hr') {
      return '<br>';
    }
    // A block inside inline content (a <p> in a list item, a <div> in a
    // link): its content, on a line of its own.
    if (BLOCK_LEVEL.has(tag)) {
      let preformatted = inPre;
      if (tag === 'pre') {
        preformatted = true;
      }
      const content = inline(adapter.children(node), active, depth + 1, preformatted);
      if (content === '') {
        return '';
      }
      return `${content}<br>`;
    }
    const { formats, span } = inlineFormats(tag, node, adapter);
    let open = '';
    let close = '';
    const now = { ...active };
    for (const name of ['strong', 'em', 'u', 's', 'sub', 'sup']) {
      if (formats[name] && !active[name]) {
        open += `<${name}>`;
        close = `</${name}>${close}`;
        now[name] = true;
      }
    }
    const styleText = spanStyle(span);
    if (styleText) {
      open += `<span style="${escapeAttribute(styleText)}">`;
      close = `</span>${close}`;
    }
    if (tag === 'a') {
      const href = attrText(adapter, node, 'href').trim();
      if (/^(https?:\/\/|mailto:|tel:)/i.test(href) && href.length <= 2000 && !active.link) {
        let extra = '';
        if (mode === 'render' || mode === 'display') {
          extra = ' target="_blank" rel="noopener noreferrer nofollow"';
        }
        open = `<a href="${escapeAttribute(href)}"${extra}>${open}`;
        close = `${close}</a>`;
        now.link = true;
      }
    }
    const content = inline(adapter.children(node), now, depth + 1, inPre);
    if (content === '') {
      return '';
    }
    return `${open}${content}${close}`;
  }

  // Whether inline HTML shows anything: text, a picture or a line break.
  function hasContent(html) {
    if (/<(img|br)\b/.test(html)) {
      return true;
    }
    return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim() !== '';
  }

  // Whether an element has blocks (or Word list paragraphs) among its
  // children.
  function holdsBlocks(node) {
    return adapter.children(node).some((child) => {
      if (adapter.type(child) !== 'element') {
        return false;
      }
      if (BLOCK_LEVEL.has(adapter.tag(child))) {
        return true;
      }
      return wordListLevel(child, adapter) > 0;
    });
  }

  // Blocks for a list of nodes: runs of inline content become paragraphs.
  function flow(nodes, inherited, depth) {
    let html = '';
    let pending = [];
    const flush = () => {
      if (pending.length > 0) {
        const content = inline(pending, {}, depth + 1, false).replace(/^\s+|\s+$/g, '').replace(/(<br>)+$/, '');
        if (hasContent(content)) {
          html += `<p${layoutStyle(inherited)}>${content}</p>`;
        }
        pending = [];
      }
    };
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (adapter.type(node) !== 'element') {
        if (adapter.type(node) === 'text') {
          pending.push(node);
        }
        continue;
      }
      const tag = adapter.tag(node);
      if (wordListLevel(node, adapter) > 0) {
        flush();
        const run = [];
        while (index < nodes.length) {
          const each = nodes[index];
          if (adapter.type(each) === 'text' && adapter.text(each).trim() === '') {
            index += 1;
            continue;
          }
          if (adapter.type(each) !== 'element' || wordListLevel(each, adapter) === 0) {
            break;
          }
          run.push(each);
          index += 1;
        }
        index -= 1;
        html += wordList(run, depth);
        continue;
      }
      if (!BLOCK_LEVEL.has(tag) || DROPPED.has(tag)) {
        if (DROPPED.has(tag) && tag !== 'video') {
          continue;
        }
        // An inline element holding blocks (Google Docs wraps a whole paste
        // in <b style="font-weight:normal">): its blocks, as blocks.
        if (holdsBlocks(node)) {
          flush();
          html += flow(adapter.children(node), inherited, depth + 1);
          continue;
        }
        pending.push(node);
        continue;
      }
      flush();
      html += block(node, tag, inherited, depth + 1);
    }
    flush();
    return html;
  }

  function block(node, tag, inherited, depth) {
    if (depth > MAX_DEPTH) {
      return '';
    }
    const layout = blockLayout(node, adapter, inherited);
    if (tag === 'hr') {
      return '<hr>';
    }
    if (HEADINGS.has(tag)) {
      const content = blockInline(node, depth, false);
      if (!hasContent(content)) {
        return '';
      }
      const level = headingMap[tag];
      return `<${level}${layoutStyle(layout)}>${content}</${level}>`;
    }
    if (tag === 'blockquote') {
      const content = flow(adapter.children(node), { align: layout.align, indent: 0 }, depth);
      if (content === '') {
        return '';
      }
      return `<blockquote${layoutStyle({ align: '', indent: layout.indent })}>${content}</blockquote>`;
    }
    if (tag === 'ul' || tag === 'ol' || tag === 'li') {
      return list(node, tag, layout, depth);
    }
    if (tag === 'table' || tag === 'tbody' || tag === 'thead' || tag === 'tfoot' || tag === 'tr') {
      return table(node, depth);
    }
    if (tag === 'td' || tag === 'th') {
      return flow(adapter.children(node), layout, depth);
    }
    if (tag === 'pre') {
      const content = blockInline(node, depth, true);
      if (!hasContent(content)) {
        return '';
      }
      return `<p${layoutStyle(layout)}>${content}</p>`;
    }
    // A paragraph, or a container of blocks.
    const children = adapter.children(node);
    if (holdsBlocks(node)) {
      return flow(children, layout, depth);
    }
    const content = blockInline(node, depth, false);
    if (!hasContent(content)) {
      // An empty paragraph the editor made on purpose: a blank line.
      if (tag === 'p' && children.some((child) => isElement(adapter, child, 'br'))) {
        return '<p><br></p>';
      }
      return '';
    }
    return `<p${layoutStyle(layout)}>${content}</p>`;
  }

  // The inline content of a block, with the block's own text formatting
  // (a <p style="color:..."> or <h2 style="font-size:...">) kept on a span.
  function blockInline(node, depth, inPre) {
    const tag = adapter.tag(node);
    const { span } = inlineFormats(tag, node, adapter);
    let content = inline(adapter.children(node), {}, depth + 1, inPre).replace(/^\s+|\s+$/g, '').replace(/(<br>)+$/, '');
    const styleText = spanStyle(span);
    if (styleText && hasContent(content)) {
      content = `<span style="${escapeAttribute(styleText)}">${content}</span>`;
    }
    return content;
  }

  function list(node, tag, layout, depth) {
    let listTag = tag;
    let items = adapter.children(node);
    if (tag === 'li') {
      listTag = 'ul';
      items = [node];
    }
    let html = '';
    for (const item of items) {
      if (adapter.type(item) === 'text') {
        const text = adapter.text(item).trim();
        if (text) {
          stats.textLength += text.length;
          html += `<li>${escapeText(text)}</li>`;
        }
        continue;
      }
      if (adapter.type(item) !== 'element') {
        continue;
      }
      const itemTag = adapter.tag(item);
      if (itemTag === 'ul' || itemTag === 'ol') {
        // A nested list straight inside a list: it belongs to the item before.
        const nested = list(item, itemTag, { align: '', indent: 0 }, depth + 1);
        if (html.endsWith('</li>')) {
          html = `${html.slice(0, -5)}${nested}</li>`;
        } else {
          html += `<li>${nested}</li>`;
        }
        continue;
      }
      let content = '';
      let nestedLists = '';
      for (const child of adapter.children(item)) {
        if (adapter.type(child) === 'element' && (adapter.tag(child) === 'ul' || adapter.tag(child) === 'ol')) {
          nestedLists += list(child, adapter.tag(child), { align: '', indent: 0 }, depth + 1);
        } else {
          content += inlineNode(child, {}, depth + 1, false);
        }
      }
      content = content.replace(/^\s+|\s+$/g, '').replace(/(<br>)+$/, '');
      const { span } = inlineFormats(itemTag, item, adapter);
      const styleText = spanStyle(span);
      if (styleText && hasContent(content)) {
        content = `<span style="${escapeAttribute(styleText)}">${content}</span>`;
      }
      if (hasContent(content) || nestedLists) {
        html += `<li>${content}${nestedLists}</li>`;
      }
    }
    if (html === '') {
      return '';
    }
    let start = '';
    if (listTag === 'ol') {
      const startAt = Number(adapter.attr(node, 'start'));
      if (Number.isInteger(startAt) && startAt > 1 && startAt < 100000) {
        start = ` start="${startAt}"`;
      }
      const kind = attrText(adapter, node, 'type');
      if (['a', 'A', 'i', 'I'].includes(kind)) {
        start += ` type="${kind}"`;
      }
    }
    return `<${listTag}${start}${layoutStyle({ align: layout.align, indent: layout.indent })}>${html}</${listTag}>`;
  }

  // Word's list paragraphs as real, nested lists.
  function wordList(paragraphs, depth) {
    const items = paragraphs.map((paragraph) => {
      const marker = findWordMarker(paragraph, adapter);
      let ordered = false;
      if (marker !== null && /^\s*([0-9]+|[a-zA-Z]{1,3})[.)]/.test(marker.replace(/\u00a0/g, ' '))) {
        ordered = true;
      }
      const content = blockInline(paragraph, depth, false);
      return { level: wordListLevel(paragraph, adapter), ordered, content };
    });
    const lowest = Math.min(...items.map((item) => item.level));
    let html = '';
    const open = [];
    for (const item of items) {
      let level = item.level - lowest + 1;
      level = Math.min(level, open.length + 1);
      let tag = 'ul';
      if (item.ordered) {
        tag = 'ol';
      }
      if (level > open.length) {
        html += `<${tag}>`;
        open.push(tag);
        html += `<li>${item.content}`;
        continue;
      }
      while (open.length > level) {
        html += `</li></${open.pop()}>`;
      }
      html += `</li><li>${item.content}`;
    }
    while (open.length > 0) {
      html += `</li></${open.pop()}>`;
    }
    return html;
  }

  function table(node, depth) {
    const rows = [];
    const collect = (parent) => {
      for (const child of adapter.children(parent)) {
        if (adapter.type(child) !== 'element') {
          continue;
        }
        const tag = adapter.tag(child);
        if (tag === 'tr') {
          rows.push(child);
        } else if (tag === 'tbody' || tag === 'thead' || tag === 'tfoot') {
          collect(child);
        }
      }
    };
    if (adapter.tag(node) === 'tr') {
      rows.push(node);
    } else {
      collect(node);
    }
    let html = '';
    for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
      let cells = '';
      let count = 0;
      for (const cell of adapter.children(row)) {
        if (adapter.type(cell) !== 'element') {
          continue;
        }
        const tag = adapter.tag(cell);
        if (tag !== 'td' && tag !== 'th') {
          continue;
        }
        count += 1;
        if (count > MAX_TABLE_COLUMNS) {
          break;
        }
        let attributes = '';
        for (const name of ['colspan', 'rowspan']) {
          const value = Number(adapter.attr(cell, name));
          if (Number.isInteger(value) && value > 1 && value <= MAX_TABLE_COLUMNS) {
            attributes += ` ${name}="${value}"`;
          }
        }
        const style = parseStyle(adapter.attr(cell, 'style'));
        const parts = [];
        let background = style['background-color'];
        if (!background) {
          background = adapter.attr(cell, 'bgcolor');
        }
        if (background) {
          const colour = highlightColour(background);
          if (colour) {
            parts.push(`background-color: ${colour}`);
          }
        }
        if (parts.length > 0) {
          attributes += ` style="${parts.join('; ')}"`;
        }
        let content = flow(adapter.children(cell), blockLayout(cell, adapter, { align: '', indent: 0 }), depth + 1);
        if (content === '') {
          content = '<p><br></p>';
        }
        cells += `<${tag}${attributes}>${content}</${tag}>`;
      }
      if (cells) {
        html += `<tr>${cells}</tr>`;
      }
    }
    if (html === '') {
      return '';
    }
    return `<table><tbody>${html}</tbody></table>`;
  }

  // Leading and trailing blank lines go.
  const html = flow(adapter.children(root), { align: '', indent: 0 }, 0).replace(/^(<p><br><\/p>)+|(<p><br><\/p>)+$/g, '');
  return {
    html,
    textLength: stats.textLength,
    pictures: stats.pictures,
    galleryIds: [...stats.galleryIds],
    stickerIds: [...stats.stickerIds],
  };
}

// A picture as 'display', 'render' and 'paste' write it: a gallery picture
// in its own shape; a sticker as its still picture, with its video (a WebM
// video sticker) in data-video for the page to play where it can.
function pictureTag(kind, id, found) {
  let size = '';
  if (Number.isInteger(found.width) && found.width > 0 && Number.isInteger(found.height) && found.height > 0) {
    size = ` width="${found.width}" height="${found.height}"`;
  }
  if (kind === 'gallery') {
    let crop = '';
    if (found.crop) {
      crop = ` data-crop="${found.crop}"`;
    }
    if (found.size) {
      crop += ` data-size="${found.size}"`;
    }
    return `<img src="${escapeAttribute(found.src)}"${size} alt="" loading="lazy" data-gallery-id="${id}"${crop}>`;
  }
  let video = '';
  if (found.video) {
    video = ` data-video="${escapeAttribute(found.video)}"`;
  }
  return `<img class="rich-sticker" src="${escapeAttribute(found.src)}"${size} alt="" loading="lazy" data-sticker-id="${id}"${video}>`;
}
