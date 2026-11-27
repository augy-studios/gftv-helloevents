// A forgotten password, for public accounts: a Telegram code to the linked
// chat or an emailed code to the confirmed address (either plus the second
// step when 2FA is on), a backup code (when 2FA is on), or a one-time code
// from GFTV staff. A name the server cannot start a reset for (unknown,
// suspended or a staff account: it answers all three the same way) gets one
// message that also sends staff to gftv.asia.
//
// The email also holds a link, /reset#email=<token> (migrations/028).
// Opened in the browser that asked for it, the email way is proven and this
// tab carries on from there with a new challenge; the token leaves the
// address at once.

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
// The email link was followed: the email way needs no code.
let emailVerified = false;
// Turnstile on the first step only: every later step needs its challenge.
const check = humanCheck(byId('humanCheck'));

function pickFactor(name) {
  factor = name;
  document.querySelectorAll('#resetPicker [data-factor]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.factor === name)));
  byId('factorCodeField').hidden = name === 'passkey';
  let labelKey = 'field.code';
  if (name === 'backup') {
    labelKey = 'field.backup-code';
  }
  byId('factorCodeLabel').textContent = translate(labelKey);
  byId('factorCode').value = '';
}

// The way's own fields, and the second step for Telegram and email when 2FA
// is on.
function pickWay(name) {
  way = name;
  document.querySelectorAll('#wayPicker [data-way]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.way === name)));
  byId('telegramWay').hidden = name !== 'telegram';
  byId('emailWay').hidden = name !== 'email';
  byId('backupWay').hidden = name !== 'backup';
  byId('staffWay').hidden = name !== 'staff-code';
  let factorHidden = true;
  if (needsFactor && (name === 'telegram' || name === 'email')) {
    factorHidden = false;
  }
  byId('factorBox').hidden = factorHidden;
  byId('emailSendRow').hidden = emailVerified;
  byId('emailCodeField').hidden = emailVerified;
  byId('emailVerifiedNote').hidden = !emailVerified;
  byId('finishError').textContent = '';
}

// For an account the server can reset: offers the ways it has (Telegram,
// email, a backup code, or only a code from staff), shows the second-factor
// picker when 2FA is on, and picks the first of each (email after its link).
function showWays(data) {
  challenge = data.challenge;
  needsFactor = data.factor.required;
  emailVerified = data.emailVerified === true;
  const picker = byId('wayPicker');
  picker.querySelector('[data-way="telegram"]').hidden = !data.telegram;
  picker.querySelector('[data-way="email"]').hidden = !data.emailCodes;
  picker.querySelector('[data-way="backup"]').hidden = !data.backup;
  // None of them: the only way is a code from staff.
  let askStaffHidden = false;
  if (data.telegram || data.emailCodes || data.backup) {
    askStaffHidden = true;
  }
  byId('askStaff').hidden = askStaffHidden;
  let passkeyUsable = data.factor.passkey;
  if (passkeyUsable) {
    passkeyUsable = passkeysSupported();
  }
  const usable = { totp: data.factor.totp, passkey: passkeyUsable, backup: data.factor.backup };
  document.querySelectorAll('#resetPicker [data-factor]').forEach((button) => {
    button.hidden = !usable[button.dataset.factor];
  });
  if (needsFactor) {
    let firstFactor = 'backup';
    if (usable.totp) {
      firstFactor = 'totp';
    } else if (usable.passkey) {
      firstFactor = 'passkey';
    }
    pickFactor(firstFactor);
  }
  let firstWay = 'staff-code';
  if (emailVerified) {
    firstWay = 'email';
  } else if (data.telegram) {
    firstWay = 'telegram';
  } else if (data.emailCodes) {
    firstWay = 'email';
  } else if (data.backup) {
    firstWay = 'backup';
  }
  pickWay(firstWay);
  byId('stepStart').hidden = true;
  byId('stepCode').hidden = false;
}

// Step one: the name.
byId('startForm').addEventListener('submit', (event) => {
  event.preventDefault();
  byId('notFound').hidden = true;
  withBusy(byId('startSubmit'), byId('startError'), async () => {
    let data;
    try {
      data = await post('/api/auth/recover', { action: 'start', identifier: byId('identifier').value, ...(await check.fields()) });
    } finally {
      check.reset();
    }
    if (!data.found) {
      byId('notFound').hidden = false;
      return;
    }
    showWays(data);
  });
});

document.querySelectorAll('#wayPicker [data-way]').forEach((button) => button.addEventListener('click', () => pickWay(button.dataset.way)));
document.querySelectorAll('#resetPicker [data-factor]').forEach((button) => button.addEventListener('click', () => pickFactor(button.dataset.factor)));

byId('sendCode').addEventListener('click', () => {
  withBusy(byId('sendCode'), byId('finishError'), async () => {
    await post('/api/auth/recover', { action: 'send', challenge });
    toast(translate('telegram.sent'));
    byId('telegramCode').focus();
  });
});

byId('sendEmail').addEventListener('click', () => {
  withBusy(byId('sendEmail'), byId('finishError'), async () => {
    await post('/api/auth/recover', { action: 'send', channel: 'email', challenge });
    toast(translate('email.sent'));
    byId('emailCode').focus();
  });
});

// Step two: the new password with the chosen way's code. The Telegram and
// email ways on an account with 2FA also need the second factor: an
// authenticator or backup code, or a passkey prompt.
byId('finishForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('finishSubmit'), byId('finishError'), async () => {
    const body = { action: 'finish', challenge, method: way, newPassword: byId('newPassword').value };
    if (way === 'backup') {
      body.code = byId('backupCode').value;
    }
    if (way === 'staff-code') {
      body.resetCode = byId('resetCode').value;
    }
    if (way === 'telegram' || way === 'email') {
      const proof = {};
      if (way === 'telegram') {
        proof.telegramCode = byId('telegramCode').value;
      } else if (!emailVerified) {
        proof.emailCode = byId('emailCode').value;
      }
      Object.assign(body, proof);
      if (needsFactor) {
        body.factor = factor;
        if (factor === 'passkey') {
          const { options } = await post('/api/auth/recover', { action: 'passkey-options', challenge, method: way, ...proof });
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

// /reset#email=<token>: the emailed link, taken out of the address first.
function emailLinkToken() {
  const match = /^#email=([A-Za-z0-9_-]{32,64})$/.exec(location.hash);
  if (!match) {
    return null;
  }
  history.replaceState(null, '', location.pathname + location.search);
  return match[1];
}

const linkFromEmail = emailLinkToken();
if (linkFromEmail) {
  withBusy(byId('startSubmit'), byId('startError'), async () => {
    showWays(await post('/api/auth/recover', { action: 'email-link', link: linkFromEmail }));
  });
}

onChange(() => {
  if (factor) {
    pickFactor(factor);
  }
});
