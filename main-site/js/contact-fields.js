// Contact details an event asks the people going for (migrations/021): the
// one set of rules, used in the browser (the edit form, the RSVP form) and
// on the server (event-rules.js when an event is saved, api/events/rsvp.js
// when someone RSVPs). Nothing here touches the DOM or Node.
//
// An event's editor picks the fields:
//   - ready-made ones: a phone number, a Telegram username, a Discord
//     username (id and type both 'phone', 'telegram' or 'discord');
//   - their own, each with a label they write and a type that says what is
//     typed in it: a phone number, an email address, a username, or any
//     text (id 'c' and six letters or digits).
// and a rule for what the people going must give:
//   'any'       at least one of them (the default);
//   'all'       every one;
//   'optional'  none: they may leave them all blank.
// Stored on the event as contact_fields ([{ id, type, label }], label null
// for a ready-made one) and contact_rule; what each person gave is stored
// on their RSVP as contact ({ id: value }), seen only by the event's
// editors.

export const CONTACT_PRESETS = ['phone', 'telegram', 'discord'];
export const CUSTOM_TYPES = ['phone', 'email', 'username', 'text'];
export const CONTACT_RULES = ['any', 'all', 'optional'];
export const DEFAULT_CONTACT_RULE = 'any';
export const MAX_CUSTOM_FIELDS = 5;
export const CONTACT_LABEL_MAX = 40;

const CUSTOM_ID = /^c[a-z0-9]{6}$/;
const VALUE_MAX = { phone: 30, telegram: 33, discord: 40, email: 254, username: 60, text: 200 };

// A new custom field's id.
export function newContactId() {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `c${[...bytes].map((byte) => letters[byte % letters.length]).join('')}`;
}

function cleanLine(value, maximumLength) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength + 1);
}

// An event's fields as sent by the edit form: { ok: true, fields } in the
// stored shape, or { ok: false, field, index } naming what is wrong:
// 'contactFields' (not a list, a field twice, too many) or 'contactLabel'
// (a custom field's label blank or too long; index is its place in the
// list, from 0).
export function readContactFields(input) {
  if (input === undefined || input === null) {
    return { ok: true, fields: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, field: 'contactFields' };
  }
  const fields = [];
  const seen = new Set();
  let custom = 0;
  for (let index = 0; index < input.length; index += 1) {
    const each = input[index];
    if (!each || typeof each !== 'object') {
      return { ok: false, field: 'contactFields' };
    }
    let id = '';
    if (typeof each.id === 'string') {
      id = each.id;
    }
    if (seen.has(id)) {
      return { ok: false, field: 'contactFields' };
    }
    if (CONTACT_PRESETS.includes(id)) {
      seen.add(id);
      fields.push({ id, type: id, label: null });
      continue;
    }
    if (!CUSTOM_ID.test(id) || !CUSTOM_TYPES.includes(each.type)) {
      return { ok: false, field: 'contactFields' };
    }
    custom += 1;
    if (custom > MAX_CUSTOM_FIELDS) {
      return { ok: false, field: 'contactFields' };
    }
    const label = cleanLine(each.label, CONTACT_LABEL_MAX);
    if (label === '' || label.length > CONTACT_LABEL_MAX) {
      return { ok: false, field: 'contactLabel', index };
    }
    seen.add(id);
    fields.push({ id, type: each.type, label });
  }
  // The ready-made ones first, in their own order; then the editor's own.
  fields.sort((first, second) => presetOrder(first) - presetOrder(second));
  return { ok: true, fields };
}

function presetOrder(field) {
  const at = CONTACT_PRESETS.indexOf(field.id);
  if (at < 0) {
    return CONTACT_PRESETS.length;
  }
  return at;
}

// The rule as sent: one of CONTACT_RULES, or null for one that is not.
export function readContactRule(input) {
  if (input === undefined || input === null || input === '') {
    return DEFAULT_CONTACT_RULE;
  }
  if (CONTACT_RULES.includes(input)) {
    return input;
  }
  return null;
}

function isObject(value) {
  if (value === null) {
    return false;
  }
  return typeof value === 'object';
}

// An event row's fields, as stored, leaving out anything that is not one.
export function storedContactFields(row) {
  if (!row || !Array.isArray(row.contact_fields)) {
    return [];
  }
  const read = readContactFields(row.contact_fields.filter(isObject));
  if (!read.ok) {
    return [];
  }
  return read.fields;
}

