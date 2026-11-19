// GET /e/<slug> (vercel.json rewrites it here): the event page, event.html,
// with the event's own link-preview tags, so a link pasted into Discord,
// Telegram, WhatsApp, X or iMessage unfurls as the event: its title, when and
// where, its summary, and its cover picture (as a JPEG, embed-image.js).
//
// The same idea as SG Bus Timings' share pages (api/share-page.js there): the
// tags are written per link on the server, since apps reading a link for a
// preview run no JavaScript. Unlike those, people get the page itself rather
// than being sent on: event.html still fetches and draws the event in the
// browser, for each viewer (js/pages/event.js), so nothing here is personal
// and the HTML can be cached by the CDN for a minute.
//
// Only a released event's public fields go in (the feed card's: title,
// summary, when, place name, cover). A draft, an event not released yet, or
// an address with no event gets event.html as it is, with the site's own
// tags, just as before, so an unreleased event is not given away. A database
// error does the same: the page still opens, and loads the event itself.

import { readFile } from 'node:fs/promises';
import { route, guard, query, errorDetail } from '../_lib/http.js';
import { siteUrl } from '../_lib/env.js';
import { releasedEventBySlug } from '../_lib/events.js';
import { embedImageUrl } from '../_lib/covers.js';
import { whenText, placeText } from '../_lib/event-text.js';

const SITE_NAME = 'GFTV HelloEvents';
// How much of the summary or description a preview shows.
const DESCRIPTION_MAX = 240;

// event.html, read once per instance. vercel.json includes it with this
// function (includeFiles).
let template = null;
async function eventHtml() {
  if (template === null) {
    template = await readFile(new URL('../../event.html', import.meta.url), 'utf8');
  }
  return template;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

// Text cut to at most max characters, on a word where it can be, with an
// ellipsis when anything was cut. Line breaks become spaces.
function clip(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, max - 1);
  let end = cut.lastIndexOf(' ');
  if (end < max / 2) {
    end = cut.length;
  }
  return `${cut.slice(0, end).replace(/[\s,.;:]+$/, '')}…`;
}

// The preview's description: "Cancelled" when it is, when and where, then
// the summary (or the start of the English description).
function previewDescription(row) {
  const parts = [];
  if (row.status === 'cancelled') {
    parts.push('Cancelled');
  }
  parts.push(whenText(row));
  const place = placeText(row);
  if (place) {
    parts.push(place);
  }
  let line = parts.join(' · ');
  let about = row.summary;
  if (!about) {
    about = row.description;
  }
  if (about) {
    line = `${line}. ${about}`;
  }
  return clip(line, DESCRIPTION_MAX);
}

// What the preview shows for one released event.
export function previewTags(row) {
  let title = row.title;
  if (row.status === 'cancelled') {
    title = `Cancelled: ${title}`;
  }
  const url = `${siteUrl()}/e/${row.slug}`;
  return { title, description: previewDescription(row), url, image: embedImageUrl(row), imageAlt: row.title };
}

// Writes one tag's content into the page. A tag that is not there leaves the
// page as it was.
function setContent(html, attribute, name, value) {
  const pattern = new RegExp(`(<meta ${attribute}="${name}" content=")[^"]*(")`);
  return html.replace(pattern, (whole, start, end) => `${start}${escapeHtml(value)}${end}`);
}

// event.html with the preview's tags in place of the site's.
export function withPreview(html, tags) {
  let page = html;
  // The title and description lose their data-i18n markers, so the page's
  // translation script leaves them alone; event.js retitles the page in the
  // reader's language once the event has loaded.
  page = page.replace(/<title[^>]*>[^<]*<\/title>/, `<title>${escapeHtml(`${tags.title} | ${SITE_NAME}`)}</title>`);
  page = page.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(tags.description)}">`);
  page = setContent(page, 'property', 'og:type', 'article');
  page = setContent(page, 'property', 'og:title', tags.title);
  page = setContent(page, 'property', 'og:description', tags.description);
  page = setContent(page, 'property', 'og:url', tags.url);
  page = page.replace(/(<link rel="canonical" href=")[^"]*(")/, (whole, start, end) => `${start}${escapeHtml(tags.url)}${end}`);
  if (tags.image) {
    page = setContent(page, 'property', 'og:image', tags.image);
    page = setContent(page, 'name', 'twitter:image', tags.image);
    page = setContent(page, 'name', 'twitter:card', 'summary_large_image');
    page = page.replace(
      /(<meta property="og:image" content="[^"]*">)/,
      (whole) => `${whole}\n    <meta property="og:image:type" content="image/jpeg">\n    <meta property="og:image:alt" content="${escapeHtml(tags.imageAlt)}">`
    );
  }
  page = page.replace(
    /(<meta name="twitter:card" content="[^"]*">)/,
    (whole) => `${whole}\n    <meta name="twitter:title" content="${escapeHtml(tags.title)}">\n    <meta name="twitter:description" content="${escapeHtml(tags.description)}">`
  );
  return page;
}

// The released event at this address, or null (none, not released yet, or
// the database could not be reached).
async function findEvent(slug) {
  try {
    return await releasedEventBySlug(slug);
  } catch (cause) {
    console.error('[helloevents] events/page:', errorDetail(cause));
    return null;
  }
}

export default route('events/page', async (request, response) => {
  if (guard(request, response, ['GET', 'HEAD'])) {
    return;
  }
  const slug = query(request, 'slug').toLowerCase();
  let html = await eventHtml();
  const row = await findEvent(slug);
  if (row) {
    html = withPreview(html, previewTags(row));
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  // The same for everyone: a minute at the CDN, then served stale while it
  // refreshes, so an edit reaches new previews within a few minutes.
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(html);
});
