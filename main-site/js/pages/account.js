// The account page: who you are, the events you are going to, notifications,
// and the ways in (second factors). Public accounts can also delete
// themselves here.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { eventCard } from '../cards.js';
import { showCodes } from '../codes.js';
import { qrSvg } from '../qr.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';
import { pushSupported, currentSubscription, subscribeDevice, unsubscribeDevice } from '../push-client.js';

const byId = (id) => document.getElementById(id);
let currentUser = null;
let security = null;
let rsvps = null;
let notifications = null;
let deviceOn = false;
let totpSetup = null; // the set-up token while an authenticator is being added
// The action waiting on the password dialog.
let pendingAction = null;

function renderProfile() {
  byId('displayName').textContent = currentUser.displayName;
  byId('username').textContent = currentUser.username;
  byId('role').textContent = translate(`role.${currentUser.role}`);
  if (currentUser.avatarUrl) {
    byId('avatar').referrerPolicy = 'no-referrer';
    byId('avatar').src = currentUser.avatarUrl;
    byId('avatar').hidden = false;
  }
  byId('deleteBox').hidden = currentUser.kind !== 'public';
  // Staff names come from gftv.asia.
  byId('nameForm').hidden = currentUser.kind !== 'public';
  if (document.activeElement !== byId('nameInput')) {
    byId('nameInput').value = currentUser.displayName;
  }
}

function renderRsvps() {
  byId('rsvpUpcoming').replaceChildren(...rsvps.upcoming.filter((rsvp) => rsvp.event).map((rsvp) => eventCard(rsvp.event)));
  byId('rsvpEmpty').hidden = rsvps.upcoming.length > 0;
  byId('pastBox').hidden = rsvps.past.length === 0;
  byId('rsvpPast').replaceChildren(...rsvps.past.filter((rsvp) => rsvp.event).map((rsvp) => eventCard(rsvp.event)));
}

// The notification settings: the four switches, the Telegram row (offered
// when the site has Telegram; usable once a chat is linked), and the push
// buttons and status line for this device.
function renderNotify() {
  const settings = notifications;
  byId('prefUpdates').checked = settings.prefs.updates;
  byId('prefReminders').checked = settings.prefs.reminders;
  byId('prefNewEvents').checked = settings.prefs.newEvents;
  byId('prefTelegram').checked = settings.prefs.telegram;
  byId('notifyTelegramBox').hidden = !settings.telegram.available;
  byId('prefTelegram').disabled = !settings.telegram.linked;
  byId('notifyTelegramNote').hidden = settings.telegram.linked;

  // Push on this device needs push set up on the site and a browser that
  // supports it; then one button shows: Turn on, or Turn off.
  let canPush = settings.push.available;
  if (canPush) {
    canPush = pushSupported();
  }
  if (!canPush) {
    byId('pushOn').hidden = true;
    byId('pushOff').hidden = true;
  } else {
    byId('pushOn').hidden = deviceOn;
    byId('pushOff').hidden = !deviceOn;
  }

  // A test needs somewhere to go: this device, or Telegram with Telegram
  // notifications switched on.
  let canTest = false;
  if (deviceOn || (settings.telegram.linked && settings.prefs.telegram)) {
    canTest = true;
  }
  byId('pushTest').hidden = !canTest;

  let pushStateKey;
  if (!settings.push.available) {
    pushStateKey = 'notify.push-unavailable';
  } else if (!pushSupported()) {
    pushStateKey = 'notify.push-unsupported';
  } else if (deviceOn) {
    pushStateKey = 'notify.push-on-here';
  } else {
    pushStateKey = 'notify.push-off-here';
  }
  byId('pushState').textContent = translate(pushStateKey);
}

// "Last used 14 Nov 2026, 2:00 pm" under a passkey, or "Never used" for one
// that has not signed in yet (lastUsedAt is null).
function passkeyLastUsed(lastUsedAt) {
  if (!lastUsedAt) {
    return translate('security.passkey-never-used');
  }
  return translate('security.passkey-last-used', { date: formatDate(lastUsedAt) });
}

