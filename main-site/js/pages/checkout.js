// The checkout page, /checkout?slug=<slug> (migrations/016): one ticket for
// the whole event, for the person signed in.
//
// Before they hold one: pick a tier (when the event sells tiers), tick "I
// would like to volunteer" (a convention taking volunteers; carried over
// from the event page as &volunteer=1), pick how to pay, see the order, and
// Reserve. Paying on the day is a plain RSVP. Paying by link or QR code
// takes a place at once and waits for payment.
//
// Holding one: where the payment stands, the amount, the organiser's
// instructions, the QR code or the link, and "Done paying? Tell the
// organisers": the payment reference and, if they like, a screenshot. Until
// an editor confirms it, they can report again or pay another way.

import { session } from '../app.js';
import { t as translate, onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, withBusy, errorText } from '../ui.js';
import { iconNode } from '../icons.js';
import { whenText, formatMoney, tierPriceText } from '../format.js';
import { proofPicture } from '../picture-file.js';
import { startTours } from '../tour.js';
import { drawContactForm } from '../contact-form.js';

const byId = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let slug = '';
if (params.get('slug')) {
  slug = params.get('slug').toLowerCase();
}
let checkout = null;
// What is picked before reserving: the ticket's place in the list, and the
// method.
let pickedTicket = 0;
let pickedMethod = null;
// The contact details form (migrations/021), and what it was drawn for, so
// a re-render keeps what is being typed.
let contactForm = null;
let contactDrawn = '';
// The screenshot chosen for the report, as a data: URL, or null.
let proof = null;

const eventHref = () => `/e/${encodeURIComponent(slug)}`;
const money = (amount) => formatMoney(amount, checkout.currency);

function setText(id, text) {
  byId(id).textContent = text;
}

function renderHeader() {
  setText('checkoutTitle', checkout.title);
  setText('checkoutWhen', whenText(checkout.when));
  document.title = translate('checkout.title-named', { title: checkout.title });
  const cover = byId('checkoutCover');
  cover.replaceChildren();
  cover.classList.toggle('no-image', !checkout.coverImageUrl);
  if (checkout.coverImageUrl) {
    cover.append(createElement('img', { alt: '', src: checkout.coverImageUrl, decoding: 'async' }));
  } else {
    cover.append(iconNode('calendar'));
  }
  for (const id of ['backToEvent', 'closedLink', 'payBack']) {
    byId(id).href = eventHref();
  }
}

// One radio card: a name, a line or two under it, and a price on the right.
function choiceCard({ name, value, checked, title, lines = [], aside = null }) {
  const input = createElement('input', { type: 'radio', name, value });
  input.checked = checked;
  const body = [createElement('span', { class: 'choice-title', text: title })];
  for (const line of lines) {
    body.push(createElement('span', { class: 'small muted', text: line }));
  }
  const parts = [input, createElement('span', { class: 'choice-body' }, body)];
  if (aside) {
    parts.push(aside);
  }
  return createElement('label', { class: 'choice-card' }, parts);
}

// A ticket's price, struck through with the price after the volunteer
// benefit when that is less.
function priceAside(ticket) {
  const box = createElement('span', { class: 'choice-price' });
  if (ticket.amount < ticket.price) {
    box.append(createElement('s', { class: 'muted small', text: tierPriceText(ticket.price, checkout.currency) }));
  }
  box.append(createElement('strong', { text: tierPriceText(ticket.amount, checkout.currency) }));
  return box;
}

