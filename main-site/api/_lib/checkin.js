// Check-in at the door (migrations/027).
//
// Two kinds of code, both signed with crypto.js keyedHash so neither can be
// made up:
//
//   An attendee's code   "ghe1.<event id>.<RSVP ID>.<signature>", shown as a
//                        QR code on the event page to the person going. The
//                        signature covers their account too, so a code only
//                        ever checks in the person it was made for; a new
//                        RSVP (a new RSVP ID) makes a new code. Organisers
//                        scan it on the check-in page (/checkin).
//   The beacon's code    while an organiser has self check-in on, the
//                        check-in page shows a QR code of the event's address
//                        with ?checkin=<window>.<signature> (made a few hours
//                        ahead, so it keeps changing offline). The window is
//                        the 30-second stretch it was made in, so the QR code
//                        changes every 30 seconds, and a code is taken for
//                        BEACON_WINDOWS_ACCEPTED windows (5 minutes: enough
//                        to sign in first), so a photo of it sent away soon
//                        stops working. Scanning it with a phone's camera
//                        opens the event page, which checks its holder in.

import { keyedHash, safeEqual } from './crypto.js';
import { siteUrl } from './env.js';

export const BEACON_WINDOW_SECONDS = 30;
const BEACON_WINDOWS_ACCEPTED = 10;
const SIGNATURE_LENGTH = 22;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ATTENDEE_CODE = new RegExp(`^ghe1\\.(${UUID})\\.(\\d{1,9})\\.([A-Za-z0-9_-]{${SIGNATURE_LENGTH}})$`, 'i');
const BEACON_CODE = /^(\d{1,12})\.([A-Za-z0-9_-]{22})$/;

function attendeeSignature(eventId, userId, rsvpNumber) {
  return keyedHash('checkin-attendee', `${eventId}:${userId}:${rsvpNumber}`).slice(0, SIGNATURE_LENGTH);
}

// The code for one person going, or null without an RSVP ID.
export function attendeeCode(eventId, userId, rsvpNumber) {
  if (!Number.isInteger(rsvpNumber)) {
    return null;
  }
  return `ghe1.${eventId}.${rsvpNumber}.${attendeeSignature(eventId, userId, rsvpNumber)}`;
}

// A scanned attendee code taken apart: { eventId, rsvpNumber, signature },
// or null when it is not one.
export function readAttendeeCode(text) {
  const match = ATTENDEE_CODE.exec(String(text).trim());
  if (!match) {
    return null;
  }
  return { eventId: match[1].toLowerCase(), rsvpNumber: Number(match[2]), signature: match[3] };
}

// Whether a read code was made for this attendee (their account).
export function attendeeCodeMatches(code, userId) {
  return safeEqual(code.signature, attendeeSignature(code.eventId, userId, code.rsvpNumber));
}

function windowAt(time) {
  return Math.floor(time / (BEACON_WINDOW_SECONDS * 1000));
}

function beaconSignature(eventId, window) {
  return keyedHash('checkin-beacon', `${eventId}:${window}`).slice(0, SIGNATURE_LENGTH);
}

// The beacon's codes from now on, each with the address its QR code carries
// and the 30 seconds it is shown for, made ahead so the check-in page keeps
// changing them with no connection. -> [{ url, from, until }]
export const BEACON_AHEAD_HOURS = 4;

export function beaconCodesAhead(eventId, slug, now = Date.now(), hours = BEACON_AHEAD_HOURS) {
  const first = windowAt(now);
  const count = Math.ceil((hours * 3600) / BEACON_WINDOW_SECONDS);
  const codes = [];
  for (let window = first; window < first + count; window += 1) {
    const code = `${window}.${beaconSignature(eventId, window)}`;
    codes.push({
      url: `${siteUrl()}/e/${slug}?checkin=${code}`,
      from: new Date(window * BEACON_WINDOW_SECONDS * 1000).toISOString(),
      until: new Date((window + 1) * BEACON_WINDOW_SECONDS * 1000).toISOString(),
    });
  }
  return codes;
}

// Whether a beacon code is this event's, and recent enough.
export function beaconCodeValid(eventId, text, now = Date.now()) {
  const match = BEACON_CODE.exec(String(text).trim());
  if (!match) {
    return false;
  }
  const window = Number(match[1]);
  const current = windowAt(now);
  if (window > current || window <= current - BEACON_WINDOWS_ACCEPTED) {
    return false;
  }
  return safeEqual(match[2], beaconSignature(eventId, window));
}
