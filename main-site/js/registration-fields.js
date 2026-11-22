// Registration forms (migrations/024): the one set of rules, used in the
// browser (the edit form, the RSVP and checkout forms, the "Registration
// details" card) and on the server (event-rules.js when an event is saved,
// api/events/rsvp.js when someone registers or changes an answer). Nothing
// here touches the DOM or Node.
//
// An event's editor switches the form on (registration_enabled) and picks
// its questions (registration_fields):
//   - ready-made ones (REGISTRATION_PRESETS), each switched on or off, and
//     required or not; the T-shirt sizes and the Code of Conduct's link can
//     be changed. Three of them come from the person's account, not the
//     form (legal name, date of birth, emergency contact): the form only
//     says whether the event needs them, and editors then see them;
//   - up to MAX_CUSTOM_QUESTIONS of their own, each with a label, a hint,
//     a type (CUSTOM_TYPES), and for a choice its options.
// Any question can be asked of every ticket (tiers null) or only of the
// people holding some of the event's tiers (tiers: their ids), such as a
// T-shirt size for the tiers that come with a shirt. Only a paid event asks
// a form at all.
// A list never set up (registration_fields null) is the ready-made defaults.
// What each person answered is stored on their RSVP as registration
// ({ question id: answer }), seen only by them and the event's editors.

import { contactValue } from './contact-fields.js';

// The ready-made questions, in the order the form asks them. place 'end'
// ones come after the editor's own questions. account: the answer is on the
// person's account. on: switched on in a new form.
export const REGISTRATION_PRESETS = Object.freeze([
  { id: 'legalName', type: 'account', on: false, required: true },
  { id: 'dateOfBirth', type: 'account', on: false, required: true },
  { id: 'emergencyContact', type: 'account', on: false, required: true },
  { id: 'badgeName', type: 'text', on: true, required: true },
  { id: 'nfcUrl', type: 'url', on: true, required: false },
  { id: 'fursuiting', type: 'yesno', on: true, required: true },
  { id: 'handlers', type: 'text', on: true, required: false },
  { id: 'badgePhoto', type: 'photo', on: true, required: true },
  { id: 'tshirt', type: 'choice', on: true, required: true },
  { id: 'guardian', type: 'checkbox', on: true, required: false },
  { id: 'donation', type: 'amount', on: true, required: false, place: 'end' },
  { id: 'conduct', type: 'agreement', on: true, required: true, place: 'end' },
]);
export const PRESET_IDS = REGISTRATION_PRESETS.map((preset) => preset.id);
export const ACCOUNT_PRESETS = ['legalName', 'dateOfBirth', 'emergencyContact'];
// Ready-made questions whose "required" cannot be changed: ticking "I will
// be accompanying a minor" can never be required, and the Code of Conduct
// always has to be accepted.
const FIXED_REQUIRED = { guardian: false, conduct: true };
export const DEFAULT_TSHIRT_SIZES = Object.freeze(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);

export const CUSTOM_TYPES = ['text', 'paragraph', 'url', 'yesno', 'choice', 'checkbox', 'photo'];
export const MAX_CUSTOM_QUESTIONS = 10;
// The most tiers one question can name (an event has at most 10).
export const MAX_QUESTION_TIERS = 10;
// A tier's id, as api/_lib/event-rules.js keeps it.
const TIER_ID = /^t-[a-z0-9]{4,16}$/;
export const MAX_OPTIONS = 20;
export const LIMITS = Object.freeze({ label: 80, hint: 200, option: 40, link: 500 });
const VALUE_MAX = { text: 200, paragraph: 1000, url: 300, badgeName: 40, handlers: 100 };
export const MAX_DONATION = 100000;
export const ACCOUNT_LIMITS = Object.freeze({ legalName: 100, emergencyName: 100 });

const CUSTOM_ID = /^q[a-z0-9]{6}$/;
// A photo answer is the name its file was stored under
// (reg/<event>/<account>/<name>.webp, api/_lib/payments.js).
export const PHOTO_NAME = /^[A-Za-z0-9_-]{16,64}$/;

