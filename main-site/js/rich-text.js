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
const CODE_TAGS = new Set(['code', 'kbd', 'samp', 'tt']);
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

// A plain-text description (one from before descriptions were rich, or sent
// by something other than the editor) as rich text: its markdown read as
// formatting (markdownToHtml: headings, lists, quotes, **bold**, *italic*,
// [links](https://...) and bare web addresses as links), and a "<br>"
// typed into it as the line break it was meant to be. Markdown's # heading
// is the editor's Heading 1 (h2), ## Heading 2, ### Heading 3.
const TYPED_BREAK = /<br\s*\/?>/gi;

// Plain text with each "<br>" typed into it (as a message copied from
// Telegram can have) made the line break it was meant to be.
export function typedBreaksToLines(text) {
  return String(text).replace(TYPED_BREAK, '\n');
}

export function plainDescriptionToHtml(text) {
  const source = typedBreaksToLines(text);
  const marked = markdownToHtml(source);
  if (!marked) {
    return plainToHtml(source);
  }
  return marked.replace(/<(\/?)h([1-3])>/g, (whole, slash, level) => `<${slash}h${Number(level) + 1}>`);
}

// Whether a description is rich text (HTML) rather than plain text: it
// starts with an element a description or the editor writes. Plain text
// that merely contains a "<" is read as text.
const RICH_START = /^\s*<(p|h[1-6]|ul|ol|li|blockquote|table|hr|div|span|strong|b|em|i|u|s|br|img|a|meta|section|pre|figure|font|html|body)[\s>/]/i;
export function looksRich(value) {
  return RICH_START.test(String(value));
}

// ---------------------------------------------------------------------------
// Pastes from chat apps: Discord and Telegram
//
// What each puts on the clipboard:
//   - Discord and Telegram Web, a selection copied: HTML in the app's own
//     markup, with the browser's copy of its theme on it (light grey text
//     on dark grey, in the app's font), emoji as pictures with the emoji as
//     their alt text, and a message's line breaks as newlines in text that
//     keeps its white space (white-space: pre-wrap);
//   - Discord's "Copy Text": the message's markdown, as plain text;
//   - Telegram Desktop: plain text only (its formatting stays inside
//     Telegram), a link written out as "text (address)".
// So, when pasting: HTML from a chat app loses the theme's colours, fonts
// and sizes (neither app lets a message choose them) but keeps its bold,
// italic, underline, strikethrough, code, links, quotes, lists and
// headings; emoji pictures from anywhere go in as the emoji themselves (or
// a custom emoji as its :name:), not as gallery pictures; avatars are left
// out; and plain text with markdown in it (markdownToHtml) is read as
// formatting, with web addresses turned into links.
// ---------------------------------------------------------------------------

const DISCORD_MARKS = /\bsrc="https?:\/\/(?:[\w-]+\.)*discord(?:app)?\.(?:com|net)\/|\bclass="[^"]*\b(?:markup|messageContent|blockquoteContainer|inlineCode|codeContainer|emojiContainer|spoilerContent|messageListItem)[_-]|gg (?:sans|mono)/i;
const TELEGRAM_MARKS = /\bsrc="https?:\/\/web\.telegram\.org\/|data-entity-type="?MessageEntity|\bclass="[^"]*\b(?:text-entity-\w+|translatable-message|spoilers-container|custom-emoji)\b/i;

// Which chat app pasted HTML was copied from: 'discord', 'telegram' or ''.
export function pasteSource(html) {
  const text = String(html).slice(0, MAX_HTML * 10);
  if (DISCORD_MARKS.test(text)) {
    return 'discord';
  }
  if (TELEGRAM_MARKS.test(text)) {
    return 'telegram';
  }
  return '';
}

// Text that is only emoji: every character part of one, and at least one
// that is a picture (not just a digit or a #).
const EMOJI_CHARACTERS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|⃣)+$/u;
const EMOJI_PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

function emojiOnly(text) {
  if (!EMOJI_CHARACTERS.test(text)) {
    return false;
  }
  return EMOJI_PICTURE.test(text);
}

