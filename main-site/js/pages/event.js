// One event: /e/<slug>, served from event.html by a rewrite.

import { session } from '../app.js';
import { t as translate, onChange, getLocale } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, errorText, withBusy, copyText } from '../ui.js';
import { iconNode, icon } from '../icons.js';
import { whenText, placeText, priceText, spacesText, locationText, locationLabel, mealLocationLabel, mealsText, mealPlacesText, tierPriceText, formatMoney } from '../format.js';
import { startLangSwitch, preferredDescriptionLang, rememberDescriptionLang } from '../lang-switch.js';
import { renderTimetable } from '../timetable.js';
import { renderEventGallery } from '../event-gallery.js';
import { renderRichText } from '../rich-dom.js';
import { startTours } from '../tour.js';
import { drawContactForm } from '../contact-form.js';

const byId = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.replace(/^\/e\//, '').replace(/\/+$/, '')).toLowerCase();
let event = null;
let preview = false;
let descriptionLang = preferredDescriptionLang();
// The language and description last drawn.
let descriptionShown = '';
// What this person is coming for: mode 'event' (the whole event, with a
// ticket where the event sells them), 'meals' (only some of the meals the
// event offers) or 'lepak' ("Just Lepak Only", migrations/017: no ticket,
// with any meals ticked as well); meals the ids ticked. Taken from the
// server while they are going; picked here before they say they are going.
let choice = { mode: 'event', meals: [] };
// The meals the tick boxes were last drawn for, so they are redrawn only
// when those change (not under a box being ticked).
let mealsDrawn = '';
// A change of meals on its way to the server, and whether another came
// while it was.
let choiceSaving = null;
let choiceAgain = false;
// Whether "I would like to volunteer" is ticked before this person says
// they are going (once going, the server's answer says).
let volunteerPick = false;
// "I'm a fursuiter", ticked before going (migrations/023).
let fursuiterPick = false;
// The contact details form (migrations/021), and what it was drawn for, so
// a re-render keeps what is being typed.
let contactForm = null;
let contactDrawn = '';

function renderCover() {
  const box = byId('eventCover');
  box.replaceChildren();
  box.classList.toggle('no-image', !event.coverImageUrl);
  if (event.coverImageUrl) {
    const image = createElement('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    // A broken picture falls back to the plain tile rather than an empty box.
    image.addEventListener('error', () => {
      image.remove();
      box.classList.add('no-image');
      box.append(iconNode('calendar'));
    }, { once: true });
    image.src = event.coverImageUrl;
    box.append(image);
  } else {
    box.append(iconNode('calendar'));
  }
}

// The street address and map link of one location, when this viewer may
// see them.
function addressLines(location) {
  const lines = [];
  if (location.address) {
    lines.push(createElement('span', { class: 'muted', text: location.address }));
  }
  if (location.mapsUrl) {
    lines.push(createElement('a', { class: 'text-link', href: location.mapsUrl, target: '_blank', rel: 'noopener noreferrer', text: translate('event.open-map') }));
  }
  return lines;
}

// One labelled place: its heading, "Venue, City, Country" (or "Place to be
// announced"), then its address and map link when this viewer may see them.
function labelledPlace(heading, location) {
  let name = locationText(location);
  if (!name) {
    name = translate('event.place-tba');
  }
  return [
    createElement('span', { class: 'location-heading', text: heading }),
    createElement('span', { text: name }),
    ...addressLines(location),
  ];
}

// The place lines: one place on its own reads as before ("Venue, City,
// Country", and online); several, or one labelled other than the event's
// location, each get their label, then "Online too" when it is. A meal held
// somewhere else follows, headed with the meal's name ("Dinner"), so the
// event's own place is then labelled too.
function placeLines(where, meals) {
  const locations = where.locations;
  const mealPlaces = [];
  for (const meal of meals) {
    for (const location of meal.locations) {
      mealPlaces.push(...labelledPlace(mealLocationLabel(meal, location), location));
    }
  }
  if (locations.length === 0) {
    return [createElement('span', { text: placeText(where) }), ...mealPlaces];
  }
  if (locations.length === 1 && locations[0].label === 'event' && mealPlaces.length === 0) {
    return [createElement('span', { text: placeText(where) }), ...addressLines(locations[0])];
  }
  const lines = [];
  for (const location of locations) {
    lines.push(...labelledPlace(locationLabel(location), location));
  }
  if (where.online) {
    lines.push(createElement('span', { text: translate('event.online-too') }));
  }
  lines.push(...mealPlaces);
  return lines;
}

// The places, their addresses and the online link when this viewer may see
// them, and a note when they are kept for attendees.
function renderWhere() {
  const whereElement = byId('factWhere');
  const where = event.where;
  const lines = placeLines(where, event.meals);
  if (where.addressForAttendees) {
    lines.push(createElement('span', { class: 'muted small', text: translate('event.address-for-attendees') }));
  }
  if (where.onlineUrl) {
    lines.push(createElement('a', { class: 'text-link', href: where.onlineUrl, target: '_blank', rel: 'noopener noreferrer', text: translate('event.online-link') }));
  }
  if (where.onlineUrlForAttendees) {
    lines.push(createElement('span', { class: 'muted small', text: translate('event.online-for-attendees') }));
  }
  whereElement.replaceChildren(...lines.map((line) => createElement('span', { class: 'fact-line' }, [line])));
}

// The description in the language picked on the switcher, which shows only
// when the event has both (an event saved before both were required may
// have one). It is rich text (rich-dom.js), marked with its language, so
// the right font and screen reader voice are used; the placeholder is the
// page's own language. It is drawn again only when the language or the
// description changes, so a playing sticker is not restarted by an RSVP.
function renderDescription() {
  const texts = { en: event.description, zh: event.descriptionZh };
  const box = byId('eventDescription');
  let hasBoth = false;
  if (texts.en && texts.zh) {
    hasBoth = true;
  }
  byId('descriptionSwitch').hidden = !hasBoth;
  let lang = descriptionLang;
  if (!texts[lang]) {
    lang = 'en';
    if (!texts.en) {
      lang = 'zh';
    }
  }
  for (const button of descriptionSwitch.buttons) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
  }
  let shown = `none:${translate('event.no-description')}`;
  if (texts[lang]) {
    shown = `${lang}:${texts[lang]}`;
  }
  if (descriptionShown === shown) {
    return;
  }
  descriptionShown = shown;
  if (texts[lang]) {
    box.lang = lang;
    renderRichText(box, texts[lang]);
  } else {
    box.removeAttribute('lang');
    box.textContent = translate('event.no-description');
  }
}

const descriptionSwitch = startLangSwitch(byId('descriptionSwitch'), (lang) => {
  descriptionLang = lang;
  rememberDescriptionLang(lang);
  if (event) {
    renderDescription();
  }
});

// Whether a meal still has a place: no limit, or some left.
function mealOpen(meal) {
  if (meal.left === null) {
    return true;
  }
  return meal.left > 0;
}

// Whether "Just Lepak Only" can be picked: the event takes lepak RSVPs and
// has a place left, or this person is lepak already.
function lepakOpen() {
  if (!event.lepak.offered) {
    return false;
  }
  if (event.viewer.going && event.viewer.lepak) {
    return true;
  }
  if (event.lepak.left === null) {
    return true;
  }
  return event.lepak.left > 0;
}

// Whether someone not yet going can still say they are coming: RSVPs open,
// or the event full but a meal or a lepak place left (neither takes one of
// the event's spaces).
function canJoinNow() {
  if (event.rsvp === 'open') {
    return true;
  }
  if (event.rsvp !== 'full') {
    return false;
  }
  if (event.meals.some(mealOpen)) {
    return true;
  }
  return lepakOpen();
}

// Whether this person holds a place at the whole event (a ticket).
function holdsWholeEvent() {
  if (!event.viewer.going || event.viewer.lepak) {
    return false;
  }
  return event.viewer.meals.length === 0;
}

// Whether "The whole event" can be picked: there is a space, or this person
// already has one.
function wholeEventOpen() {
  if (event.rsvp === 'open') {
    return true;
  }
  return holdsWholeEvent();
}

// The meal choice as the server has it, while this person is going. Before
// they go, what they picked here is kept, less any meal no longer offered.
function syncChoice() {
  const offered = event.meals.map((meal) => meal.id);
  if (event.viewer.going) {
    let mode = 'event';
    if (event.viewer.lepak) {
      mode = 'lepak';
    } else if (event.viewer.meals.length > 0) {
      mode = 'meals';
    }
    choice = { mode, meals: [...event.viewer.meals] };
    return;
  }
  if (choice.mode === 'meals' && offered.length === 0) {
    choice.mode = 'event';
  }
  if (choice.mode === 'lepak' && !event.lepak.offered) {
    choice.mode = 'event';
  }
  choice.meals = choice.meals.filter((id) => offered.includes(id));
}

// The meals to send: none for the whole event, otherwise the ones ticked,
// in the event's order.
function chosenMeals() {
  if (choice.mode === 'event') {
    return [];
  }
  return event.meals.map((meal) => meal.id).filter((id) => choice.meals.includes(id));
}

// Whether the choice can be sent: the whole event, lepak (with or without
// meals), or at least one meal.
function choiceReady() {
  if (choice.mode !== 'meals') {
    return true;
  }
  return chosenMeals().length > 0;
}

// "Just Lepak Only" (or the editor's words), with the places left when the
// event caps them.
function lepakChoiceText() {
  const label = event.lepak.label;
  if (event.lepak.left === null) {
    return label;
  }
  if (event.lepak.left === 0) {
    return translate('event.lepak-full', { label });
  }
  return translate('event.lepak-left', { label, count: event.lepak.left });
}

// One tick box per meal the event offers, drawn again only when the meals
// (or the language) change; then each box shows the current choice.
function drawMealChecks() {
  const signature = JSON.stringify(event.meals);
  if (signature !== mealsDrawn) {
    mealsDrawn = signature;
    byId('rsvpMealChecks').replaceChildren(...event.meals.map((meal) => createElement('label', { class: 'check' }, [
      createElement('input', { type: 'checkbox', value: meal.id, 'data-meal': '' }),
      createElement('span', { class: 'meal-choice-label' }),
    ])));
  }
  // A full meal can be kept by someone already coming for it, but not
  // picked by anyone else.
  const mine = event.viewer.meals;
  for (const label of byId('rsvpMealChecks').children) {
    const box = label.querySelector('input');
    const meal = event.meals.find((each) => each.id === box.value);
    box.checked = choice.meals.includes(box.value);
    let full = !mealOpen(meal);
    if (mine.includes(meal.id)) {
      full = false;
    }
    box.disabled = full;
    label.querySelector('.meal-choice-label').textContent = mealPlacesText(meal);
  }
}

// The choice of the whole event or only the meals, shown to someone signed
// in when the event offers meals and they can still say (or change) what
// they are coming for. A person going can change it while the event is
// full, since they already have their place, and after RSVPs close, among
// the meals (migrations/010).
function renderMealChoice() {
  const going = event.viewer.going;
  let canChange = canJoinNow();
  if (going && (event.rsvp === 'full' || event.rsvp === 'closed')) {
    canChange = true;
  }
  const hasMeals = event.meals.length > 0;
  let shown = false;
  if (event.viewer.signedIn && (hasMeals || event.lepak.offered) && canChange) {
    shown = true;
  }
  byId('rsvpMeals').hidden = !shown;
  if (!shown) {
    return;
  }
  // With the event full, someone without a space can only come for a meal
  // or lepak.
  const wholeOpen = wholeEventOpen();
  byId('rsvpForEvent').disabled = !wholeOpen;
  if (!wholeOpen && choice.mode === 'event') {
    if (hasMeals) {
      choice.mode = 'meals';
    } else {
      choice.mode = 'lepak';
    }
  }
  byId('rsvpForMealsRow').hidden = !hasMeals;
  byId('rsvpForLepakRow').hidden = !event.lepak.offered;
  if (event.lepak.offered) {
    byId('rsvpForLepak').disabled = !lepakOpen();
    byId('rsvpForLepakText').textContent = lepakChoiceText();
  }
  drawMealChecks();
  byId('rsvpForEvent').checked = choice.mode === 'event';
  byId('rsvpForMeals').checked = choice.mode === 'meals';
  byId('rsvpForLepak').checked = choice.mode === 'lepak';
  // The meals to tick: for just meals, or alongside lepak.
  let mealListShown = false;
  if (hasMeals && choice.mode !== 'event') {
    mealListShown = true;
  }
  byId('rsvpMealList').hidden = !mealListShown;
  byId('rsvpMealsHint').hidden = choiceReady();
}

// Where /checkout takes this person to get a ticket for the whole event,
// with "I would like to volunteer" carried over when it is ticked.
function checkoutHref() {
  let href = `/checkout?slug=${encodeURIComponent(event.slug)}`;
  if (volunteerPick && !byId('rsvpVolunteerRow').hidden) {
    href = `${href}&volunteer=1`;
  }
  if (fursuiterPick && !byId('rsvpFursuiterRow').hidden) {
    href = `${href}&fursuiter=1`;
  }
  return href;
}

// Whether the whole event, as chosen now, needs a ticket from /checkout
// (migrations/016): the event takes payment online and this person does not
// hold a place at the whole event yet.
function ticketNeeded() {
  if (!event.payment.checkout || choice.mode !== 'event') {
    return false;
  }
  return !holdsWholeEvent();
}

// Someone going: where their payment stands, with the way back to the
// checkout page while it is not confirmed (migrations/016). Paying on the
// day gets a line of its own; nothing to pay, nothing shown.
function renderPayment() {
  const box = byId('rsvpPayment');
  const payment = event.viewer.payment;
  box.hidden = true;
  if (!event.viewer.going || !payment.method) {
    return;
  }
  let textKey = 'event.payment-onsite';
  let linkKey = null;
  let tone = 'ok';
  if (payment.status === 'awaiting') {
    textKey = 'event.payment-awaiting';
    linkKey = 'event.payment-finish';
    tone = 'warn';
  } else if (payment.status === 'submitted') {
    textKey = 'event.payment-submitted';
    linkKey = 'event.payment-see';
  } else if (payment.status === 'paid') {
    textKey = 'event.payment-paid';
  }
  box.hidden = false;
  box.classList.toggle('warn', tone === 'warn');
  box.classList.toggle('ok', tone === 'ok');
  byId('rsvpPaymentText').textContent = translate(textKey);
  const link = byId('rsvpPaymentLink');
  link.hidden = linkKey === null;
  if (linkKey) {
    link.href = `/checkout?slug=${encodeURIComponent(event.slug)}`;
    byId('rsvpPaymentLinkText').textContent = translate(linkKey);
  }
}

// The RSVP box: "you're going" (and for which meals), a sign-in link for
// visitors while RSVPs are open, the meal choice, and one button that says
// Going or Cancel, plus the spaces line. At an event taking payment online,
// "Get a ticket" goes to /checkout in place of the Going button.
function renderRsvp() {
  const signedIn = event.viewer.signedIn;
  const going = event.viewer.going;
  const canJoin = canJoinNow();
  byId('rsvpStatus').hidden = !going;
  let statusText = translate('event.you-are-going');
  if (going && event.viewer.lepak && event.viewer.meals.length > 0) {
    statusText = translate('event.you-are-going-lepak-meals', { label: event.lepak.label, meals: mealsText(event.meals, event.viewer.meals) });
  } else if (going && event.viewer.lepak) {
    statusText = translate('event.you-are-going-lepak', { label: event.lepak.label });
  } else if (going && event.viewer.meals.length > 0) {
    statusText = translate('event.you-are-going-for', { meals: mealsText(event.meals, event.viewer.meals) });
  }
  byId('rsvpStatusText').textContent = statusText;
  // Their RSVP ID for this event (migrations/013), to give at the door.
  const number = event.viewer.rsvpNumber;
  byId('rsvpNumber').hidden = true;
  if (going && number !== null) {
    byId('rsvpNumber').hidden = false;
    byId('rsvpNumber').textContent = translate('event.rsvp-number', { number });
  }
  renderMealChoice();
  renderVolunteer();
  renderFursuiter();
  renderPayment();

  let signInHidden = false;
  if (signedIn || !canJoin) {
    signInHidden = true;
  }
  byId('rsvpSignIn').hidden = signInHidden;
  byId('rsvpSignIn').href = `/login?next=${encodeURIComponent(location.pathname)}`;

  // A cross-border event needs a country of origin before an RSVP
  // (migrations/015); someone already going can still change or cancel it.
  let needsCountry = false;
  if (event.viewer.needsCountry === true && !going && canJoin) {
    needsCountry = true;
  }
  byId('rsvpCountry').hidden = !needsCountry;
  byId('rsvpCountryLink').href = countryPageHref();
  if (needsCountry) {
    byId('rsvpMeals').hidden = true;
    byId('rsvpVolunteerRow').hidden = true;
    byId('rsvpFursuiterRow').hidden = true;
    byId('rsvpFursuiterHint').hidden = true;
  }

  const rsvpButton = byId('rsvpBtn');
  let rsvpButtonHidden = false;
  if (!signedIn || (!going && !canJoin) || needsCountry) {
    rsvpButtonHidden = true;
  }
  rsvpButton.hidden = rsvpButtonHidden;
  let buttonClass = 'btn btn-primary btn-block';
  let iconName = 'check';
  let labelKey = 'event.rsvp-going';
  if (going) {
    buttonClass = 'btn btn-block';
    iconName = 'x-circle';
    labelKey = 'event.rsvp-cancel';
  }
  rsvpButton.className = buttonClass;
  rsvpButton.innerHTML = `${icon(iconName)}<span></span>`;
  rsvpButton.querySelector('span').textContent = translate(labelKey);
  let buttonDisabled = false;
  if (!going && !choiceReady()) {
    buttonDisabled = true;
  }
  rsvpButton.disabled = buttonDisabled;
  // A ticket from /checkout instead, for someone not going yet.
  const checkoutLink = byId('rsvpCheckout');
  checkoutLink.hidden = true;
  if (!rsvpButtonHidden && !going && ticketNeeded()) {
    rsvpButton.hidden = true;
    checkoutLink.hidden = false;
    checkoutLink.href = checkoutHref();
  }
  let note = spacesText(event);
  if (event.rsvp === 'full' && event.meals.some(mealOpen)) {
    note = translate('event.full-meals-open');
  }
  byId('rsvpNote').textContent = note;
  // The contact details asked for: with "I am going" for someone joining
  // here (a ticket's go with it on the checkout page), and to fill in or
  // change for someone going.
  let contactShown = false;
  if (event.contact.fields.length > 0 && signedIn) {
    if (going) {
      contactShown = true;
    } else if (!rsvpButtonHidden && !ticketNeeded()) {
      contactShown = true;
    }
  }
  renderContact(contactShown);
}

// The contact details box: drawn again only when what it shows changed.
function renderContact(shown) {
  const box = byId('rsvpContact');
  box.hidden = !shown;
  if (!shown) {
    return;
  }
  const going = event.viewer.going;
  const drawFor = JSON.stringify([event.contact, going, event.viewer.contact, getLocale()]);
  if (drawFor !== contactDrawn) {
    contactDrawn = drawFor;
    contactForm = drawContactForm(byId('rsvpContactFields'), {
      fields: event.contact.fields,
      rule: event.contact.rule,
      values: event.viewer.contact,
      idPrefix: 'rsvpContact',
    });
  }
  let missing = false;
  if (going && event.viewer.contactMissing) {
    missing = true;
  }
  byId('rsvpContactMissing').hidden = !missing;
  byId('rsvpContactSave').hidden = !going;
  if (!going) {
    byId('rsvpContactSaved').hidden = true;
  }
}

// Whether the contact details go with "I am going": the box is shown.
function contactAsked() {
  if (contactForm === null) {
    return false;
  }
  return !byId('rsvpContact').hidden;
}

// How people can pay, in words: "Pay on the day, by payment link or by QR
// code"; '' when the event says nothing (migrations/016).
function paymentMethodsText(methods) {
  if (!methods.length) {
    return '';
  }
  const names = methods.map((method) => translate(`payment.method.${method}`));
  return translate('event.payment-methods', { methods: new Intl.ListFormat(getLocale(), { type: 'disjunction' }).format(names) });
}

// A convention's volunteer benefit in words: "20% off", "SGD 15.00 off".
function benefitText(discount) {
  if (discount.type === 'amount') {
    return translate('event.volunteer-benefit-amount', { amount: formatMoney(discount.value, discount.currency) });
  }
  return translate('event.volunteer-benefit-percent', { value: discount.value });
}

// The Volunteers fact, for a convention taking volunteers or giving a
// benefit to the ones from an earlier convention; hidden otherwise.
function renderVolunteerFact() {
  const volunteers = event.volunteers;
  const lines = [];
  if (volunteers.wanted) {
    lines.push(translate('event.volunteers-wanted'));
  }
  const discount = volunteers.discount;
  if (discount && discount.fromTitle) {
    lines.push(translate('event.volunteer-benefit-from', { convention: discount.fromTitle, benefit: benefitText(discount) }));
  } else if (discount) {
    lines.push(translate('event.volunteer-benefit-earlier', { benefit: benefitText(discount) }));
  }
  byId('factVolunteersRow').hidden = lines.length === 0;
  byId('factVolunteers').replaceChildren(...lines.map((line) => createElement('span', { class: 'fact-line', text: line })));
}

// Whether this person can still sign up to volunteer, or change it: while
// they can join, or, once going, until the event is over or cancelled.
function canChangeVolunteer() {
  if (!event.viewer.going) {
    return canJoinNow();
  }
  if (event.rsvp === 'over' || event.rsvp === 'cancelled') {
    return false;
  }
  return true;
}

// "I'm a fursuiter" in the RSVP box, for someone signed in while the event
// asks (migrations/023), as long as they could sign up to volunteer: while
// they can join, or once going, until the event is over.
function renderFursuiter() {
  const viewer = event.viewer;
  let shown = false;
  if (viewer.signedIn && event.fursuitersAsked && canChangeVolunteer()) {
    shown = true;
  }
  byId('rsvpFursuiterRow').hidden = !shown;
  byId('rsvpFursuiterHint').hidden = !shown;
  if (viewer.going) {
    byId('rsvpFursuiter').checked = viewer.fursuiter;
  } else {
    byId('rsvpFursuiter').checked = fursuiterPick;
  }
}

// The volunteer tick box in the RSVP box, for someone signed in while the
// convention takes volunteers, and under it their thanks for volunteering
// here and the benefit they get from volunteering at an earlier convention.
function renderVolunteer() {
  const viewer = event.viewer;
  let shown = false;
  if (viewer.signedIn && event.volunteers.wanted && canChangeVolunteer()) {
    shown = true;
  }
  byId('rsvpVolunteerRow').hidden = !shown;
  if (viewer.going) {
    byId('rsvpVolunteer').checked = viewer.volunteer;
  } else {
    byId('rsvpVolunteer').checked = volunteerPick;
  }

  const notes = [];
  if (viewer.volunteered) {
    notes.push(translate('event.volunteer-thanks'));
  }
  const discount = event.volunteers.discount;
  if (viewer.volunteerDiscount && discount && discount.fromTitle) {
    notes.push(translate('event.volunteer-you-get', { convention: discount.fromTitle, benefit: benefitText(discount) }));
  } else if (viewer.volunteerDiscount && discount) {
    notes.push(translate('event.volunteer-you-get-earlier', { benefit: benefitText(discount) }));
  }
  byId('rsvpVolunteerNote').hidden = notes.length === 0;
  byId('rsvpVolunteerNote').textContent = notes.join(' ');
}

// The ticket tiers, when the event sells its tickets in tiers: each tier's
// name and price (none while the price is hidden), then what it gives. A
// tier that includes another (any other, migrations/022) either lists those
// benefits first (marked as included) or says "Everything in <tier>,
// plus:", as the editor chose; and one that a person can buy more than one
// of says how many.
function renderTiers() {
  const tiers = event.tiers;
  byId('ticketsBox').hidden = tiers.length === 0;
  const cards = tiers.map((tier) => {
    const head = [createElement('h3', { class: 'tier-name', text: tier.name })];
    if (tier.price !== null) {
      head.push(createElement('span', { class: 'tier-price', text: tierPriceText(tier.price, event.price.currency) }));
    }
    const body = [createElement('div', { class: 'tier-head' }, head)];
    if (tier.includesTier) {
      body.push(createElement('p', { class: 'tier-includes', text: translate('event.tier-includes', { tier: tier.includesTier }) }));
    }
    const items = [
      ...tier.includedBenefits.map((benefit) => createElement('li', { class: 'tier-included' }, [
        iconNode('check'),
        createElement('span', { text: benefit }),
        createElement('span', { class: 'visually-hidden', text: translate('event.tier-included-mark') }),
      ])),
      ...tier.benefits.map((benefit) => createElement('li', {}, [iconNode('check'), createElement('span', { text: benefit })])),
    ];
    if (items.length) {
      body.push(createElement('ul', { class: 'tier-benefits' }, items));
    }
    if (tier.maxPerPerson > 1) {
      body.push(createElement('p', { class: 'tier-methods', text: translate('event.tier-max', { count: tier.maxPerPerson }) }));
    }
    // How this tier is paid for, when it differs from the event's.
    if (tier.methods.length > 0 && JSON.stringify(tier.methods) !== JSON.stringify(event.payment.methods)) {
      body.push(createElement('p', { class: 'tier-methods', text: paymentMethodsText(tier.methods) }));
    }
    return createElement('article', { class: 'tier-card' }, body);
  });
  byId('ticketTiers').replaceChildren(...cards);
}

// Where to set a country of origin, coming back here afterwards.
function countryPageHref() {
  return `/account?next=${encodeURIComponent(location.pathname)}#profile`;
}

// The event's link button, saying what the editor picked (Tickets, Join the
// group, their own words). A cross-border event's link needs a country of
// origin (migrations/015): signed out, the button signs in first; signed in
// with no country, it goes to the account page to set one. Neither has the
// link's address, which the server leaves out.
function renderExternalLink() {
  const link = event.externalLink;
  const button = byId('externalLink');
  const note = byId('externalLinkNote');
  button.hidden = !link;
  note.hidden = true;
  if (!link) {
    return;
  }
  let text = link.customLabel;
  if (link.label !== 'custom' || !text) {
    text = translate(`link.${link.label}`);
  }
  byId('externalLinkText').textContent = text;
  let iconName = 'external';
  button.removeAttribute('target');
  button.removeAttribute('rel');
  if (link.locked === 'sign-in') {
    iconName = 'lock';
    button.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    note.hidden = false;
    note.textContent = translate('event.link-sign-in');
  } else if (link.locked === 'country') {
    iconName = 'lock';
    button.href = countryPageHref();
    note.hidden = false;
    note.textContent = translate('event.link-country');
  } else {
    button.href = link.url;
    button.target = '_blank';
    button.rel = 'noopener noreferrer';
  }
  byId('externalLinkIcon').innerHTML = icon(iconName);
}

// Draws the whole event: title, chips, cover, summary, description,
// gallery, organiser, the facts (when, where, price, going), the outside and manage
// links, the preview note, and the RSVP box.
function render() {
  document.title = translate('event.page-title', { title: event.title });
  renderCover();

  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
  if (event.crossBorder) {
    chips.push(createElement('span', { class: 'chip chip-cross-border' }, [iconNode('globe'), createElement('span', { text: translate('event.cross-border') })]));
  }
  if (event.cancelled) {
    chips.push(createElement('span', { class: 'chip chip-danger', text: translate('event.state.cancelled') }));
  }
  byId('eventChips').replaceChildren(...chips);

  byId('eventTitle').textContent = event.title;
  byId('eventSummary').hidden = !event.summary;
  let summary = event.summary;
  if (!summary) {
    summary = '';
  }
  byId('eventSummary').textContent = summary;
  renderDescription();
  renderEventGallery(event.gallery);
  byId('eventOrganiser').hidden = !event.organiserName;
  let organiserText = '';
  if (event.organiserName) {
    organiserText = translate('event.organiser', { name: event.organiserName });
  }
  byId('eventOrganiser').textContent = organiserText;

  byId('factWhen').textContent = whenText(event.when);
  renderWhere();
  byId('factPrice').textContent = [priceText(event.price), event.price.note, paymentMethodsText(event.payment.methods)].filter(Boolean).join('. ');
  renderTiers();
  let goingText;
  if (event.capacity) {
    goingText = translate('event.going-of', { count: event.going, capacity: event.capacity });
  } else {
    goingText = translate('event.going', { count: event.going });
  }
  byId('factGoing').textContent = goingText;
  byId('factMealsRow').hidden = event.meals.length === 0;
  byId('factMeals').textContent = event.meals.map((meal) => mealPlacesText(meal)).join(', ');
  renderVolunteerFact();

  renderExternalLink();
  byId('manageLink').hidden = !event.viewer.canManage;
  byId('manageLink').href = `/manage?slug=${encodeURIComponent(event.slug)}`;
  byId('previewNote').hidden = !preview;

  renderRsvp();
}

// The timetable is drawn on its own, only when it changes (or the reader's
// language does), so an RSVP or a meal choice does not redraw it under
// someone scrolling through the grid.
let timetableDrawn = '';
function drawTimetable(force = false) {
  let timetable = event.timetable;
  if (timetable === undefined) {
    timetable = null;
  }
  const key = JSON.stringify(timetable);
  if (!force && key === timetableDrawn) {
    return;
  }
  timetableDrawn = key;
  renderTimetable(timetable, event.when.timezone);
}

async function load() {
  try {
    await session;
    const data = await api(`/api/events/detail?slug=${encodeURIComponent(slug)}`);
    event = data.event;
    preview = data.preview === true;
    syncChoice();
    byId('eventLoading').hidden = true;
    byId('eventView').hidden = false;
    render();
    drawTimetable();
    startTours('event');
  } catch (error) {
    byId('eventLoading').hidden = true;
    if (error.code === 'not_found') {
      byId('eventMissing').hidden = false;
    } else {
      byId('eventError').textContent = errorText(error);
    }
  }
}

byId('rsvpBtn').addEventListener('click', () => {
  // Taking back a ticket that is paid or reported paid: refunds are up to
  // the organisers, so ask first.
  const payment = event.viewer.payment;
  if (event.viewer.going && ['submitted', 'paid'].includes(payment.status)) {
    if (!window.confirm(translate('event.payment-cancel-confirm'))) {
      return;
    }
  }
  // Joining: the contact details asked for are checked before sending.
  if (!event.viewer.going && contactAsked()) {
    const problem = contactForm.check();
    if (problem) {
      byId('rsvpError').textContent = problem;
      return;
    }
  }
  withBusy(byId('rsvpBtn'), byId('rsvpError'), async () => {
    const body = { slug: event.slug, going: !event.viewer.going };
    if (body.going) {
      body.meals = chosenMeals();
      body.lepak = choice.mode === 'lepak';
      if (contactAsked()) {
        body.contact = contactForm.read();
      }
    }
    if (body.going && !byId('rsvpVolunteerRow').hidden) {
      body.volunteer = volunteerPick;
    }
    if (body.going && !byId('rsvpFursuiterRow').hidden) {
      body.fursuiter = fursuiterPick;
    }
    const data = await post('/api/events/rsvp', body);
    event = data.event;
    syncChoice();
    render();
    byId('rsvpBtn').focus();
  });
});

// While going, a new meal choice is saved as soon as it is made (and can be
// sent), one save at a time; a change made while one is on its way is sent
// straight after it.
function saveChoice() {
  if (choiceSaving) {
    choiceAgain = true;
    return;
  }
  const meals = chosenMeals();
  const lepak = choice.mode === 'lepak';
  if (JSON.stringify(meals) === JSON.stringify(event.viewer.meals) && lepak === event.viewer.lepak) {
    return;
  }
  // From just meals or lepak to the whole event, where that takes a ticket:
  // off to the checkout page to get one.
  if (choice.mode === 'event' && ticketNeeded()) {
    location.href = checkoutHref();
    return;
  }
  choiceSaving = withBusy(null, byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: true, meals, lepak });
    event = data.event;
    render();
  }).finally(() => {
    choiceSaving = null;
    if (choiceAgain) {
      choiceAgain = false;
      if (event.viewer.going && choiceReady()) {
        saveChoice();
      }
    }
  });
}

