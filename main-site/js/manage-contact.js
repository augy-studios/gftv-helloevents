// The "Contact details" section of the edit form (migrations/021,
// js/contact-fields.js holds the rules): which ways to reach them the
// people going are asked for, and what they must give. A phone number, a
// Telegram username and a Discord username are tick boxes; up to
// MAX_CUSTOM_FIELDS more are the editor's own, one row each, with a label
// and the kind of value typed in it. A row still without a label is not
// sent, so a new one is not refused while it is being named.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';
import { CONTACT_PRESETS, CUSTOM_TYPES, MAX_CUSTOM_FIELDS, CONTACT_LABEL_MAX, DEFAULT_CONTACT_RULE, newContactId } from './contact-fields.js';

const byId = (id) => document.getElementById(id);
const list = () => byId('contactCustomList');

// Tells the edit form the fields changed without a field being left (one
// removed), so it autosaves them.
export const CONTACT_CHANGED = 'contact-changed';
function announceChange() {
  list().dispatchEvent(new CustomEvent(CONTACT_CHANGED, { bubbles: true }));
}

function presetBox(id) {
  return document.querySelector(`[data-contact-preset="${id}"]`);
}

// One of the editor's own fields: its label, its kind, and Remove.
function customRow(field) {
  const number = list().children.length + 1;
  const label = createElement('input', {
    type: 'text',
    class: 'contact-custom-label',
    maxlength: String(CONTACT_LABEL_MAX),
    placeholder: translate('manage.contact-custom-placeholder'),
    'aria-label': translate('manage.contact-custom-label', { number }),
    'data-contact-id': field.id,
  });
  if (field.label) {
    label.value = field.label;
  }
  const type = createElement('select', {
    class: 'contact-custom-type',
    'aria-label': translate('manage.contact-custom-type', { number }),
  }, CUSTOM_TYPES.map((kind) => createElement('option', { value: kind, text: translate(`manage.contact-type.${kind}`) })));
  type.value = field.type;
  const remove = createElement('button', {
    type: 'button',
    class: 'btn btn-small btn-quiet',
    'aria-label': translate('manage.contact-custom-remove', { number }),
  }, [iconNode('trash'), createElement('span', { text: translate('manage.contact-remove') })]);
  const row = createElement('div', { class: 'contact-custom-row' }, [label, type, remove]);
  remove.addEventListener('click', () => {
    const next = row.nextElementSibling;
    row.remove();
    relabelContact();
    syncAdd();
    if (next) {
      next.querySelector('input').focus();
    } else {
      byId('contactAdd').focus();
    }
    announceChange();
  });
  return row;
}

function syncAdd() {
  byId('contactAdd').hidden = list().children.length >= MAX_CUSTOM_FIELDS;
  let any = list().children.length > 0;
  for (const id of CONTACT_PRESETS) {
    if (presetBox(id).checked) {
      any = true;
    }
  }
  // The rule means something only once a field is asked for.
  byId('f-contactRule').disabled = !any;
}

// The fields and rule from an event as the server sent it.
export function setContact(values) {
  let fields = values.contactFields;
  if (!Array.isArray(fields)) {
    fields = [];
  }
  for (const id of CONTACT_PRESETS) {
    presetBox(id).checked = fields.some((field) => field.id === id);
  }
  list().replaceChildren();
  for (const field of fields) {
    if (!CONTACT_PRESETS.includes(field.id)) {
      list().append(customRow(field));
    }
  }
  let rule = values.contactRule;
  if (!rule) {
    rule = DEFAULT_CONTACT_RULE;
  }
  byId('f-contactRule').value = rule;
  syncAdd();
}

// The fields and rule to send: { contactFields, contactRule }.
export function readContact() {
  const contactFields = [];
  for (const id of CONTACT_PRESETS) {
    if (presetBox(id).checked) {
      contactFields.push({ id });
    }
  }
  for (const row of list().children) {
    const label = row.querySelector('.contact-custom-label');
    if (label.value.trim() === '') {
      continue;
    }
    contactFields.push({ id: label.dataset.contactId, type: row.querySelector('.contact-custom-type').value, label: label.value.trim() });
  }
  return { contactFields, contactRule: byId('f-contactRule').value };
}

// Each row's names, in the reader's language and numbered as they now are.
export function relabelContact() {
  [...list().children].forEach((row, index) => {
    const number = index + 1;
    row.querySelector('.contact-custom-label').setAttribute('aria-label', translate('manage.contact-custom-label', { number }));
    row.querySelector('.contact-custom-label').placeholder = translate('manage.contact-custom-placeholder');
    const type = row.querySelector('.contact-custom-type');
    type.setAttribute('aria-label', translate('manage.contact-custom-type', { number }));
    for (const option of type.options) {
      option.textContent = translate(`manage.contact-type.${option.value}`);
    }
    row.querySelector('button').setAttribute('aria-label', translate('manage.contact-custom-remove', { number }));
    row.querySelector('button span').textContent = translate('manage.contact-remove');
  });
}

export function startContact() {
  byId('contactAdd').addEventListener('click', () => {
    if (list().children.length >= MAX_CUSTOM_FIELDS) {
      return;
    }
    const row = customRow({ id: newContactId(), type: 'text', label: '' });
    list().append(row);
    syncAdd();
    row.querySelector('input').focus();
  });
  byId('contactSection').addEventListener('change', syncAdd);
}
