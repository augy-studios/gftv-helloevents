// A Google Maps link pasted into a location on the edit form, read for the
// place it points at, so the form can fill in the venue, street address,
// city and country (api/manage/place.js).
//
// Adapted from sgbus-timings (main-site/api/_lib/gmaps.js): a short link
// (maps.app.goo.gl, goo.gl/maps) is followed to the full link first, only
// ever on Google's own hosts, and the full link is read for the place's own
// pin (!3d<lat>!4d<lng>), coordinates in a parameter or the path, and its
// name and address ("?q=ION+Orchard,+2+Orchard+Turn,+Singapore+238801").
// sgbus looks places up on OneMap, which covers Singapore only; events here
// are in Malaysia and Indonesia too, so the city, country and street come
// from OpenStreetMap's Nominatim instead: by the coordinates where the link
// has them, otherwise by the name and address it carries.

import { siteUrl } from './env.js';

const LINK_PATTERN =
  /(?:https?:\/\/)?(?:maps\.app\.goo\.gl\/|goo\.gl\/maps\/|(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?\/maps|maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?\/?)[^\s<>"]*/i;
// Only Google's own hosts are fetched, so a link can never send this
// function anywhere else.
const GOOGLE_HOST = /^(?:maps\.app\.goo\.gl|goo\.gl|(?:www\.|maps\.|consent\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?)$/i;
const SHORT_HOST = /^(?:maps\.app\.)?goo\.gl$/i;
const MAX_HOPS = 5;
const FETCH_TIMEOUT_MS = 8000;
const LAT_LNG = /^\s*(?:loc:\s*)?(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;
const NOMINATIM = 'https://nominatim.openstreetmap.org';

// A link that cannot be placed. code is the error code the route answers
// with, and the edit form shows error.<code>.
export class MapsLinkError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// The Google Maps link in text, and whatever was shared with it (Google Maps
// shares "ION Orchard\nhttps://maps.app.goo.gl/..."); null if there is none.
export function findMapsLink(text) {
  const source = String(text);
  const match = source.match(LINK_PATTERN);
  if (!match) {
    return null;
  }
  // Not the full stop or bracket a link in a sentence ends with.
  const link = match[0].replace(/[).,!?]+$/, '');
  let href = link;
  if (!/^https?:\/\//i.test(link)) {
    href = `https://${link}`;
  }
  const rest = (source.slice(0, match.index) + source.slice(match.index + match[0].length))
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
  return { href, rest };
}

// A short link followed to the full one it stands for, without fetching the
// map page itself; null if it goes nowhere or leaves Google.
async function expand(href) {
  try {
    let url = new URL(href);
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      if (!GOOGLE_HOST.test(url.hostname)) {
        return null;
      }
      // The cookie consent page some regions get passes the real link on in
      // its "continue" parameter.
      if (/^consent\./i.test(url.hostname)) {
        url = new URL(url.searchParams.get('continue'));
        continue;
      }
      if (!SHORT_HOST.test(url.hostname)) {
        return url;
      }
      const answer = await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const location = answer.headers.get('location');
      if (!location) {
        return null;
      }
      url = new URL(location, url);
    }
  } catch {
    // A broken link, or a short link that did not answer.
  }
  return null;
}

// A piece of a link with its escapes and "+" spaces undone.
function decodePart(part) {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' ')).trim();
  } catch {
    return part.trim();
  }
}

// { lat, lng } from "1.3048,103.8318", or null.
function latLngOf(text) {
  if (!text) {
    return null;
  }
  const match = text.match(LAT_LNG);
  if (!match) {
    return null;
  }
  return { lat: Number(match[1]), lng: Number(match[2]) };
}

// Whether a path segment is the map's view or its data blob, not a name.
function isViewSegment(segment) {
  if (segment.startsWith('@') || segment.startsWith('data=')) {
    return true;
  }
  return false;
}

// The coordinates a full link gives, most exact first: the place's own pin;
// a direction's last stop; any given as text; then, only for a link with no
// words at all, where the map was looking (a search's view is wherever the
// person sharing it happened to be).
function coordinatesOf(url, segments, texts, place, hasWords) {
  const pins = [...url.href.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)];
  if (pins.length) {
    const pin = pins[pins.length - 1];
    return { lat: Number(pin[1]), lng: Number(pin[2]) };
  }
  if (segments.includes('dir')) {
    const stops = [...url.href.matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)];
    if (stops.length) {
      const stop = stops[stops.length - 1];
      return { lat: Number(stop[2]), lng: Number(stop[1]) };
    }
  }
  const candidates = [...texts, place, url.searchParams.get('ll'), url.searchParams.get('center')];
  for (const candidate of candidates) {
    const given = latLngOf(candidate);
    if (given) {
      return given;
    }
  }
  if (hasWords) {
    return null;
  }
  for (const segment of segments) {
    const view = segment.match(/^@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (view) {
      return { lat: Number(view[1]), lng: Number(view[2]) };
    }
  }
  return null;
}

