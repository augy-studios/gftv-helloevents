// The contact details an event asks for, as a form (migrations/021,
// js/contact-fields.js holds the rules): on the event page with the RSVP,
// and on the checkout page with the ticket. Each field is a labelled input
// of the right kind (a phone number, an email address, a username), filled
// in with what the person gave before; check() says what is wrong in the
// reader's language before anything is sent, and the server checks again.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { contactValue, readContactAnswers } from './contact-fields.js';

// The input's type, keyboard and autofill for each kind of value.
const INPUTS = {
  phone: { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+65 9123 4567' },
  telegram: { type: 'text', autocomplete: 'off', placeholder: '@username', autocapitalize: 'none', spellcheck: 'false' },
  discord: { type: 'text', autocomplete: 'off', placeholder: 'username', autocapitalize: 'none', spellcheck: 'false' },
  email: { type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'name@example.com' },
  username: { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' },
  text: { type: 'text', autocomplete: 'off' },
};

// A field's label: a ready-made one's own words, or the editor's.
export function contactLabel(field) {
  if (field.label) {
    return field.label;
  }
  return translate(`contact.field.${field.id}`);
}

// What the rule asks, in words.
export function contactRuleText(rule, count) {
  if (rule === 'optional') {
    return translate('contact.rule-optional');
  }
  if (rule === 'all' || count === 1) {
    return translate('contact.rule-all');
  }
  return translate('contact.rule-any');
}

// Draws the form into box (emptied first) for these fields and rule, filled
// in with values ({ field id: value }). Returns { read, check, focusField }:
// read() gives { field id: typed value }; check() marks what is wrong and
// gives the sentence to show, or '' when it can be sent.
export function drawContactForm(box, { fields, rule, values = {}, idPrefix }) {
  const inputs = new Map();
  const rows = [];
  for (const field of fields) {
    const id = `${idPrefix}-${field.id}`;
    const settings = INPUTS[field.type];
    const input = createElement('input', {
      id,
      name: field.id,
      maxlength: '254',
      ...settings,
      'data-contact-type': field.type,
    });
    let value = values[field.id];
    if (typeof value === 'string' && value !== '') {
      if (field.type === 'telegram') {
        value = `@${value}`;
      }
      input.value = value;
    }
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    inputs.set(field.id, input);
    let hint = null;
    if (field.type !== 'text') {
      hint = createElement('span', { class: 'field-hint', text: translate(`contact.hint.${field.type}`) });
    }
    rows.push(createElement('label', { class: 'field', for: id }, [
      createElement('span', { text: contactLabel(field) }),
      input,
      hint,
    ]));
  }
  box.replaceChildren(
    createElement('p', { class: 'small muted', text: contactRuleText(rule, fields.length) }),
    ...rows,
    createElement('p', { class: 'small muted', text: translate('contact.private') }),
  );

  const read = () => {
    const given = {};
    for (const [id, input] of inputs) {
      given[id] = input.value;
    }
    return given;
  };
  const focusField = (id) => {
    const input = inputs.get(id);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  };
  const check = () => {
    for (const input of inputs.values()) {
      input.removeAttribute('aria-invalid');
    }
    for (const field of fields) {
      if (!contactValue(field.type, inputs.get(field.id).value).ok) {
        focusField(field.id);
        return translate('contact.invalid', { field: contactLabel(field), example: translate(`contact.hint.${field.type}`) });
      }
    }
    const answers = readContactAnswers(fields, rule, read());
    if (answers.ok) {
      return '';
    }
    if (answers.field) {
      const field = fields.find((each) => each.id === answers.field);
      focusField(answers.field);
      return translate('contact.required-field', { field: contactLabel(field) });
    }
    focusField(fields[0].id);
    return translate('contact.required-any');
  };
  return { read, check, focusField };
}
