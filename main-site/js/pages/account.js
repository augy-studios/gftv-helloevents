// The account page: who you are, the events you are going to, notifications,
// and the ways in (second factors). Public accounts can also delete
// themselves here.

import { session } from '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { el, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { eventCard } from '../cards.js';
import { showCodes } from '../codes.js';
import { qrSvg } from '../qr.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';
import { pushSupported, currentSubscription, subscribeDevice, unsubscribeDevice } from '../push-client.js';

const $ = (id) => document.getElementById(id);
let me = null;
let security = null;
let rsvps = null;
let notify = null;
let deviceOn = false;
let totpSetup = null; // the set-up token while an authenticator is being added
// The action waiting on the password dialog.
let pending = null;

function renderProfile() {
  $('displayName').textContent = me.displayName;
  $('username').textContent = me.username;
  $('role').textContent = t(`role.${me.role}`);
  if (me.avatarUrl) {
    $('avatar').referrerPolicy = 'no-referrer';
    $('avatar').src = me.avatarUrl;
    $('avatar').hidden = false;
  }
  $('deleteBox').hidden = me.kind !== 'public';
}

function renderRsvps() {
  $('rsvpUpcoming').replaceChildren(...rsvps.upcoming.filter((r) => r.event).map((r) => eventCard(r.event)));
  $('rsvpEmpty').hidden = rsvps.upcoming.length > 0;
  $('pastBox').hidden = rsvps.past.length === 0;
  $('rsvpPast').replaceChildren(...rsvps.past.filter((r) => r.event).map((r) => eventCard(r.event)));
}

function renderNotify() {
  const n = notify;
  $('prefUpdates').checked = n.prefs.updates;
  $('prefReminders').checked = n.prefs.reminders;
  $('prefNewEvents').checked = n.prefs.newEvents;
  $('prefTelegram').checked = n.prefs.telegram;
  $('notifyTelegramBox').hidden = !n.telegram.available;
  $('prefTelegram').disabled = !n.telegram.linked;
  $('notifyTelegramNote').hidden = n.telegram.linked;

  const can = n.push.available && pushSupported();
  $('pushOn').hidden = !can || deviceOn;
  $('pushOff').hidden = !can || !deviceOn;
  $('pushTest').hidden = !(deviceOn || (n.telegram.linked && n.prefs.telegram));
  $('pushState').textContent = !n.push.available
    ? t('notify.push-unavailable')
    : !pushSupported()
      ? t('notify.push-unsupported')
      : deviceOn
        ? t('notify.push-on-here')
        : t('notify.push-off-here');
}