// What a full Google Maps link says: { name, text, lat, lng }, each only
// where the link has it. name is the place's name from /place/<name>; text
// is a search, or a direction's destination, often "name, address".
export function readMapsUrl(url) {
  const out = {};
  const segments = url.pathname.split('/').filter(Boolean).map(decodePart);
  const after = (word) => {
    const index = segments.indexOf(word);
    if (index >= 0 && segments[index + 1] && !isViewSegment(segments[index + 1])) {
      return segments[index + 1];
    }
    return null;
  };

  const texts = ['destination', 'daddr', 'q', 'query'].map((key) => url.searchParams.get(key)).filter(Boolean);
  if (segments.includes('dir')) {
    const stops = segments.slice(segments.indexOf('dir') + 1).filter((segment) => !isViewSegment(segment));
    if (stops.length) {
      texts.push(stops[stops.length - 1]);
    }
  }
  const searched = after('search');
  if (searched) {
    texts.push(searched);
  }
  const place = after('place');
  if (place && !latLngOf(place)) {
    out.name = place;
  }
  const words = texts.find((text) => !latLngOf(text));
  if (words) {
    out.text = words;
  }
  const at = coordinatesOf(url, segments, texts, place, Boolean(out.text));
  if (at) {
    Object.assign(out, at);
  }
  return out;
}

// The parts of a shared name and address: "ION Orchard, 2 Orchard Turn" is
// ["ION Orchard", "2 Orchard Turn"].
function partsOf(text) {
  if (!text) {
    return [];
  }
  return text
    .split(/,|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// A place's name out of the text Google gives for it: the first part that
// is not a street number, a postcode or a unit, less any unit number.
// "Takagi Ramen @ Dhoby Ghaut Exchange" from "11 Orchard Rd, B1-11 Takagi
// Ramen @ Dhoby Ghaut Exchange, Singapore 238826"; the first part where
// that is all there is.
export function nameOf(text) {
  const parts = partsOf(text).map((part) => part.replace(/^#?[A-Z]?\d{1,3}-\d{1,4}[A-Z]?\s+/i, ''));
  const named = parts.find((part) => !/^\d/.test(part));
  if (named) {
    return named;
  }
  if (parts.length) {
    return parts[0];
  }
  return '';
}

// The street address in the text Google gives, which is everything after
// the place's name: "2 Orchard Turn, Singapore 238801". '' when the text is
// only a name.
function addressOf(text, name) {
  const parts = partsOf(text);
  if (parts.length < 2) {
    return '';
  }
  if (parts[0] === name) {
    return parts.slice(1).join(', ');
  }
  return parts.join(', ');
}

// One Nominatim request: its JSON, or null when it fails.
async function nominatim(path, parameters) {
  const url = new URL(path, NOMINATIM);
  url.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', ...parameters }).toString();
  try {
    const answer = await fetch(url, {
      headers: {
        // Nominatim's usage policy asks each application to name itself.
        'user-agent': `GFTV-HelloEvents/1.0 (+${siteUrl()})`,
        'accept-language': 'en',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!answer.ok) {
      return null;
    }
    return await answer.json();
  } catch {
    return null;
  }
}

// The city of a Nominatim address: its city, or the nearest thing to one.
function cityOf(address) {
  for (const key of ['city', 'town', 'village', 'municipality', 'city_district', 'county', 'state']) {
    if (address[key]) {
      return address[key];
    }
  }
  return '';
}

// A street address from a Nominatim address: "2 Orchard Turn, 238801".
function streetOf(address) {
  const street = [address.house_number, address.road].filter(Boolean).join(' ');
  return [street, address.postcode].filter(Boolean).join(', ');
}

// The place for the edit form, from a link findMapsLink() found:
// { venueName, venueAddress, city, country, mapsUrl }, every field a string
// ('' where it is not known; country a two-letter code). Throws
// MapsLinkError when the link cannot be placed.
export async function placeFromMapsLink({ href, rest }) {
  const url = await expand(href);
  if (!url) {
    throw new MapsLinkError('maps_link_unreadable');
  }
  const read = readMapsUrl(url);
  let shared = '';
  if (rest && !/^https?:/i.test(rest)) {
    shared = rest;
  }
  let text = read.text;
  if (!text) {
    text = shared;
  }
  let name = nameOf(read.name);
  if (!name) {
    name = nameOf(text);
  }

  let found = null;
  if (read.lat !== undefined) {
    found = await nominatim('/reverse', { lat: String(read.lat), lon: String(read.lng), zoom: '18' });
  } else if (text || name) {
    let searchText = text;
    if (!searchText) {
      searchText = name;
    }
    const hits = await nominatim('/search', { q: searchText, limit: '1' });
    if (Array.isArray(hits) && hits.length) {
      found = hits[0];
    }
  } else {
    throw new MapsLinkError('maps_link_unreadable');
  }
  if (!found || found.error) {
    throw new MapsLinkError('maps_lookup_failed');
  }

  let address = {};
  if (found.address) {
    address = found.address;
  }
  if (!name && found.name) {
    name = found.name;
  }
  // The address Google gives with the name, from the search text or the
  // /place/ name ("ION Orchard, 2 Orchard Turn"), else Nominatim's street.
  let venueAddress = addressOf(text, name);
  if (!venueAddress && read.name) {
    venueAddress = addressOf(read.name, name);
  }
  if (!venueAddress) {
    venueAddress = streetOf(address);
  }
  let country = '';
  if (address.country_code) {
    country = String(address.country_code).toUpperCase();
  }
  return { venueName: name, venueAddress, city: cityOf(address), country, mapsUrl: href };
}
