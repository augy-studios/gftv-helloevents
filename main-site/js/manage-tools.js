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
let admin = false;

function renderAllowances() {
  byId('allowanceHere').textContent = translate(state.here ? 'admin.allowance-here-on' : 'admin.allowance-here-off');
  byId('allowanceList').replaceChildren(
    ...state.allowances.map((a) => createElement('li', { class: 'item-row' }, [
      iconNode('users'),
      createElement('span', { class: 'item-main' }, [
        createElement('span', { text: `${a.label || translate('admin.allowance-unnamed')}${a.here ? ` (${translate('admin.allowance-this')})` : ''}` }),
        createElement('span', { class: 'muted small', text: translate('admin.allowance-detail', { rate: a.perHour, until: formatDate(a.expiresAt), by: a.by || '?' }) }),
      ]),
      createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', text: translate('admin.allowance-end'), onclick: () => revoke(a.id) }),
    ]))
  );
}

function renderFilters() {
  byId('builtInTerms').textContent = state.builtIn.join(', ');
  byId('filterList').replaceChildren(
    ...(state.filters.length === 0
      ? [createElement('li', { class: 'muted small', text: translate('admin.filter-none') })]
      : state.filters.map((f) => createElement('li', { class: 'item-row' }, [
        createElement('span', { class: 'item-main', text: f.term }),
        createElement('button', { class: 'btn btn-small btn-quiet', type: 'button', text: translate('security.remove'), 'aria-label': translate('admin.filter-remove', { term: f.term }), onclick: () => removeFilter(f.id) }),
      ])))
  );
  byId('flaggedList').replaceChildren(
    ...(state.flagged.length === 0
      ? [createElement('li', { class: 'muted small', text: translate('admin.flagged-none') })]
      : state.flagged.map((f) => createElement('li', { class: 'item-row' }, [
        iconNode('alert'),
        createElement('span', { class: 'item-main' }, [
          createElement('span', { text: f.displayName }),
          createElement('span', { class: 'muted small', text: translate('admin.flagged-detail', { username: f.username, term: f.term }) }),
        ]),
      ])))
  );
}

function render() {
  renderAllowances();
  if (admin) renderFilters();
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

export async function startTools(me) {
  admin = me.role === 'admin';
  try {
    state = await api('/api/manage/admin');
  } catch {
    return; // the events still work; the tools stay hidden
  }
  byId('allowanceBox').hidden = false;
  byId('filterBox').hidden = !admin;
  byId('resetBox').hidden = !admin;
  render();

  byId('allowanceForm').addEventListener('submit', (e) => {
    e.preventDefault();
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

  byId('filterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(byId('filterSubmit'), byId('filterError'), async () => {
      const data = await post('/api/manage/admin', { action: 'filter-add', term: byId('filterTerm').value });
      state = { ...state, ...data };
      byId('filterTerm').value = '';
      renderFilters();
    });
  });

  byId('resetForm').addEventListener('submit', (e) => {
    e.preventDefault();
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
