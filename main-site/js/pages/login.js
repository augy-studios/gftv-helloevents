// Sign in: password, then the second factor, or setting one up first when
// the account has none (the mandatory 2FA gate). No session exists until
// the second step is done; the server enforces that, this only draws it.

import { session } from '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast, errorText } from '../ui.js';
import { passkeysSupported, usePasskey, createPasskey, passkeyErrorCode } from '../passkeys.js';
import { humanCheck } from '../turnstile.js';
import { qrSvg } from '../qr.js';
import { showCodes } from '../codes.js';

const $ = (id) => document.getElementById(id);
let challenge = null;
let method = null;
let setupMethod = null;
let totpStarted = false;
const check = humanCheck($('humanCheck'), 'login');

// Only a path on this site, so ?next= cannot send anyone elsewhere.
function nextPath() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(next) && !next.startsWith('/login') ? next : '/';
}

session.then((s) => { if (s.signedIn) location.replace(nextPath()); });

function show(step) {
  for (const id of ['stepPassword', 'stepFactor', 'stepSetup', 'stepCodes']) $(id).hidden = id !== step;
  const heading = document.querySelector(`#${step} h1`);
  if (heading && step !== 'stepPassword') {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function startOver(message) {
  challenge = null;
  show('stepPassword');
  $('passwordError').textContent = message || '';
  $('password').focus();
}

function handleExpiry(error) {
  if (error.code === 'challenge_expired') startOver(t('error.challenge_expired'));
}

// ---------------------------------------------------------------------------
// Step one: the password
// ---------------------------------------------------------------------------

$('passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('passwordSubmit'), $('passwordError'), async () => {
    try {
      const data = await post('/api/auth/login', {
        identifier: $('identifier').value,
        password: $('password').value,
        humanCheck: await check.token(),
      });
      challenge = data.challenge;
      $('password').value = '';
      if (data.step === 'setup') showSetup(data.options);
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
  $('codeHelp').textContent = t(HELP[name]);
  const code = $('code');
  code.value = '';
  $('codeError').textContent = '';
  const numeric = name === 'totp' || name === 'telegram';
  code.inputMode = numeric ? 'numeric' : 'text';
  code.maxLength = numeric ? 6 : 16;
  code.classList.toggle('code-input', numeric);
  $('codeLabel').textContent = t(name === 'backup' ? 'field.backup-code' : name === 'telegram' ? 'field.telegram-code' : 'field.code');
  $('codeField').hidden = name === 'passkey';
  $('codeSubmitRow').hidden = name === 'passkey';
  $('passkeyRow').hidden = name !== 'passkey';
  $('telegramSendRow').hidden = name !== 'telegram';
}

document.querySelectorAll('#methodPicker [data-method]').forEach((b) => {
  b.addEventListener('click', () => pick(b.dataset.method));
});

function signedIn() {
  location.replace(nextPath());
}

$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('codeSubmit'), $('codeError'), async () => {
    try {
      await post('/api/auth/verify', { challenge, method, code: $('code').value });
      signedIn();
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
  });
});

$('telegramSend').addEventListener('click', () => {
  withBusy($('telegramSend'), $('codeError'), async () => {
    try {
      await post('/api/auth/verify', { challenge, method: 'telegram-send' });
    } catch (error) {
      handleExpiry(error);
      throw error;
    }
    toast(t('telegram.sent'));
    $('code').focus();
  });
});

$('passkeyUse').addEventListener('click', () => {
  withBusy($('passkeyUse'), $('codeError'), async () => {
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

$('startOver').addEventListener('click', () => startOver());

// ---------------------------------------------------------------------------
// The 2FA gate: setting up a first factor
// ---------------------------------------------------------------------------

function showSetup(options) {
  $('setupPicker').querySelector('[data-setup="passkey"]').hidden = !(options.passkey && passkeysSupported());
  $('setupPicker').querySelector('[data-setup="telegram"]').hidden = !options.telegram;
  totpStarted = false;
  show('stepSetup');
  pickSetup('totp');
}

function enrol(body) {
  return post('/api/auth/enrol', { challenge, ...body }).catch((error) => {
    handleExpiry(error);
    throw error;
  });
}

function pickSetup(name) {
  setupMethod = name;
  document.querySelectorAll('#setupPicker [data-setup]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.setup === name));
  });
  $('setupTotp').hidden = name !== 'totp';
  $('setupPasskey').hidden = name !== 'passkey';
  $('setupTelegram').hidden = name !== 'telegram';
  $('setupError').textContent = '';
  if (name === 'totp' && !totpStarted) startTotp();
  if (name === 'telegram') startTelegram();
}

document.querySelectorAll('#setupPicker [data-setup]').forEach((b) => {
  b.addEventListener('click', () => pickSetup(b.dataset.setup));
});

async function startTotp() {
  totpStarted = true;
  try {
    const { secret, uri } = await enrol({ action: 'totp-start' });
    $('totpQr').innerHTML = qrSvg(uri, t('setup.totp-qr-label'));
    // Groups of four, easier to type into an app by hand.
    $('totpSecret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
  } catch (error) {
    totpStarted = false;
    $('setupError').textContent = errorText(error);
  }
}

async function startTelegram() {
  $('telegramOpen').hidden = true;
  try {
    const { url } = await enrol({ action: 'telegram-link' });
    $('telegramOpen').href = url;
    $('telegramOpen').hidden = false;
  } catch (error) {
    $('setupError').textContent = errorText(error);
  }
}

function finished(data) {
  if (!data.backupCodes || data.backupCodes.length === 0) return signedIn();
  showCodes($('codesList'), data.backupCodes, { copyButton: $('codesCopy'), downloadButton: $('codesDownload') });
  show('stepCodes');
}

$('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('totpSubmit'), $('setupError'), async () => {
    finished(await enrol({ action: 'totp-finish', code: $('totpCode').value }));
  });
});

$('passkeyCreate').addEventListener('click', () => {
  withBusy($('passkeyCreate'), $('setupError'), async () => {
    const { options } = await enrol({ action: 'passkey-options' });
    let response;
    try {
      response = await createPasskey(options);
    } catch (cause) {
      throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
    }
    finished(await enrol({ action: 'passkey-finish', response, label: $('passkeyLabel').value }));
  });
});

$('telegramForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('telegramSubmit'), $('setupError'), async () => {
    finished(await enrol({ action: 'telegram-finish', code: $('telegramCode').value }));
  });
});

$('setupStartOver').addEventListener('click', () => startOver());
$('codesDone').addEventListener('click', signedIn);

onChange(() => {
  if (method && !$('stepFactor').hidden) pick(method);
});
