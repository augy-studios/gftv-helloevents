// One event: /e/<slug>, served from event.html by a rewrite.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, errorText, withBusy, copyText } from '../ui.js';
import { iconNode, icon } from '../icons.js';
import { whenText, placeText, priceText, spacesText, locationText, locationLabel, mealLocationLabel, mealsText, mealPlacesText, tierPriceText, formatMoney } from '../format.js';
import { startLangSwitch, preferredDescriptionLang, rememberDescriptionLang } from '../lang-switch.js';

const byId = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.replace(/^\/e\//, '').replace(/\/+$/, '')).toLowerCase();
let event = null;
let preview = false;
let descriptionLang = preferredDescriptionLang();
// What this person is coming for: the whole event, or only some of the
// meals the event offers (ids). Taken from the server while they are going;
// picked here before they say they are going.
let choice = { onlyMeals: false, meals: [] };
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
// have one). The text is marked with its language, so the right font and
// screen reader voice are used; the placeholder is the page's own language.
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
  if (texts[lang]) {
    box.lang = lang;
    box.textContent = texts[lang];
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

// Whether someone not yet going can still say they are coming: RSVPs open,
// or the event full but a meal with a place left (people coming just for a
// meal take none of the event's spaces).
function canJoinNow() {
  if (event.rsvp === 'open') {
    return true;
  }
  if (event.rsvp !== 'full') {
    return false;
  }
  return event.meals.some(mealOpen);
}

// Whether "The whole event" can be picked: there is a space, or this person
// already has one.
function wholeEventOpen() {
  if (event.rsvp === 'open') {
    return true;
  }
  if (!event.viewer.going) {
    return false;
  }
  return event.viewer.meals.length === 0;
}

// The meal choice as the server has it, while this person is going. Before
// they go, what they picked here is kept, less any meal no longer offered.
function syncChoice() {
  const offered = event.meals.map((meal) => meal.id);
  if (event.viewer.going) {
    choice = { onlyMeals: event.viewer.meals.length > 0, meals: [...event.viewer.meals] };
    return;
  }
  if (offered.length === 0) {
    choice.onlyMeals = false;
  }
  choice.meals = choice.meals.filter((id) => offered.includes(id));
}

// The meals to send: none for the whole event, otherwise the ones ticked,
// in the event's order.
function chosenMeals() {
  if (!choice.onlyMeals) {
    return [];
  }
  return event.meals.map((meal) => meal.id).filter((id) => choice.meals.includes(id));
}

// Whether the choice can be sent: the whole event, or at least one meal.
function choiceReady() {
  if (!choice.onlyMeals) {
    return true;
  }
  return chosenMeals().length > 0;
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
  let shown = false;
  if (event.viewer.signedIn && event.meals.length > 0 && canChange) {
    shown = true;
  }
  byId('rsvpMeals').hidden = !shown;
  if (!shown) {
    return;
  }
  // With the event full, someone without a space can only come for a meal.
  const wholeOpen = wholeEventOpen();
  byId('rsvpForEvent').disabled = !wholeOpen;
  if (!wholeOpen) {
    choice.onlyMeals = true;
  }
  drawMealChecks();
  byId('rsvpForEvent').checked = !choice.onlyMeals;
  byId('rsvpForMeals').checked = choice.onlyMeals;
  byId('rsvpMealList').hidden = !choice.onlyMeals;
  byId('rsvpMealsHint').hidden = choiceReady();
}

// The RSVP box: "you're going" (and for which meals), a sign-in link for
// visitors while RSVPs are open, the meal choice, and one button that says
// Going or Cancel, plus the spaces line.
function renderRsvp() {
  const signedIn = event.viewer.signedIn;
  const going = event.viewer.going;
  const canJoin = canJoinNow();
  byId('rsvpStatus').hidden = !going;
  let statusText = translate('event.you-are-going');
  if (going && event.viewer.meals.length > 0) {
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

  let signInHidden = false;
  if (signedIn || !canJoin) {
    signInHidden = true;
  }
  byId('rsvpSignIn').hidden = signInHidden;
  byId('rsvpSignIn').href = `/login?next=${encodeURIComponent(location.pathname)}`;

  const rsvpButton = byId('rsvpBtn');
  let rsvpButtonHidden = false;
  if (!signedIn || (!going && !canJoin)) {
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
  let note = spacesText(event);
  if (event.rsvp === 'full' && event.meals.some(mealOpen)) {
    note = translate('event.full-meals-open');
  }
  byId('rsvpNote').textContent = note;
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
// tier that includes the one before it either lists those benefits first
// (marked as included) or says "Everything in <tier>, plus:", as the editor
// chose.
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
    return createElement('article', { class: 'tier-card' }, body);
  });
  byId('ticketTiers').replaceChildren(...cards);
}

// Draws the whole event: title, chips, cover, summary, description,
// organiser, the facts (when, where, price, going), the outside and manage
// links, the preview note, and the RSVP box.
function render() {
  document.title = translate('event.page-title', { title: event.title });
  renderCover();

  const chips = [createElement('span', { class: `chip kind-${event.kind}`, text: translate(`kind.${event.kind}`) })];
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
  byId('eventOrganiser').hidden = !event.organiserName;
  let organiserText = '';
  if (event.organiserName) {
    organiserText = translate('event.organiser', { name: event.organiserName });
  }
  byId('eventOrganiser').textContent = organiserText;

  byId('factWhen').textContent = whenText(event.when);
  renderWhere();
  byId('factPrice').textContent = [priceText(event.price), event.price.note].filter(Boolean).join('. ');
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

  byId('externalLink').hidden = !event.externalUrl;
  if (event.externalUrl) {
    byId('externalLink').href = event.externalUrl;
  }
  byId('manageLink').hidden = !event.viewer.canManage;
  byId('manageLink').href = `/manage?slug=${encodeURIComponent(event.slug)}`;
  byId('previewNote').hidden = !preview;

  renderRsvp();
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
  withBusy(byId('rsvpBtn'), byId('rsvpError'), async () => {
    const body = { slug: event.slug, going: !event.viewer.going };
    if (body.going) {
      body.meals = chosenMeals();
    }
    if (body.going && !byId('rsvpVolunteerRow').hidden) {
      body.volunteer = volunteerPick;
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
  if (JSON.stringify(meals) === JSON.stringify(event.viewer.meals)) {
    return;
  }
  choiceSaving = withBusy(null, byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: true, meals });
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
    choice.onlyMeals = byId('rsvpForMeals').checked;
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
    return;
  }
  byId('rsvpVolunteer').disabled = true;
  withBusy(null, byId('rsvpError'), async () => {
    const data = await post('/api/events/rsvp', { slug: event.slug, going: true, meals: event.viewer.meals, volunteer: wanted });
    event = data.event;
    render();
  }).finally(() => {
    byId('rsvpVolunteer').disabled = false;
    renderVolunteer();
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
  }
});

load();
