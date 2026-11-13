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
  const next = new URLSearchParams(location.search).get('next') || '';
  return /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(next) && !next.startsWith('/login') ? next : '/';
}

session.then((s) => { if (s.signedIn) location.replace(nextPath()); });

function show(step) {
  for (const id of ['stepPassword', 'stepFactor']) byId(id).hidden = id !== step;
  const heading = document.querySelector(`#${step} h1`);
  if (heading && step !== 'stepPassword') {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function startOver(message) {
  challenge = null;
  show('stepPassword');
  byId('passwordError').textContent = message || '';
  byId('password').focus();
}

function handleExpiry(error) {
  if (error.code === 'challenge_expired') startOver(translate('error.challenge_expired'));
}

// ---------------------------------------------------------------------------
// Step one: the password
// ---------------------------------------------------------------------------

byId('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('passwordSubmit'), byId('passwordError'), async () => {
    try {
      const data = await post('/api/auth/login', {
        identifier: byId('identifier').value,
        password: byId('password').value,
        ...(await check.fields()),
      });
      challenge = data.challenge;
      byId('password').value = '';
      if (data.step === 'done') signedIn();
      else showFactors(data.methods);
    } finally {
      check.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// Step two: the second factor
// ---------------------------------------------------------------------------

const HELP = { totp: 'login.help-totp', passkey: 'login.help-passkey', telegram: 'login.help-telegram', backup: 'login.help-backup' };

function showFactors(methods) {
  const usable = {
    totp: methods.totp,
    passkey: methods.passkey && passkeysSupported(),
    telegram: methods.telegram,
    backup: methods.backup,
  };
  document.querySelectorAll('#methodPicker [data-method]').forEach((b) => { b.hidden = !usable[b.dataset.method]; });
  show('stepFactor');
  // Picking Telegram sends nothing by itself: the code goes out only when
  // "Send me a code" is pressed.
  pick(usable.totp ? 'totp' : usable.passkey ? 'passkey' : usable.telegram ? 'telegram' : 'backup');
}

function pick(name) {
  method = name;
  document.querySelectorAll('#methodPicker [data-method]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.method === name));
  });
  byId('codeHelp').textContent = translate(HELP[name]);
  const code = byId('code');
  code.value = '';
  byId('codeError').textContent = '';
  const numeric = name === 'totp' || name === 'telegram';
  code.inputMode = numeric ? 'numeric' : 'text';
  code.maxLength = numeric ? 6 : 16;
  code.classList.toggle('code-input', numeric);
  byId('codeLabel').textContent = translate(name === 'backup' ? 'field.backup-code' : name === 'telegram' ? 'field.telegram-code' : 'field.code');
  byId('codeField').hidden = name === 'passkey';
  byId('codeSubmitRow').hidden = name === 'passkey';
  byId('passkeyRow').hidden = name !== 'passkey';
  byId('telegramSendRow').hidden = name !== 'telegram';
}

document.querySelectorAll('#methodPicker [data-method]').forEach((b) => {
  b.addEventListener('click', () => pick(b.dataset.method));
});

function signedIn() {
  location.replace(nextPath());
}

byId('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
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
  if (method && !byId('stepFactor').hidden) pick(method);
});
