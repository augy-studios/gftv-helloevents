// The edit form's Payment section and the attendee list's payments
// (migrations/016).
//
// Payment section: which ways an event takes payment (on the day, a link, a
// QR code), the link, the instructions, and the QR code, uploaded on its own
// (api/manage/payment-qr.js) once the event has saved, at its own shape. The
// ticks, link and instructions save with the rest of the form. A method
// ticked that cannot be offered yet is explained under it
// (paymentProblems), rather than refused.
//
// Attendee list: each person's payment (tier, amount, method, where it
// stands, reference), a link to their screenshot, a Paid box once there is
// a payment to check, and a count under the heading.

import { t as translate } from '../assets/i18n/i18n.js';
import { post } from './api.js';
import { createElement, withBusy } from './ui.js';
import { formatMoney } from './format.js';
import { qrPicture } from './picture-file.js';

const byId = (id) => document.getElementById(id);
const METHODS = ['onsite', 'link', 'qr'];
let qr = { url: '', problems: [] };
let currentEvent = () => null;

const methodBox = (method) => byId(`f-pay-${method}`);

export function readPayment() {
  return {
    paymentMethods: METHODS.filter((method) => methodBox(method).checked),
    paymentLink: byId('f-paymentLink').value,
    paymentInstructions: byId('f-paymentInstructions').value,
  };
}

function setMethods(methods) {
  let list = [];
  if (Array.isArray(methods)) {
    list = methods;
  }
  for (const method of METHODS) {
    methodBox(method).checked = list.includes(method);
  }
}

