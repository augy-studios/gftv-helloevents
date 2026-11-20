// Emoji for event descriptions: the editor's emoji picker data and the
// emoji font that fills the gaps on older devices, rebuilt from their
// sources. Run it again when Unicode publishes a new emoji edition (each
// September) and Google's Noto Color Emoji has caught up.
//
// Usage, from this folder:  node make-emoji.mjs
//
// Writes into ../main-site:
//   - assets/emoji/emoji.json: every fully-qualified emoji in Unicode's
//     latest emoji-test.txt, by group, each with its name and, where it has
//     them, its five skin tone versions; the edition is in "version";
//   - assets/fonts/emoji/noto-color-emoji-<n>.woff2: Google Fonts' slices of
//     Noto Color Emoji, and emoji.css, the @font-face rules that load a slice
//     only when a page shows an emoji in its range, under the family name
//     "GFTV Emoji";
//   - assets/fonts/emoji/OFL.txt: the font's licence (SIL Open Font License
//     1.1), which travels with it.

import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'main-site');
const EMOJI_TEST = 'https://unicode.org/Public/emoji/latest/emoji-test.txt';
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap';
const FONT_LICENCE = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notocoloremoji/OFL.txt';
// Google Fonts sends WOFF2 slices to a current browser.
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TONES = ['light skin tone', 'medium-light skin tone', 'medium skin tone', 'medium-dark skin tone', 'dark skin tone'];
// The picker's groups, in emoji-test.txt's order, without "Component" (skin
// tones and hair styles on their own).
const SKIPPED_GROUPS = new Set(['Component']);

async function text(url) {
  const response = await fetch(url, { headers: { 'User-Agent': BROWSER } });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return response.text();
}

async function bytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': BROWSER } });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// emoji-test.txt as { version, groups: [{ name, emoji: [[emoji, name,
// tones?]] }] }.
function parseEmojiTest(source) {
  const version = /^# Version: ([\d.]+)/m.exec(source)[1];
  const groups = [];
  const byName = new Map();
  let group = null;
  for (const line of source.split('\n')) {
    const heading = /^# group: (.+)$/.exec(line);
    if (heading) {
      group = { name: heading[1].trim(), emoji: [] };
      if (!SKIPPED_GROUPS.has(group.name)) {
        groups.push(group);
      }
      continue;
    }
    const entry = /^[0-9A-F ]+;\s*fully-qualified\s*#\s*(\S+)\s+E[\d.]+\s+(.+)$/.exec(line);
    if (!entry || !group || SKIPPED_GROUPS.has(group.name)) {
      continue;
    }
    const [, emoji, name] = entry;
    const toned = /^(.*): (.+)$/.exec(name);
    if (toned && TONES.includes(toned[2]) && byName.has(toned[1])) {
      const base = byName.get(toned[1]);
      if (!base[2]) {
        base[2] = [];
      }
      base[2][TONES.indexOf(toned[2])] = emoji;
      continue;
    }
    // Other skin tone mixes (two people, two tones) are left to the
    // keyboard: the picker offers one tone at a time.
    if (/skin tone/.test(name)) {
      continue;
    }
    const item = [emoji, name];
    byName.set(name, item);
    group.emoji.push(item);
  }
  // Only complete sets of five tones are kept.
  for (const each of groups) {
    for (const item of each.emoji) {
      if (item[2] && item[2].filter(Boolean).length !== TONES.length) {
        item.length = 2;
      }
    }
  }
  return { version, groups };
}

async function main() {
  const emoji = parseEmojiTest(await text(EMOJI_TEST));
  await mkdir(join(SITE, 'assets', 'emoji'), { recursive: true });
  await writeFile(join(SITE, 'assets', 'emoji', 'emoji.json'), `${JSON.stringify(emoji)}\n`);
  const count = emoji.groups.reduce((sum, group) => sum + group.emoji.length, 0);
  console.log(`Emoji ${emoji.version}: ${count} emoji in ${emoji.groups.length} groups`);

  const fontDir = join(SITE, 'assets', 'fonts', 'emoji');
  await mkdir(fontDir, { recursive: true });
  for (const old of await readdir(fontDir)) {
    if (old.endsWith('.woff2')) {
      await unlink(join(fontDir, old));
    }
  }
  const css = await text(FONT_CSS);
  const rules = [...css.matchAll(/@font-face\s*{[^}]*?src:\s*url\(([^)]+)\)[^}]*?unicode-range:\s*([^;]+);[^}]*}/g)];
  let out = '/* Noto Color Emoji (SIL Open Font License 1.1, OFL.txt), from Google Fonts,\n'
    + '   rebuilt by tools/make-emoji.mjs. Each slice loads only when a page shows\n'
    + '   an emoji in its range. */\n';
  for (const [index, rule] of rules.entries()) {
    const file = `noto-color-emoji-${index}.woff2`;
    await writeFile(join(fontDir, file), await bytes(rule[1]));
    out += `@font-face {\n  font-family: 'GFTV Emoji';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n`
      + `  src: url('/assets/fonts/emoji/${file}') format('woff2');\n  unicode-range: ${rule[2].trim()};\n}\n`;
  }
  await writeFile(join(fontDir, 'emoji.css'), out);
  await writeFile(join(fontDir, 'OFL.txt'), await text(FONT_LICENCE));
  console.log(`Noto Color Emoji: ${rules.length} slices`);
}

await main();
