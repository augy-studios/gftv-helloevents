// The registration form an event asks (migrations/024, js/registration-fields.js
// holds the rules), as inputs: on the event page with the RSVP, on the
// checkout page with the ticket, and one question at a time when someone
// going changes an answer on their "Registration details" card
// (js/registration-card.js). Each question becomes the right control (a
// text box, Yes and No, a list, a tick box, a photo picker, an amount);
// check() says what is wrong in the reader's language before anything is
// sent, and the server checks again.
//
// Account details (legal name, date of birth, emergency contact) are not
// typed here: they come from the person's account, and the form shows them
// with a way to the Profile tab to fill in what is missing.

import { t as translate } from '../assets/i18n/i18n.js';
import { post } from './api.js';
import { createElement, errorText } from './ui.js';
import { iconNode } from './icons.js';
import { formatMoney } from './format.js';
import { registrationPicture } from './picture-file.js';
import { answerValue, readRegistrationAnswers, formQuestions } from './registration-fields.js';

// A question's label: a ready-made one's own words, or the editor's.
export function questionLabel(field) {
  if (field.label) {
    return field.label;
  }
  return translate(`registration.preset.${field.id}`);
}

// A question's hint: the editor's, or a ready-made one's own ('' for none).
export function questionHint(field) {
  if (field.hint) {
    return field.hint;
  }
  if (field.label === null || field.label === undefined) {
    const key = `registration.hint.${field.id}`;
    const text = translate(key);
    if (text !== key) {
      return text;
    }
  }
  return '';
}

// An answer in words, for the card and the attendee list: Yes or No with a
// mark, a ticked box as Yes, a donation as money; '–' for none.
export function answerText(field, value, currency) {
  if (value === undefined || value === null || value === '') {
    return '–';
  }
  if (field.type === 'yesno') {
    if (value === 'yes') {
      return `✅ ${translate('registration.yes')}`;
    }
    return `❌ ${translate('registration.no')}`;
  }
  if (field.type === 'checkbox') {
    return `✅ ${translate('registration.yes')}`;
  }
  if (field.type === 'agreement') {
    return `✅ ${translate('registration.accepted')}`;
  }
  if (field.type === 'amount') {
    return formatMoney(Number(value), currency);
  }
  return String(value);
}

// Where to fill in account details the form needs: the Profile tab, which
// points them out and comes back to the event page once saved.
export function accountDetailsHref(missing, slug) {
  const next = `/e/${slug}`;
  return `/account?next=${encodeURIComponent(next)}&need=${encodeURIComponent(missing.join(','))}#profile`;
}

// The account details the form asks for, read only, with what is missing
// pointed out. personal: the viewer's (registration.personal from the
// server); missing: the required ones their account lacks.
export function accountDetailRows(fields, personal, missing) {
  const rows = [];
  for (const field of fields) {
    if (field.type !== 'account') {
      continue;
    }
    let value = '';
    if (field.id === 'legalName' && personal.legalName) {
      value = personal.legalName;
    }
    if (field.id === 'dateOfBirth' && personal.dateOfBirth) {
      value = personal.dateOfBirth;
    }
    if (field.id === 'emergencyContact' && personal.emergencyName && personal.emergencyPhone) {
      value = `${personal.emergencyName}, ${personal.emergencyPhone}`;
    }
    let shown = value;
    if (!shown) {
      shown = '–';
    }
    const row = createElement('div', { class: 'reg-row reg-account-row' }, [
      createElement('span', { class: 'reg-label', text: questionLabel(field) }),
      createElement('span', { class: 'reg-value', text: shown }),
    ]);
    if (missing.includes(field.id)) {
      row.classList.add('reg-missing');
    }
    rows.push(row);
  }
  return rows;
}

