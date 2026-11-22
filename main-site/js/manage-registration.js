// The "Registration form" section of the edit form (migrations/024,
// js/registration-fields.js holds the rules): switched on or off, the
// ready-made questions (each ticked to ask it, and required or not; the
// T-shirt sizes, the Code of Conduct's link and whether editors see a full
// date of birth can be changed), and up to MAX_CUSTOM_QUESTIONS of the
// editor's own, each a card with a label, a kind, a hint, required or not,
// and for a list its options. A card still without a label is not sent, so
// a new one is not refused while it is being named.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';
import { REGISTRATION_PRESETS, ACCOUNT_PRESETS, CUSTOM_TYPES, MAX_CUSTOM_QUESTIONS, DEFAULT_TSHIRT_SIZES, LIMITS, defaultRegistrationFields, newQuestionId } from './registration-fields.js';

const byId = (id) => document.getElementById(id);
const customList = () => byId('registrationCustomList');

// Tells the edit form the questions changed without a field being left
// (one removed), so it autosaves them.
export const REGISTRATION_CHANGED = 'registration-changed';
function announceChange() {
  customList().dispatchEvent(new CustomEvent(REGISTRATION_CHANGED, { bubbles: true }));
}

// The ready-made questions whose "required" cannot be changed.
const FIXED_REQUIRED = ['guardian', 'conduct'];

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
  ]);
  return row;
}

function syncPresetRow(row) {
  const on = row.querySelector('[data-reg-on]').checked;
  const extras = row.querySelector('.reg-preset-extras');
  extras.hidden = true;
  if (on && extras.children.length > 0) {
    extras.hidden = false;
  }
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

// The section shown, or only its switch while the form is off.
export function syncRegistration() {
  byId('registrationFieldsBox').hidden = !byId('f-registrationEnabled').checked;
  for (const row of byId('registrationPresets').children) {
    syncPresetRow(row);
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
  [...customList().children].forEach((card, index) => {
    card.querySelector('.reg-custom-title').textContent = translate('manage.registration-custom-title', { number: index + 1 });
    card.querySelector('.btn-label').textContent = translate('security.remove');
    for (const option of card.querySelector('[data-key="type"]').options) {
      option.textContent = translate(`manage.registration-kind.${option.value}`);
    }
  });
}

export function startRegistration() {
  byId('registrationPresets').replaceChildren(...REGISTRATION_PRESETS.map(presetRow));
  byId('registrationAdd').addEventListener('click', () => {
    if (customList().children.length >= MAX_CUSTOM_QUESTIONS) {
      return;
    }
    const card = customCard({ id: newQuestionId(), type: 'text', label: '', hint: '', required: false, options: [] });
    customList().append(card);
    relabelRegistration();
    syncAdd();
    card.querySelector('input').focus();
  });
  byId('registrationSection').addEventListener('change', syncRegistration);
  relabelRegistration();
}