// A new question's id.
export function newQuestionId() {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `q${[...bytes].map((byte) => letters[byte % letters.length]).join('')}`;
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

// Lines kept (a paragraph), every other control character a space.
function cleanParagraph(value, maximumLength) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximumLength + 1);
}

// An https:// address: { ok: true, url } (url null when blank) or { ok:
// false }.
export function httpsAddress(input, maximumLength = LIMITS.link) {
  const raw = cleanLine(input, maximumLength + 10);
  if (raw === '') {
    return { ok: true, url: null };
  }
  if (raw.length > maximumLength || !/^https:\/\//i.test(raw)) {
    return { ok: false };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.') || parsed.username || parsed.password) {
    return { ok: false };
  }
  return { ok: true, url: raw };
}

function presetOf(id) {
  return REGISTRATION_PRESETS.find((preset) => preset.id === id);
}

function readOptions(input) {
  if (!Array.isArray(input)) {
    return null;
  }
  const options = [];
  for (const each of input) {
    const option = cleanLine(each, LIMITS.option);
    if (option === '') {
      continue;
    }
    if (option.length > LIMITS.option) {
      return null;
    }
    if (!options.includes(option)) {
      options.push(option);
    }
  }
  if (options.length > MAX_OPTIONS) {
    return null;
  }
  return options;
}

// The tiers a question is asked of, as sent: { ok: true, tiers } (null for
// every ticket, as for none ticked) or { ok: false }.
function readQuestionTiers(input) {
  if (input === undefined || input === null) {
    return { ok: true, tiers: null };
  }
  if (!Array.isArray(input) || input.length > MAX_QUESTION_TIERS) {
    return { ok: false };
  }
  const tiers = [];
  for (const id of input) {
    if (typeof id !== 'string' || !TIER_ID.test(id)) {
      return { ok: false };
    }
    if (!tiers.includes(id)) {
      tiers.push(id);
    }
  }
  if (tiers.length === 0) {
    return { ok: true, tiers: null };
  }
  return { ok: true, tiers };
}

// One ready-made question in the stored shape.
function presetEntry(preset, each = {}) {
  let required = preset.required;
  if (typeof each.required === 'boolean') {
    required = each.required;
  }
  if (FIXED_REQUIRED[preset.id] !== undefined) {
    required = FIXED_REQUIRED[preset.id];
  }
  const entry = { id: preset.id, type: preset.type, label: null, hint: '', required, options: [], link: null, fullDate: false, tiers: null };
  if (preset.id === 'tshirt') {
    entry.options = [...DEFAULT_TSHIRT_SIZES];
  }
  if (preset.id === 'dateOfBirth') {
    entry.fullDate = each.fullDate === true;
  }
  return entry;
}

