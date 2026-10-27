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

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', 'main-site');

const S = 1024;
const SAFE_RADIUS = 0.4 * S - 8; // a few pixels inside the safe circle
const BG = '#fedc00';
const INK = '#2e2800'; // hello-theme text colour, for outlines
const CARD = '#ffffff';
const RED = '#fd0000';
const BLUE = '#1a8cff';
const WORD = ['#fd0000', '#ffda00', '#17ad1b', '#1a8cff'];

function fontPath() {
  const candidates = [
    process.env.ARIAL_BLACK,
    '/System/Library/Fonts/Supplemental/Arial Black.ttf',
    '/Library/Fonts/Arial Black.ttf',
    'C:/Windows/Fonts/ariblk.ttf',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Arial Black not found; set ARIAL_BLACK to the .ttf path');
  return found;
}

function wordmark(top) {
  const font = opentype.parse(readFileSync(fontPath()).buffer);
  const size = 190;
  const gap = 6;
  const letters = [...'GFTV'];
  const widths = letters.map((ch) => font.getAdvanceWidth(ch, size));
  let x = S / 2 - (widths.reduce((a, b) => a + b, 0) + gap * (letters.length - 1)) / 2;
  const baseline = top + size * 0.86;
  return letters
    .map((ch, i) => {
      const d = font.getPath(ch, x, baseline, size).toPathData(2);
      x += widths[i] + gap;
      // Each letter outlined, so the yellow F reads on the yellow ground.
      return `<path d="${d}" fill="${WORD[i]}" stroke="${INK}" stroke-width="18" stroke-linejoin="round" paint-order="stroke"/>`;
    })
    .join('');
}

function artwork({ withWordmark = true } = {}) {
  const cx = S / 2;
  const left = cx - 200;
  const right = cx + 200;
  const top = 150;
  const bottom = 590;
  const band = 250;
  return [
    // The calendar page, its red header band, and the two binder rings.
    `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="56" fill="${CARD}" stroke="${INK}" stroke-width="22"/>`,
    `<path d="M${left + 11} ${band} V${top + 56} a45 45 0 0 1 45 -45 H${right - 56} a45 45 0 0 1 45 45 V${band} Z" fill="${RED}"/>`,
    `<line x1="${left + 11}" y1="${band}" x2="${right - 11}" y2="${band}" stroke="${INK}" stroke-width="18"/>`,
    `<rect x="${cx - 120}" y="${top - 50}" width="44" height="110" rx="22" fill="${CARD}" stroke="${INK}" stroke-width="18"/>`,
    `<rect x="${cx + 76}" y="${top - 50}" width="44" height="110" rx="22" fill="${CARD}" stroke="${INK}" stroke-width="18"/>`,
    // A paw print on the page: four toes and a pad.
    `<g fill="${BLUE}">`,
    `<ellipse cx="${cx - 104}" cy="365" rx="34" ry="44" transform="rotate(-20 ${cx - 104} 365)"/>`,
    `<ellipse cx="${cx - 40}" cy="318" rx="36" ry="46" transform="rotate(-6 ${cx - 40} 318)"/>`,
    `<ellipse cx="${cx + 40}" cy="318" rx="36" ry="46" transform="rotate(6 ${cx + 40} 318)"/>`,
    `<ellipse cx="${cx + 104}" cy="365" rx="34" ry="44" transform="rotate(20 ${cx + 104} 365)"/>`,
    `<path d="M${cx} 405 C${cx + 70} 405 ${cx + 128} 470 ${cx + 118} 515 C${cx + 108} 556 ${cx + 54} 548 ${cx} 536 C${cx - 54} 548 ${cx - 108} 556 ${cx - 118} 515 C${cx - 128} 470 ${cx - 70} 405 ${cx} 405 Z"/>`,
    '</g>',
    withWordmark ? wordmark(640) : '',
  ].join('\n  ');
}

const svg = (body, background) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">\n  ${
    background ? `<rect width="${S}" height="${S}" fill="${BG}"/>\n  ` : ''
  }${body}\n</svg>\n`;

// Scale and centre the artwork so its farthest painted pixel lies on
// SAFE_RADIUS from the middle of the icon.
async function fitToCircle(body, radius = SAFE_RADIUS) {
  const { data, info } = await sharp(Buffer.from(svg(body, false))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = S, minY = S, maxX = 0, maxY = 0;
  const painted = [];
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        painted.push(x, y);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const ox = (minX + maxX + 1) / 2;
  const oy = (minY + maxY + 1) / 2;
  let farthest = 0;
  for (let i = 0; i < painted.length; i += 2) {
    farthest = Math.max(farthest, Math.hypot(painted[i] + 0.5 - ox, painted[i + 1] + 0.5 - oy));
  }
  const scale = radius / farthest;
  const tx = S / 2 - ox * scale;
  const ty = S / 2 - oy * scale;
  return { scale, body: `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">\n  ${body}\n  </g>` };
}

// An .ico holding PNG images, which every current browser reads.
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const { scale, body } = await fitToCircle(artwork());
const final = svg(body, true);
writeFileSync(join(here, 'GHE-icon.svg'), final);

const master = await sharp(Buffer.from(final), { density: 72 }).png().toBuffer();
const sized = (n) => sharp(master).resize(n, n, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(site, 'GHE-main.png'), await sharp(master).png({ compressionLevel: 9 }).toBuffer());
for (const n of [512, 192, 180]) writeFileSync(join(site, `GHE-${n}.png`), await sized(n));

// The favicon is the glyph alone: at 16 and 32 pixels the wordmark is a blur.
// It still sits inside a circle (47% radius, inside the inscribed circle), so
// a round crop loses nothing.
const glyph = await fitToCircle(artwork({ withWordmark: false }), 0.47 * S);
const glyphMaster = await sharp(Buffer.from(svg(glyph.body, true)), { density: 72 }).png().toBuffer();
const glyphSized = (n) => sharp(glyphMaster).resize(n, n, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(site, 'favicon.ico'), ico(await Promise.all([16, 32, 48].map(async (n) => ({ size: n, data: await glyphSized(n) })))));

// The banner mark: a small copy of the flag, never the full size one.
const flag = join(here, '..', 'gftv-flag.png');
if (existsSync(flag)) {
  writeFileSync(join(site, 'gftv-flag.png'), await sharp(flag).resize(72, 48, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer());
}

console.log(`artwork scaled by ${scale.toFixed(3)} to fit the safe circle`);
