// The staff tools under the events on /manage (api/manage/admin.js): venue
// sign-up allowances for editors and admins; the name filter, flagged names
// and member password reset codes for admins. The server checks the role on
// every request; hiding sections here is only tidiness.

import { t, onChange } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { el, withBusy, formatDate, copyText } from './ui.js';
import { iconNode } from './icons.js';

const $ = (id) => document.getElementById(id);
let state = null;
let admin = false;

function renderAllowances() {
  $('allowanceHere').textContent = t(state.here ? 'admin.allowance-here-on' : 'admin.allowance-here-off');
  $('allowanceList').replaceChildren(
    ...state.allowances.map((a) => el('li', { class: 'item-row' }, [
      iconNode('users'),
      el('span', { class: 'item-main' }, [
        el('span', { text: `${a.label || t('admin.allowance-unnamed')}${a.here ? ` (${t('admin.allowance-this')})` : ''}` }),
        el('span', { class: 'muted small', text: t('admin.allowance-detail', { rate: a.perHour, until: formatDate(a.expiresAt), by: a.by || '?' }) }),
      ]),
      el('button', { class: 'btn btn-small btn-quiet', type: 'button', text: t('admin.allowance-end'), onclick: () => revoke(a.id) }),
    ]))
  );
}

function renderFilters() {
  $('builtInTerms').textContent = state.builtIn.join(', ');
  $('filterList').replaceChildren(
    ...(state.filters.length === 0
      ? [el('li', { class: 'muted small', text: t('admin.filter-none') })]
      : state.filters.map((f) => el('li', { class: 'item-row' }, [
        el('span', { class: 'item-main', text: f.term }),
        el('button', { class: 'btn btn-small btn-quiet', type: 'button', text: t('security.remove'), 'aria-label': t('admin.filter-remove', { term: f.term }), onclick: () => removeFilter(f.id) }),
      ])))
  );
  $('flaggedList').replaceChildren(
    ...(state.flagged.length === 0
      ? [el('li', { class: 'muted small', text: t('admin.flagged-none') })]
      : state.flagged.map((f) => el('li', { class: 'item-row' }, [
        iconNode('alert'),
        el('span', { class: 'item-main' }, [
          el('span', { text: f.displayName }),
          el('span', { class: 'muted small', text: t('admin.flagged-detail', { username: f.username, term: f.term }) }),
        ]),
      ])))
  );
}

function render() {
  renderAllowances();
  if (admin) renderFilters();
}

async function revoke(id) {
  await withBusy(null, $('allowanceError'), async () => {
    const data = await post('/api/manage/admin', { action: 'allowance-revoke', id });
    state = { ...state, ...data };
    renderAllowances();
  });
}

async function removeFilter(id) {
  await withBusy(null, $('filterError'), async () => {
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
  $('allowanceBox').hidden = false;
  $('filterBox').hidden = !admin;
  $('resetBox').hidden = !admin;
  render();

  $('allowanceForm').addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('allowanceSubmit'), $('allowanceError'), async () => {
      const data = await post('/api/manage/admin', {
        action: 'allowance-grant',
        hours: Number($('allowanceHours').value),
        perHour: Number($('allowanceRate').value),
        label: $('allowanceLabel').value,
      });
      state = { ...state, ...data };
      $('allowanceLabel').value = '';
      renderAllowances();
    });
  });

  $('filterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('filterSubmit'), $('filterError'), async () => {
      const data = await post('/api/manage/admin', { action: 'filter-add', term: $('filterTerm').value });
      state = { ...state, ...data };
      $('filterTerm').value = '';
      renderFilters();
    });
  });

  $('resetForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('resetResult').hidden = true;
    withBusy($('resetSubmit'), $('resetError'), async () => {
      const { code, expiresAt } = await post('/api/manage/admin', { action: 'reset-issue', username: $('resetUsername').value });
      $('resetCodeShown').textContent = code;
      $('resetExpiry').textContent = t('admin.reset-expires', { until: formatDate(expiresAt) });
      $('resetCopy').onclick = () => copyText(code);
      $('resetResult').hidden = false;
    });
  });

  onChange(render);
}
