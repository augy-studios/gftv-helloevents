// An eye button inside every password field, to show what is being typed.
//
// A real <button> with aria-pressed and a label that says what it will do,
// so it is keyboard operable and announced. The field goes back to hidden
// when its form is submitted, so a shown password is never left on screen
// behind the next step.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { icon } from './icons.js';

const toggles = [];

function render(button, input) {
  const shown = input.type === 'text';
  let iconName = 'eye';
  let labelKey = 'password.show';
  if (shown) {
    iconName = 'eye-off';
    labelKey = 'password.hide';
  }
  button.innerHTML = icon(iconName);
  button.setAttribute('aria-pressed', String(shown));
  button.setAttribute('aria-label', translate(labelKey));
  button.title = translate(labelKey);
}

// Wraps one password field with its eye button (once per field): a click
// shows or hides the password and keeps the caret where it was, and
// submitting the form hides it again.
function wire(input) {
  if (input.dataset.revealable) {
    return;
  }
  input.dataset.revealable = 'true';
  if (!input.id) {
    input.id = `pw-${Math.random().toString(36).slice(2, 9)}`;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'password-field';
  input.replaceWith(wrapper);
  wrapper.appendChild(input);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'password-reveal';
  button.setAttribute('aria-controls', input.id);
  wrapper.appendChild(button);

  button.addEventListener('click', () => {
    // Keep the caret where it was, so typing carries on uninterrupted.
    const { selectionStart, selectionEnd } = input;
    if (input.type === 'password') {
      input.type = 'text';
    } else {
      input.type = 'password';
    }
    render(button, input);
    input.focus();
    try {
      input.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      /* not all types allow it */
    }
  });

  if (input.form) {
    input.form.addEventListener('submit', () => {
      if (input.type !== 'password') {
        input.type = 'password';
        render(button, input);
      }
    });
  }

  render(button, input);
  toggles.push([button, input]);
}

export function initializePasswordToggles(root = document) {
  root.querySelectorAll('input[type="password"]').forEach(wire);
}

onChange(() => toggles.forEach(([button, input]) => render(button, input)));
