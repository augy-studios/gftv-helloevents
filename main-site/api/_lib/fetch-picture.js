// Fetching a picture from another website, for a description pasted with
// pictures in it (api/manage/gallery.js { imageUrl }): the site shows only
// pictures it stores itself, so a pasted picture is copied into the event's
// gallery.
//
// The address comes from an editor's clipboard, so the server must not be
// talked into reaching anything private through it:
//   - http and https only, on the usual ports;
//   - every address the name resolves to is checked when the connection is
//     made (not before, so a name cannot change between the check and the
//     connection), and loopback, private, link-local (cloud metadata),
//     carrier-grade NAT, multicast and reserved ranges are refused, in IPv4
//     and IPv6;
//   - at most MAX_REDIRECTS redirects, each checked the same way;
//   - at most MAX_BYTES, and TIMEOUT_MS in all.
// The bytes are then read by sharp as a picture (covers.js), never trusted.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12000;

const fail = (code) => Object.assign(new Error(code), { code });

// Tests answer here instead of the network.
let testFetcher = null;
export function useTestPictureFetcher(fetcher) {
  testFetcher = fetcher;
}

function ipv4Parts(address) {
  return address.split('.').map(Number);
}

// Whether an IP address is one a server must never be sent to.
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [first, second] = ipv4Parts(address);
    if (first === 0 || first === 10 || first === 127 || first >= 224) {
      return true;
    }
    if (first === 100 && second >= 64 && second <= 127) {
      return true;
    }
    if (first === 169 && second === 254) {
      return true;
    }
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
    if (first === 192 && (second === 168 || second === 0)) {
      return true;
    }
    if (first === 198 && (second === 18 || second === 19)) {
      return true;
    }
    return false;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) {
      return isPrivateAddress(mapped[1]);
    }
    if (lower === '::' || lower === '::1') {
      return true;
    }
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff') || lower.startsWith('64:ff9b') || lower.startsWith('2001:db8')) {
      return true;
    }
    return false;
  }
  return true;
}

// dns.lookup, refusing private addresses: used by the request itself.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (allowed.length === 0 || allowed.length !== addresses.length) {
      callback(fail('picture_address_refused'));
      return;
    }
    if (options && options.all) {
      callback(null, allowed);
      return;
    }
    callback(null, allowed[0].address, allowed[0].family);
  });
}

// The URL, if it is one this may fetch: http(s), a name or public address,
// the usual ports, no user name or password.
function checkedUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) {
    return null;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return null;
  }
  return url;
}

function requestOnce(url, deadline) {
  return new Promise((resolve, reject) => {
    let client = https;
    if (url.protocol === 'http:') {
      client = http;
    }
    const request = client.get(url, {
      lookup: safeLookup,
      headers: { 'User-Agent': 'HelloEvents-picture-copy/1.0', Accept: 'image/*' },
      timeout: Math.max(1000, deadline - Date.now()),
    }, (response) => {
      const status = response.statusCode;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url).toString() });
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(fail('picture_fetch_failed'));
        return;
      }
      const type = String(response.headers['content-type']).toLowerCase();
      if (!type.startsWith('image/') || type.includes('svg')) {
        response.resume();
        reject(fail('picture_not_image'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          request.destroy(fail('cover_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(fail('picture_fetch_failed')));
    request.on('error', (error) => {
      if (error.code === 'picture_address_refused' || error.code === 'cover_too_large') {
        reject(error);
        return;
      }
      reject(fail('picture_fetch_failed'));
    });
  });
}

// The bytes of the picture at address, or throws with code
// 'picture_address_refused' (not an address this may fetch),
// 'picture_not_image', 'cover_too_large' or 'picture_fetch_failed'.
export async function fetchPicture(address) {
  if (testFetcher) {
    return testFetcher(address);
  }
  let url = checkedUrl(String(address));
  if (!url) {
    throw fail('picture_address_refused');
  }
  const deadline = Date.now() + TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(url, deadline);
    if (result.bytes) {
      return result.bytes;
    }
    url = checkedUrl(result.redirect);
    if (!url) {
      throw fail('picture_address_refused');
    }
  }
  throw fail('picture_fetch_failed');
}