// One passkey in the list: its name, when it was added and last used, and a
// Remove button, which asks for the password first.
function passkeyRow(passkey) {
  let name = passkey.label;
  if (!name) {
    name = translate('security.passkey-unnamed');
  }
  return createElement('li', { class: 'item-row' }, [
    iconNode('key'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: name }),
      createElement('span', { class: 'muted small', text: translate('security.passkey-added', { date: formatDate(passkey.createdAt) }) }),
      createElement('span', { class: 'muted small', text: passkeyLastUsed(passkey.lastUsedAt) }),
    ]),
    createElement('button', {
      class: 'btn btn-small btn-quiet',
      type: 'button',
      text: translate('security.remove'),
      'aria-label': translate('security.passkey-remove', { name }),
      onclick: () => askPassword({ kind: 'passkey-remove', id: passkey.id }),
    }),
  ]);
}

// The ways in: the authenticator app (shared from gftv.asia, added here, or
// none, with its add and remove buttons and set-up box), the passkeys,
// Telegram, and how many backup codes are left.
function renderSecurity() {
  let ledeKey = 'security.lede-public';
  if (security.required) {
    ledeKey = 'security.lede-staff';
  }
  byId('securityLede').textContent = translate(ledeKey);

  let totpStateKey = 'security.totp-none';
  if (security.totp.shared) {
    totpStateKey = 'security.totp-shared';
  } else if (security.totp.local) {
    totpStateKey = 'security.totp-local';
  }
  byId('totpState').textContent = translate(totpStateKey);
  // Add is offered only with no authenticator and no set-up under way.
  let totpAddHidden = false;
  if (security.totp.shared || security.totp.local || totpSetup !== null) {
    totpAddHidden = true;
  }
  byId('totpAdd').hidden = totpAddHidden;
  byId('totpRemove').hidden = !security.totp.local;
  byId('totpSetup').hidden = totpSetup === null;

  let passkeyRows;
  if (security.passkeys.length === 0) {
    passkeyRows = [createElement('li', { class: 'muted small', text: translate('security.passkeys-none') })];
  } else {
    passkeyRows = security.passkeys.map((passkey) => passkeyRow(passkey));
  }
  byId('passkeyList').replaceChildren(...passkeyRows);
  byId('passkeyAdd').hidden = !passkeysSupported();

  byId('telegramBox').hidden = !security.telegram.available;
  let telegramStateText;
  if (!security.telegram.linked) {
    telegramStateText = translate('security.telegram-none');
  } else if (security.telegram.username) {
    telegramStateText = translate('security.telegram-linked-as', { username: security.telegram.username });
  } else {
    telegramStateText = translate('security.telegram-linked');
  }
  byId('telegramState').textContent = telegramStateText;
  byId('telegramLink').hidden = security.telegram.linked;
  byId('telegramUnlink').hidden = !security.telegram.linked;

  byId('backupState').textContent = translate('security.backup-left', { count: security.backupCodesLeft });
}

