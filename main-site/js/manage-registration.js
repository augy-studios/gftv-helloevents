// The "Registration form" section of the edit form (migrations/024,
// js/registration-fields.js holds the rules): switched on or off, the
// ready-made questions (each ticked to ask it, and required or not; the
// T-shirt sizes, the Code of Conduct's link and whether editors see a full
// date of birth can be changed), and up to MAX_CUSTOM_QUESTIONS of the
// editor's own, each a card with a label, a kind, a hint, required or not,
// and for a list its options. A card still without a label is not sent, so
// a new one is not refused while it is being named.
//
// While the event sells tiers, every question also says which tiers it is
// for (a T-shirt size only for the tiers with a shirt): one tick box per
// tier in the Price and RSVP tab's list, none ticked for every ticket. What
// is ticked is kept on the picker (data-reg-tiers, the tiers' ids), so
// turning tiers off and on again loses nothing. A question whose tiers have
// all been removed is asked of no one, and says so, until another is
// ticked.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';
import { REGISTRATION_PRESETS, ACCOUNT_PRESETS, CUSTOM_TYPES, MAX_CUSTOM_QUESTIONS, DEFAULT_TSHIRT_SIZES, LIMITS, defaultRegistrationFields, newQuestionId } from './registration-fields.js';

const byId = (id) => document.getElementById(id);
const customList = () => byId('registrationCustomList');

// The event's tiers as the edit form has them now: { on, tiers: [{ id, name
// }] } (on: a paid event selling tiers). Set by startRegistration.
let currentTiers = () => ({ on: false, tiers: [] });
let pickerCount = 0;

// Tells the edit form the questions changed without a field being left
// (one removed), so it autosaves them.
export const REGISTRATION_CHANGED = 'registration-changed';
function announceChange() {
  customList().dispatchEvent(new CustomEvent(REGISTRATION_CHANGED, { bubbles: true }));
}

// The ready-made questions whose "required" cannot be changed.
const FIXED_REQUIRED = ['guardian', 'conduct'];

// Which tiers a question is for: a tick box per tier, drawn by drawTiers.
function tierPicker(tiers) {
  let picked = [];
  if (Array.isArray(tiers)) {
    picked = tiers;
  }
  pickerCount += 1;
  const titleId = `regTiers-${pickerCount}`;
  return createElement('div', { class: 'reg-tiers', role: 'group', 'aria-labelledby': titleId, 'data-reg-tiers': JSON.stringify(picked) }, [
    createElement('span', { class: 'reg-tiers-title', id: titleId, 'data-reg-text': 'manage.registration-tiers' }),
    createElement('div', { class: 'reg-tiers-list' }),
    createElement('p', { class: 'callout warn small reg-tiers-gone', 'data-reg-text': 'manage.registration-tiers-gone', hidden: true }),
    createElement('span', { class: 'field-hint', 'data-reg-text': 'manage.registration-tiers-hint' }),
  ]);
}

function pickedTiers(picker) {
  try {
    const ids = JSON.parse(picker.dataset.regTiers);
    if (Array.isArray(ids)) {
      return ids.filter((id) => typeof id === 'string');
    }
  } catch {
    // A picker never set: none ticked.
  }
  return [];
}

// The tick boxes, one per tier as the form has them now, drawn again only
// when the tiers changed (so a box just ticked keeps its focus).
function drawTiers(picker, tiers) {
  const drawnFor = JSON.stringify(tiers);
  if (picker.dataset.drawnFor === drawnFor) {
    return;
  }
  picker.dataset.drawnFor = drawnFor;
  const picked = pickedTiers(picker);
  picker.querySelector('.reg-tiers-list').replaceChildren(...tiers.map((tier, index) => {
    const box = createElement('input', { type: 'checkbox', 'data-reg-tier': tier.id });
    box.checked = picked.includes(tier.id);
    let name = tier.name;
    if (!name) {
      name = translate('manage.tier-number', { number: index + 1 });
    }
    return createElement('label', { class: 'check small' }, [box, createElement('span', { text: name })]);
  }));
}

// Whether every tier a question was for has been removed from the list.
function tiersGone(picker, tiers) {
  const picked = pickedTiers(picker);
  if (picked.length === 0) {
    return false;
  }
  return !picked.some((id) => tiers.some((tier) => tier.id === id));
}

// What a picker sends: the tiers ticked, of those the event has now. All
// that were ticked go while tiers are off, to keep them for when they are
// on, and while all of them have been removed, so the question stays asked
// of no one rather than of every tier.
function readTierPicker(picker) {
  const state = currentTiers();
  const picked = pickedTiers(picker);
  if (!state.on || tiersGone(picker, state.tiers)) {
    return picked;
  }
  const ids = state.tiers.map((tier) => tier.id);
  return picked.filter((id) => ids.includes(id));
}

