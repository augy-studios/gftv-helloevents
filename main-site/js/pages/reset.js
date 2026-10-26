// A forgotten password, for public accounts: a Telegram code to the linked
// chat, plus the second factor when the account has one. Staff are sent to
// gftv.asia.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';

const $ = (id) => document.getElementById(id);
let challenge = null;
let factor = null;
let needsFactor = false;

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.factor === name)));
  $('factorCodeField').hidden = name === 'passkey';
  $('factorCodeLabel').textContent = t(name === 'backup' ? 'field.backup-code' : 'field.code');
  $('factorCode').value = '';
}

$('startForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('noTelegram').hidden = true;
  $('staffNote').hidden = true;
  withBusy($('startSubmit'), $('startError'), async () => {
    const data = await post('/api/auth/recover', { action: 'start', identifier: $('identifier').value });
    if (data.staff) { $('staffNote').hidden = false; return; }
    if (!data.telegram) { $('noTelegram').hidden = false; return; }
    challenge = data.challenge;
    needsFactor = data.factor.required;
    $('factorBox').hidden = !needsFactor;
    const usable = { totp: data.factor.totp, passkey: data.factor.passkey && passkeysSupported(), backup: data.factor.backup };
    document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => { b.hidden = !usable[b.dataset.factor]; });
    if (needsFactor) pickFactor(usable.totp ? 'totp' : usable.passkey ? 'passkey' : 'backup');
    $('stepStart').hidden = true;
    $('stepCode').hidden = false;
  });
});

document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => b.addEventListener('click', () => pickFactor(b.dataset.factor)));

$('sendCode').addEventListener('click', () => {
  withBusy($('sendCode'), $('finishError'), async () => {
    await post('/api/auth/recover', { action: 'send', challenge });
    toast(t('telegram.sent'));
    $('telegramCode').focus();
  });
});

$('finishForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('finishSubmit'), $('finishError'), async () => {
    const body = { action: 'finish', challenge, telegramCode: $('telegramCode').value, newPassword: $('newPassword').value };
    if (needsFactor) {
      body.factor = factor;
      if (factor === 'passkey') {
        const { options } = await post('/api/auth/recover', { action: 'passkey-options', challenge, telegramCode: body.telegramCode });
        try {
          body.response = await usePasskey(options);
        } catch (cause) {
          throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
        }
      } else {
        body.code = $('factorCode').value;
      }
    }
    await post('/api/auth/recover', body);
    location.replace('/account');
  });
});

onChange(() => { if (factor) pickFactor(factor); });
