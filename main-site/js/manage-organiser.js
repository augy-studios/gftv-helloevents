// The edit form's Organiser field: a list of GFTV's teams (the divisions,
// sub-committees and teams, as the GFTV jobs portal lists them), or
// "Other" for anyone else, which shows a box to type their name in.
//
// The organiser is still stored as plain text (organiser_name): a team
// picked is saved by its full name, so the event page says "Organised by
// Media and News (MAWS) Division" and a search for "MAWS" finds it. A saved
// name that is not one of the teams opens on "Other", with the name in the
// box. The list itself (#organiserPick) is never sent; #f-organiserName,
// the box, always holds the value.

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';

// GFTV's teams, by their short code, in the jobs portal's order.
export const GFTV_TEAMS = [
  { code: 'ciisc', name: 'Community Inclusion and Integration Sub-Committee (CIISC)' },
  { code: 'cio', name: 'Community Initiative and Outreach (CIO) Division' },
  { code: 'ccs', name: 'Core Coverage Support (CCS) Team' },
  { code: 'maws', name: 'Media and News (MAWS) Division' },
  { code: 'pal', name: 'Policy, Action and Leadership (PAL) Division' },
  { code: 'psosc', name: 'Project Starlight Organising Sub-Committee (PSOSC)' },
  { code: 'tidsc', name: 'Technology and Infrastructure Development Sub-Committee (TIDSC)' },
];

const OTHER = 'other';
const byId = (id) => document.getElementById(id);

// The team a saved name is, or null.
function teamNamed(name) {
  const wanted = name.trim().toLowerCase();
  const match = GFTV_TEAMS.find((team) => team.name.toLowerCase() === wanted);
  if (!match) {
    return null;
  }
  return match;
}

function showOther(shown) {
  byId('organiserOtherField').hidden = !shown;
}

// The list's options: none yet, each team, and Other. Kept on what is
// picked when drawn again in another language.
function fillPick() {
  const pick = byId('organiserPick');
  const picked = pick.value;
  pick.replaceChildren(
    createElement('option', { value: '', text: translate('manage.organiser-none') }),
    ...GFTV_TEAMS.map((team) => createElement('option', { value: team.code, text: team.name })),
    createElement('option', { value: OTHER, text: translate('manage.organiser-other') }),
  );
  pick.value = picked;
}

// Sets the list from the name in the box. reset: a newly opened event, so
// a blank name is "none yet" even if Other was picked for the last one;
// otherwise a blank box keeps Other while someone is about to type in it.
export function syncOrganiser({ reset = false } = {}) {
  const pick = byId('organiserPick');
  const name = byId('f-organiserName').value;
  const team = teamNamed(name);
  if (team) {
    pick.value = team.code;
    byId('f-organiserName').value = team.name;
  } else if (name.trim() !== '') {
    pick.value = OTHER;
  } else if (reset || pick.value !== OTHER) {
    pick.value = '';
  }
  showOther(pick.value === OTHER);
}

// Wires the list once. A team picked goes into the box (hidden), so the
// form saves it like any other field; Other shows the box, emptied of a
// team's name, to type in.
export function startOrganiser() {
  fillPick();
  const pick = byId('organiserPick');
  pick.addEventListener('change', () => {
    const box = byId('f-organiserName');
    if (pick.value === OTHER) {
      if (teamNamed(box.value)) {
        box.value = '';
      }
      showOther(true);
      box.focus();
      return;
    }
    const team = GFTV_TEAMS.find((each) => each.code === pick.value);
    box.value = '';
    if (team) {
      box.value = team.name;
    }
    showOther(false);
  });
  syncOrganiser({ reset: true });
}

// Redraws the list's words in the reader's language.
export function relabelOrganiser() {
  fillPick();
}