// One question's control: { node, read(), focus(), field }. ctx: { idPrefix,
// slug, currency, onEvent(event) (a photo saved for someone going brings
// back the event), errorBox }.
export function questionControl(field, value, ctx) {
  const id = `${ctx.idPrefix}-${field.id}`;
  const label = questionLabel(field);
  const hint = questionHint(field);
  let labelText = label;
  if (!field.required && field.type !== 'checkbox' && field.type !== 'agreement') {
    labelText = translate('registration.optional', { label });
  }
  const hintNode = () => {
    if (!hint) {
      return null;
    }
    return createElement('span', { class: 'field-hint', id: `${id}-hint`, text: hint });
  };
  let describedBy = null;
  if (hint) {
    describedBy = `${id}-hint`;
  }

  if (field.type === 'yesno') {
    const yes = createElement('input', { type: 'radio', name: id, value: 'yes', id: `${id}-yes` });
    const no = createElement('input', { type: 'radio', name: id, value: 'no', id: `${id}-no` });
    yes.checked = value === 'yes';
    no.checked = value === 'no';
    const node = createElement('fieldset', { class: 'reg-field reg-yesno', 'aria-describedby': describedBy }, [
      createElement('legend', { text: labelText }),
      hintNode(),
      createElement('div', { class: 'reg-choices' }, [
        createElement('label', { class: 'check' }, [yes, createElement('span', { text: translate('registration.yes') })]),
        createElement('label', { class: 'check' }, [no, createElement('span', { text: translate('registration.no') })]),
      ]),
    ]);
    return {
      field,
      node,
      read: () => {
        if (yes.checked) {
          return 'yes';
        }
        if (no.checked) {
          return 'no';
        }
        return '';
      },
      focus: () => yes.focus(),
    };
  }

  if (field.type === 'checkbox' || field.type === 'agreement') {
    const box = createElement('input', { type: 'checkbox', id, 'aria-describedby': describedBy });
    box.checked = value === true;
    let text = [createElement('span', { text: label })];
    if (field.type === 'agreement') {
      let linkNode = translate('registration.preset.conduct-link');
      if (field.link) {
        linkNode = createElement('a', { class: 'text-link', href: field.link, target: '_blank', rel: 'noopener noreferrer', text: translate('registration.preset.conduct-link') });
      }
      text = [createElement('span', { text: translate('registration.conduct-accept') }), ' ', linkNode];
    } else if (field.link) {
      text = [createElement('a', { class: 'text-link', href: field.link, target: '_blank', rel: 'noopener noreferrer', text: label })];
    }
    // A hint over a tick box reads as its heading ("Guardian (optional)").
    const node = createElement('div', { class: 'reg-field reg-check' }, [
      hintNode(),
      createElement('label', { class: 'check' }, [box, createElement('span', {}, text)]),
    ]);
    return { field, node, read: () => box.checked, focus: () => box.focus() };
  }

  if (field.type === 'choice') {
    const select = createElement('select', { id, 'aria-describedby': describedBy }, [
      createElement('option', { value: '', text: translate('registration.choose') }),
      ...field.options.map((option) => createElement('option', { value: option, text: option })),
    ]);
    let current = '';
    if (typeof value === 'string') {
      current = value;
    }
    select.value = current;
    const node = createElement('label', { class: 'field', for: id }, [createElement('span', { text: labelText }), hintNode(), select]);
    return { field, node, read: () => select.value, focus: () => select.focus() };
  }

  if (field.type === 'photo') {
    return photoControl(field, value, ctx, { id, labelText, hintNode, describedBy });
  }

  let input;
  if (field.type === 'paragraph') {
    input = createElement('textarea', { id, rows: '3', maxlength: '1000', 'aria-describedby': describedBy });
  } else {
    const settings = { id, type: 'text', autocomplete: 'off', 'aria-describedby': describedBy };
    if (field.type === 'url') {
      Object.assign(settings, { type: 'url', inputmode: 'url', placeholder: 'https://', maxlength: '300', autocapitalize: 'none', spellcheck: 'false' });
    } else if (field.type === 'amount') {
      Object.assign(settings, { inputmode: 'decimal', placeholder: '0.00', maxlength: '12' });
    } else if (field.id === 'badgeName') {
      settings.maxlength = '40';
    } else {
      settings.maxlength = '200';
    }
    input = createElement('input', settings);
  }
  if (value !== undefined && value !== null && value !== '') {
    input.value = String(value);
  }
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  let control = input;
  if (field.type === 'amount') {
    let currency = ctx.currency;
    if (!currency) {
      currency = 'SGD';
    }
    control = createElement('div', { class: 'reg-amount' }, [createElement('span', { class: 'reg-currency', 'aria-hidden': 'true', text: currency }), input]);
    let amountKey = 'registration.amount-label';
    if (!field.required) {
      amountKey = 'registration.amount-label-optional';
    }
    labelText = translate(amountKey, { label, currency });
  }
  const node = createElement('label', { class: 'field', for: id }, [createElement('span', { text: labelText }), hintNode(), control]);
  return { field, node, read: () => input.value, focus: () => input.focus() };
}