function blankIfMissing(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function renderQr() {
  const event = currentEvent();
  const saved = event !== null;
  byId('payQrSaveFirst').hidden = saved;
  byId('payQrPick').hidden = !saved;
  byId('payQrPreview').hidden = !qr.url;
  byId('payQrRemove').hidden = !qr.url;
  if (qr.url && byId('payQrImage').getAttribute('src') !== qr.url) {
    byId('payQrImage').src = qr.url;
  }
}

// A problem in words: the event's, or one tier's ("Gold: ...").
function problemText(problem) {
  const text = translate(`manage.payment-problem.${problem.code}`);
  if (problem.tier) {
    return translate('manage.payment-problem-tier', { tier: problem.tier, problem: translate(`manage.payment-problem.tier-${problem.code}`) });
  }
  return text;
}

// The payment problems as the server now has them (after a tier's QR code
// changes, js/manage-tiers.js).
export function setPaymentProblems(problems) {
  if (Array.isArray(problems)) {
    qr.problems = problems;
  }
  renderProblems();
}

function renderProblems() {
  const list = byId('paymentProblems');
  list.replaceChildren(...qr.problems.map((problem) => createElement('li', { text: problemText(problem) })));
  let shown = false;
  if (qr.problems.length > 0 && byId('f-priceType').value === 'paid') {
    shown = true;
  }
  list.hidden = !shown;
}

// The section's parts that depend on what is ticked: the link field with
// the link, the QR code with the QR code, all of it for a paid event only.
export function syncPayment() {
  const paid = byId('f-priceType').value === 'paid';
  byId('paymentNotPaid').hidden = paid;
  byId('paymentFields').hidden = !paid;
  byId('paymentLinkField').hidden = !methodBox('link').checked;
  byId('paymentQrField').hidden = !methodBox('qr').checked;
  renderQr();
  renderProblems();
}

// The section as an event has it (the edit form's values).
export function setPayment(values) {
  setMethods(values.paymentMethods);
  byId('f-paymentLink').value = blankIfMissing(values.paymentLink);
  byId('f-paymentInstructions').value = blankIfMissing(values.paymentInstructions);
  let problems = [];
  if (Array.isArray(values.paymentProblems)) {
    problems = values.paymentProblems;
  }
  qr = { url: blankIfMissing(values.paymentQrUrl), problems };
  byId('payQrError').textContent = '';
  renderQr();
  syncPayment();
}

// After a save: what the server kept, for the fields not changed since it
// was sent (now: the form as it is, sent: as it was sent).
export function applySavedPayment(saved, now, sent) {
  if (JSON.stringify(now.paymentMethods) === JSON.stringify(sent.paymentMethods)) {
    setMethods(saved.paymentMethods);
  }
  for (const [name, id] of [['paymentLink', 'f-paymentLink'], ['paymentInstructions', 'f-paymentInstructions']]) {
    const value = blankIfMissing(saved[name]);
    if (now[name] === sent[name] && document.activeElement !== byId(id) && byId(id).value !== value) {
      byId(id).value = value;
    }
  }
  if (Array.isArray(saved.paymentProblems)) {
    qr.problems = saved.paymentProblems;
  }
  syncPayment();
}

async function uploadQr(body) {
  const event = currentEvent();
  const data = await post('/api/manage/payment-qr', { id: event.id, ...body });
  qr = { url: data.event.paymentQrUrl, problems: data.event.paymentProblems };
  renderQr();
  renderProblems();
}

// getEvent: the event open in the form ({ id }), or null for a new one not
// saved yet.
export function startPayment({ getEvent }) {
  currentEvent = getEvent;
  byId('payQrFile').addEventListener('change', async () => {
    const file = byId('payQrFile').files[0];
    byId('payQrFile').value = '';
    byId('payQrError').textContent = '';
    if (!file || !currentEvent()) {
      return;
    }
    await withBusy(byId('payQrPick'), byId('payQrError'), async () => {
      await uploadQr({ image: await qrPicture(file) });
    });
  });
  byId('payQrRemove').addEventListener('click', () => {
    withBusy(byId('payQrRemove'), byId('payQrError'), () => uploadQr({ remove: true }));
  });
}

// ---------------------------------------------------------------------------
// The attendee list
// ---------------------------------------------------------------------------

// One attendee's payment in words, for their row ("Sponsor · SGD 120.00 ·
// QR code · To check · Ref TXN 123"), or '' when they have none.
export function attendeePaymentText(attendee) {
  const payment = attendee.payment;
  if (!payment || !payment.method) {
    return '';
  }
  const parts = [];
  if (payment.tier) {
    parts.push(payment.tier);
  }
  if (payment.amount !== null) {
    parts.push(formatMoney(payment.amount, payment.currency));
  }
  // Upgraded (migrations/024): what was paid before, so only the rest is
  // to be checked.
  if (payment.credit > 0) {
    parts.push(translate('manage.payment-credit', { amount: formatMoney(payment.credit, payment.currency) }));
  }
  parts.push(translate(`payment.method.${payment.method}`));
  if (payment.method !== 'onsite') {
    parts.push(translate(`manage.payment-status.${payment.status}`));
  }
  if (payment.reference) {
    parts.push(translate('manage.payment-reference', { reference: payment.reference }));
  }
  return parts.join(' · ');
}

// The address of an attendee's payment screenshot (editors only).
function proofHref(eventId, attendee) {
  let staff = '0';
  if (attendee.staff) {
    staff = '1';
  }
  return `/api/manage/payment-proof?id=${encodeURIComponent(eventId)}&username=${encodeURIComponent(attendee.username)}&staff=${staff}`;
}

// The screenshot link and the Paid box, for someone with a payment to
// check. onChanged: called with the new attendee list after a change.
export function attendeePaymentControls(attendee, name, onChanged, errorBox) {
  const payment = attendee.payment;
  const controls = [];
  if (!payment || !['awaiting', 'submitted', 'paid'].includes(payment.status)) {
    return controls;
  }
  const event = currentEvent();
  if (payment.hasProof) {
    controls.push(createElement('a', {
      class: 'btn btn-small btn-quiet',
      href: proofHref(event.id, attendee),
      target: '_blank',
      rel: 'noopener',
      text: translate('manage.payment-proof'),
      'aria-label': translate('manage.payment-proof-named', { name }),
    }));
  }
  const box = createElement('input', { type: 'checkbox' });
  box.checked = payment.status === 'paid';
  box.addEventListener('change', async () => {
    box.disabled = true;
    const done = await withBusy(null, errorBox, async () => {
      const data = await post('/api/manage/events', {
        action: 'payment-confirm',
        id: event.id,
        username: attendee.username,
        staff: attendee.staff,
        paid: box.checked,
      });
      onChanged(data.attendees);
      return true;
    });
    if (!done) {
      box.checked = payment.status === 'paid';
      box.disabled = false;
    }
  });
  controls.push(createElement('label', { class: 'check attendee-paid' }, [
    box,
    createElement('span', { text: translate('manage.payment-paid') }),
    createElement('span', { class: 'visually-hidden', text: translate('manage.payment-paid-named', { name }) }),
  ]));
  return controls;
}

// Under the attendee count, where the payments stand ("Payments: 3 paid ·
// 2 to check · 1 waiting for payment · 4 on the day"). Hidden while nobody
// has a payment method.
export function renderPaymentCounts(attendees) {
  const box = byId('attendeesPayments');
  const count = (test) => attendees.filter((attendee) => {
    if (!attendee.payment) {
      return false;
    }
    return test(attendee.payment);
  }).length;
  const counts = [
    ['manage.payments-paid', count((payment) => payment.status === 'paid')],
    ['manage.payments-submitted', count((payment) => payment.status === 'submitted')],
    ['manage.payments-awaiting', count((payment) => payment.status === 'awaiting')],
    ['manage.payments-onsite', count((payment) => payment.method === 'onsite')],
  ];
  const parts = counts.filter(([, number]) => number > 0).map(([key, number]) => translate(key, { count: number }));
  box.hidden = parts.length === 0;
  box.textContent = translate('manage.attendees-payments', { counts: parts.join(' · ') });
}