// The questions as sent by the edit form: { ok: true, fields } in the
// stored shape and order, or { ok: false, field, index } naming what is
// wrong: 'registrationFields' (not a list, a question twice, too many),
// 'registrationLabel' (one of the editor's own without a label, or too
// long), 'registrationHint', 'registrationOptions' (a choice with fewer than
// two options, or too many), 'registrationLink' (a link that is not
// https://) or 'registrationTiers' (tiers that are not a list of tier ids).
// index is the question's place in the list sent, from 0.
export function readRegistrationFields(input) {
  if (input === undefined || input === null) {
    return { ok: true, fields: [] };
  }
  if (!Array.isArray(input) || input.length > PRESET_IDS.length + MAX_CUSTOM_QUESTIONS) {
    return { ok: false, field: 'registrationFields' };
  }
  const presets = new Map();
  const custom = [];
  const seen = new Set();
  for (let index = 0; index < input.length; index += 1) {
    const each = input[index];
    if (!each || typeof each !== 'object' || Array.isArray(each)) {
      return { ok: false, field: 'registrationFields' };
    }
    let id = '';
    if (typeof each.id === 'string') {
      id = each.id;
    }
    if (seen.has(id)) {
      return { ok: false, field: 'registrationFields' };
    }
    seen.add(id);
    const tiers = readQuestionTiers(each.tiers);
    if (!tiers.ok) {
      return { ok: false, field: 'registrationTiers', index };
    }
    const preset = presetOf(id);
    if (preset) {
      const entry = presetEntry(preset, each);
      entry.tiers = tiers.tiers;
      if (id === 'tshirt' && each.options !== undefined) {
        const options = readOptions(each.options);
        if (options === null || options.length < 2) {
          return { ok: false, field: 'registrationOptions', index };
        }
        entry.options = options;
      }
      if (id === 'conduct') {
        const link = httpsAddress(each.link);
        if (!link.ok) {
          return { ok: false, field: 'registrationLink', index };
        }
        entry.link = link.url;
      }
      presets.set(id, entry);
      continue;
    }
    if (!CUSTOM_ID.test(id) || !CUSTOM_TYPES.includes(each.type)) {
      return { ok: false, field: 'registrationFields' };
    }
    if (custom.length >= MAX_CUSTOM_QUESTIONS) {
      return { ok: false, field: 'registrationFields' };
    }
    const label = cleanLine(each.label, LIMITS.label);
    if (label === '' || label.length > LIMITS.label) {
      return { ok: false, field: 'registrationLabel', index };
    }
    const hint = cleanLine(each.hint, LIMITS.hint);
    if (hint.length > LIMITS.hint) {
      return { ok: false, field: 'registrationHint', index };
    }
    const entry = { id, type: each.type, label, hint, required: each.required === true, options: [], link: null, fullDate: false, tiers: tiers.tiers };
    if (each.type === 'choice') {
      const options = readOptions(each.options);
      if (options === null || options.length < 2) {
        return { ok: false, field: 'registrationOptions', index };
      }
      entry.options = options;
    }
    if (each.type === 'checkbox') {
      const link = httpsAddress(each.link);
      if (!link.ok) {
        return { ok: false, field: 'registrationLink', index };
      }
      entry.link = link.url;
    }
    custom.push(entry);
  }
  const fields = [];
  for (const preset of REGISTRATION_PRESETS) {
    if (preset.place === 'end') {
      continue;
    }
    if (presets.has(preset.id)) {
      fields.push(presets.get(preset.id));
    }
  }
  fields.push(...custom);
  for (const preset of REGISTRATION_PRESETS) {
    if (preset.place === 'end' && presets.has(preset.id)) {
      fields.push(presets.get(preset.id));
    }
  }
  return { ok: true, fields };
}

// The questions a new form starts with: every ready-made one switched on
// by default.
export function defaultRegistrationFields() {
  return REGISTRATION_PRESETS.filter((preset) => preset.on).map((preset) => presetEntry(preset));
}

function isObject(value) {
  if (value === null) {
    return false;
  }
  return typeof value === 'object';
}

// An event row's questions as the edit form shows them, whether the form is
// switched on or not: the defaults while they were never set up.
export function configuredRegistrationFields(row) {
  if (!row || row.registration_fields === null || row.registration_fields === undefined) {
    return defaultRegistrationFields();
  }
  if (!Array.isArray(row.registration_fields)) {
    return [];
  }
  const read = readRegistrationFields(row.registration_fields.filter(isObject));
  if (!read.ok) {
    return [];
  }
  return read.fields;
}

// The questions an event asks the people going: none while its form is off,
// and none at an event that is not paid (the form goes with a ticket; a
// donation is added to its total, in the event's currency). Each still
// names the tiers it is for: api/_lib/event-rules.js registrationFieldsFor
// says which of them someone is asked.
export function storedRegistrationFields(row) {
  if (!row || row.registration_enabled !== true || row.price_type !== 'paid') {
    return [];
  }
  return configuredRegistrationFields(row);
}

export function asksRegistration(row) {
  return storedRegistrationFields(row).length > 0;
}

// Whether an event's form asks "Are you fursuiting?" (its answer is kept in
// the fursuiter flag too, migrations/023).
export function registrationAsksFursuiting(row) {
  return storedRegistrationFields(row).some((field) => field.id === 'fursuiting');
}

