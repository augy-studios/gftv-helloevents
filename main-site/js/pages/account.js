// The account page: who you are, the events you are going to, and the
// second factors you have on this site.

import { session } from '../app.js';
import { t, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { el, withBusy, errorText, openModal, closeModal, formatDate } from '../ui.js';
import { iconNode } from '../icons.js';
import { eventCard } from '../cards.js';
import { showCodes } from '../codes.js';
import { passkeysSupported, createPasskey, passkeyErrorCode } from '../passkeys.js';

const $ = (id) => document.getElementById(id);
let me = null;
let security = null;
let rsvps = null;
// The action waiting on the password dialog.
let pending = null;

function renderProfile() {
  $('displayName').textContent = me.displayName;
  $('username').textContent = me.username;
  $('role').textContent = t(`role.${me.role}`);
  if (me.avatarUrl) {
    $('avatar').src = me.avatarUrl;
    $('avatar').referrerPolicy = 'no-referrer';
    $('avatar').hidden = false;
  }
}

function renderRsvps() {
  $('rsvpUpcoming').replaceChildren(...rsvps.upcoming.filter((r) => r.event).map((r) => eventCard(r.event)));
  $('rsvpEmpty').hidden = rsvps.upcoming.length > 0;
  $('pastBox').hidden = rsvps.past.length === 0;
  $('rsvpPast').replaceChildren(...rsvps.past.filter((r) => r.event).map((r) => eventCard(r.event)));
}

function renderSecurity() {
  const s = security;
  $('totpState').textContent = s.totp.shared
    ? t('security.totp-shared')
    : s.totp.local
      ? t('security.totp-local')
      : t('security.totp-none');

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
    [security, rsvps] = await Promise.all([api('/api/me/security'), api('/api/me/rsvps')]);
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
  renderSecurity();
}

// ---------------------------------------------------------------------------
// Actions that need the password again
// ---------------------------------------------------------------------------

function askPassword(action) {
  pending = action;
  $('confirmPassword').value = '';
  $('passwordModalError').textContent = '';
  $('passkeyLabelField').hidden = action.kind !== 'passkey-add';
  openModal('passwordModal', { initialFocus: action.kind === 'passkey-add' ? $('newPasskeyLabel') : $('confirmPassword') });
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
    } else if (action.kind === 'backup-new') {
      const { codes } = await post('/api/me/security', { action: 'backup-regenerate', password });
      showCodes($('codesList'), codes, { copyButton: $('codesCopy'), downloadButton: $('codesDownload') });
      $('newCodes').hidden = false;
      security = { ...security, backupCodesLeft: codes.length };
    }
    closeModal('passwordModal');
    renderSecurity();
  });
});

$('passkeyAdd').addEventListener('click', () => askPassword({ kind: 'passkey-add' }));
$('telegramUnlink').addEventListener('click', () => askPassword({ kind: 'telegram-unlink' }));
$('backupNew').addEventListener('click', () => askPassword({ kind: 'backup-new' }));

$('telegramLink').addEventListener('click', () => {
  withBusy($('telegramLink'), $('securityError'), async () => {
    const { url } = await post('/api/me/security', { action: 'telegram-link' });
    window.open(url, '_blank', 'noopener');
    $('telegramState').textContent = t('security.telegram-pending');
    // Linking finishes in Telegram; look again when the person comes back.
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', refresh);
      security = await api('/api/me/security');
      renderSecurity();
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
  if (security) renderSecurity();
});

load();
