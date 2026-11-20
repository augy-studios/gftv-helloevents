// The web app manifest's screenshots (main-site/images/screenshot_*.png),
// taken from the live site, events.globalfurry.tv, with its real events.
//
// Each is rendered at twice the size manifest.json gives it and then halved
// with a Lanczos filter, so text and pictures are sharper than a render at
// the final size:
//   - screenshot_1.png (narrow): a phone, 360 by 780 CSS pixels at 6x
//     (2160 by 4680), halved to 1080 by 2340;
//   - screenshot_2.png (wide): a computer, 1280 by 720 at 3x (3840 by
//     2160), halved to 1920 by 1080.
// It waits for the events, their covers and the fonts to load, and blocks
// Google Analytics so the shots are not counted as visits. The page tours a
// first visit starts (js/tour.js) are marked as seen beforehand, as for a
// returning visitor, so none covers the page.
//
// Usage, from this folder, once main-site's dependencies are installed:
//   node make-screenshots.mjs
// CHROMIUM=/path/to/chrome picks the browser (by default, the one
// @playwright/test installed).

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'main-site');
const require = createRequire(join(SITE, 'package.json'));
const { chromium } = require('@playwright/test');
const sharp = require('sharp');

const LIVE = 'https://events.globalfurry.tv/';
const SUPERSAMPLE = 2;
const SHOTS = [
  { file: 'screenshot_1.png', formFactor: 'narrow', viewport: { width: 360, height: 780 }, mobile: true },
  { file: 'screenshot_2.png', formFactor: 'wide', viewport: { width: 1280, height: 720 }, mobile: false },
];

// The size manifest.json gives each screenshot.
async function manifestSizes() {
  const manifest = JSON.parse(await readFile(join(SITE, 'manifest.json'), 'utf8'));
  const sizes = new Map();
  for (const entry of manifest.screenshots) {
    const [width, height] = entry.sizes.split('x').map(Number);
    sizes.set(entry.form_factor, { width, height, file: entry.src.split('/').pop() });
  }
  return sizes;
}

// Waits until the feed has drawn its events, every picture on screen has
// loaded, the fonts are ready, and nothing moves any more.
async function settled(page) {
  await page.waitForLoadState('networkidle');
  await page.locator('.event-card').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const pictures = [...document.images].filter((image) => {
      const box = image.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight;
    });
    await Promise.all(pictures.map((image) => {
      image.loading = 'eager';
      if (image.complete && image.naturalWidth > 0) {
        return image.decode().catch(() => {});
      }
      return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }));
  });
  await page.waitForTimeout(1500);
}

// Every page tour's id on the live site (js/tours.js), for marking them all
// as seen.
async function tourIds() {
  const response = await fetch(new URL('/js/tours.js', LIVE));
  if (!response.ok) {
    return ['home'];
  }
  const source = await response.text();
  const ids = [...source.matchAll(/^\s+id: '([^']+)'/gm)].map((match) => match[1]);
  if (ids.length === 0) {
    return ['home'];
  }
  return ids;
}

const sizes = await manifestSizes();
const seenTours = await tourIds();
const launchOptions = {};
if (process.env.CHROMIUM) {
  launchOptions.executablePath = process.env.CHROMIUM;
}
const browser = await chromium.launch(launchOptions);
try {
  for (const shot of SHOTS) {
    const target = sizes.get(shot.formFactor);
    const scale = (target.width / shot.viewport.width) * SUPERSAMPLE;
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: scale,
      isMobile: shot.mobile,
      hasTouch: shot.mobile,
      locale: 'en-SG',
      timezoneId: 'Asia/Singapore',
      colorScheme: 'light',
      serviceWorkers: 'block',
    });
    await context.route(/googletagmanager\.com|google-analytics\.com|doubleclick\.net/, (route) => route.abort());
    await context.addInitScript((ids) => {
      try {
        localStorage.setItem('tour.seen', JSON.stringify(ids));
      } catch {
        // Storage blocked: js/tour.js then counts every tour as seen.
      }
    }, seenTours);
    const page = await context.newPage();
    await page.goto(LIVE, { waitUntil: 'domcontentloaded' });
    await settled(page);
    const raw = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    const out = join(SITE, 'images', target.file);
    await sharp(raw)
      .resize(target.width, target.height, { kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(out);
    const rendered = await sharp(raw).metadata();
    console.log(`${target.file}: ${shot.viewport.width}x${shot.viewport.height} at ${scale}x (${rendered.width}x${rendered.height}) -> ${target.width}x${target.height}`);
    await context.close();
  }
} finally {
  await browser.close();
}
