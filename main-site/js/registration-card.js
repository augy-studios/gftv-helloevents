// "Registration details" on the event page (migrations/024): for someone
// going to an event with a registration form, their badge name (with the
// tier they hold), their badge number (their RSVP ID), the account details
// the form asks for, and every answer, each with a pencil to change it
// while registration is open for them (RSVPs open, the event not over, and
// their tier not closed). A pencil opens that one question in place, with
// Save and Cancel. A donation in a checkout order and the accepted Code of
// Conduct are not changed here. "Upgrade registration tier" goes to the
// checkout page when there is a dearer tier to move to.

import { t as translate } from '../assets/i18n/i18n.js';
import { post } from './api.js';
import { createElement, withBusy } from './ui.js';
import { iconNode } from './icons.js';
import { formQuestions } from './registration-fields.js';
import { questionLabel, answerText, accountDetailRows, accountDetailsHref, questionControl, controlProblem, registrationErrorText } from './registration-form.js';

// The question open for changing, if any, so a redraw keeps it open.
let editing = null;

// Whether this answer can be changed from the card.
function changeable(event, field) {
  const mine = event.viewer.registration;
  if (!mine.open) {
    return false;
  }
  if (field.type === 'agreement') {
    return false;
  }
  if (field.type === 'amount' && event.viewer.payment.method) {
    return false;
  }
  return true;
}

function pencil(field, onClick) {
  return createElement('button', {
    type: 'button',
    class: 'btn-icon reg-edit',
    'aria-label': translate('registration.edit', { field: questionLabel(field) }),
    onclick: onClick,
  }, [iconNode('edit')]);
}

// One question, as shown or as it is being changed.
function questionRow(event, field, redraw, onEvent, errorBox) {
  const mine = event.viewer.registration;
  const value = mine.answers[field.id];
  if (editing === field.id) {
    const control = questionControl(field, value, {
      idPrefix: 'regCard',
      slug: event.slug,
      currency: event.registration.currency,
      photoUrl: mine.photos[field.id],
      onEvent: (fresh) => {
        editing = null;
        onEvent(fresh);
      },
      errorBox,
    });
    const save = createElement('button', { type: 'button', class: 'btn btn-small btn-primary' }, [iconNode('check'), createElement('span', { text: translate('registration.save') })]);
    const cancel = createElement('button', { type: 'button', class: 'btn btn-small btn-quiet', text: translate('registration.cancel') });
    cancel.addEventListener('click', () => {
      editing = null;
      errorBox.textContent = '';
      redraw();
    });
    save.addEventListener('click', () => {
      const problem = controlProblem(control);
      if (problem) {
        errorBox.textContent = problem;
        control.focus();
        return;
      }
      errorBox.textContent = '';
      withBusy(save, null, async () => {
        try {
          const data = await post('/api/events/rsvp', { slug: event.slug, registration: { [field.id]: control.read() } });
          editing = null;
          onEvent(data.event);
        } catch (error) {
          errorBox.textContent = registrationErrorText(error, event.registration.fields);
        }
      });
    });
    let actions = [save, cancel];
    // A photo saves itself once chosen; only Done is needed.
    if (field.type === 'photo') {
      cancel.textContent = translate('registration.done');
      actions = [cancel];
    }
    return createElement('div', { class: 'reg-row reg-editing' }, [control.node, createElement('div', { class: 'actions inline' }, actions)]);
  }
  const head = [createElement('span', { class: 'reg-label', text: questionLabel(field) })];
  if (changeable(event, field)) {
    head.push(pencil(field, () => {
      editing = field.id;
      redraw();
      const opened = document.querySelector('.reg-editing input, .reg-editing select, .reg-editing textarea, .reg-editing .file-btn');
      if (opened) {
        opened.focus();
      }
    }));
  }
  let shown = createElement('span', { class: 'reg-value', text: answerText(field, value, event.registration.currency) });
  if (field.type === 'photo' && mine.photos[field.id]) {
    shown = createElement('img', { class: 'reg-photo-shown', src: mine.photos[field.id], alt: translate('registration.photo-alt', { label: questionLabel(field) }) });
  }
  return createElement('div', { class: 'reg-row' }, [createElement('div', { class: 'reg-row-head' }, head), shown]);
}