function renderTickets() {
  const tickets = checkout.tickets;
  if (pickedTicket >= tickets.length || tickets[pickedTicket].methods.length === 0) {
    pickedTicket = Math.max(0, tickets.findIndex((ticket) => ticket.methods.length > 0));
  }
  byId('ticketList').replaceChildren(...tickets.map((ticket, place) => {
    let title = ticket.name;
    if (!title) {
      title = translate('checkout.ticket-single');
    }
    const lines = [...ticket.benefits];
    // A ticket no way to pay is set up for yet cannot be picked.
    if (ticket.methods.length === 0) {
      lines.push(translate('checkout.ticket-unavailable'));
    }
    const card = choiceCard({ name: 'ticket', value: String(place), checked: place === pickedTicket, title, lines, aside: priceAside(ticket) });
    if (ticket.methods.length === 0) {
      card.classList.add('unavailable');
      card.querySelector('input').disabled = true;
    }
    return card;
  }));
  byId('discountNote').hidden = !checkout.volunteerDiscount;
}

// The ways to pay the picked ticket (its tier's own, or the event's).
function ticketMethods() {
  const ticket = checkout.tickets[pickedTicket];
  if (!ticket) {
    return [];
  }
  return ticket.methods;
}

function renderMethods() {
  const methods = ticketMethods();
  if (!methods.includes(pickedMethod)) {
    pickedMethod = methods[0];
  }
  byId('methodList').replaceChildren(...methods.map((method) => choiceCard({
    name: 'method',
    value: method,
    checked: method === pickedMethod,
    title: translate(`payment.method.${method}`),
    lines: [translate(`checkout.method-hint.${method}`)],
  })));
}

// Label and value pairs as a definition list.
function fillLines(listId, pairs) {
  byId(listId).replaceChildren(...pairs.map(([label, value]) => createElement('div', {}, [
    createElement('dt', { text: label }),
    createElement('dd', { text: value }),
  ])));
}

function renderOrder() {
  const ticket = checkout.tickets[pickedTicket];
  const pairs = [];
  if (ticket.name) {
    pairs.push([translate('checkout.order-ticket'), ticket.name]);
  }
  pairs.push([translate('checkout.order-price'), tierPriceText(ticket.price, checkout.currency)]);
  if (ticket.amount < ticket.price) {
    pairs.push([translate('checkout.order-discount'), `-${money(ticket.price - ticket.amount)}`]);
  }
  pairs.push([translate('checkout.order-total'), tierPriceText(ticket.amount, checkout.currency)]);
  pairs.push([translate('checkout.order-method'), translate(`payment.method.${pickedMethod}`)]);
  fillLines('orderLines', pairs);

  let buttonKey = 'checkout.reserve';
  let noteKey = 'checkout.reserve-note';
  if (pickedMethod === 'onsite') {
    buttonKey = 'checkout.reserve-onsite';
    noteKey = 'checkout.reserve-note-onsite';
  }
  const button = byId('reserveBtn');
  button.replaceChildren(iconNode('ticket'), createElement('span', { text: translate(buttonKey) }));
  setText('reserveNote', translate(noteKey));
  const needsCountry = checkout.needsCountry === true;
  byId('countryNeeded').hidden = !needsCountry;
  button.disabled = needsCountry;
}

// Why there is nothing to buy here, or '' when there is.
function closedReason() {
  if (!checkout.checkout || !checkout.tickets.some((ticket) => ticket.methods.length > 0)) {
    return translate('checkout.closed-no-payment');
  }
  if (checkout.rsvp === 'open') {
    return '';
  }
  return translate(`checkout.closed-${checkout.rsvp}`);
}

function renderOrderBox() {
  const reason = closedReason();
  byId('closedBox').hidden = reason === '';
  setText('closedText', reason);
  byId('orderBox').hidden = reason !== '';
  if (reason) {
    return;
  }
  renderTickets();
  byId('volunteerRow').hidden = !checkout.takesVolunteers;
  renderContact();
  renderMethods();
  renderOrder();
}

