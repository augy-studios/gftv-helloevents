// The edit form's Check-in and entry tab (migrations/027): the link to the
// check-in page, and the organisers' own entry QR codes
// (api/manage/entry-codes.js). The mode, who gets them and when they show
// are plain fields of the form; the codes are uploaded on their own, once
// the event is saved. In "one per person" mode each code says who it is
// handed to, and can be handed to someone else by their RSVP ID.

import { t as translate } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, withBusy, errorText } from './ui.js';
import { iconNode } from './icons.js';
import { qrPicture } from './picture-file.js';

const byId = (id) => document.getElementById(id);
let getEvent = () => null;
let codes = [];

function mode() {
  return byId('f-entryQrMode').value;
}

// Fields that mean something only with codes on, and the hours only for
// "from some hours before".
export function syncEntry() {
  const on = mode() !== 'off';
  for (const id of ['f-entryQrAudience', 'f-entryQrShow', 'f-entryQrHours']) {
    byId(id).disabled = !on;
  }
  byId('entryQrHoursField').hidden = byId('f-entryQrShow').value !== 'before';
  const event = getEvent();
  byId('entryCodesBox').hidden = true;
  byId('entryCodesSaveFirst').hidden = true;
  if (on && event) {
    byId('entryCodesBox').hidden = false;
  } else if (on) {
    byId('entryCodesSaveFirst').hidden = false;
  }
  byId('checkinOpen').hidden = !event;
  if (event) {
    byId('checkinOpen').href = `/checkin?id=${encodeURIComponent(event.id)}`;
  }
  let hint = 'manage.entry-hint.shared';
  let add = 'manage.entry-add-shared';
  if (mode() === 'each') {
    hint = 'manage.entry-hint.each';
    add = 'manage.entry-add';
  }
  byId('entryCodesHint').textContent = translate(hint, { count: codes.length });
  byId('entryCodeAddText').textContent = translate(add);
  byId('entryCodeFile').multiple = mode() === 'each';
}

function codeRow(code, index) {
  const event = getEvent();
  let holderText = translate('manage.entry-free');
  if (code.holder) {
    let name = code.holder.displayName;
    if (!name) {
      name = code.holder.username;
    }
    holderText = translate('manage.entry-held', { name, number: code.holder.rsvpNumber });
  }
  const children = [
    createElement('img', { src: code.imageUrl, alt: translate('manage.entry-code-alt', { number: index + 1 }), loading: 'lazy' }),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: translate('manage.entry-code', { number: index + 1 }) }),
    ]),
  ];
  if (mode() === 'each') {
    children[1].append(createElement('span', { class: 'muted small', text: holderText }));
    const input = createElement('input', { type: 'text', inputmode: 'numeric', placeholder: translate('manage.entry-assign-placeholder'), 'aria-label': translate('manage.entry-assign-label', { number: index + 1 }), size: '6' });
    if (code.holder) {
      input.value = String(code.holder.rsvpNumber);
    }
    input.addEventListener('change', () => {
      withBusy(null, byId('entryCodeError'), async () => {
        let rsvpNumber = null;
        if (input.value.trim() !== '') {
          rsvpNumber = input.value.trim();
        }
        const data = await post('/api/manage/entry-codes', { action: 'assign', id: event.id, code: code.id, rsvpNumber });
        codes = data.codes;
        renderCodes();
      });
    });
    children.push(input);
  }
  children.push(createElement('button', {
    class: 'btn btn-small btn-quiet',
    type: 'button',
    'aria-label': translate('manage.entry-remove', { number: index + 1 }),
    onclick: () => {
      withBusy(null, byId('entryCodeError'), async () => {
        const data = await post('/api/manage/entry-codes', { action: 'remove', id: event.id, code: code.id });
        codes = data.codes;
        renderCodes();
      });
    },
  }, [iconNode('trash')]));
  return createElement('li', { class: 'item-row entry-code' }, children);
}

function renderCodes() {
  byId('entryCodeList').replaceChildren(...codes.map((code, index) => codeRow(code, index)));
  syncEntry();
}

// The open event's codes (none for a new event).
export async function loadEntryCodes() {
  codes = [];
  const event = getEvent();
  if (event) {
    try {
      codes = (await api(`/api/manage/entry-codes?id=${encodeURIComponent(event.id)}`)).codes;
    } catch {
      codes = [];
    }
  }
  renderCodes();
}

async function addFiles(files) {
  const event = getEvent();
  if (!event) {
    return;
  }
  byId('entryCodeError').textContent = '';
  const list = [...files];
  for (let index = 0; index < list.length; index += 1) {
    byId('entryCodeStatus').textContent = translate('manage.entry-uploading', { done: index, total: list.length });
    try {
      const image = await qrPicture(list[index]);
      const data = await post('/api/manage/entry-codes', { action: 'add', id: event.id, image });
      codes = data.codes;
    } catch (error) {
      byId('entryCodeError').textContent = errorText(error);
      break;
    }
  }
  byId('entryCodeStatus').textContent = '';
  renderCodes();
}

export function relabelEntry() {
  renderCodes();
}

export function startEntry(options) {
  getEvent = options.getEvent;
  for (const id of ['f-entryQrMode', 'f-entryQrShow']) {
    byId(id).addEventListener('change', syncEntry);
  }
  byId('entryCodeFile').addEventListener('change', () => {
    const files = byId('entryCodeFile').files;
    if (files && files.length > 0) {
      addFiles(files);
    }
    byId('entryCodeFile').value = '';
  });
}
