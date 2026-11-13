// GFTV HelloEvents app icon. Flat, in the GFTV icon family (OneLink GFTV's
// OLG-*.png, gsl-*.png): a glyph over the multicolour GFTV wordmark in Arial
// Black, on the #fedc00 background. The glyph is a calendar page with a paw
// print on it.
//
// The artwork is drawn on a transparent layer first, then scaled and centred
// so every painted pixel sits inside a centred circle of 40% radius, the
// maskable icon safe zone. So the icon survives being cropped to a circle
// (Android, the manifest's "maskable" purpose, round avatars) with nothing
// cut off. The same method as gftv-linktree's tools/make-icons.py.
//
// The wordmark is turned into paths with opentype.js, so GHE-icon.svg needs no
// font to render. Arial Black ships with macOS and Windows; set ARIAL_BLACK to
// its path anywhere else.
//
// Usage, from this folder:  npm install  then  npm run icons
// Writes GHE-icon.svg here, and GHE-main.png (1024), GHE-512.png,
// GHE-192.png, GHE-180.png, favicon.ico (16, 32, 48; the glyph without the
// wordmark, which is a blur at that size) and the 72 by 48
// gftv-flag.png (from the full size flag in the repo root) into ../main-site.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import opentype from 'opentype.js';

const toolsFolder = dirname(fileURLToPath(import.meta.url));
const siteFolder = join(toolsFolder, '..', 'main-site');

const ICON_SIZE = 1024;
const SAFE_RADIUS = 0.4 * ICON_SIZE - 8; // a few pixels inside the safe circle
const BACKGROUND = '#fedc00';
const INK = '#2e2800'; // hello-theme text colour, for outlines
const CARD = '#ffffff';
const RED = '#fd0000';
const BLUE = '#1a8cff';
const WORDMARK_COLOURS = ['#fd0000', '#ffda00', '#17ad1b', '#1a8cff'];

// Finds Arial Black: the ARIAL_BLACK path first, then the usual macOS and
// Windows places.
function fontPath() {
  const candidates = [
    process.env.ARIAL_BLACK,
    '/System/Library/Fonts/Supplemental/Arial Black.ttf',
    '/Library/Fonts/Arial Black.ttf',
    'C:/Windows/Fonts/ariblk.ttf',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('Arial Black not found; set ARIAL_BLACK to the .ttf path');
  }
  return found;
}

// The GFTV wordmark as SVG paths, centred across the icon, with its top edge
// at the given height.
function wordmark(top) {
  const font = opentype.parse(readFileSync(fontPath()).buffer);
  const size = 190;
  const gap = 6;
  const letters = [...'GFTV'];
  const widths = letters.map((letter) => font.getAdvanceWidth(letter, size));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (letters.length - 1);
  let nextLeft = ICON_SIZE / 2 - totalWidth / 2;
  const baseline = top + size * 0.86;
  return letters
    .map((letter, letterIndex) => {
      const pathData = font.getPath(letter, nextLeft, baseline, size).toPathData(2);
      nextLeft += widths[letterIndex] + gap;
      // Each letter outlined, so the yellow F reads on the yellow ground.
      return `<path d="${pathData}" fill="${WORDMARK_COLOURS[letterIndex]}" stroke="${INK}" stroke-width="18" stroke-linejoin="round" paint-order="stroke"/>`;
    })
    .join('');
}

// The icon's shapes as SVG: the calendar page with its paw print, and
// (unless switched off for the favicon) the wordmark below it.
function artwork({ withWordmark = true } = {}) {
  const centreX = ICON_SIZE / 2;
  const left = centreX - 200;
  const right = centreX + 200;
  const top = 150;
  const bottom = 590;
  const band = 250;
  let wordmarkShapes = '';
  if (withWordmark) {
    wordmarkShapes = wordmark(640);
  }
  return [
    // The calendar page, its red header band, and the two binder rings.
    `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="56" fill="${CARD}" stroke="${INK}" stroke-width="22"/>`,
    `<path d="M${left + 11} ${band} V${top + 56} a45 45 0 0 1 45 -45 H${right - 56} a45 45 0 0 1 45 45 V${band} Z" fill="${RED}"/>`,
    `<line x1="${left + 11}" y1="${band}" x2="${right - 11}" y2="${band}" stroke="${INK}" stroke-width="18"/>`,
    `<rect x="${centreX - 120}" y="${top - 50}" width="44" height="110" rx="22" fill="${CARD}" stroke="${INK}" stroke-width="18"/>`,
    `<rect x="${centreX + 76}" y="${top - 50}" width="44" height="110" rx="22" fill="${CARD}" stroke="${INK}" stroke-width="18"/>`,
    // A paw print on the page: four toes and a pad.
    `<g fill="${BLUE}">`,
    `<ellipse cx="${centreX - 104}" cy="365" rx="34" ry="44" transform="rotate(-20 ${centreX - 104} 365)"/>`,
    `<ellipse cx="${centreX - 40}" cy="318" rx="36" ry="46" transform="rotate(-6 ${centreX - 40} 318)"/>`,
    `<ellipse cx="${centreX + 40}" cy="318" rx="36" ry="46" transform="rotate(6 ${centreX + 40} 318)"/>`,
    `<ellipse cx="${centreX + 104}" cy="365" rx="34" ry="44" transform="rotate(20 ${centreX + 104} 365)"/>`,
    `<path d="M${centreX} 405 C${centreX + 70} 405 ${centreX + 128} 470 ${centreX + 118} 515 C${centreX + 108} 556 ${centreX + 54} 548 ${centreX} 536 C${centreX - 54} 548 ${centreX - 108} 556 ${centreX - 118} 515 C${centreX - 128} 470 ${centreX - 70} 405 ${centreX} 405 Z"/>`,
    '</g>',
    wordmarkShapes,
  ].join('\n  ');
}

