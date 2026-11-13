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
let me = null;
let security = null;
let rsvps = null;
let notify = null;
let deviceOn = false;
let totpSetup = null; // the set-up token while an authenticator is being added
// The action waiting on the password dialog.
let pending = null;

function renderProfile() {
  byId('displayName').textContent = me.displayName;
  byId('username').textContent = me.username;
  byId('role').textContent = translate(`role.${me.role}`);
  if (me.avatarUrl) {
    byId('avatar').referrerPolicy = 'no-referrer';
    byId('avatar').src = me.avatarUrl;
    byId('avatar').hidden = false;
  }
  byId('deleteBox').hidden = me.kind !== 'public';
  // Staff names come from gftv.asia.
  byId('nameForm').hidden = me.kind !== 'public';
  if (document.activeElement !== byId('nameInput')) byId('nameInput').value = me.displayName;
}

function renderRsvps() {
  byId('rsvpUpcoming').replaceChildren(...rsvps.upcoming.filter((r) => r.event).map((r) => eventCard(r.event)));
  byId('rsvpEmpty').hidden = rsvps.upcoming.length > 0;
  byId('pastBox').hidden = rsvps.past.length === 0;
  byId('rsvpPast').replaceChildren(...rsvps.past.filter((r) => r.event).map((r) => eventCard(r.event)));
}

function renderNotify() {
  const n = notify;
  byId('prefUpdates').checked = n.prefs.updates;
  byId('prefReminders').checked = n.prefs.reminders;
  byId('prefNewEvents').checked = n.prefs.newEvents;
  byId('prefTelegram').checked = n.prefs.telegram;
  byId('notifyTelegramBox').hidden = !n.telegram.available;
  byId('prefTelegram').disabled = !n.telegram.linked;
  byId('notifyTelegramNote').hidden = n.telegram.linked;

  const can = n.push.available && pushSupported();
  byId('pushOn').hidden = !can || deviceOn;
  byId('pushOff').hidden = !can || !deviceOn;
  byId('pushTest').hidden = !(deviceOn || (n.telegram.linked && n.prefs.telegram));
  byId('pushState').textContent = !n.push.available
    ? translate('notify.push-unavailable')
    : !pushSupported()
      ? translate('notify.push-unsupported')
      : deviceOn
        ? translate('notify.push-on-here')
        : translate('notify.push-off-here');
}

// "Last used 14 Nov 2026, 2:00 pm" under a passkey, or "Never used" for one
// that has not signed in yet (lastUsedAt is null).
function passkeyLastUsed(lastUsedAt) {
  if (!lastUsedAt) {
    return translate('security.passkey-never-used');
  }
  return translate('security.passkey-last-used', { date: formatDate(lastUsedAt) });
}

function renderSecurity() {
  const s = security;
  byId('securityLede').textContent = translate(s.required ? 'security.lede-staff' : 'security.lede-public');
  byId('totpState').textContent = s.totp.shared
    ? translate('security.totp-shared')
    : s.totp.local
      ? translate('security.totp-local')
      : translate('security.totp-none');
  byId('totpAdd').hidden = s.totp.shared || s.totp.local || totpSetup !== null;
  byId('totpRemove').hidden = !s.totp.local;
  byId('totpSetup').hidden = totpSetup === null;

  byId('passkeyList').replaceChildren(
    ...(s.passkeys.length === 0
      ? [createElement('li', { class: 'muted small', text: translate('security.passkeys-none') })]
      : s.passkeys.map((p) => createElement('li', { class: 'item-row' }, [
        iconNode('key'),
        createElement('span', { class: 'item-main' }, [
          createElement('span', { text: p.label || translate('security.passkey-unnamed') }),
          createElement('span', { class: 'muted small', text: translate('security.passkey-added', { date: formatDate(p.createdAt) }) }),
          createElement('span', { class: 'muted small', text: passkeyLastUsed(p.lastUsedAt) }),
        ]),
        createElement('button', {
          class: 'btn btn-small btn-quiet',
          type: 'button',
          text: translate('security.remove'),
          'aria-label': translate('security.passkey-remove', { name: p.label || translate('security.passkey-unnamed') }),
          onclick: () => askPassword({ kind: 'passkey-remove', id: p.id }),
        }),
      ])))
  );
  byId('passkeyAdd').hidden = !passkeysSupported();

  byId('telegramBox').hidden = !s.telegram.available;
  byId('telegramState').textContent = s.telegram.linked
    ? (s.telegram.username ? translate('security.telegram-linked-as', { username: s.telegram.username }) : translate('security.telegram-linked'))
    : translate('security.telegram-none');
  byId('telegramLink').hidden = s.telegram.linked;
  byId('telegramUnlink').hidden = !s.telegram.linked;

  byId('backupState').textContent = translate('security.backup-left', { count: s.backupCodesLeft });
}