function renderSecurity() {
  const s = security;
  $('securityLede').textContent = t(s.required ? 'security.lede-staff' : 'security.lede-public');
  $('totpState').textContent = s.totp.shared
    ? t('security.totp-shared')
    : s.totp.local
      ? t('security.totp-local')
      : t('security.totp-none');
  $('totpAdd').hidden = s.totp.shared || s.totp.local || totpSetup !== null;
  $('totpRemove').hidden = !s.totp.local;
  $('totpSetup').hidden = totpSetup === null;

  $('passkeyList').replaceChildren(
    ...(s.passkeys.length === 0
      ? [el('li', { class: 'muted small', text: t('security.passkeys-none') })]
      : s.passkeys.map((p) => el('li', { class: 'item-row' }, [
        iconNode('key'),
        el('span', { class: 'item-main' }, [
          el('span', { text: p.label || t('security.passkey-unnamed') }),
          el('span', { class: 'muted small', text: t('security.passkey-added', { date: formatDate(p.createdAt) }) }),
        ]),
        el('button', {
          class: 'btn btn-small btn-quiet',
          type: 'button',
          text: t('security.remove'),
          'aria-label': t('security.passkey-remove', { name: p.label || t('security.passkey-unnamed') }),
          onclick: () => askPassword({ kind: 'passkey-remove', id: p.id }),
        }),
      ])))
  );
  $('passkeyAdd').hidden = !passkeysSupported();

  $('telegramBox').hidden = !s.telegram.available;
  $('telegramState').textContent = s.telegram.linked
    ? (s.telegram.username ? t('security.telegram-linked-as', { username: s.telegram.username }) : t('security.telegram-linked'))
    : t('security.telegram-none');
  $('telegramLink').hidden = s.telegram.linked;
  $('telegramUnlink').hidden = !s.telegram.linked;

  $('backupState').textContent = t('security.backup-left', { count: s.backupCodesLeft });
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
    $('accountLoading').hidden = true;
    $('accountView').hidden = false;
    $('securityError').textContent = errorText(error);
    renderProfile();
    return;
  }
  $('accountLoading').hidden = true;
  $('accountView').hidden = false;
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
  $(id).addEventListener('change', () => {
    const box = $(id);
    withBusy(null, $('notifyError'), async () => {
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

$('pushOn').addEventListener('click', () => {
  withBusy($('pushOn'), $('notifyError'), async () => {
    const subscription = await subscribeDevice(notify.push.publicKey);
    notify = await post('/api/me/notifications', { action: 'subscribe', subscription });
    deviceOn = true;
    renderNotify();
  });
});

$('pushOff').addEventListener('click', () => {
  withBusy($('pushOff'), $('notifyError'), async () => {
    const endpoint = await unsubscribeDevice();
    if (endpoint) notify = await post('/api/me/notifications', { action: 'unsubscribe', endpoint });
    deviceOn = false;
    renderNotify();
  });
});

$('pushTest').addEventListener('click', () => {
  withBusy($('pushTest'), $('notifyError'), async () => {
    await post('/api/me/notifications', { action: 'test' });
  });
});

// ---------------------------------------------------------------------------
// Actions that need the password again
// ---------------------------------------------------------------------------

function askPassword(action) {
  pending = action;
  $('confirmPassword').value = '';
  $('passwordModalError').textContent = '';
  $('passkeyLabelField').hidden = action.kind !== 'passkey-add';
  $('passwordModalLede').textContent = t(action.kind === 'delete-account' ? 'account.delete-confirm' : 'security.password-lede');
  openModal('passwordModal', { initialFocus: action.kind === 'passkey-add' ? $('newPasskeyLabel') : $('confirmPassword') });
}

function showNewCodes(codes) {
  showCodes($('codesList'), codes, { copyButton: $('codesCopy'), downloadButton: $('codesDownload') });
  $('newCodes').hidden = false;
}

$('passwordModalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const password = $('confirmPassword').value;
  withBusy($('passwordModalSubmit'), $('passwordModalError'), async () => {
    const action = pending;
    if (action.kind === 'passkey-add') {
      const { options } = await post('/api/me/security', { action: 'passkey-options', password });
      let response;
      try {
        response = await createPasskey(options);
      } catch (cause) {
        throw Object.assign(new Error('passkey'), { code: passkeyErrorCode(cause) });
      }
      security = await post('/api/me/security', { action: 'passkey-finish', response, label: $('newPasskeyLabel').value });
      $('newPasskeyLabel').value = '';
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
      $('totpQr').innerHTML = qrSvg(data.uri, t('setup.totp-qr-label'));
      $('totpSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    } else if (action.kind === 'totp-remove') {
      security = await post('/api/me/security', { action: 'totp-remove', password });
    } else if (action.kind === 'delete-account') {
      await post('/api/me/security', { action: 'delete-account', password });
      location.replace('/');
      return;
    }
    closeModal('passwordModal');
    renderSecurity();
    if (action.kind === 'totp-add') $('totpCode').focus();
  });
});

$('totpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('totpSubmit'), $('securityError'), async () => {
    const data = await post('/api/me/security', { action: 'totp-finish', setup: totpSetup, code: $('totpCode').value });
    totpSetup = null;
    $('totpCode').value = '';
    const { codes, ...rest } = data;
    security = rest;
    if (codes) showNewCodes(codes);
    renderSecurity();
  });
});

$('totpAdd').addEventListener('click', () => askPassword({ kind: 'totp-add' }));
$('totpRemove').addEventListener('click', () => askPassword({ kind: 'totp-remove' }));
$('passkeyAdd').addEventListener('click', () => askPassword({ kind: 'passkey-add' }));
$('telegramUnlink').addEventListener('click', () => askPassword({ kind: 'telegram-unlink' }));
$('backupNew').addEventListener('click', () => askPassword({ kind: 'backup-new' }));
$('deleteAccount').addEventListener('click', () => askPassword({ kind: 'delete-account' }));

$('telegramLink').addEventListener('click', () => {
  withBusy($('telegramLink'), $('securityError'), async () => {
    const { url } = await post('/api/me/security', { action: 'telegram-link' });
    window.open(url, '_blank', 'noopener');
    $('telegramState').textContent = t('security.telegram-pending');
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

$('signOut').addEventListener('click', () => {
  withBusy($('signOut'), $('securityError'), async () => {
    await post('/api/auth/session', { action: 'logout' });
    location.replace('/');
  });
});

$('signOutOthers').addEventListener('click', () => {
  withBusy($('signOutOthers'), $('securityError'), async () => {
    await post('/api/auth/session', { action: 'logout-others' });
    $('accountNotice').textContent = t('account.signed-out-others');
  });
});

onChange(() => {
  if (me) renderProfile();
  if (rsvps) renderRsvps();
  if (notify) renderNotify();
  if (security) renderSecurity();
});

load();