// Wraps shapes in a whole SVG document, with the yellow background if asked.
function buildSvg(body, withBackground) {
  let backgroundRect = '';
  if (withBackground) {
    backgroundRect = `<rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="${BACKGROUND}"/>\n  `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">\n  ${backgroundRect}${body}\n</svg>\n`;
}

// Scale and centre the artwork so its farthest painted pixel lies on
// the given radius from the middle of the icon. It draws the artwork on a
// transparent layer, finds every painted pixel and their bounding box, then
// works out the scale and shift that fit them inside the circle.
async function fitToCircle(body, radius = SAFE_RADIUS) {
  const { data, info } = await sharp(Buffer.from(buildSvg(body, false))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minColumn = ICON_SIZE;
  let minRow = ICON_SIZE;
  let maxColumn = 0;
  let maxRow = 0;
  const painted = [];
  for (let row = 0; row < info.height; row += 1) {
    for (let column = 0; column < info.width; column += 1) {
      if (data[(row * info.width + column) * 4 + 3] > 8) {
        painted.push(column, row);
        if (column < minColumn) {
          minColumn = column;
        }
        if (row < minRow) {
          minRow = row;
        }
        if (column > maxColumn) {
          maxColumn = column;
        }
        if (row > maxRow) {
          maxRow = row;
        }
      }
    }
  }
  const originX = (minColumn + maxColumn + 1) / 2;
  const originY = (minRow + maxRow + 1) / 2;
  let farthest = 0;
  for (let pairIndex = 0; pairIndex < painted.length; pairIndex += 2) {
    farthest = Math.max(farthest, Math.hypot(painted[pairIndex] + 0.5 - originX, painted[pairIndex + 1] + 0.5 - originY));
  }
  const scale = radius / farthest;
  const translateX = ICON_SIZE / 2 - originX * scale;
  const translateY = ICON_SIZE / 2 - originY * scale;
  return { scale, body: `<g transform="translate(${translateX.toFixed(2)} ${translateY.toFixed(2)}) scale(${scale.toFixed(4)})">\n  ${body}\n  </g>` };
}

// An .ico holding PNG images, which every current browser reads.
function buildIcoFile(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    // A size of 256 or more is written as 0 in an .ico entry.
    let storedSize = size;
    if (size >= 256) {
      storedSize = 0;
    }
    const entry = Buffer.alloc(16);
    entry.writeUInt8(storedSize, 0);
    entry.writeUInt8(storedSize, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

const { scale, body } = await fitToCircle(artwork());
const finalSvg = buildSvg(body, true);
writeFileSync(join(toolsFolder, 'GHE-icon.svg'), finalSvg);

const master = await sharp(Buffer.from(finalSvg), { density: 72 }).png().toBuffer();
const resizeMaster = (pixels) => sharp(master).resize(pixels, pixels, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(siteFolder, 'GHE-main.png'), await sharp(master).png({ compressionLevel: 9 }).toBuffer());
for (const pixels of [512, 192, 180]) {
  writeFileSync(join(siteFolder, `GHE-${pixels}.png`), await resizeMaster(pixels));
}

// The favicon is the glyph alone: at 16 and 32 pixels the wordmark is a blur.
// It still sits inside a circle (47% radius, inside the inscribed circle), so
// a round crop loses nothing.
const glyph = await fitToCircle(artwork({ withWordmark: false }), 0.47 * ICON_SIZE);
const glyphMaster = await sharp(Buffer.from(buildSvg(glyph.body, true)), { density: 72 }).png().toBuffer();
const resizeGlyph = (pixels) => sharp(glyphMaster).resize(pixels, pixels, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(siteFolder, 'favicon.ico'), buildIcoFile(await Promise.all([16, 32, 48].map(async (pixels) => ({ size: pixels, data: await resizeGlyph(pixels) })))));

// The banner mark: a small copy of the flag, never the full size one.
const flagPath = join(toolsFolder, '..', 'gftv-flag.png');
if (existsSync(flagPath)) {
  writeFileSync(join(siteFolder, 'gftv-flag.png'), await sharp(flagPath).resize(72, 48, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer());
}

console.log(`artwork scaled by ${scale.toFixed(3)} to fit the safe circle`);