// The questions asked of someone holding these tiers, or about to: held
// lists the tiers (as the questions' tiers name them, each tier with the
// ones it includes). A question for some tiers only is asked of someone
// holding one of them (none at all: of no one); one for every ticket (tiers
// null) of everyone.
export function questionsAskedOf(fields, held) {
  return fields.filter((field) => {
    if (!Array.isArray(field.tiers)) {
      return true;
    }
    return field.tiers.some((tier) => held.includes(tier));
  });
}

// What a page asks someone about to get a ticket for these tiers (places:
// their places in the tier list, as the event page and checkout have the
// questions' tiers; none for an RSVP with no tier): the questions, and of
// the account details their account lacks (accountMissing), those the
// questions need.
export function askedForPicks(fields, accountMissing, places) {
  const asked = questionsAskedOf(fields, places);
  return {
    fields: asked,
    accountMissing: accountMissing.filter((id) => asked.some((field) => field.id === id)),
  };
}

// The questions answered on the form itself (not the account ones).
export function formQuestions(fields) {
  return fields.filter((field) => field.type !== 'account');
}

// One answer as typed, for a question: { ok: true, value } in its stored
// form ('' when blank), or { ok: false }.
//   text       one line: a badge name up to 40, handler names up to 100,
//              anything else up to 200;
//   paragraph  lines kept, up to 1000;
//   url        an https:// address, up to 300;
//   yesno      'yes' or 'no';
//   choice     one of the question's options, exactly;
//   checkbox, agreement   true when ticked;
//   photo      the name a photo was stored under;
//   amount     a donation: 0 to MAX_DONATION, to the cent (0 is blank).
export function answerValue(field, input) {
  if (input === undefined || input === null || input === false || input === '') {
    return { ok: true, value: '' };
  }
  const type = field.type;
  if (type === 'text') {
    let maximum = VALUE_MAX.text;
    if (VALUE_MAX[field.id]) {
      maximum = VALUE_MAX[field.id];
    }
    const value = cleanLine(input, maximum);
    if (value.length > maximum) {
      return { ok: false };
    }
    return { ok: true, value };
  }
  if (type === 'paragraph') {
    const value = cleanParagraph(input, VALUE_MAX.paragraph);
    if (value.length > VALUE_MAX.paragraph) {
      return { ok: false };
    }
    return { ok: true, value };
  }
  if (type === 'url') {
    const read = httpsAddress(input, VALUE_MAX.url);
    if (!read.ok) {
      return { ok: false };
    }
    if (read.url === null) {
      return { ok: true, value: '' };
    }
    return { ok: true, value: read.url };
  }
  if (type === 'yesno') {
    if (input === 'yes' || input === 'no') {
      return { ok: true, value: input };
    }
    return { ok: false };
  }
  if (type === 'choice') {
    if (typeof input === 'string' && field.options.includes(input)) {
      return { ok: true, value: input };
    }
    return { ok: false };
  }
  if (type === 'checkbox' || type === 'agreement') {
    if (input === true) {
      return { ok: true, value: true };
    }
    return { ok: false };
  }
  if (type === 'photo') {
    if (typeof input === 'string' && PHOTO_NAME.test(input)) {
      return { ok: true, value: input };
    }
    return { ok: false };
  }
  if (type === 'amount') {
    const text = String(input).replace(/[,\s]/g, '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
      return { ok: false };
    }
    const amount = Math.round(Number(text) * 100) / 100;
    if (!Number.isFinite(amount) || amount > MAX_DONATION) {
      return { ok: false };
    }
    if (amount === 0) {
      return { ok: true, value: '' };
    }
    return { ok: true, value: amount };
  }
  return { ok: false };
}

// A stored RSVP's answers, with only the form's current questions' (and
// each still a valid answer: a T-shirt size taken off the list is dropped).
export function storedAnswers(fields, raw) {
  const answers = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return answers;
  }
  for (const field of formQuestions(fields)) {
    const read = answerValue(field, raw[field.id]);
    if (read.ok && read.value !== '') {
      answers[field.id] = read.value;
    }
  }
  return answers;
}