const MARKDOWN_MAX = 50000;
const MARKDOWN_LINE_MAX = 4000;
const MARKDOWN_DEPTH = 8;
const FENCE_LINE = /^\s*```/;
const HEADING_LINE = /^(#{1,3}) +(\S.*)$/;
const SUBTEXT_LINE = /^-# +(\S.*)$/;
const QUOTE_LINE = /^> |^>$/;
const QUOTE_REST = /^>>> ?(.*)$/;
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)]) +(\S.*)$/;
// Longest first, so *** is not read as ** and *.
const MARKDOWN_PAIRS = [
  ['***', '<strong><em>', '</em></strong>'],
  ['___', '<u><em>', '</em></u>'],
  ['**', '<strong>', '</strong>'],
  ['__', '<u>', '</u>'],
  ['~~', '<s>', '</s>'],
  // A spoiler: shown as its text.
  ['||', '', ''],
  ['*', '<em>', '</em>'],
  ['_', '<em>', '</em>'],
];
const MARKDOWN_ESCAPABLE = '\\*_~`|[]()<>#-.!:';
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const BARE_ADDRESS = /https?:\/\/[^\s<>]+/iy;
const MASKED_LINK = /\[([^[\]\n]+)\]\(<?(https?:\/\/[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*)>?\)/iy;
const ANGLE_ADDRESS = /<(https?:\/\/[^\s<>]+)>/iy;
// Discord's own: a custom emoji, and a timestamp (shown in the reader's
// time).
const CUSTOM_EMOJI = /<a?:(\w{2,32}):\d{5,25}>/y;
const TIMESTAMP = /<t:(-?\d{1,13})(?::[tTdDfFR])?>/y;

// Plain text with Discord's markdown (which Telegram's mostly shares) as
// HTML for the paste cleaner: # headings, > and >>> quotes, - and 1. lists,
// ``` code blocks, **bold**, *italic* or _italic_, __underline__,
// ~~strikethrough~~, `code`, ||spoilers||, [masked](https://links) and bare
// web addresses as links. Text with none of that gives null (it is pasted
// as plain text, as it always was).
export function markdownToHtml(text) {
  const source = String(text).replace(/\r\n?/g, '\n');
  if (source.length > MARKDOWN_MAX) {
    return null;
  }
  const html = markdownBlocks(source.split('\n'), false);
  if (html === plainToHtml(source)) {
    return null;
  }
  return html;
}

function markdownBlocks(lines, inQuote) {
  let html = '';
  let paragraph = [];
  const flush = () => {
    if (paragraph.join('').trim() !== '') {
      html += `<p>${paragraph.map(markdownInline).join('<br>')}</p>`;
    }
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') {
      flush();
      continue;
    }
    if (FENCE_LINE.test(line)) {
      const fenced = codeFence(lines, index);
      if (fenced) {
        flush();
        html += fenced.html;
        index = fenced.end;
        if (fenced.rest) {
          paragraph.push(fenced.rest);
        }
        continue;
      }
    }
    let match = HEADING_LINE.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      html += `<h${level}>${markdownInline(match[2])}</h${level}>`;
      continue;
    }
    match = SUBTEXT_LINE.exec(line);
    if (match) {
      paragraph.push(match[1]);
      continue;
    }
    if (!inQuote) {
      match = QUOTE_REST.exec(line);
      if (match) {
        flush();
        const inner = markdownBlocks([match[1], ...lines.slice(index + 1)], true);
        if (inner) {
          html += `<blockquote>${inner}</blockquote>`;
        }
        break;
      }
      if (QUOTE_LINE.test(line)) {
        flush();
        const quoted = [];
        while (index < lines.length && QUOTE_LINE.test(lines[index])) {
          quoted.push(lines[index].replace(/^> ?/, ''));
          index += 1;
        }
        index -= 1;
        const inner = markdownBlocks(quoted, true);
        if (inner) {
          html += `<blockquote>${inner}</blockquote>`;
        }
        continue;
      }
    }
    if (LIST_LINE.test(line)) {
      flush();
      const items = [];
      while (index < lines.length) {
        const item = LIST_LINE.exec(lines[index]);
        if (!item) {
          break;
        }
        items.push({
          indent: item[1].replace(/\t/g, '    ').length,
          ordered: /\d/.test(item[2]),
          number: parseInt(item[2], 10),
          text: item[3],
        });
        index += 1;
      }
      index -= 1;
      html += markdownList(items);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return html;
}

// A ``` code block starting on lines[start]: { html, end (its last line),
// rest (text after the closing ```) }, or null when it is never closed.
function codeFence(lines, start) {
  const opening = lines[start].replace(/^\s*```/, '');
  const closesHere = opening.indexOf('```');
  if (closesHere >= 0) {
    return { html: codeBlock([opening.slice(0, closesHere)]), end: start, rest: opening.slice(closesHere + 3).trim() };
  }
  const code = [];
  // ```js names the language; the code starts on the next line.
  if (!/^[\w+#.-]*$/.test(opening.trim())) {
    code.push(opening);
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const close = lines[index].indexOf('```');
    if (close >= 0) {
      code.push(lines[index].slice(0, close));
      return { html: codeBlock(code), end: index, rest: lines[index].slice(close + 3).trim() };
    }
    code.push(lines[index]);
  }
  return null;
}

function codeBlock(code) {
  const lines = [...code];
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return '';
  }
  return `<pre><code>${escapeText(lines.join('\n'))}</code></pre>`;
}

// Markdown list lines as lists, nested by their indent.
function markdownList(items) {
  let html = '';
  const open = [];
  for (const item of items) {
    let tag = 'ul';
    if (item.ordered) {
      tag = 'ol';
    }
    let start = '';
    if (tag === 'ol' && item.number > 1 && item.number < 100000) {
      start = ` start="${item.number}"`;
    }
    const text = markdownInline(item.text);
    while (open.length > 0 && item.indent < open[open.length - 1].indent) {
      html += `</li></${open.pop().tag}>`;
    }
    const top = open[open.length - 1];
    if (!top || item.indent > top.indent) {
      html += `<${tag}${start}><li>${text}`;
      open.push({ indent: item.indent, tag });
    } else if (top.tag !== tag) {
      html += `</li></${open.pop().tag}><${tag}${start}><li>${text}`;
      open.push({ indent: item.indent, tag });
    } else {
      html += `</li><li>${text}`;
    }
  }
  while (open.length > 0) {
    html += `</li></${open.pop().tag}>`;
  }
  return html;
}

function markdownInline(line) {
  if (line.length > MARKDOWN_LINE_MAX) {
    return escapeText(line);
  }
  return markdownSpan(line, 0);
}

// A web address found in text, without the punctuation after it (the full
// stop ending a sentence, the bracket around it, the ** of bold around it).
function trimAddress(address) {
  let trimmed = address;
  for (;;) {
    const last = trimmed[trimmed.length - 1];
    if ('.,;:!?\'"*_~|'.includes(last)) {
      trimmed = trimmed.slice(0, -1);
    } else if (last === ')' && (trimmed.match(/\(/g) || []).length < (trimmed.match(/\)/g) || []).length) {
      trimmed = trimmed.slice(0, -1);
    } else {
      return trimmed;
    }
  }
}

function markdownLink(address, label) {
  return `<a href="${escapeAttribute(address)}">${label}</a>`;
}

// Where the mark closing one opened at start is, or -1.
function closingMark(text, start, mark) {
  const from = start + mark.length;
  let single = false;
  if (mark === '*' || mark === '_') {
    single = true;
  }
  if (from >= text.length || /\s/.test(text[from])) {
    return -1;
  }
  // A single * or _ inside a word (2*3*4, snake_case_name) is not italic.
  if (single && start > 0 && LETTER_OR_DIGIT.test(text[start - 1])) {
    return -1;
  }
  let at = text.indexOf(mark, from + 1);
  while (at >= 0) {
    let fits = !/\s/.test(text[at - 1]);
    if (single) {
      const after = text[at + 1];
      if (text[at - 1] === mark || after === mark || (after !== undefined && LETTER_OR_DIGIT.test(after))) {
        fits = false;
      }
    }
    if (fits) {
      return at;
    }
    at = text.indexOf(mark, at + 1);
  }
  return -1;
}

function stickyMatch(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

function markdownSpan(text, depth) {
  if (depth > MARKDOWN_DEPTH) {
    return escapeText(text);
  }
  let html = '';
  let plain = '';
  const emit = (piece) => {
    html += escapeText(plain) + piece;
    plain = '';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length && MARKDOWN_ESCAPABLE.includes(text[index + 1])) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      const run = /`+/y;
      run.lastIndex = index;
      const ticks = run.exec(text)[0];
      const close = text.indexOf(ticks, index + ticks.length);
      if (close > index + ticks.length) {
        let code = text.slice(index + ticks.length, close);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) {
          code = code.slice(1, -1);
        }
        emit(`<code>${escapeText(code)}</code>`);
        index = close + ticks.length;
      } else {
        plain += ticks;
        index += ticks.length;
      }
      continue;
    }
    if (char === '[') {
      const link = stickyMatch(MASKED_LINK, text, index);
      if (link) {
        emit(markdownLink(link[2], markdownSpan(link[1], depth + 1)));
        index += link[0].length;
        continue;
      }
    }
    if (char === '<') {
      const angle = stickyMatch(ANGLE_ADDRESS, text, index);
      if (angle) {
        emit(markdownLink(angle[1], escapeText(angle[1])));
        index += angle[0].length;
        continue;
      }
      const custom = stickyMatch(CUSTOM_EMOJI, text, index);
      if (custom) {
        plain += `:${custom[1]}:`;
        index += custom[0].length;
        continue;
      }
      const time = stickyMatch(TIMESTAMP, text, index);
      if (time) {
        const when = new Date(Number(time[1]) * 1000);
        if (Number.isNaN(when.getTime())) {
          plain += time[0];
        } else {
          plain += when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        }
        index += time[0].length;
        continue;
      }
    }
    if ((char === 'h' || char === 'H') && (index === 0 || !LETTER_OR_DIGIT.test(text[index - 1]))) {
      const bare = stickyMatch(BARE_ADDRESS, text, index);
      if (bare) {
        const address = trimAddress(bare[0]);
        if (/^https?:\/\/[^/?#]+/i.test(address)) {
          emit(markdownLink(address, escapeText(address)));
          index += address.length;
          continue;
        }
      }
    }
    if ('*_~|'.includes(char)) {
      let matched = false;
      for (const [mark, open, close] of MARKDOWN_PAIRS) {
        if (!text.startsWith(mark, index)) {
          continue;
        }
        const end = closingMark(text, index, mark);
        if (end > 0) {
          emit(`${open}${markdownSpan(text.slice(index + mark.length, end), depth + 1)}${close}`);
          index = end + mark.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // The whole run of marks is text: none of them opens anything.
        let end = index;
        while (text[end] === char) {
          end += 1;
        }
        plain += text.slice(index, end);
        index = end;
      }
      continue;
    }
    plain += char;
    index += 1;
  }
  return html + escapeText(plain);
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

// Whether text in colour on background (both #rrggbb) is a dark theme's:
// light grey on dark grey.
function darkTheme(colour, background) {
  const text = parseColour(colour);
  const behind = parseColour(background);
  if (!text || !behind) {
    return false;
  }
  if (colourfulness(text) >= 0.15 || lightness(text) <= 0.3) {
    return false;
  }
  if (colourfulness(behind) >= 0.15) {
    return false;
  }
  return lightness(behind) < 0.1;
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
  } else if (CODE_TAGS.has(tag)) {
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
  // A paste from a chat app (pasteSource), whose colours, fonts and sizes
  // are its theme.
  let chat = '';
  if (mode === 'paste' && (options.source === 'discord' || options.source === 'telegram')) {
    chat = options.source;
  }

  // An element's inline formats and span (inlineFormats), as this paste
  // keeps them.
  function formatsOf(tag, node) {
    const found = inlineFormats(tag, node, adapter);
    if (mode !== 'paste') {
      return found;
    }
    if (chat) {
      // Only code keeps a font of its own: monospace.
      const span = {};
      if (CODE_TAGS.has(tag)) {
        span.font = 'monospace';
      }
      return { formats: found.formats, span };
    }
    // A copy from any dark-themed page: light grey text on a dark grey
    // background is the page's theme, not a highlight.
    const { span } = found;
    if (span.colour && span.background && parseStyle(adapter.attr(node, 'style')).color && darkTheme(span.colour, span.background)) {
      delete span.colour;
      delete span.background;
    }
    return found;
  }

  // Whether an element keeps its text's newlines (white-space: pre and
  // the like), as Discord's and Telegram's messages do.
  function keepsNewlines(node) {
    if (mode !== 'paste') {
      return false;
    }
    const value = parseStyle(adapter.attr(node, 'style'))['white-space'];
    if (!value) {
      return false;
    }
    return /^(pre|pre-wrap|pre-line|break-spaces)$/i.test(value.trim());
  }

  // An emoji drawn as a picture (Discord's, Telegram Web's, Slack's...) as
  // the emoji itself, or a custom one as its :name:; null for a picture.
  function emojiText(element) {
    if (mode !== 'paste') {
      return null;
    }
    const alt = attrText(adapter, element, 'alt').trim();
    if (!alt || alt.length > 64) {
      return null;
    }
    if (emojiOnly(alt)) {
      return alt;
    }
    // A custom emoji, marked as an emoji by its class.
    if (/^:[\w~-]{1,40}:$/.test(alt) && /emoji/i.test(attrText(adapter, element, 'class'))) {
      return alt;
    }
    return null;
  }

  // A chat app's pictures that are not the message's own: avatars, role
  // icons, badges.
  function chatChrome(element) {
    if (!chat) {
      return false;
    }
    if (/avatar/i.test(attrText(adapter, element, 'class'))) {
      return true;
    }
    return /\/(?:avatars|role-icons|clan-badges|guild-tag-badges|avatar-decoration-presets|app-icons)\//i.test(attrText(adapter, element, 'src'));
  }

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
        return text.replace(/\r\n?/g, '\n').split('\n').map(escapeText).join('<br>');
      }
      text = text.replace(/[\t\n\r\f ]+/g, ' ');
      stats.textLength += text.trim().length;
      // A "<br>" typed as text (a plain description once kept it so, and
      // an editor that loaded one saved it so) is the line break meant.
      return text.split(TYPED_BREAK).map(escapeText).join('<br>');
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
    if (tag === 'img') {
      const emoji = emojiText(node);
      if (emoji !== null) {
        stats.textLength += emoji.length;
        return escapeText(emoji);
      }
      if (chatChrome(node)) {
        return '';
      }
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
      if (tag === 'pre' || keepsNewlines(node)) {
        preformatted = true;
      }
      const content = inline(adapter.children(node), active, depth + 1, preformatted);
      if (content === '') {
        return '';
      }
      return `${content}<br>`;
    }
    const { formats, span } = formatsOf(tag, node);
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
    let preformatted = inPre;
    if (keepsNewlines(node)) {
      preformatted = true;
    }
    const content = inline(adapter.children(node), now, depth + 1, preformatted);
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
    // Discord's message header (who wrote it, and when) is an <h3>: a
    // paragraph, not a heading.
    let chatHeader = false;
    if (chat === 'discord' && /(^|\s)header[-_]/.test(attrText(adapter, node, 'class'))) {
      chatHeader = true;
    }
    if (HEADINGS.has(tag) && !chatHeader) {
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
    const { span } = formatsOf(tag, node);
    let preformatted = inPre;
    if (keepsNewlines(node)) {
      preformatted = true;
    }
    let content = inline(adapter.children(node), {}, depth + 1, preformatted).replace(/^\s+|\s+$/g, '').replace(/(<br>)+$/, '');
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
          content += inlineNode(child, {}, depth + 1, keepsNewlines(item));
        }
      }
      content = content.replace(/^\s+|\s+$/g, '').replace(/(<br>)+$/, '');
      const { span } = formatsOf(itemTag, item);
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
