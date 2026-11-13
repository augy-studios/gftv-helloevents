// The staff tools under the events on /manage (api/manage/admin.js): venue
// sign-up allowances for editors and admins; the name filter, flagged names
// and member password reset codes for admins. The server checks the role on
// every request; hiding sections here is only tidiness.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, withBusy, formatDate, copyText } from './ui.js';
import { iconNode } from './icons.js';

const byId = (id) => document.getElementById(id);
let state = null;
let isAdmin = false;

// One venue allowance: its name (marked when it is for this connection), the
// rate, until when and who set it, and an End button.
function allowanceRow(allowance) {
  let name = allowance.label;
  if (!name) {
    name = translate('admin.allowance-unnamed');
  }
  let thisConnection = '';
  if (allowance.here) {
    thisConnection = ` (${translate('admin.allowance-this')})`;
  }
  let grantedBy = allowance.by;
  if (!grantedBy) {
    grantedBy = '?';
  }
  const detail = translate('admin.allowance-detail', { rate: allowance.perHour, until: formatDate(allowance.expiresAt), by: grantedBy });
  return createElement('li', { class: 'item-row' }, [
    iconNode('users'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: `${name}${thisConnection}` }),
      createElement('span', { class: 'muted small', text: detail }),
    ]),
    createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', text: translate('admin.allowance-end'), onclick: () => revoke(allowance.id) }),
  ]);
}

function renderAllowances() {
  let hereKey = 'admin.allowance-here-off';
  if (state.here) {
    hereKey = 'admin.allowance-here-on';
  }
  byId('allowanceHere').textContent = translate(hereKey);
  byId('allowanceList').replaceChildren(...state.allowances.map((allowance) => allowanceRow(allowance)));
}

// One word an admin added to the name filter, with its Remove button.
function nameFilterRow(nameFilter) {
  return createElement('li', { class: 'item-row' }, [
    createElement('span', { class: 'item-main', text: nameFilter.term }),
    createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', text: translate('security.remove'), 'aria-label': translate('admin.filter-remove', { term: nameFilter.term }), onclick: () => removeFilter(nameFilter.id) }),
  ]);
}

// One existing name that matches the filter: the display name, the username
// and the word it matched.
function flaggedRow(flagged) {
  return createElement('li', { class: 'item-row' }, [
    iconNode('alert'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: flagged.displayName }),
      createElement('span', { class: 'muted small', text: translate('admin.flagged-detail', { username: flagged.username, term: flagged.term }) }),
    ]),
  ]);
}

function renderFilters() {
  byId('builtInTerms').textContent = state.builtIn.join(', ');

  let filterRows;
  if (state.filters.length === 0) {
    filterRows = [createElement('li', { class: 'muted small', text: translate('admin.filter-none') })];
  } else {
    filterRows = state.filters.map((nameFilter) => nameFilterRow(nameFilter));
  }
  byId('filterList').replaceChildren(...filterRows);

  let flaggedRows;
  if (state.flagged.length === 0) {
    flaggedRows = [createElement('li', { class: 'muted small', text: translate('admin.flagged-none') })];
  } else {
    flaggedRows = state.flagged.map((flagged) => flaggedRow(flagged));
  }
  byId('flaggedList').replaceChildren(...flaggedRows);
}

function render() {
  renderAllowances();
  if (isAdmin) {
    renderFilters();
  }
}

async function revoke(id) {
  await withBusy(null, byId('allowanceError'), async () => {
    const data = await post('/api/manage/admin', { action: 'allowance-revoke', id });
    state = { ...state, ...data };
    renderAllowances();
  });
}

async function removeFilter(id) {
  await withBusy(null, byId('filterError'), async () => {
    const data = await post('/api/manage/admin', { action: 'filter-remove', id });
    state = { ...state, ...data };
    renderFilters();
  });
}

// Loads the tools' state and shows the sections this role may use: venue
// allowances for every editor, the name filter and reset codes for admins
// only. Then wires the three forms: grant an allowance, add a filter word,
// and make a one-time reset code (shown with a Copy button).
export async function startTools(currentUser) {
  isAdmin = currentUser.role === 'admin';
  try {
    state = await api('/api/manage/admin');
  } catch {
    return; // the events still work; the tools stay hidden
  }
  byId('allowanceBox').hidden = false;
  byId('filterBox').hidden = !isAdmin;
  byId('resetBox').hidden = !isAdmin;
  render();

  byId('allowanceForm').addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(byId('allowanceSubmit'), byId('allowanceError'), async () => {
      const data = await post('/api/manage/admin', {
        action: 'allowance-grant',
        hours: Number(byId('allowanceHours').value),
        perHour: Number(byId('allowanceRate').value),
        label: byId('allowanceLabel').value,
      });
      state = { ...state, ...data };
      byId('allowanceLabel').value = '';
      renderAllowances();
    });
  });

  byId('filterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(byId('filterSubmit'), byId('filterError'), async () => {
      const data = await post('/api/manage/admin', { action: 'filter-add', term: byId('filterTerm').value });
      state = { ...state, ...data };
      byId('filterTerm').value = '';
      renderFilters();
    });
  });

  byId('resetForm').addEventListener('submit', (event) => {
    event.preventDefault();
    byId('resetResult').hidden = true;
    withBusy(byId('resetSubmit'), byId('resetError'), async () => {
      const { code, expiresAt } = await post('/api/manage/admin', { action: 'reset-issue', username: byId('resetUsername').value });
      byId('resetCodeShown').textContent = code;
      byId('resetExpiry').textContent = translate('admin.reset-expires', { until: formatDate(expiresAt) });
      byId('resetCopy').onclick = () => copyText(code);
      byId('resetResult').hidden = false;
    });
  });

  onChange(render);
}