// The contact details the event asks for, sent with the ticket.
function renderContact() {
  const asked = checkout.contact.fields.length > 0;
  byId('contactStep').hidden = !asked;
  if (!asked) {
    contactForm = null;
    return;
  }
  const drawFor = JSON.stringify([checkout.contact, checkout.viewer.contact, getLocale()]);
  if (drawFor === contactDrawn && contactForm) {
    return;
  }
  contactDrawn = drawFor;
  contactForm = drawContactForm(byId('contactFields'), {
    fields: checkout.contact.fields,
    rule: checkout.contact.rule,
    values: checkout.viewer.contact,
    idPrefix: 'checkoutContact',
  });
}

// The payment's state in words, and its tone.
function statusOf(payment) {
  if (payment.status === 'paid') {
    return { key: 'checkout.status-paid', tone: 'ok' };
  }
  if (payment.status === 'submitted') {
    return { key: 'checkout.status-submitted', tone: 'ok' };
  }
  if (payment.status === 'awaiting') {
    return { key: 'checkout.status-awaiting', tone: 'warn' };
  }
  return { key: 'checkout.status-onsite', tone: 'ok' };
}

function renderPayHow(payment) {
  const open = ['awaiting', 'submitted'].includes(payment.status);
  byId('payHow').hidden = !open;
  if (!open) {
    return;
  }
  byId('payInstructions').hidden = !checkout.instructions;
  if (checkout.instructions) {
    setText('payInstructions', checkout.instructions);
  }
  byId('payQrBox').hidden = !checkout.paymentQrUrl;
  if (checkout.paymentQrUrl && byId('payQr').getAttribute('src') !== checkout.paymentQrUrl) {
    byId('payQr').src = checkout.paymentQrUrl;
  }
  byId('payLink').hidden = !checkout.paymentLink;
  if (checkout.paymentLink) {
    byId('payLink').href = checkout.paymentLink;
  }
  if (document.activeElement !== byId('payReference')) {
    let reference = '';
    if (payment.reference) {
      reference = payment.reference;
    }
    byId('payReference').value = reference;
  }
  let submitKey = 'checkout.report';
  if (payment.status === 'submitted') {
    submitKey = 'checkout.report-again';
  }
  setText('reportSubmitText', translate(submitKey));
  let proofText = '';
  if (proof) {
    proofText = translate('checkout.proof-ready');
  } else if (payment.hasProof) {
    proofText = translate('checkout.proof-sent');
  }
  setText('payProofName', proofText);
}

// The other ways to pay, while the payment is not confirmed.
function renderSwitch(payment) {
  // The ways to pay this ticket's tier (or the event's, without tiers).
  let methods = checkout.methods;
  const ticket = checkout.tickets.find((each) => each.name === payment.tier);
  if (payment.tier && ticket) {
    methods = ticket.methods;
  }
  const others = methods.filter((method) => method !== payment.method);
  byId('switchBox').hidden = true;
  if (payment.status === 'paid' || others.length === 0) {
    return;
  }
  byId('switchBox').hidden = false;
  byId('switchList').replaceChildren(...others.map((method) => {
    const button = createElement('button', { class: 'btn btn-small', type: 'button', text: translate(`checkout.switch-to.${method}`) });
    button.addEventListener('click', () => switchMethod(button, method));
    return button;
  }));
}

function renderPayBox() {
  const payment = checkout.viewer.payment;
  const status = statusOf(payment);
  const box = byId('payStatus');
  box.classList.toggle('ok', status.tone === 'ok');
  box.classList.toggle('warn', status.tone === 'warn');
  setText('payStatusText', translate(status.key));
  const number = checkout.viewer.rsvpNumber;
  byId('payNumber').hidden = number === null;
  if (number !== null) {
    setText('payNumber', translate('event.rsvp-number', { number }));
  }
  const pairs = [];
  if (payment.tier) {
    pairs.push([translate('checkout.order-ticket'), payment.tier]);
  }
  if (payment.amount !== null) {
    pairs.push([translate('checkout.order-total'), tierPriceText(payment.amount, payment.currency)]);
  }
  pairs.push([translate('checkout.order-method'), translate(`payment.method.${payment.method}`)]);
  fillLines('payLines', pairs);
  renderPayHow(payment);
  renderSwitch(payment);
}