// What someone sent for an event's form ({ question id: answer }), merged
// over what they answered before (previous, as stored: a change can send
// just the answers it changes), and checked: { ok: true, answers } with
// every answer in its stored form (blank ones left out), or { ok: false,
// error, field } with error 'registration_invalid' (an answer that is not
// a valid one) or 'registration_required' (a required question still
// unanswered), field its id.
export function readRegistrationAnswers(fields, input, previous = {}) {
  let given = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    given = input;
  }
  const answers = {};
  for (const field of formQuestions(fields)) {
    let typed = previous[field.id];
    if (Object.hasOwn(given, field.id)) {
      typed = given[field.id];
    }
    const read = answerValue(field, typed);
    if (!read.ok) {
      return { ok: false, error: 'registration_invalid', field: field.id };
    }
    if (read.value !== '') {
      answers[field.id] = read.value;
    }
  }
  for (const field of formQuestions(fields)) {
    if (field.required && answers[field.id] === undefined) {
      return { ok: false, error: 'registration_required', field: field.id };
    }
  }
  return { ok: true, answers };
}

// Whether stored answers meet the form (so someone who registered before a
// question was added is told to answer it).
export function answersComplete(fields, answers) {
  return readRegistrationAnswers(fields, {}, answers).ok;
}

// The photo questions' answers, for deleting their files.
export function photoNames(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }
  return Object.values(raw).filter((value) => {
    if (typeof value !== 'string') {
      return false;
    }
    return PHOTO_NAME.test(value);
  });
}

// ---------------------------------------------------------------------------
// Personal details on the account (migrations/024)
// ---------------------------------------------------------------------------

// A legal name or an emergency contact's name: one line, 1 to 100
// characters: { ok: true, value } ('' when blank) or { ok: false }.
export function personName(input) {
  const value = cleanLine(input, ACCOUNT_LIMITS.legalName);
  if ([...value].length > ACCOUNT_LIMITS.legalName) {
    return { ok: false };
  }
  return { ok: true, value };
}

// A date of birth, 'YYYY-MM-DD', a real day from 1900 to today:
// { ok: true, value } ('' when blank) or { ok: false }.
export function birthDate(input, today = new Date()) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: '' };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input));
  if (!match) {
    return { ok: false };
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false };
  }
  const todayText = today.toISOString().slice(0, 10);
  if (year < 1900 || match[0] > todayText) {
    return { ok: false };
  }
  return { ok: true, value: match[0] };
}

// An emergency contact's number, as contact-fields.js checks a phone.
export function emergencyPhone(input) {
  return contactValue('phone', input);
}

// Age in whole years on a day ('YYYY-MM-DD' both), or null.
export function ageOn(dateOfBirth, day) {
  if (!dateOfBirth || !day) {
    return null;
  }
  const born = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth);
  const on = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!born || !on) {
    return null;
  }
  let age = Number(on[1]) - Number(born[1]);
  if (on[2] < born[2] || (on[2] === born[2] && on[3] < born[3])) {
    age -= 1;
  }
  return age;
}

// Which of the account details an event's form requires are missing from
// this account (personal: { legalName, dateOfBirth, emergencyName,
// emergencyPhone }, each null when blank): a list of preset ids.
export function missingAccountDetails(fields, given = {}) {
  let personal = given;
  if (personal === null || personal === undefined) {
    personal = {};
  }
  const missing = [];
  for (const field of fields) {
    if (field.type !== 'account' || !field.required) {
      continue;
    }
    if (field.id === 'legalName' && !personal.legalName) {
      missing.push(field.id);
    }
    if (field.id === 'dateOfBirth' && !personal.dateOfBirth) {
      missing.push(field.id);
    }
    if (field.id === 'emergencyContact' && (!personal.emergencyName || !personal.emergencyPhone)) {
      missing.push(field.id);
    }
  }
  return missing;
}