// Draws the card into box, or hides it (nobody going, or no form).
// onEvent(event): the event as the server answered after a change.
export function renderRegistrationCard(box, event, onEvent) {
  const viewer = event.viewer;
  if (!viewer.going || event.registration.fields.length === 0) {
    box.hidden = true;
    editing = null;
    return;
  }
  box.hidden = false;
  const mine = viewer.registration;
  // Only the questions the tiers they hold are asked.
  let fields = event.registration.fields;
  if (Array.isArray(mine.asked)) {
    fields = fields.filter((field) => mine.asked.includes(field.id));
  }
  const errorBox = createElement('div', { class: 'callout danger', role: 'alert' });
  const redraw = () => renderRegistrationCard(box, event, onEvent);

  // The heading: the badge name (or their display name's place, a dash),
  // its pencil, and the tier chip.
  const badgeField = fields.find((field) => field.id === 'badgeName');
  const title = [];
  if (badgeField && editing !== 'badgeName') {
    let badgeText = mine.answers.badgeName;
    if (!badgeText) {
      badgeText = '–';
    }
    title.push(createElement('span', { class: 'reg-badge-name', text: badgeText }));
    if (changeable(event, badgeField)) {
      title.push(pencil(badgeField, () => {
        editing = 'badgeName';
        redraw();
      }));
    }
  }
  if (mine.tier) {
    title.push(createElement('span', { class: 'chip reg-tier', text: mine.tier }));
  }
  const parts = [createElement('h2', { class: 'reg-title', text: translate('registration.card-title') })];
  const head = createElement('div', { class: 'reg-card-head' }, title);
  parts.push(head);
  if (badgeField && editing === 'badgeName') {
    parts.push(questionRow(event, badgeField, redraw, onEvent, errorBox));
  }
  if (viewer.rsvpNumber !== null) {
    parts.push(createElement('p', { class: 'reg-badge-number', text: translate('registration.badge-number', { number: viewer.rsvpNumber }) }));
  }
  const accountRows = accountDetailRows(fields, mine.personal, mine.accountMissing);
  parts.push(...accountRows);
  if (mine.accountMissing.length > 0) {
    parts.push(createElement('a', { class: 'btn btn-small', href: accountDetailsHref(mine.accountMissing, event.slug) }, [iconNode('user'), createElement('span', { text: translate('registration.account-fill') })]));
  }
  if (mine.missing) {
    parts.push(createElement('p', { class: 'callout warn small', text: translate('registration.answers-missing') }));
  }
  const others = formQuestions(fields).filter((field) => field.id !== 'badgeName');
  if (others.length > 0) {
    parts.push(createElement('hr', { class: 'reg-divider' }));
    parts.push(createElement('h3', { class: 'reg-subtitle', text: translate('registration.additional') }));
    parts.push(...others.map((field) => questionRow(event, field, redraw, onEvent, errorBox)));
  }
  if (!mine.open) {
    parts.push(createElement('p', { class: 'small muted', text: translate('registration.closed-note') }));
  }
  parts.push(errorBox);
  const card = createElement('div', { class: 'reg-card' }, parts);
  const after = [];
  if (viewer.canUpgrade) {
    after.push(createElement('a', { class: 'btn btn-primary btn-block reg-upgrade', href: `/checkout?slug=${encodeURIComponent(event.slug)}&upgrade=1` }, [iconNode('ticket'), createElement('span', { text: translate('registration.upgrade') })]));
  }
  box.replaceChildren(card, ...after);
}
