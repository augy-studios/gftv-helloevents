// The checkout page, /checkout?slug=<slug> (migrations/016): one ticket for
// the whole event, for the person signed in.
//
// Before they hold one: pick the tiers (when the event sells tiers: any
// number of them, each once, or up to its limit where one person can buy
// more than one of it, migrations/022; they must share a way to pay), tick "I
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
// What is picked before reserving: how many of each ticket, by its place in
// the list (null until the page first draws, which picks the first one on
// sale), and the method.
let picked = null;
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

// One radio (or tick box) card: a name, a line or two under it, and a price
// on the right.
function choiceCard({ name, value, checked, title, lines = [], aside = null, type = 'radio' }) {
  const input = createElement('input', { type, name, value });
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

// Whether the event sells tiers, so more than one can be picked.
function sellsTiers() {
  if (checkout.tickets.length === 0) {
    return false;
  }
  return checkout.tickets[0].index !== null;
}

// The picks still possible: tickets on sale only, each at most its limit;
// the first one on sale when nothing is picked yet. Without tiers, the one
// ticket.
function settlePicks() {
  const tickets = checkout.tickets;
  const kept = new Map();
  if (picked) {
    for (const [place, quantity] of picked) {
      const ticket = tickets[place];
      if (ticket && ticket.methods.length > 0) {
        kept.set(place, Math.min(Math.max(1, quantity), ticket.maxPerPerson));
      }
    }
  }
  if ((picked === null || !sellsTiers()) && kept.size === 0) {
    const first = tickets.findIndex((ticket) => ticket.methods.length > 0);
    if (first >= 0) {
      kept.set(first, 1);
    }
  }
  picked = kept;
}

// The "How many" box under a picked ticket that one person can buy more
// than one of.
function quantityField(ticket, place) {
  const field = createElement('input', {
    type: 'number',
    min: 1,
    max: ticket.maxPerPerson,
    step: 1,
    inputmode: 'numeric',
    value: String(picked.get(place)),
    'data-quantity': String(place),
  });
  return createElement('label', { class: 'field ticket-quantity' }, [
    createElement('span', { text: translate('checkout.quantity', { count: ticket.maxPerPerson }) }),
    field,
  ]);
}

function renderTickets() {
  const tickets = checkout.tickets;
  settlePicks();
  const tiered = sellsTiers();
  let role = 'radiogroup';
  if (tiered) {
    role = 'group';
  }
  byId('ticketList').setAttribute('role', role);
  let hintHidden = true;
  if (tiered && tickets.length > 1) {
    hintHidden = false;
  }
  byId('ticketHint').hidden = hintHidden;
  byId('ticketList').replaceChildren(...tickets.map((ticket, place) => {
    let title = ticket.name;
    if (!title) {
      title = translate('checkout.ticket-single');
    }
    const lines = [...ticket.benefits];
    if (ticket.maxPerPerson > 1) {
      lines.push(translate('event.tier-max', { count: ticket.maxPerPerson }));
    }
    // A ticket no way to pay is set up for yet cannot be picked.
    if (ticket.methods.length === 0) {
      lines.push(translate('checkout.ticket-unavailable'));
    }
    let type = 'radio';
    let aside = priceAside(ticket);
    if (tiered) {
      type = 'checkbox';
      // The volunteer benefit comes off the order's total, below.
      aside = createElement('span', { class: 'choice-price' }, [createElement('strong', { text: tierPriceText(ticket.price, checkout.currency) })]);
    }
    const card = choiceCard({ name: 'ticket', value: String(place), checked: picked.has(place), title, lines, aside, type });
    if (ticket.methods.length === 0) {
      card.classList.add('unavailable');
      card.querySelector('input').disabled = true;
    }
    if (!tiered || ticket.maxPerPerson < 2 || !picked.has(place)) {
      return card;
    }
    return createElement('div', { class: 'ticket-pick' }, [card, quantityField(ticket, place)]);
  }));
  byId('discountNote').hidden = !checkout.volunteerDiscount;
}

// The tickets picked, with how many of each, in the list's order.
function pickedTickets() {
  return [...picked.entries()]
    .sort((first, second) => first[0] - second[0])
    .map(([place, quantity]) => ({ ticket: checkout.tickets[place], quantity }));
}

// The ways to pay the tickets picked, together: the ways they all take, a
// link or QR code only when they all pay to the same one (as the server
// decides, api/_lib/event-rules.js basketOptions).
function ticketMethods() {
  const chosen = pickedTickets().map((each) => each.ticket);
  if (chosen.length === 0) {
    return [];
  }
  return chosen[0].methods.filter((method) => {
    if (!chosen.every((ticket) => ticket.methods.includes(method))) {
      return false;
    }
    if (method === 'link' || method === 'qr') {
      return new Set(chosen.map((ticket) => ticket.payTo[method])).size === 1;
    }
    return true;
  });
}

// What the tickets picked cost, and the volunteer benefit off the total
// once: { price, discount, amount }.
function orderAmounts() {
  const chosen = pickedTickets();
  if (!sellsTiers()) {
    const ticket = chosen[0].ticket;
    return { price: ticket.price, discount: Math.round((ticket.price - ticket.amount) * 100) / 100, amount: ticket.amount };
  }
  const price = Math.round(chosen.reduce((sum, each) => sum + each.ticket.price * each.quantity, 0) * 100) / 100;
  let discount = 0;
  const benefit = checkout.volunteerBenefit;
  if (benefit) {
    if (benefit.type === 'amount') {
      discount = Math.min(price, benefit.value);
    } else {
      discount = (price * Math.min(benefit.value, 100)) / 100;
    }
  }
  discount = Math.round(discount * 100) / 100;
  return { price, discount, amount: Math.round((price - discount) * 100) / 100 };
}

// Why the tickets picked cannot be reserved, or '' when they can.
function pickProblem() {
  if (picked.size === 0) {
    return translate('error.tier_required');
  }
  if (ticketMethods().length === 0) {
    return translate('error.tiers_not_together');
  }
  return '';
}

function renderMethods() {
  const methods = ticketMethods();
  if (!methods.includes(pickedMethod)) {
    pickedMethod = methods[0];
  }
  byId('methodStep').hidden = methods.length === 0;
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
  const problem = pickProblem();
  byId('pickProblem').hidden = problem === '';
  setText('pickProblem', problem);
  byId('orderSummary').hidden = problem !== '';
  const button = byId('reserveBtn');
  if (problem) {
    button.disabled = true;
    return;
  }
  const pairs = [];
  for (const { ticket, quantity } of pickedTickets()) {
    if (!ticket.name) {
      continue;
    }
    let label = ticket.name;
    if (quantity > 1) {
      label = translate('checkout.order-quantity', { name: ticket.name, count: quantity });
    }
    pairs.push([label, tierPriceText(ticket.price * quantity, checkout.currency)]);
  }
  const amounts = orderAmounts();
  if (!sellsTiers() || amounts.discount > 0) {
    pairs.push([translate('checkout.order-price'), tierPriceText(amounts.price, checkout.currency)]);
  }
  if (amounts.discount > 0) {
    pairs.push([translate('checkout.order-discount'), `-${money(amounts.discount)}`]);
  }
  pairs.push([translate('checkout.order-total'), tierPriceText(amounts.amount, checkout.currency)]);
  pairs.push([translate('checkout.order-method'), translate(`payment.method.${pickedMethod}`)]);
  fillLines('orderLines', pairs);

  let buttonKey = 'checkout.reserve';
  let noteKey = 'checkout.reserve-note';
  if (pickedMethod === 'onsite') {
    buttonKey = 'checkout.reserve-onsite';
    noteKey = 'checkout.reserve-note-onsite';
  }
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
  byId('fursuiterRow').hidden = !checkout.asksFursuiters;
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

// The other ways to pay, while the payment is not confirmed: those the
// ticket's tiers take together (or the event's, without tiers).
function renderSwitch(payment) {
  const others = checkout.heldMethods.filter((method) => method !== payment.method);
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
  const payment = { method: pickedMethod };
  if (sellsTiers()) {
    payment.items = pickedTickets().map(({ ticket, quantity }) => ({ tier: ticket.index, tierName: ticket.name, quantity }));
  }
  const body = { slug, going: true, meals: [], payment };
  if (checkout.takesVolunteers) {
    body.volunteer = byId('volunteerPick').checked;
  }
  if (checkout.asksFursuiters) {
    body.fursuiter = byId('fursuiterPick').checked;
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

// Other tickets can be paid for in other ways: the methods follow them.
// With tiers, a tick adds or takes off a ticket, and "How many" sets how
// many of it.
byId('ticketList').addEventListener('change', (changed) => {
  const target = changed.target;
  if (target.dataset.quantity !== undefined) {
    const place = Number(target.dataset.quantity);
    let quantity = Number(target.value);
    if (!Number.isInteger(quantity) || quantity < 1) {
      quantity = 1;
    }
    picked.set(place, Math.min(quantity, checkout.tickets[place].maxPerPerson));
    target.value = String(picked.get(place));
  } else {
    const place = Number(target.value);
    if (!sellsTiers()) {
      picked = new Map([[place, 1]]);
    } else if (target.checked) {
      picked.set(place, 1);
    } else {
      picked.delete(place);
    }
    renderTickets();
    const again = byId('ticketList').querySelector(`input[name="ticket"][value="${place}"]`);
    if (again) {
      again.focus();
    }
  }
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
  if (params.get('fursuiter') === '1') {
    byId('fursuiterPick').checked = true;
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