export function storedContactRule(row) {
  let stored = null;
  if (row) {
    stored = row.contact_rule;
  }
  const rule = readContactRule(stored);
  if (rule === null) {
    return DEFAULT_CONTACT_RULE;
  }
  return rule;
}

// One value as typed, for a field of this type: { ok: true, value } in its
// stored form ('' when blank), or { ok: false }.
//   phone     digits, with spaces, dashes, dots, brackets and a leading +:
//             6 to 15 digits;
//   telegram  5 to 32 letters, digits and underscores, an @ in front or not
//             (stored without it), or a t.me link to one;
//   discord   2 to 32 lowercase letters, digits, underscores and dots
//             (stored lowercase), or an older Name#1234;
//   email     one @, a dotted domain, no spaces;
//   username  no spaces, up to 60;
//   text      anything, on one line, up to 200.
export function contactValue(type, input) {
  const maximum = VALUE_MAX[type];
  if (!maximum) {
    return { ok: false };
  }
  const raw = cleanLine(input, maximum + 20);
  if (raw === '') {
    return { ok: true, value: '' };
  }
  if (type === 'phone') {
    const digits = raw.replace(/\D/g, '');
    if (!/^\+?[\d\s().-]+$/.test(raw) || digits.length < 6 || digits.length > 15 || raw.length > maximum) {
      return { ok: false };
    }
    return { ok: true, value: raw };
  }
  if (type === 'telegram') {
    const name = raw.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) || name.endsWith('_')) {
      return { ok: false };
    }
    return { ok: true, value: name };
  }
  if (type === 'discord') {
    const name = raw.replace(/^@/, '');
    if (/^[^#@:]{2,32}#\d{4}$/.test(name)) {
      return { ok: true, value: name };
    }
    const lower = name.toLowerCase();
    if (!/^[a-z0-9_.]{2,32}$/.test(lower) || lower.includes('..')) {
      return { ok: false };
    }
    return { ok: true, value: lower };
  }
  if (type === 'email') {
    if (raw.length > maximum || !/^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(raw)) {
      return { ok: false };
    }
    return { ok: true, value: raw };
  }
  if (type === 'username') {
    if (raw.length > maximum || /\s/.test(raw)) {
      return { ok: false };
    }
    return { ok: true, value: raw };
  }
  if (raw.length > maximum) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

// What someone gave for an event's fields ({ id: typed value }), checked
// against the event's rule: { ok: true, contact } with every value in its
// stored form (blank ones left out), or { ok: false, error, field } with
// error 'contact_invalid' (field: the id of the first one that is not a
// valid value) or 'contact_required' (field: the first one still needed,
// for 'all'; null for 'any', where any one will do).
export function readContactAnswers(fields, rule, input) {
  let given = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    given = input;
  }
  const contact = {};
  for (const field of fields) {
    const read = contactValue(field.type, given[field.id]);
    if (!read.ok) {
      return { ok: false, error: 'contact_invalid', field: field.id };
    }
    if (read.value !== '') {
      contact[field.id] = read.value;
    }
  }
  if (fields.length > 0 && rule === 'all') {
    const missing = fields.find((field) => contact[field.id] === undefined);
    if (missing) {
      return { ok: false, error: 'contact_required', field: missing.id };
    }
  }
  if (fields.length > 0 && rule === 'any' && Object.keys(contact).length === 0) {
    return { ok: false, error: 'contact_required', field: null };
  }
  return { ok: true, contact };
}

// A stored RSVP's contact, with only the event's current fields' values.
export function storedContact(fields, raw) {
  const contact = {};
  if (!raw || typeof raw !== 'object') {
    return contact;
  }
  for (const field of fields) {
    if (typeof raw[field.id] === 'string' && raw[field.id] !== '') {
      contact[field.id] = raw[field.id];
    }
  }
  return contact;
}

// Whether a stored contact meets the event's rule (so someone who RSVPed
// before the event asked can be told to fill it in).
export function contactComplete(fields, rule, contact) {
  return readContactAnswers(fields, rule, contact).ok;
}

// A value as shown: a Telegram username with its @.
export function contactText(type, value) {
  if (type === 'telegram') {
    return `@${value}`;
  }
  return value;
}

// Where a value leads, for the attendee list: a phone number to call, an
// email to write to, a Telegram username's chat; '' for none (a Discord
// username has no address of its own).
export function contactHref(type, value) {
  if (type === 'phone') {
    return `tel:${value.replace(/[^\d+]/g, '')}`;
  }
  if (type === 'email') {
    return `mailto:${value}`;
  }
  if (type === 'telegram') {
    return `https://t.me/${value}`;
  }
  return '';
}