// A photo question: the photo chosen so far (or none), and a button to
// choose one. It is uploaded as soon as it is chosen (the browser makes it a
// WebP first); for someone going it is saved as their answer at once.
function photoControl(field, value, ctx, { id, labelText, hintNode }) {
  let name = '';
  if (typeof value === 'string') {
    name = value;
  }
  const preview = createElement('img', { class: 'reg-photo-preview', alt: translate('registration.photo-alt', { label: questionLabel(field) }), hidden: true });
  if (ctx.photoUrl) {
    preview.src = ctx.photoUrl;
    preview.hidden = false;
  }
  const status = createElement('span', { class: 'small muted', 'aria-live': 'polite' });
  if (!name) {
    status.textContent = translate('registration.photo-none');
  }
  const fileInput = createElement('input', { type: 'file', id, accept: 'image/*', class: 'visually-hidden' });
  const pick = createElement('label', { class: 'btn file-btn', for: id }, [iconNode('image'), createElement('span', { text: translate('registration.photo-choose') }), fileInput]);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) {
      return;
    }
    status.textContent = translate('registration.photo-uploading');
    pick.classList.add('is-busy');
    try {
      const picture = await registrationPicture(file);
      const answer = await post('/api/events/registration-photo', { slug: ctx.slug, question: field.id, picture });
      name = answer.photo;
      preview.src = answer.url;
      preview.hidden = false;
      status.textContent = translate('registration.photo-ready');
      if (answer.event && ctx.onEvent) {
        ctx.onEvent(answer.event);
      }
    } catch (error) {
      status.textContent = '';
      if (ctx.errorBox) {
        ctx.errorBox.textContent = errorText(error);
      }
    } finally {
      pick.classList.remove('is-busy');
    }
  });
  const node = createElement('div', { class: 'field reg-photo' }, [
    createElement('span', { text: labelText }),
    hintNode(),
    preview,
    createElement('div', { class: 'actions inline' }, [pick, status]),
  ]);
  return { field, node, read: () => name, focus: () => pick.focus() };
}

// What is wrong with one control's answer, in words, or ''.
export function controlProblem(control) {
  const field = control.field;
  const read = answerValue(field, control.read());
  if (!read.ok) {
    return translate(`registration.invalid.${invalidKind(field)}`, { field: questionLabel(field) });
  }
  if (field.required && read.value === '') {
    if (field.type === 'agreement') {
      return translate('registration.conduct-required');
    }
    return translate('registration.required', { field: questionLabel(field) });
  }
  return '';
}

function invalidKind(field) {
  if (['url', 'amount', 'choice', 'text'].includes(field.type)) {
    return field.type;
  }
  return 'other';
}

// Draws the whole form into box (emptied first). Returns { read, check,
// accountMissing }: read() gives { question id: answer }; check() marks what
// is wrong and gives the sentence to show, or '' when it can be sent.
// options: { fields, values, photos, personal, accountMissing, currency,
// idPrefix, slug, onEvent, errorBox }.
export function drawRegistrationForm(box, options) {
  const { fields, values = {}, photos = {}, personal = {}, accountMissing = [] } = options;
  const parts = [];
  const accountRows = accountDetailRows(fields, personal, accountMissing);
  if (accountRows.length > 0) {
    parts.push(createElement('div', { class: 'reg-account' }, [
      createElement('p', { class: 'small muted', text: translate('registration.from-account') }),
      ...accountRows,
    ]));
    if (accountMissing.length > 0) {
      parts.push(createElement('div', { class: 'callout warn small' }, [
        createElement('p', { text: translate('registration.account-missing') }),
        createElement('a', { class: 'btn btn-small u-mt-1', href: accountDetailsHref(accountMissing, options.slug) }, [iconNode('user'), createElement('span', { text: translate('registration.account-fill') })]),
      ]));
    }
  }
  const controls = formQuestions(fields).map((field) => questionControl(field, values[field.id], {
    ...options,
    photoUrl: photos[field.id],
  }));
  parts.push(...controls.map((control) => control.node));
  parts.push(createElement('p', { class: 'small muted', text: translate('registration.private') }));
  box.replaceChildren(...parts);

  const read = () => {
    const given = {};
    for (const control of controls) {
      given[control.field.id] = control.read();
    }
    return given;
  };
  const check = () => {
    for (const control of controls) {
      control.node.removeAttribute('data-invalid');
    }
    if (accountMissing.length > 0) {
      return translate('registration.account-missing');
    }
    for (const control of controls) {
      const problem = controlProblem(control);
      if (problem) {
        control.node.setAttribute('data-invalid', 'true');
        control.focus();
        return problem;
      }
    }
    if (!readRegistrationAnswers(fields, read()).ok) {
      return translate('error.registration_invalid');
    }
    return '';
  };
  return { read, check };
}

// The sentence for a refusal of the form by the server, naming the question.
export function registrationErrorText(error, fields) {
  if (error && error.detail && typeof error.detail.field === 'string') {
    const field = fields.find((each) => each.id === error.detail.field);
    if (field && error.code === 'registration_required') {
      return translate('registration.required', { field: questionLabel(field) });
    }
    if (field && error.code === 'registration_invalid') {
      return translate(`registration.invalid.${invalidKind(field)}`, { field: questionLabel(field) });
    }
  }
  return errorText(error);
}