byId('rsvpMeals').addEventListener('change', (changed) => {
  if (changed.target.name === 'rsvpFor') {
    choice.mode = changed.target.value;
  } else if (changed.target.hasAttribute('data-meal')) {
    choice.meals = [...byId('rsvpMealChecks').querySelectorAll('input:checked')].map((box) => box.value);
  }
  byId('rsvpError').textContent = '';
  renderRsvp();
  if (event.viewer.going && choiceReady()) {
    saveChoice();
  }
});

// Before going, the tick is kept and sent with "I am going". While going,
// it is saved at once (with the meals as they are); if that fails, the box
// goes back to what the server has.
byId('rsvpVolunteer').addEventListener('change', () => {
  const wanted = byId('rsvpVolunteer').checked;
  byId('rsvpError').textContent = '';
  if (!event.viewer.going) {
    volunteerPick = wanted;
    byId('rsvpCheckout').href = checkoutHref();
    return;
  }
  byId('rsvpVolunteer').disabled = true;
  withBusy(null, byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: true, meals: event.viewer.meals, lepak: event.viewer.lepak, volunteer: wanted });
    event = data.event;
    render();
  }).finally(() => {
    byId('rsvpVolunteer').disabled = false;
    renderVolunteer();
  });
});

// The same for "I'm a fursuiter": kept until "I am going" before going,
// saved at once while going.
byId('rsvpFursuiter').addEventListener('change', () => {
  const wanted = byId('rsvpFursuiter').checked;
  byId('rsvpError').textContent = '';
  if (!event.viewer.going) {
    fursuiterPick = wanted;
    byId('rsvpCheckout').href = checkoutHref();
    return;
  }
  byId('rsvpFursuiter').disabled = true;
  withBusy(null, byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: true, meals: event.viewer.meals, lepak: event.viewer.lepak, fursuiter: wanted });
    event = data.event;
    render();
  }).finally(() => {
    byId('rsvpFursuiter').disabled = false;
    renderFursuiter();
  });
});

// Someone going fills in or changes their contact details.
byId('rsvpContactSave').addEventListener('click', () => {
  byId('rsvpContactSaved').hidden = true;
  const problem = contactForm.check();
  if (problem) {
    byId('rsvpError').textContent = problem;
    return;
  }
  byId('rsvpError').textContent = '';
  withBusy(byId('rsvpContactSave'), byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, contact: contactForm.read() });
    event = data.event;
    render();
    byId('rsvpContactSaved').hidden = false;
  });
});

byId('shareBtn').addEventListener('click', () => {
  // The event's own slug once it has loaded; until then, the one in the address.
  let shareSlug;
  if (event !== null && event !== undefined) {
    shareSlug = event.slug;
  }
  if (shareSlug === null || shareSlug === undefined) {
    shareSlug = slug;
  }
  copyText(`${location.origin}/e/${shareSlug}`);
});

onChange(() => {
  if (event) {
    mealsDrawn = '';
    render();
    drawTimetable(true);
  }
});

load();
