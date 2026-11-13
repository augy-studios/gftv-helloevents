// Sign in: password, then the second factor when the account has one. Staff
// must have one (set up on gftv.asia); for public accounts it is optional,
// and the server answers step "done" straight after the password.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast, errorText } from '../ui.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);
let challenge = null;
let method = null;
const check = humanCheck(byId('humanCheck'));

// Only a path on this site, so ?next= cannot send anyone elsewhere.
function nextPath() {
  let next = new URLSearchParams(location.search).get('next');
  if (!next) {
    next = '';
  }
  if (/^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(next) && !next.startsWith('/login')) {
    return next;
  }
  return '/';
}

session.then((currentSession) => {
  if (currentSession.signedIn) {
    location.replace(nextPath());
  }
});

function show(step) {
  for (const id of ['stepPassword', 'stepFactor']) {
    byId(id).hidden = id !== step;
  }
  const heading = document.querySelector(`#${step} h1`);
  if (heading && step !== 'stepPassword') {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function startOver(message) {
  challenge = null;
  show('stepPassword');
  let errorMessage = message;
  if (!errorMessage) {
    errorMessage = '';
  }
  byId('passwordError').textContent = errorMessage;
  byId('password').focus();
}

function handleExpiry(error) {
  if (error.code === 'challenge_expired') {
    startOver(translate('error.challenge_expired'));
  }
}

// ---------------------------------------------------------------------------
// Step one: the password
// ---------------------------------------------------------------------------

byId('passwordForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('passwordSubmit'), byId('passwordError'), async () => {
    try {
      const data = await post('/api/auth/login', {
        identifier: byId('identifier').value,
        password: byId('password').value,
        ...(await check.fields()),
      });
      challenge = data.challenge;
      byId('password').value = '';
      if (data.step === 'done') {
        signedIn();
      } else {
        showFactors(data.methods);
      }
    } finally {
      check.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// Step two: the second factor
// ---------------------------------------------------------------------------

const HELP_KEYS = { totp: 'login.help-totp', passkey: 'login.help-passkey', telegram: 'login.help-telegram', backup: 'login.help-backup' };

// Shows the second step with a button for each method this account has (a
// passkey only where the browser supports them), and picks the first of
// authenticator, passkey, Telegram, backup code.
function showFactors(methods) {
  let passkeyUsable = methods.passkey;
  if (passkeyUsable) {
    passkeyUsable = passkeysSupported();
  }
  const usable = {
    totp: methods.totp,
    passkey: passkeyUsable,
    telegram: methods.telegram,
    backup: methods.backup,
  };
  document.querySelectorAll('#methodPicker [data-method]').forEach((button) => {
    button.hidden = !usable[button.dataset.method];
  });
  show('stepFactor');
  // Picking Telegram sends nothing by itself: the code goes out only when
  // "Send me a code" is pressed.
  let firstMethod = 'backup';
  if (usable.totp) {
    firstMethod = 'totp';
  } else if (usable.passkey) {
    firstMethod = 'passkey';
  } else if (usable.telegram) {
    firstMethod = 'telegram';
  }
  pick(firstMethod);
}

// Switches the second step to one method: presses its button, sets the help
// line, and shapes the code field for it (six digits for the authenticator
// and Telegram, up to 16 characters for a backup code, none for a passkey).
function pick(name) {
  method = name;
  document.querySelectorAll('#methodPicker [data-method]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.method === name));
  });
  byId('codeHelp').textContent = translate(HELP_KEYS[name]);
  const codeInput = byId('code');
  codeInput.value = '';
  byId('codeError').textContent = '';
  let numeric = false;
  if (name === 'totp' || name === 'telegram') {
    numeric = true;
  }
  if (numeric) {
    codeInput.inputMode = 'numeric';
    codeInput.maxLength = 6;
  } else {
    codeInput.inputMode = 'text';
    codeInput.maxLength = 16;
  }
  codeInput.classList.toggle('code-input', numeric);
  let labelKey = 'field.code';
  if (name === 'backup') {
    labelKey = 'field.backup-code';
  } else if (name === 'telegram') {
    labelKey = 'field.telegram-code';
  }
  byId('codeLabel').textContent = translate(labelKey);
  byId('codeField').hidden = name === 'passkey';
  byId('codeSubmitRow').hidden = name === 'passkey';
  byId('passkeyRow').hidden = name !== 'passkey';
  byId('telegramSendRow').hidden = name !== 'telegram';
}

document.querySelectorAll('#methodPicker [data-method]').forEach((button) => {
  button.addEventListener('click', () => pick(button.dataset.method));
});

function signedIn() {
  location.replace(nextPath());
}

byId('codeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('codeSubmit'), byId('codeError'), async () => {
    try {
      await post('/api/auth/verify', { challenge, method, code: byId('code').value });
      signedIn();
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
  });
});

byId('telegramSend').addEventListener('click', () => {
  withBusy(byId('telegramSend'), byId('codeError'), async () => {
    try {
      await post('/api/auth/verify', { challenge, method: 'telegram-send' });
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
    toast(translate('telegram.sent'));
    byId('code').focus();
  });
});

byId('passkeyUse').addEventListener('click', () => {
  withBusy(byId('passkeyUse'), byId('codeError'), async () => {
    try {
      const { options } = await post('/api/auth/verify', { challenge, method: 'passkey-options' });
      let response;
      try {
        response = await usePasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      await post('/api/auth/verify', { challenge, method: 'passkey', response });
      signedIn();
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
  });
});

byId('startOver').addEventListener('click', () => startOver());

onChange(() => {
  if (method && !byId('stepFactor').hidden) {
    pick(method);
  }
});