// Signed out: off to sign in, then back here. Signed in: the profile, RSVPs,
// notifications and security are fetched together and drawn; if any of them
// fails, the profile still shows with the error. Whether this device has
// push switched on is checked last, after the page is drawn.
async function load() {
  const currentSession = await session;
  if (!currentSession.signedIn) {
    location.replace(`/login?next=${encodeURIComponent('/account')}`);
    return;
  }
  currentUser = currentSession.user;
  try {
    [security, rsvps, notifications] = await Promise.all([api('/api/me/security'), api('/api/me/rsvps'), api('/api/me/notifications')]);
  } catch (error) {
    byId('accountLoading').hidden = true;
    byId('accountView').hidden = false;
    byId('securityError').textContent = errorText(error);
    renderProfile();
    return;
  }
  byId('accountLoading').hidden = true;
  byId('accountView').hidden = false;
  renderProfile();
  renderRsvps();
  renderNotify();
  renderSecurity();
  // Whether this device is subscribed, after the page is drawn.
  const subscription = await currentSubscription();
  let subscribedHere = false;
  if (subscription && notifications.push.devices > 0) {
    subscribedHere = true;
  }
  deviceOn = subscribedHere;
  renderNotify();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

// Each switch saves as soon as it changes, and flips back if saving fails.
for (const [id, key] of [['prefUpdates', 'updates'], ['prefReminders', 'reminders'], ['prefNewEvents', 'newEvents'], ['prefTelegram', 'telegram']]) {
  byId(id).addEventListener('change', () => {
    const box = byId(id);
    withBusy(null, byId('notifyError'), async () => {
      try {
        notifications = await post('/api/me/notifications', { action: 'prefs', [key]: box.checked });
      } catch (error) {
        box.checked = !box.checked;
        throw error;
      }
      renderNotify();
    });
  });
}

byId('pushOn').addEventListener('click', () => {
  withBusy(byId('pushOn'), byId('notifyError'), async () => {
    const subscription = await subscribeDevice(notifications.push.publicKey);
    notifications = await post('/api/me/notifications', { action: 'subscribe', subscription });
    deviceOn = true;
    renderNotify();
  });
});

byId('pushOff').addEventListener('click', () => {
  withBusy(byId('pushOff'), byId('notifyError'), async () => {
    const endpoint = await unsubscribeDevice();
    if (endpoint) {
      notifications = await post('/api/me/notifications', { action: 'unsubscribe', endpoint });
    }
    deviceOn = false;
    renderNotify();
  });
});

byId('pushTest').addEventListener('click', () => {
  withBusy(byId('pushTest'), byId('notifyError'), async () => {
    await post('/api/me/notifications', { action: 'test' });
  });
});

// ---------------------------------------------------------------------------
// Actions that need the password again
// ---------------------------------------------------------------------------

function askPassword(action) {
  pendingAction = action;
  byId('confirmPassword').value = '';
  byId('passwordModalError').textContent = '';
  byId('passkeyLabelField').hidden = action.kind !== 'passkey-add';
  let ledeKey = 'security.password-lede';
  if (action.kind === 'delete-account') {
    ledeKey = 'account.delete-confirm';
  }
  byId('passwordModalLede').textContent = translate(ledeKey);
  // Adding a passkey starts at its name; everything else at the password.
  let initialFocus;
  if (action.kind === 'passkey-add') {
    initialFocus = byId('newPasskeyLabel');
  } else {
    initialFocus = byId('confirmPassword');
  }
  openModal('passwordModal', { initialFocus });
}

function showNewCodes(codes) {
  showCodes(byId('codesList'), codes, { copyButton: byId('codesCopy'), downloadButton: byId('codesDownload') });
  byId('newCodes').hidden = false;
}

// The password dialog's submit: sends the password with the action waiting
// on it (add or remove a passkey, unlink Telegram, new backup codes, add or
// remove the authenticator, or delete the account), then closes the dialog
// and redraws the security section.
byId('passwordModalForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = byId('confirmPassword').value;
  withBusy(byId('passwordModalSubmit'), byId('passwordModalError'), async () => {
    const action = pendingAction;
    if (action.kind === 'passkey-add') {
      const { options } = await post('/api/me/security', { action: 'passkey-options', password });
      let response;
      try {
        response = await createPasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      const { codes, ...updatedSecurity } = await post('/api/me/security', { action: 'passkey-finish', response, label: byId('newPasskeyLabel').value });
      security = updatedSecurity;
      // A first passkey that turns 2FA on comes with backup codes.
      if (codes) {
        showNewCodes(codes);
      }
      byId('newPasskeyLabel').value = '';
    } else if (action.kind === 'passkey-remove') {
      security = await post('/api/me/security', { action: 'passkey-remove', id: action.id, password });
    } else if (action.kind === 'telegram-unlink') {
      security = await post('/api/me/security', { action: 'telegram-unlink', password });
      notifications = await api('/api/me/notifications');
      renderNotify();
    } else if (action.kind === 'backup-new') {
      const { codes } = await post('/api/me/security', { action: 'backup-regenerate', password });
      showNewCodes(codes);
      security = { ...security, backupCodesLeft: codes.length };
    } else if (action.kind === 'totp-add') {
      const data = await post('/api/me/security', { action: 'totp-start', password });
      totpSetup = data.setup;
      byId('totpQr').innerHTML = qrSvg(data.uri, translate('setup.totp-qr-label'));
      byId('totpSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    } else if (action.kind === 'totp-remove') {
      security = await post('/api/me/security', { action: 'totp-remove', password });
    } else if (action.kind === 'delete-account') {
      await post('/api/me/security', { action: 'delete-account', password });
      location.replace('/');
      return;
    }
    closeModal('passwordModal');
    renderSecurity();
    if (action.kind === 'totp-add') {
      byId('totpCode').focus();
    }
  });
});

byId('totpForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('totpSubmit'), byId('securityError'), async () => {
    const data = await post('/api/me/security', { action: 'totp-finish', setup: totpSetup, code: byId('totpCode').value });
    totpSetup = null;
    byId('totpCode').value = '';
    const { codes, ...updatedSecurity } = data;
    security = updatedSecurity;
    if (codes) {
      showNewCodes(codes);
    }
    renderSecurity();
  });
});

