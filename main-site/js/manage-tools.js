// The staff tools in their own tabs on /manage (api/manage/admin.js), for
// admins: HelloID reviews (js/manage-idreviews.js), the name filter, flagged
// names, member password reset codes and corrections to locked personal
// details. The server checks the role on
// every request; hiding sections here is only tidiness.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, withBusy, formatDate, copyText } from './ui.js';
import { iconNode } from './icons.js';
import { fillCountrySelect } from './choices.js';
import { startIdReviews, relabelIdReviews } from './manage-idreviews.js';

const byId = (id) => document.getElementById(id);
let state = null;

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
  renderFilters();
}

async function removeFilter(id) {
  await withBusy(null, byId('filterError'), async () => {
    const data = await post('/api/manage/admin', { action: 'filter-remove', id });
    state = { ...state, ...data };
    renderFilters();
  });
}

// For an admin, loads the tools' state and shows their tabs (the page then
// calls its tabs' refresh). Then wires the forms: add a filter word, make a
// one-time reset code (shown with a Copy button), and correct a locked
// personal detail. Other editors have no staff tools.
export async function startTools(currentUser) {
  if (currentUser.role !== 'admin') {
    return;
  }
  try {
    state = await api('/api/manage/admin');
  } catch {
    return; // the events still work; the tools' tabs stay hidden
  }
  byId('tab-filter').hidden = false;
  byId('tab-reset').hidden = false;
  render();
  await startIdReviews();

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

  // Correcting a locked personal detail (migrations/024): the input for the
  // detail picked; blank clears it.
  fillCountrySelect(byId('personalFixCountry'), '');
  const syncPersonalFix = () => {
    const which = byId('personalFixWhich').value;
    byId('personalFixTextField').hidden = which !== 'legalName';
    byId('personalFixDateField').hidden = which !== 'dateOfBirth';
    byId('personalFixCountryField').hidden = which !== 'country';
  };
  byId('personalFixWhich').addEventListener('change', syncPersonalFix);
  syncPersonalFix();
  byId('personalFixForm').addEventListener('submit', (event) => {
    event.preventDefault();
    byId('personalFixDone').hidden = true;
    withBusy(byId('personalFixSubmit'), byId('personalFixError'), async () => {
      const which = byId('personalFixWhich').value;
      const body = { action: 'personal-fix', username: byId('personalFixUsername').value };
      if (which === 'legalName') {
        body.legalName = byId('personalFixText').value;
      } else if (which === 'dateOfBirth') {
        body.dateOfBirth = byId('personalFixDate').value;
      } else {
        body.country = byId('personalFixCountry').value;
      }
      await post('/api/manage/admin', body);
      byId('personalFixDone').textContent = translate('admin.personal-done', { username: body.username.trim() });
      byId('personalFixDone').hidden = false;
    });
  });

  onChange(() => {
    render();
    relabelIdReviews();
  });
}