async function load() {
  const s = await session;
  if (!s.signedIn) {
    location.replace(`/login?next=${encodeURIComponent('/account')}`);
    return;
  }
  me = s.user;
  try {
    [security, rsvps, notify] = await Promise.all([api('/api/me/security'), api('/api/me/rsvps'), api('/api/me/notifications')]);
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
  deviceOn = Boolean(await currentSubscription()) && notify.push.devices > 0;
  renderNotify();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

for (const [id, key] of [['prefUpdates', 'updates'], ['prefReminders', 'reminders'], ['prefNewEvents', 'newEvents'], ['prefTelegram', 'telegram']]) {
  byId(id).addEventListener('change', () => {
    const box = byId(id);
    withBusy(null, byId('notifyError'), async () => {
      try {
        notify = await post('/api/me/notifications', { action: 'prefs', [key]: box.checked });
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
    const subscription = await subscribeDevice(notify.push.publicKey);
    notify = await post('/api/me/notifications', { action: 'subscribe', subscription });
    deviceOn = true;
    renderNotify();
  });
});

byId('pushOff').addEventListener('click', () => {
  withBusy(byId('pushOff'), byId('notifyError'), async () => {
    const endpoint = await unsubscribeDevice();
    if (endpoint) notify = await post('/api/me/notifications', { action: 'unsubscribe', endpoint });
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
  pending = action;
  byId('confirmPassword').value = '';
  byId('passwordModalError').textContent = '';
  byId('passkeyLabelField').hidden = action.kind !== 'passkey-add';
  byId('passwordModalLede').textContent = translate(action.kind === 'delete-account' ? 'account.delete-confirm' : 'security.password-lede');
  openModal('passwordModal', { initialFocus: action.kind === 'passkey-add' ? byId('newPasskeyLabel') : byId('confirmPassword') });
}

function showNewCodes(codes) {
  showCodes(byId('codesList'), codes, { copyButton: byId('codesCopy'), downloadButton: byId('codesDownload') });
  byId('newCodes').hidden = false;
}

byId('passwordModalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const password = byId('confirmPassword').value;
  withBusy(byId('passwordModalSubmit'), byId('passwordModalError'), async () => {
    const action = pending;
    if (action.kind === 'passkey-add') {
      const { options } = await post('/api/me/security', { action: 'passkey-options', password });
      let response;
      try {
        response = await createPasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      const { codes, ...rest } = await post('/api/me/security', { action: 'passkey-finish', response, label: byId('newPasskeyLabel').value });
      security = rest;
      // A first passkey that turns 2FA on comes with backup codes.
      if (codes) showNewCodes(codes);
      byId('newPasskeyLabel').value = '';
    } else if (action.kind === 'passkey-remove') {
      security = await post('/api/me/security', { action: 'passkey-remove', id: action.id, password });
    } else if (action.kind === 'telegram-unlink') {
      security = await post('/api/me/security', { action: 'telegram-unlink', password });
      notify = await api('/api/me/notifications');
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
    if (action.kind === 'totp-add') byId('totpCode').focus();
  });
});

byId('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('totpSubmit'), byId('securityError'), async () => {
    const data = await post('/api/me/security', { action: 'totp-finish', setup: totpSetup, code: byId('totpCode').value });
    totpSetup = null;
    byId('totpCode').value = '';
    const { codes, ...rest } = data;
    security = rest;
    if (codes) showNewCodes(codes);
    renderSecurity();
  });
});

byId('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(byId('nameSubmit'), byId('nameError'), async () => {
    const { user } = await post('/api/me/profile', { displayName: byId('nameInput').value });
    me = user;
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
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', refresh);
      [security, notify] = await Promise.all([api('/api/me/security'), api('/api/me/notifications')]);
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
  if (me) renderProfile();
  if (rsvps) renderRsvps();
  if (notify) renderNotify();
  if (security) renderSecurity();
});

load();
