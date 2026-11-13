// Shared UI helpers: dialogs, the toast, busy buttons, formatting.

import { t as translate, getLocale } from '../assets/i18n/i18n.js';

// ---------------------------------------------------------------------------
// Dialogs
//
// Opening one moves focus inside, traps it there, makes the rest of the page
// inert and locks scrolling. Escape, the backdrop, and any [data-close-modal]
// close it and return focus to where it was. Show and hide is one .hidden
// class flip; the timing lives in CSS.
// ---------------------------------------------------------------------------

// The dialogs open now, the top one last.
const openDialogs = [];

function focusable(root) {
  const candidates = [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  // Only what is showing: nothing inside a hidden section.
  return candidates.filter((element) => {
    if (!element.closest('[hidden]') && element.offsetParent !== null) {
      return true;
    }
    return false;
  });
}

function setBackgroundInert(makeInert) {
  for (const child of document.body.children) {
    if (child.classList.contains('modal-backdrop') || child.id === 'toast') {
      continue;
    }
    if (makeInert) {
      child.setAttribute('inert', '');
    } else {
      child.removeAttribute('inert');
    }
  }
  if (makeInert) {
    document.documentElement.style.overflow = 'hidden';
  } else {
    document.documentElement.style.overflow = '';
  }
}

export function openModal(id, { initialFocus = null, onClose = null } = {}) {
  const backdrop = document.getElementById(id);
  if (!backdrop || !backdrop.classList.contains('hidden')) {
    return;
  }
  openDialogs.forEach((entry) => entry.backdrop.setAttribute('inert', ''));
  openDialogs.push({ id, backdrop, returnTo: document.activeElement, onClose });
  // Every backdrop is z-index 50 in style.css, so a dialog opened from inside
  // another one would paint under it whenever it comes earlier in the markup,
  // and sit there unseen while the one on top is inert. Each newly opened
  // dialog goes one above the stack instead (still under the toast, at 60).
  // Not reset on close, so a closing dialog keeps its place while it fades.
  backdrop.style.zIndex = String(50 + openDialogs.length);
  backdrop.removeAttribute('inert');
  backdrop.classList.remove('hidden');
  setBackgroundInert(true);
  let target = initialFocus;
  if (!target) {
    target = focusable(backdrop)[0];
  }
  if (target) {
    target.focus();
  }
}

export function closeModal(id) {
  const index = openDialogs.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return;
  }
  const [entry] = openDialogs.splice(index, 1);
  entry.backdrop.classList.add('hidden');
  if (openDialogs.length === 0) {
    setBackgroundInert(false);
  } else {
    openDialogs[openDialogs.length - 1].backdrop.removeAttribute('inert');
  }
  if (entry.onClose) {
    entry.onClose();
  }
  if (entry.returnTo && typeof entry.returnTo.focus === 'function') {
    entry.returnTo.focus();
  }
}

// Clicks on a [data-close-modal] button or on a dialog's backdrop close that
// dialog. On the top dialog, Escape closes it, and Tab and Shift+Tab stay
// inside it, wrapping from the last item to the first and back.
export function wireModals() {
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close-modal]');
    if (closer) {
      closeModal(closer.getAttribute('data-close-modal'));
      return;
    }
    if (event.target.classList && event.target.classList.contains('modal-backdrop')) {
      closeModal(event.target.id);
    }
  });
  // Escape closes the top dialog; Tab and Shift+Tab stay inside it.
  document.addEventListener('keydown', (event) => {
    const topDialog = openDialogs[openDialogs.length - 1];
    if (!topDialog) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal(topDialog.id);
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const items = focusable(topDialog.backdrop);
    if (items.length === 0) {
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!topDialog.backdrop.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Toast: one at a time, announced through role="status" without moving focus.
// ---------------------------------------------------------------------------

let toastTimer = null;

// duration: how long the toast stays, in milliseconds.
export function toast(message, duration = 2200) {
  let toastElement = document.getElementById('toast');
  if (!toastElement) {
    toastElement = document.createElement('div');
    toastElement.id = 'toast';
    toastElement.className = 'toast hidden';
    toastElement.setAttribute('role', 'status');
    document.body.appendChild(toastElement);
  }
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  // Reading offsetHeight makes the browser lay the toast out before the class
  // changes (the usual way to restart a CSS transition).
  void toastElement.offsetHeight;
  toastElement.classList.remove('hidden');
  toastTimer = setTimeout(() => toastElement.classList.add('hidden'), duration);
}

// ---------------------------------------------------------------------------
// Busy buttons. The spinner sits inside .delayed, so a fast answer never shows
// it; the label stays for screen readers through aria-busy and the text.
// ---------------------------------------------------------------------------

export function setBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  const existing = button.querySelector('.busy-indicator');
  if (busy && !existing) {
    const indicator = document.createElement('span');
    indicator.className = 'delayed busy-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    indicator.appendChild(spinner);
    button.prepend(indicator);
  } else if (!busy && existing) {
    existing.remove();
  }
}

// Run an async action with a button showing busy, and the error, if any,
// written to a callout as a translated sentence.
export async function withBusy(button, errorBox, action) {
  setBusy(button, true);
  if (errorBox) {
    errorBox.textContent = '';
  }
  try {
    return await action();
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = errorText(error);
    } else {
      toast(errorText(error));
    }
    return undefined;
  } finally {
    setBusy(button, false);
  }
}

// The sentence for an error in the reader's language: the server's code
// looked up under error.*, or the generic sentence for a code with none.
export function errorText(error) {
  let code = 'generic';
  if (error && error.code) {
    code = error.code;
  }
  // A refused form field is named, in the reader's language.
  let field;
  if (error !== null && error !== undefined) {
    const detail = error.detail;
    if (detail !== null && detail !== undefined) {
      field = detail.field;
    }
  }
  let placeholders;
  if (field) {
    placeholders = { field: translate(`manage.field.${field}`) };
  }
  const text = translate(`error.${code}`, placeholders);
  // A code with no sentence of its own comes back as the key itself.
  if (text === `error.${code}`) {
    return translate('error.generic');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Formatting and escaping
// ---------------------------------------------------------------------------

export function formatNumber(value) {
  let number = Number(value);
  if (!number) {
    number = 0;
  }
  return new Intl.NumberFormat(getLocale()).format(number);
}

export function formatDate(value) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build an element: createElement('p', { class: 'muted', text: 'hello' }, [children]).
// Text always goes in through textContent, so text typed by an editor can
// never become markup. A property that is undefined, null or false is left
// out; one named on... with a function becomes an event listener; true
// becomes an empty attribute. Children that are null, undefined or false
// are skipped, and anything not a node goes in as text.
export function createElement(tag, properties = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'i18n') {
      node.setAttribute('data-i18n', value);
      node.textContent = translate(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (child instanceof Node) {
      node.append(child);
    } else {
      node.append(document.createTextNode(String(child)));
    }
  }
  return node;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(translate('common.copied'));
  } catch {
    toast(translate('error.copy'));
  }
}
