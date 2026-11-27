// The account page's ID verification (migrations/027): HelloID (this site's
// own, at /helloid), and the outside providers this site offers (Didit,
// Veriff: the button sends the person to the provider's page, which sends
// them back to /api/idcheck/return, then here with ?idcheck=done). The
// checkmark by the legal name shows once any way has passed.
//
// ?next=/e/<slug> (an event that asked for an ID check) is carried to the
// provider and back, and to HelloID, so "Back to the event" can go there.

import { t as translate } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { withBusy } from './ui.js';

const byId = (id) => document.getElementById(id);
let idCheck = null;
let helloid = null;
let onUser = () => {};

function backToEvent() {
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^\/e\/[a-z0-9-]{3,60}$/.test(next)) {
    return next;
  }
  return null;
}

function wayName(way) {
  if (way === 'helloid') {
    return translate('idcheck.way.helloid');
  }
  if (way === 'didit') {
    return 'Didit';
  }
  return 'Veriff';
}

// What the latest try says, as a callout: waiting, declined (with the
// reason), failed, or nothing.
function statusOf() {
  if (helloid && helloid.pending) {
    return { kind: 'warn', text: translate('idcheck.helloid-pending') };
  }
  if (helloid && helloid.latest && helloid.latest.status === 'declined' && !helloid.verified) {
    if (helloid.latest.failure === 'document_used') {
      return { kind: 'danger', text: translate('idcheck.document-used') };
    }
    return { kind: 'danger', text: translate('idcheck.helloid-declined', { reason: helloid.latest.reason }) };
  }
  if (idCheck && idCheck.latest && !idCheck.verified.includes(idCheck.latest.provider)) {
    const name = wayName(idCheck.latest.provider);
    const status = idCheck.latest.status;
    if (status === 'review' || status === 'pending' || status === 'started') {
      return { kind: 'warn', text: translate(`idcheck.provider-${status}`, { provider: name }) };
    }
    if (idCheck.latest.failure === 'document_used') {
      return { kind: 'danger', text: translate('idcheck.document-used') };
    }
    if (status === 'declined' || status === 'failed') {
      return { kind: 'danger', text: translate('idcheck.provider-failed', { provider: name }) };
    }
  }
  return null;
}

export function renderIdCheck(user) {
  const verified = user.idVerified;
  byId('legalNameVerified').hidden = verified.length === 0;
  const note = byId('idVerifiedNote');
  note.hidden = verified.length === 0;
  if (verified.length > 0) {
    note.textContent = translate('idcheck.verified-with', { ways: verified.map(wayName).join(', ') });
  }
  const status = statusOf();
  byId('idStatus').hidden = !status;
  if (status) {
    byId('idStatus').className = `callout ${status.kind} small u-mt-1`;
    byId('idStatus').textContent = status.text;
  }
  let providers = [];
  if (idCheck) {
    providers = idCheck.providers;
  }
  byId('idHelloid').hidden = verified.includes('helloid');
  // The note about outside services only when this site offers one.
  byId('idOptionsHint').hidden = providers.length === 0;
  let helloidHref = '/helloid';
  if (backToEvent()) {
    helloidHref += `?next=${encodeURIComponent(backToEvent())}`;
  }
  byId('idHelloid').href = helloidHref;
  for (const [id, way] of [['idDidit', 'didit'], ['idVeriff', 'veriff']]) {
    let shown = false;
    if (providers.includes(way) && !verified.includes(way)) {
      shown = true;
    }
    byId(id).hidden = !shown;
  }
  let waiting = false;
  if (idCheck && idCheck.latest && ['started', 'pending', 'review'].includes(idCheck.latest.status)) {
    waiting = true;
  }
  byId('idRefreshRow').hidden = !waiting;
  const back = backToEvent();
  byId('idBackToEvent').hidden = !back;
  if (back) {
    byId('idBackToEvent').href = back;
  }
}

async function reload(user, refresh) {
  if (refresh) {
    idCheck = (await post('/api/me/idcheck', { action: 'refresh' })).idCheck;
  } else {
    idCheck = (await api('/api/me/idcheck')).idCheck;
  }
  helloid = (await api('/api/me/helloid')).helloid;
  // The account as it now is: a check that passed has set the legal name.
  const fresh = (await api('/api/auth/session')).user;
  onUser(fresh);
  renderIdCheck(fresh);
}

function startProvider(provider, button) {
  withBusy(button, byId('idError'), async () => {
    const body = { action: 'start', provider };
    if (backToEvent()) {
      body.next = backToEvent();
    }
    const { url } = await post('/api/me/idcheck', body);
    location.assign(url);
  });
}

export async function startIdCheckSection(user, options) {
  onUser = options.onUser;
  renderIdCheck(user);
  byId('idDidit').addEventListener('click', () => startProvider('didit', byId('idDidit')));
  byId('idVeriff').addEventListener('click', () => startProvider('veriff', byId('idVeriff')));
  byId('idRefresh').addEventListener('click', () => withBusy(byId('idRefresh'), byId('idError'), () => reload(user, true)));
  // Back from a provider: read its result straight away.
  const back = new URLSearchParams(location.search).get('idcheck') === 'done';
  try {
    await reload(user, back);
  } catch {
    renderIdCheck(user);
  }
}