function presetRow(preset) {
  const on = createElement('input', { type: 'checkbox', 'data-reg-on': preset.id });
  const required = createElement('input', { type: 'checkbox', 'data-reg-required': preset.id });
  const head = [
    createElement('label', { class: 'check reg-preset-name' }, [on, createElement('span', { 'data-reg-label': preset.id })]),
  ];
  if (!FIXED_REQUIRED.includes(preset.id)) {
    head.push(createElement('label', { class: 'check small reg-preset-required' }, [required, createElement('span', { 'data-reg-required-text': '' })]));
  }
  const extras = [];
  if (ACCOUNT_PRESETS.includes(preset.id)) {
    extras.push(createElement('p', { class: 'field-hint', 'data-reg-hint': 'account' }));
  }
  if (preset.id === 'dateOfBirth') {
    extras.push(createElement('label', { class: 'check small' }, [
      createElement('input', { type: 'checkbox', 'data-reg-fulldate': '' }),
      createElement('span', { 'data-reg-text': 'manage.registration-full-date' }),
    ]));
  }
  if (preset.id === 'tshirt') {
    extras.push(createElement('label', { class: 'field' }, [
      createElement('span', { 'data-reg-text': 'manage.registration-sizes' }),
      createElement('textarea', { rows: '3', 'data-reg-options': preset.id, maxlength: '900' }),
      createElement('span', { class: 'field-hint', 'data-reg-text': 'manage.registration-options-hint' }),
    ]));
  }
  if (preset.id === 'conduct') {
    extras.push(createElement('label', { class: 'field' }, [
      createElement('span', { 'data-reg-text': 'manage.registration-conduct-link' }),
      createElement('input', { type: 'url', inputmode: 'url', placeholder: 'https://', maxlength: String(LIMITS.link), 'data-reg-link': preset.id }),
    ]));
  }
  if (preset.id === 'donation') {
    extras.push(createElement('p', { class: 'field-hint', 'data-reg-text': 'manage.registration-donation-hint' }));
  }
  const extraBox = createElement('div', { class: 'reg-preset-extras' }, extras);
  const row = createElement('div', { class: 'reg-preset', 'data-reg-preset': preset.id }, [
    createElement('div', { class: 'reg-preset-head' }, head),
    extraBox,
    tierPicker(null),
  ]);
  return row;
}

function syncPresetRow(row, tiersOn) {
  const on = row.querySelector('[data-reg-on]').checked;
  const extras = row.querySelector('.reg-preset-extras');
  extras.hidden = true;
  if (on && extras.children.length > 0) {
    extras.hidden = false;
  }
  row.querySelector('.reg-tiers').hidden = !(on && tiersOn);
  const required = row.querySelector('[data-reg-required]');
  if (required) {
    required.disabled = !on;
  }
}

// One of the editor's own questions.
function customCard(field) {
  const label = createElement('input', { type: 'text', 'data-key': 'label', maxlength: String(LIMITS.label), 'data-question-id': field.id });
  if (field.label) {
    label.value = field.label;
  }
  const type = createElement('select', { 'data-key': 'type' }, CUSTOM_TYPES.map((kind) => createElement('option', { value: kind })));
  type.value = field.type;
  const hint = createElement('input', { type: 'text', 'data-key': 'hint', maxlength: String(LIMITS.hint) });
  if (field.hint) {
    hint.value = field.hint;
  }
  const required = createElement('input', { type: 'checkbox', 'data-key': 'required' });
  required.checked = field.required === true;
  const options = createElement('textarea', { rows: '3', 'data-key': 'options', maxlength: '900' });
  if (Array.isArray(field.options)) {
    options.value = field.options.join('\n');
  }
  const link = createElement('input', { type: 'url', inputmode: 'url', placeholder: 'https://', maxlength: String(LIMITS.link), 'data-key': 'link' });
  if (field.link) {
    link.value = field.link;
  }
  const remove = createElement('button', { type: 'button', class: 'btn btn-small btn-quiet' }, [iconNode('trash'), createElement('span', { class: 'btn-label' })]);
  const card = createElement('div', { class: 'location-card reg-custom-card' }, [
    createElement('div', { class: 'row between' }, [createElement('h3', { class: 'section-label reg-custom-title' }), remove]),
    createElement('div', { class: 'form-grid' }, [
      createElement('label', { class: 'field' }, [createElement('span', { 'data-reg-text': 'manage.registration-question' }), label]),
      createElement('label', { class: 'field' }, [createElement('span', { 'data-reg-text': 'manage.registration-type' }), type]),
      createElement('label', { class: 'field span-2' }, [createElement('span', { 'data-reg-text': 'manage.registration-hint' }), hint]),
      createElement('label', { class: 'field span-2 reg-options-field' }, [
        createElement('span', { 'data-reg-text': 'manage.registration-options' }),
        options,
        createElement('span', { class: 'field-hint', 'data-reg-text': 'manage.registration-options-hint' }),
      ]),
      createElement('label', { class: 'field span-2 reg-link-field' }, [createElement('span', { 'data-reg-text': 'manage.registration-link' }), link]),
      createElement('label', { class: 'check span-2 reg-required-field' }, [required, createElement('span', { 'data-reg-text': 'manage.registration-required' })]),
    ]),
    tierPicker(field.tiers),
  ]);
  type.addEventListener('change', () => syncCustom(card));
  remove.addEventListener('click', () => {
    const next = card.nextElementSibling;
    card.remove();
    relabelRegistration();
    syncAdd();
    if (next) {
      next.querySelector('input').focus();
    } else {
      byId('registrationAdd').focus();
    }
    announceChange();
  });
  syncCustom(card);
  return card;
}

