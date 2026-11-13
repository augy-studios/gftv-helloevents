// A forgotten password, for public accounts. No email: a Telegram code to
// the linked chat (plus the second step when 2FA is on), a backup code (when
// 2FA is on), or a one-time code from GFTV staff. A name the server cannot
// start a reset for (unknown, suspended or a staff account: it answers all
// three the same way) gets one message that also sends staff to gftv.asia.

import '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { post } from '../api.js';
import { withBusy, toast } from '../ui.js';
import { passkeysSupported, usePasskey, passkeyErrorCode } from '../passkeys.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);
let challenge = null;
let way = null;
let factor = null;
let needsFactor = false;
// Turnstile on the first step only: every later step needs its challenge.
const check = humanCheck(byId('humanCheck'));

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.factor === name)));
  byId('factorCodeField').hidden = name === 'passkey';
  byId('factorCodeLabel').textContent = translate(name === 'backup' ? 'field.backup-code' : 'field.code');
  byId('factorCode').value = '';
}

function pickWay(name) {
  way = name;
  document.querySelectorAll('#wayPicker [data-way]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.way === name)));
  byId('telegramWay').hidden = name !== 'telegram';
  byId('backupWay').hidden = name !== 'backup';
  byId('staffWay').hidden = name !== 'staff-code';
  byId('finishError').textContent = '';
}

byId('startForm').addEventListener('submit', (e) => {
  e.preventDefault();
  byId('notFound').hidden = true;
  withBusy(byId('startSubmit'), byId('startError'), async () => {
    let data;
    try {
      data = await post('/api/auth/recover', { action: 'start', identifier: byId('identifier').value, ...(await check.fields()) });
    } finally {
      check.reset();
    }
    if (!data.found) { byId('notFound').hidden = false; return; }
    challenge = data.challenge;
    needsFactor = data.factor.required;
    byId('wayPicker').querySelector('[data-way="telegram"]').hidden = !data.telegram;
    byId('wayPicker').querySelector('[data-way="backup"]').hidden = !data.backup;
    // Neither Telegram nor 2FA: the only way is a code from staff.
    byId('askStaff').hidden = data.telegram || data.backup;
    byId('factorBox').hidden = !needsFactor;
    const usable = { totp: data.factor.totp, passkey: data.factor.passkey && passkeysSupported(), backup: data.factor.backup };
    document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => { b.hidden = !usable[b.dataset.factor]; });
    if (needsFactor) pickFactor(usable.totp ? 'totp' : usable.passkey ? 'passkey' : 'backup');
    pickWay(data.telegram ? 'telegram' : data.backup ? 'backup' : 'staff-code');
    byId('stepStart').hidden = true;
    byId('stepCode').hidden = false;
  });
});

document.querySelectorAll('#wayPicker [data-way]').forEach((b) => b.addEventListener('click', () => pickWay(b.dataset.way)));
document.querySelectorAll('#resetPicker [data-factor]').forEach((b) => b.addEventListener('click', () => pickFactor(b.dataset.factor)));

byId('sendCode').addEventListener('click', () => {
  withBusy(byId('sendCode'), byId('finishError'), async () => {
    await post('/api/auth/recover', { action: 'send', challenge });
    toast(translate('telegram.sent'));
    byId('telegramCode').focus();
  });
});

byId('finishForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('finishSubmit'), byId('finishError'), async () => {
    const body = { action: 'finish', challenge, method: way, newPassword: byId('newPassword').value };
    if (way === 'backup') body.code = byId('backupCode').value;
    if (way === 'staff-code') body.resetCode = byId('resetCode').value;
    if (way === 'telegram') {
      body.telegramCode = byId('telegramCode').value;
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
          body.code = byId('factorCode').value;
        }
      }
    }
    const data = await post('/api/auth/recover', body);
    byId('newPassword').value = '';
    if (data.signedIn) {
      location.replace('/account');
      return;
    }
    // A staff code on an account with 2FA: sign in as usual now.
    byId('stepCode').hidden = true;
    byId('stepDone').hidden = false;
  });
});

onChange(() => { if (factor) pickFactor(factor); });