// Holding a ticket (going to the whole event with a payment method) shows
// the payment; anything else, the order.
function render() {
  renderHeader();
  const payment = checkout.viewer.payment;
  let holding = false;
  if (checkout.viewer.going && !checkout.viewer.withoutTicket && payment !== null && payment.method !== null) {
    holding = true;
  }
  byId('payBox').hidden = !holding;
  if (holding) {
    byId('orderBox').hidden = true;
    byId('closedBox').hidden = true;
    renderPayBox();
    return;
  }
  // Going to the whole event from before checkout: nothing to buy.
  if (checkout.viewer.going && !checkout.viewer.withoutTicket) {
    byId('orderBox').hidden = true;
    byId('closedBox').hidden = false;
    setText('closedText', translate('checkout.already-going'));
    return;
  }
  renderOrderBox();
}

async function reserve() {
  const ticket = checkout.tickets[pickedTicket];
  const body = { slug, going: true, meals: [], payment: { method: pickedMethod, tier: ticket.index, tierName: ticket.name } };
  if (checkout.takesVolunteers) {
    body.volunteer = byId('volunteerPick').checked;
  }
  if (contactForm) {
    body.contact = contactForm.read();
  }
  await post('/api/events/rsvp', body);
  await load();
  window.scrollTo({ top: 0 });
}

async function switchMethod(button, method) {
  await withBusy(button, byId('switchError'), async () => {
    const data = await post('/api/events/payment', { slug, action: 'method', method });
    checkout = data.checkout;
    proof = null;
    render();
  });
}

// Another ticket can be paid for in other ways: the methods follow it.
byId('ticketList').addEventListener('change', (changed) => {
  pickedTicket = Number(changed.target.value);
  renderMethods();
  renderOrder();
});

byId('methodList').addEventListener('change', (changed) => {
  pickedMethod = changed.target.value;
  renderOrder();
});

byId('reserveBtn').addEventListener('click', () => {
  // The contact details asked for are checked before anything is sent.
  if (contactForm) {
    const problem = contactForm.check();
    if (problem) {
      byId('reserveError').textContent = problem;
      return;
    }
  }
  withBusy(byId('reserveBtn'), byId('reserveError'), reserve);
});

byId('payProof').addEventListener('change', async () => {
  const file = byId('payProof').files[0];
  byId('payProof').value = '';
  byId('reportError').textContent = '';
  if (!file) {
    return;
  }
  try {
    proof = await proofPicture(file);
  } catch (error) {
    proof = null;
    byId('reportError').textContent = errorText(error);
  }
  renderPayHow(checkout.viewer.payment);
});

byId('reportForm').addEventListener('submit', (submitted) => {
  submitted.preventDefault();
  withBusy(byId('reportSubmit'), byId('reportError'), async () => {
    const body = { slug, action: 'report', reference: byId('payReference').value };
    if (proof) {
      body.proof = proof;
    }
    const data = await post('/api/events/payment', body);
    checkout = data.checkout;
    proof = null;
    render();
  });
});

// Signed out: off to sign in, then back here.
async function load() {
  const data = await api(`/api/events/checkout?slug=${encodeURIComponent(slug)}`);
  checkout = data.checkout;
  byId('checkoutLoading').hidden = true;
  byId('checkoutView').hidden = false;
  render();
}

async function start() {
  const current = await session;
  if (!current.signedIn) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  if (params.get('volunteer') === '1') {
    byId('volunteerPick').checked = true;
  }
  try {
    await load();
  } catch (error) {
    byId('checkoutLoading').hidden = true;
    if (error.code === 'not_found') {
      byId('checkoutMissing').hidden = false;
    } else {
      byId('checkoutError').textContent = errorText(error);
    }
    return;
  }
  startTours('checkout');
}

onChange(() => {
  if (checkout) {
    render();
  }
});

start();