function syncCustom(card) {
  const type = card.querySelector('[data-key="type"]').value;
  card.querySelector('.reg-options-field').hidden = type !== 'choice';
  card.querySelector('.reg-link-field').hidden = type !== 'checkbox';
}

function syncAdd() {
  byId('registrationAdd').hidden = customList().children.length >= MAX_CUSTOM_QUESTIONS;
}

// The section shown, or only its switch while the form is off; the tier
// pickers only while the event sells tiers, each listing them as they are
// now in the Price and RSVP tab.
export function syncRegistration() {
  byId('registrationFieldsBox').hidden = !byId('f-registrationEnabled').checked;
  const state = currentTiers();
  let tiersOn = false;
  if (state.on && state.tiers.length > 0) {
    tiersOn = true;
  }
  for (const picker of byId('registrationSection').querySelectorAll('.reg-tiers')) {
    if (tiersOn) {
      drawTiers(picker, state.tiers);
    }
    picker.hidden = !tiersOn;
    picker.querySelector('.reg-tiers-gone').hidden = !tiersGone(picker, state.tiers);
  }
  for (const row of byId('registrationPresets').children) {
    syncPresetRow(row, tiersOn);
  }
}

// The form from an event as the server sent it (registrationFields: the
// questions as configured, the defaults for one never set up).
export function setRegistration(values) {
  byId('f-registrationEnabled').checked = values.registrationEnabled === true;
  let fields = values.registrationFields;
  if (!Array.isArray(fields)) {
    fields = defaultRegistrationFields();
  }
  for (const preset of REGISTRATION_PRESETS) {
    const row = byId('registrationPresets').querySelector(`[data-reg-preset="${preset.id}"]`);
    const field = fields.find((each) => each.id === preset.id);
    row.querySelector('[data-reg-on]').checked = Boolean(field);
    const required = row.querySelector('[data-reg-required]');
    if (required) {
      let isRequired = preset.required;
      if (field) {
        isRequired = field.required;
      }
      required.checked = isRequired;
    }
    const options = row.querySelector('[data-reg-options]');
    if (options) {
      let sizes = DEFAULT_TSHIRT_SIZES;
      if (field && field.options.length > 0) {
        sizes = field.options;
      }
      options.value = sizes.join('\n');
    }
    const link = row.querySelector('[data-reg-link]');
    if (link) {
      let address = '';
      if (field && field.link) {
        address = field.link;
      }
      link.value = address;
    }
    const fullDate = row.querySelector('[data-reg-fulldate]');
    if (fullDate) {
      fullDate.checked = false;
      if (field && field.fullDate) {
        fullDate.checked = true;
      }
    }
    const picker = row.querySelector('.reg-tiers');
    let tiers = [];
    if (field && Array.isArray(field.tiers)) {
      tiers = field.tiers;
    }
    picker.dataset.regTiers = JSON.stringify(tiers);
    delete picker.dataset.drawnFor;
  }
  customList().replaceChildren();
  for (const field of fields) {
    if (!REGISTRATION_PRESETS.some((preset) => preset.id === field.id)) {
      customList().append(customCard(field));
    }
  }
  relabelRegistration();
  syncAdd();
  syncRegistration();
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

// What to send: { registrationEnabled, registrationFields }.
export function readRegistration() {
  const registrationFields = [];
  for (const row of byId('registrationPresets').children) {
    if (!row.querySelector('[data-reg-on]').checked) {
      continue;
    }
    const entry = { id: row.dataset.regPreset };
    const required = row.querySelector('[data-reg-required]');
    if (required) {
      entry.required = required.checked;
    }
    const options = row.querySelector('[data-reg-options]');
    if (options) {
      entry.options = lines(options.value);
    }
    const link = row.querySelector('[data-reg-link]');
    if (link) {
      entry.link = link.value.trim();
    }
    const fullDate = row.querySelector('[data-reg-fulldate]');
    if (fullDate) {
      entry.fullDate = fullDate.checked;
    }
    entry.tiers = readTierPicker(row.querySelector('.reg-tiers'));
    registrationFields.push(entry);
  }
  for (const card of customList().children) {
    const label = card.querySelector('[data-key="label"]');
    if (label.value.trim() === '') {
      continue;
    }
    const type = card.querySelector('[data-key="type"]').value;
    const entry = {
      id: label.dataset.questionId,
      type,
      label: label.value.trim(),
      hint: card.querySelector('[data-key="hint"]').value.trim(),
      required: card.querySelector('[data-key="required"]').checked,
    };
    if (type === 'choice') {
      entry.options = lines(card.querySelector('[data-key="options"]').value);
    }
    if (type === 'checkbox') {
      entry.link = card.querySelector('[data-key="link"]').value.trim();
    }
    entry.tiers = readTierPicker(card.querySelector('.reg-tiers'));
    registrationFields.push(entry);
  }
  return { registrationEnabled: byId('f-registrationEnabled').checked, registrationFields };
}

// Every label in the reader's language, the cards numbered as they now are.
export function relabelRegistration() {
  for (const node of byId('registrationSection').querySelectorAll('[data-reg-label]')) {
    node.textContent = translate(`registration.preset.${node.dataset.regLabel}`);
  }
  for (const node of byId('registrationSection').querySelectorAll('[data-reg-required-text]')) {
    node.textContent = translate('manage.registration-required');
  }
  for (const node of byId('registrationSection').querySelectorAll('[data-reg-hint="account"]')) {
    node.textContent = translate('manage.registration-account-hint');
  }
  for (const node of byId('registrationSection').querySelectorAll('[data-reg-text]')) {
    node.textContent = translate(node.dataset.regText);
  }
  // Untitled tiers read "Tier 1" in the reader's language.
  for (const picker of byId('registrationSection').querySelectorAll('.reg-tiers')) {
    delete picker.dataset.drawnFor;
  }
  syncRegistration();
  [...customList().children].forEach((card, index) => {
    card.querySelector('.reg-custom-title').textContent = translate('manage.registration-custom-title', { number: index + 1 });
    card.querySelector('.btn-label').textContent = translate('security.remove');
    for (const option of card.querySelector('[data-key="type"]').options) {
      option.textContent = translate(`manage.registration-kind.${option.value}`);
    }
  });
}

// getTiers: the event's tiers as the edit form has them now ({ on, tiers:
// [{ id, name }] }).
export function startRegistration({ getTiers } = {}) {
  if (getTiers) {
    currentTiers = getTiers;
  }
  byId('registrationPresets').replaceChildren(...REGISTRATION_PRESETS.map(presetRow));
  // A tier ticked or unticked is kept on its picker before the form saves.
  byId('registrationSection').addEventListener('change', (event) => {
    const tier = event.target.dataset.regTier;
    if (tier === undefined) {
      return;
    }
    // Ticking afresh: the tiers since removed go.
    const picker = event.target.closest('.reg-tiers');
    const ids = currentTiers().tiers.map((each) => each.id);
    const picked = pickedTiers(picker).filter((id) => {
      if (id === tier) {
        return false;
      }
      return ids.includes(id);
    });
    if (event.target.checked) {
      picked.push(tier);
    }
    picker.dataset.regTiers = JSON.stringify(picked);
    picker.querySelector('.reg-tiers-gone').hidden = true;
  });
  byId('registrationAdd').addEventListener('click', () => {
    if (customList().children.length >= MAX_CUSTOM_QUESTIONS) {
      return;
    }
    const card = customCard({ id: newQuestionId(), type: 'text', label: '', hint: '', required: false, options: [], tiers: null });
    customList().append(card);
    relabelRegistration();
    syncAdd();
    card.querySelector('input').focus();
  });
  byId('registrationSection').addEventListener('change', syncRegistration);
  relabelRegistration();
}
