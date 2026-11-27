// The edit form's ID verification tab (migrations/027): the ID checks the
// event accepts (HelloID, free; Didit and Veriff, paid per check), checking
// ID at the door (a plain field of the form, idCheckDoor), and who of the
// people going has verified and who has not.
//
// The ways a deploy does not offer (an outside provider without its keys)
// are not shown; one already ticked stays shown, so it can be unticked (the
// server drops it at the next save anyway).

import { t as translate } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';
import { iconNode } from './icons.js';

const byId = (id) => document.getElementById(id);
const WAYS = ['helloid', 'didit', 'veriff'];
let offered = ['helloid'];

// The ways this deploy offers, from the event list's answer.
export function setOfferedIdWays(list) {
  if (Array.isArray(list)) {
    offered = list;
  }
  syncWays();
}

function syncWays() {
  let paidTicked = false;
  for (const way of WAYS) {
    const box = byId(`f-idway-${way}`);
    const label = box.closest('.id-way');
    let shown = offered.includes(way);
    if (box.checked) {
      shown = true;
    }
    label.hidden = !shown;
    label.nextElementSibling.hidden = !shown;
    label.classList.toggle('is-unavailable', !offered.includes(way));
    if (box.checked && way !== 'helloid') {
      paidTicked = true;
    }
  }
  byId('idWaysPaidNote').hidden = !paidTicked;
}

export function setIdCheck(values) {
  let ticked = [];
  if (Array.isArray(values.idCheckProviders)) {
    ticked = values.idCheckProviders;
  }
  for (const way of WAYS) {
    byId(`f-idway-${way}`).checked = ticked.includes(way);
  }
  syncWays();
}

export function readIdCheck() {
  return { idCheckProviders: WAYS.filter((way) => byId(`f-idway-${way}`).checked) };
}

// A way's name, as the lists show it.
export function idWayName(way) {
  if (way === 'helloid') {
    return translate('idcheck.way.helloid');
  }
  if (way === 'didit') {
    return 'Didit';
  }
  if (way === 'veriff') {
    return 'Veriff';
  }
  return way;
}

function personRow(attendee, note) {
  let name = attendee.displayName;
  if (!name) {
    name = attendee.username;
  }
  const details = [];
  if (attendee.rsvpNumber !== null) {
    details.push(translate('manage.attendee-number', { number: attendee.rsvpNumber }));
  }
  details.push(attendee.username, note);
  return createElement('li', { class: 'item-row' }, [
    iconNode('user'),
    createElement('span', { class: 'item-main' }, [
      createElement('span', { text: name }),
      createElement('span', { class: 'muted small', text: details.join(' · ') }),
    ]),
  ]);
}

// The two lists under the ways: verified (with how), and not verified yet
// (waiting for review, or nothing). attendees: the attendee list, each
// with idCheck (null when the event requires no check).
export function renderIdLists(attendees, saved) {
  const box = byId('idListsBox');
  const requires = readIdCheck().idCheckProviders.length > 0;
  box.hidden = true;
  if (saved && requires) {
    box.hidden = false;
  }
  if (box.hidden) {
    return;
  }
  const isVerified = (attendee) => {
    if (!attendee.idCheck) {
      return false;
    }
    return attendee.idCheck.state === 'verified';
  };
  const verified = attendees.filter(isVerified);
  const waiting = attendees.filter((attendee) => !isVerified(attendee));
  byId('idVerifiedTitle').textContent = translate('manage.idcheck-verified', { count: verified.length });
  byId('idPendingTitle').textContent = translate('manage.idcheck-not-verified', { count: waiting.length });
  const empty = () => createElement('li', { class: 'muted small', text: translate('manage.idcheck-nobody') });
  let verifiedRows = verified.map((attendee) => personRow(attendee, translate('manage.idcheck-via', { way: idWayName(attendee.idCheck.via) })));
  if (verifiedRows.length === 0) {
    verifiedRows = [empty()];
  }
  let waitingRows = waiting.map((attendee) => {
    let note = translate('manage.idcheck-none');
    if (attendee.idCheck && attendee.idCheck.state === 'pending') {
      note = translate('manage.idcheck-pending');
    }
    return personRow(attendee, note);
  });
  if (waitingRows.length === 0) {
    waitingRows = [empty()];
  }
  byId('idVerifiedList').replaceChildren(...verifiedRows);
  byId('idPendingList').replaceChildren(...waitingRows);
}

export function startIdCheck() {
  for (const way of WAYS) {
    byId(`f-idway-${way}`).addEventListener('change', syncWays);
  }
}