byId('nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('nameSubmit'), byId('nameError'), async () => {
    const { user } = await post('/api/me/profile', { displayName: byId('nameInput').value });
    currentUser = user;
    renderProfile();
    byId('accountNotice').textContent = translate('account.name-saved');
  });
});

byId('totpAdd').addEventListener('click', () => askPassword({ kind: 'totp-add' }));
byId('totpRemove').addEventListener('click', () => askPassword({ kind: 'totp-remove' }));
byId('passkeyAdd').addEventListener('click', () => askPassword({ kind: 'passkey-add' }));
byId('telegramUnlink').addEventListener('click', () => askPassword({ kind: 'telegram-unlink' }));
byId('backupNew').addEventListener('click', () => askPassword({ kind: 'backup-new' }));
byId('deleteAccount').addEventListener('click', () => askPassword({ kind: 'delete-account' }));

byId('telegramLink').addEventListener('click', () => {
  withBusy(byId('telegramLink'), byId('securityError'), async () => {
    const { url } = await post('/api/me/security', { action: 'telegram-link' });
    window.open(url, '_blank', 'noopener');
    byId('telegramState').textContent = translate('security.telegram-pending');
    // Linking finishes in Telegram; look again when the person comes back.
    const refresh = async () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      document.removeEventListener('visibilitychange', refresh);
      [security, notifications] = await Promise.all([api('/api/me/security'), api('/api/me/notifications')]);
      renderSecurity();
      renderNotify();
    };
    document.addEventListener('visibilitychange', refresh);
  });
});

byId('signOut').addEventListener('click', () => {
  withBusy(byId('signOut'), byId('securityError'), async () => {
    await post('/api/auth/session', { action: 'logout' });
    location.replace('/');
  });
});

byId('signOutOthers').addEventListener('click', () => {
  withBusy(byId('signOutOthers'), byId('securityError'), async () => {
    await post('/api/auth/session', { action: 'logout-others' });
    byId('accountNotice').textContent = translate('account.signed-out-others');
  });
});

onChange(() => {
  if (currentUser) {
    renderProfile();
  }
  if (rsvps) {
    renderRsvps();
  }
  if (notifications) {
    renderNotify();
  }
  if (security) {
    renderSecurity();
  }
});

load();
