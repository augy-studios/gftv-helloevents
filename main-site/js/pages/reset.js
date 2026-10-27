// A forgotten password, for public accounts. No email: a Telegram code to
// the linked chat (plus the second step when 2FA is on), a backup code (when
// 2FA is on), or a one-time code from GFTV staff. Staff are sent to
// gftv.asia.

import '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';

const $ = (id) => document.getElementById(id);
let challenge = null;
let way = null;
let factor = null;
let needsFactor = false;

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.factor === name)));
  $('factorCodeField').hidden = name === 'passkey';
  $('factorCodeLabel').textContent = t(name === 'backup' ? 'field.backup-code' : 'field.code');
  $('factorCode').value = '';
}

function pickWay(name) {
  way = name;
  document.querySelectorAll('#wayPicker [data-way]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.way === name)));
  $('telegramWay').hidden = name !== 'telegram';
  $('backupWay').hidden = name !== 'backup';
  $('staffWay').hidden = name !== 'staff-code';
  $('finishError').textContent = '';
}

$('startForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('notFound').hidden = true;
  $('staffNote').hidden = true;
  withBusy($('startSubmit'), $('startError'), async () => {
    const data = await post('/api/auth/recover', { action: 'start', identifier: $('identifier').value });
    if (data.staff) { $('staffNote').hidden = false; return; }
    if (!data.found) { $('notFound').hidden = false; return; }
    challenge = data.challenge;
    needsFactor = data.factor.required;
    $('wayPicker').querySelector('[data-way="telegram"]').hidden = !data.telegram;
    $('wayPicker').querySelector('[data-way="backup"]').hidden = !data.backup;
    // Neither Telegram nor 2FA: the only way is a code from staff.
    $('askStaff').hidden = data.telegram || data.backup;
    $('factorBox').hidden = !needsFactor;
    const usable = { totp: data.factor.totp, passkey: data.factor.passkey && passkeysSupported(), backup: data.factor.backup };
    document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => { b.hidden = !usable[b.dataset.factor]; });
    if (needsFactor) pickFactor(usable.totp ? 'totp' : usable.passkey ? 'passkey' : 'backup');
    pickWay(data.telegram ? 'telegram' : data.backup ? 'backup' : 'staff-code');
    $('stepStart').hidden = true;
    $('stepCode').hidden = false;
  });
});

document.querySelectorAll('#wayPicker [data-way]').forEach((b) => b.addEventListener('click', () => pickWay(b.dataset.way)));
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
    const body = { action: 'finish', challenge, method: way, newPassword: $('newPassword').value };
    if (way === 'backup') body.code = $('backupCode').value;
    if (way === 'staff-code') body.resetCode = $('resetCode').value;
    if (way === 'telegram') {
      body.telegramCode = $('telegramCode').value;
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
    }
    const data = await post('/api/auth/recover', body);
    $('newPassword').value = '';
    if (data.signedIn) {
      location.replace('/account');
      return;
    }
    // A staff code on an account with 2FA: sign in as usual now.
    $('stepCode').hidden = true;
    $('stepDone').hidden = false;
  });
});

onChange(() => { if (factor) pickFactor(factor); });
