// Page tours, after docs/page-tour-spec.md: the page dims, one thing on it is
// lit, and a chalk arrow runs to it from a line saying what it does. The
// tours themselves are in js/tours.js.
//
// This site is several pages, each with tabs, rather than one app of pages,
// so the spec's "page" is a tour here: a page's own, or a tab's. On a first
// visit the first unseen tour that applies runs (whatever the address: event
// pages are always reached by a link), and the next follows when it ends.
// Skip ends the chain until another tab is opened. The header's ? button
// replays every tour that applies there and then, as one, without changing
// what has been seen.
//
// What has been seen is kept in localStorage (tour.seen, a JSON list of tour
// ids). If storage throws, every tour counts as seen, so broken storage
// never shows a tour on every visit.

import { t as translate, onChange } from '../assets/i18n/i18n.js';
import { TOURS } from './tours.js';

const SEEN_KEY = 'tour.seen';
const HINT_ID = 'hint';
const PAD = 8;
const MARGIN = 12; // the card's distance from the viewport's edges
const EDGE = 20; // the arrow's: more than its head's length
const GAP_MIN = 36;
const GAP_MAX = 70;
const CARD_MIN = 220; // the narrowest the card goes to fit beside an element
const HEAD_LENGTH = 14;

let pageName = null;
let run = null; // the tour showing: { steps, at, ids, replay, returnTo, scrollY, inerted }
let waiting = null;
let quiet = false; // after Skip, until another tab opens
let root = null; // the tour's layer while one shows

// ---------------------------------------------------------------------------
// What has been seen
// ---------------------------------------------------------------------------

// The ids seen, or null when storage cannot be read.
function seenList() {
  try {
    const stored = localStorage.getItem(SEEN_KEY);
    if (!stored) {
      return [];
    }
    const list = JSON.parse(stored);
    if (Array.isArray(list)) {
      return list;
    }
    return [];
  } catch {
    return null;
  }
}

function isSeen(id) {
  const list = seenList();
  if (list === null) {
    return true;
  }
  return list.includes(id);
}

function markSeen(ids) {
  try {
    let list = seenList();
    if (list === null) {
      list = [];
    }
    const added = ids.filter((id) => !list.includes(id));
    if (added.length) {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...list, ...added]));
    }
  } catch {
    // Shown again next time.
  }
}

// ---------------------------------------------------------------------------
// Finding what to light
// ---------------------------------------------------------------------------

function visible(element) {
  if (!element || element.closest('[hidden]')) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }
  return getComputedStyle(element).visibility !== 'hidden';
}

// The first visible match of a selector, or of the first selector in a list
// that has one.
function find(selectors) {
  let list = [selectors];
  if (Array.isArray(selectors)) {
    list = selectors;
  }
  for (const selector of list) {
    const match = [...document.querySelectorAll(selector)].find(visible);
    if (match) {
      return match;
    }
  }
  return null;
}

function toursHere() {
  return TOURS.filter((tour) => tour.page === pageName);
}

function applies(tour) {
  return find(tour.needs) !== null;
}

function dialogOpen() {
  return document.querySelector('.modal-backdrop:not(.hidden)') !== null;
}

// A tour's steps whose elements are showing, each with its element.
function stepsOf(tour, { replay }) {
  // The hint about the ? button, in the first tour someone sees.
  let hintDue = false;
  if (!replay) {
    hintDue = !isSeen(HINT_ID);
  }
  return tour.steps
    .filter((step) => {
      if (step.hint) {
        return hintDue;
      }
      return true;
    })
    .map((step) => ({ ...step, target: find(step.el) }))
    .filter((step) => step.target);
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

function part(selector) {
  return root.querySelector(selector);
}

// Content that loads or grows under the tour moves what is lit.
const resizeWatch = new ResizeObserver(() => place());

function onKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    end({ skipped: true });
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    next();
  } else if (event.key === 'Tab') {
    // Only Skip and Next take focus; the page under the tour is inert.
    event.preventDefault();
    let other = '.tour-next';
    if (document.activeElement === part('.tour-next')) {
      other = '.tour-skip';
    }
    part(other).focus({ preventScroll: true });
  }
}

function build() {
  root = document.createElement('div');
  root.className = 'tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'tourText');
  root.innerHTML =
    '<div class="tour-hole"></div>' +
    '<svg class="tour-arrow" aria-hidden="true" focusable="false"><defs><filter id="tourChalk"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.5"/></filter></defs>' +
    '<path class="tour-line" filter="url(#tourChalk)"/><path class="tour-head" filter="url(#tourChalk)"/></svg>' +
    '<button class="tour-skip" type="button"></button>' +
    '<div class="tour-card"><p id="tourText" class="tour-text" aria-live="polite"></p>' +
    '<div class="tour-foot"><span class="tour-dots" aria-hidden="true"></span><button class="tour-next" type="button"></button></div></div>';
  document.body.appendChild(root);
  part('.tour-skip').addEventListener('click', () => end({ skipped: true }));
  part('.tour-next').addEventListener('click', next);
  root.addEventListener('keydown', onKey);
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  resizeWatch.observe(document.documentElement);
}

function show(index) {
  run.at = index;
  const step = run.steps[index];
  if (!step.target.isConnected || !visible(step.target)) {
    // Gone since the tour started (a list redrew): the same thing again, if it is there.
    step.target = find(step.el);
    if (!step.target) {
      next();
      return;
    }
  }
  let block = 'center';
  if (step.target.getBoundingClientRect().height > innerHeight * 0.6) {
    block = 'start';
  }
  step.target.scrollIntoView({ block, behavior: 'instant' });
  label();
  part('.tour-dots').replaceChildren(...run.steps.map((unused, dotIndex) => {
    const dot = document.createElement('span');
    if (dotIndex === index) {
      dot.className = 'on';
    }
    return dot;
  }));
  // Draw the line in again for this step.
  const line = part('.tour-line');
  line.classList.remove('drawn');
  requestAnimationFrame(() => {
    place();
    line.classList.add('drawn');
  });
  part('.tour-next').focus({ preventScroll: true });
}

// The words, again when the language changes mid-tour.
function label() {
  if (!run) {
    return;
  }
  part('.tour-text').textContent = translate(run.steps[run.at].i18n);
  part('.tour-skip').textContent = translate('tour.skip');
  let nextKey = 'tour.next';
  if (run.at === run.steps.length - 1) {
    nextKey = 'tour.done';
  }
  part('.tour-next').textContent = translate(nextKey);
}

function clamp(low, value, high) {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

// The larger of two sides' room: the first when they tie.
function roomier(room, first, second) {
  if (room[first] >= room[second]) {
    return first;
  }
  return second;
}

// Which side of the element the card goes, narrowing the card to fit beside
// it when need be; null when there is no room for the card and an arrow.
function chooseSide(card, room, viewHeight) {
  let cardWidth = card.offsetWidth;
  let cardHeight = card.offsetHeight;
  if (Math.max(room.below, room.above) >= cardHeight + GAP_MIN) {
    return roomier(room, 'below', 'above');
  }
  const beside = roomier(room, 'right', 'left');
  const fit = room[beside] - GAP_MIN;
  if (fit < Math.min(cardWidth, CARD_MIN)) {
    return null;
  }
  if (fit < cardWidth) {
    card.style.width = `${fit}px`;
    cardWidth = card.offsetWidth;
    cardHeight = card.offsetHeight;
  }
  if (cardHeight <= viewHeight - MARGIN * 2) {
    return beside;
  }
  card.style.width = '';
  return null;
}

// No room: the card on its own backing, at the end away from most of the
// element, and no arrow. Measured with the backing on.
function placeSolid(card, shown, viewWidth, viewHeight) {
  card.classList.add('solid');
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  let top = viewHeight - cardHeight - MARGIN;
  if ((shown.top + shown.bottom) / 2 > viewHeight / 2) {
    top = MARGIN;
  }
  card.style.left = `${(viewWidth - cardWidth) / 2}px`;
  card.style.top = `${top}px`;
  part('.tour-line').setAttribute('d', '');
  part('.tour-head').setAttribute('d', '');
}

// Where the card goes on its side, and the arrow's two ends: the start on
// the card's edge facing the element, the tip at the middle of the
// element's near side.
function layout(side, card, shown, room, viewWidth, viewHeight) {
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const midX = (shown.left + shown.right) / 2;
  const midY = (shown.top + shown.bottom) / 2;
  if (side === 'below' || side === 'above') {
    const gap = clamp(GAP_MIN, room[side] - cardHeight, GAP_MAX);
    const left = clamp(MARGIN, midX - cardWidth / 2, viewWidth - cardWidth - MARGIN);
    const tipX = clamp(shown.left + 12, midX, shown.right - 12);
    const startX = clamp(left + 24, tipX, left + cardWidth - 24);
    if (side === 'below') {
      const top = clamp(MARGIN, shown.bottom + PAD + gap, viewHeight - cardHeight - MARGIN);
      return { left, top, startX, startY: top - 6, tipX, tipY: shown.bottom + PAD + 4 };
    }
    const top = clamp(MARGIN, shown.top - PAD - gap - cardHeight, viewHeight - cardHeight - MARGIN);
    return { left, top, startX, startY: top + cardHeight + 6, tipX, tipY: shown.top - PAD - 4 };
  }
  const gap = clamp(GAP_MIN, room[side] - cardWidth, GAP_MAX);
  const top = clamp(MARGIN, midY - cardHeight / 2, viewHeight - cardHeight - MARGIN);
  const tipY = clamp(shown.top + 12, midY, shown.bottom - 12);
  const startY = clamp(top + 16, tipY, top + cardHeight - 16);
  if (side === 'right') {
    const left = clamp(MARGIN, shown.right + PAD + gap, viewWidth - cardWidth - MARGIN);
    return { left, top, startX: left - 6, startY, tipX: shown.right + PAD + 4, tipY };
  }
  const left = clamp(MARGIN, shown.left - PAD - gap - cardWidth, viewWidth - cardWidth - MARGIN);
  return { left, top, startX: left + cardWidth + 6, startY, tipX: shown.left - PAD - 4, tipY };
}

// A curve from the card to the element, bowed like a hand drew it, with
// every point EDGE in from the viewport so none of it is cut off.
function drawArrow(points, viewWidth, viewHeight) {
  const inX = (value) => clamp(EDGE, value, viewWidth - EDGE);
  const inY = (value) => clamp(EDGE, value, viewHeight - EDGE);
  const tipX = inX(points.tipX);
  const tipY = inY(points.tipY);
  const startX = inX(points.startX);
  const startY = inY(points.startY);
  const bendX = inX((startX + tipX) / 2 - (tipY - startY) * 0.2);
  const bendY = inY((startY + tipY) / 2 + (tipX - startX) * 0.2);

  const line = part('.tour-line');
  part('.tour-arrow').setAttribute('viewBox', `0 0 ${viewWidth} ${viewHeight}`);
  line.setAttribute('d', `M${startX},${startY} Q${bendX},${bendY} ${tipX},${tipY}`);
  line.style.setProperty('--len', String(Math.ceil(line.getTotalLength()) + 10));
  const angle = Math.atan2(tipY - bendY, tipX - bendX);
  const one = angle + Math.PI * 0.8;
  const two = angle - Math.PI * 0.8;
  part('.tour-head').setAttribute('d',
    `M${tipX + Math.cos(one) * HEAD_LENGTH},${tipY + Math.sin(one) * HEAD_LENGTH} L${tipX},${tipY} L${tipX + Math.cos(two) * HEAD_LENGTH},${tipY + Math.sin(two) * HEAD_LENGTH}`);
}

// Spec section 3: the hole, the card on the side with room and lined up with
// the element, and the arrow between them, all of it on screen.
function place() {
  if (!run) {
    return;
  }
  const rect = run.steps[run.at].target.getBoundingClientRect();
  const viewWidth = innerWidth;
  const viewHeight = innerHeight;
  const hole = part('.tour-hole');
  hole.style.left = `${rect.left - PAD}px`;
  hole.style.top = `${rect.top - PAD}px`;
  hole.style.width = `${rect.width + PAD * 2}px`;
  hole.style.height = `${rect.height + PAD * 2}px`;

  // The element's visible part: the rest works from it.
  const shown = {
    left: Math.max(rect.left, 0),
    right: Math.min(rect.right, viewWidth),
    top: Math.max(rect.top, 0),
    bottom: Math.min(rect.bottom, viewHeight),
  };
  const room = {
    below: viewHeight - shown.bottom - PAD - MARGIN,
    above: shown.top - PAD - MARGIN,
    right: viewWidth - shown.right - PAD - MARGIN,
    left: shown.left - PAD - MARGIN,
  };
  const card = part('.tour-card');
  card.classList.remove('solid');
  card.style.width = '';
  const side = chooseSide(card, room, viewHeight);
  if (!side) {
    placeSolid(card, shown, viewWidth, viewHeight);
    return;
  }
  const points = layout(side, card, shown, room, viewWidth, viewHeight);
  card.style.left = `${points.left}px`;
  card.style.top = `${points.top}px`;
  drawArrow(points, viewWidth, viewHeight);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function begin(steps, { ids, replay }) {
  const inerted = [];
  for (const child of document.body.children) {
    if (!child.hasAttribute('inert')) {
      child.setAttribute('inert', '');
      inerted.push(child);
    }
  }
  run = { steps, at: 0, ids, replay, returnTo: document.activeElement, scrollY: window.scrollY, inerted };
  document.documentElement.classList.add('touring');
  build();
  show(0);
}

function next() {
  if (!run) {
    return;
  }
  if (run.at < run.steps.length - 1) {
    show(run.at + 1);
  } else {
    end({ skipped: false });
  }
}

function end({ skipped }) {
  if (!run) {
    return;
  }
  const finished = run;
  run = null;
  if (!finished.replay) {
    const ids = [...finished.ids];
    if (finished.steps.some((step) => step.hint)) {
      ids.push(HINT_ID);
    }
    markSeen(ids);
  }
  removeEventListener('resize', place);
  removeEventListener('scroll', place, true);
  resizeWatch.disconnect();
  root.remove();
  root = null;
  finished.inerted.forEach((child) => child.removeAttribute('inert'));
  document.documentElement.classList.remove('touring');
  window.scrollTo({ top: finished.scrollY, behavior: 'instant' });
  if (finished.returnTo && typeof finished.returnTo.focus === 'function') {
    finished.returnTo.focus({ preventScroll: true });
  }
  if (skipped && !finished.replay) {
    quiet = true;
  }
  look();
}

// The first unseen tour that applies here and now, or undefined.
function due() {
  return toursHere().find((tour) => {
    if (isSeen(tour.id)) {
      return false;
    }
    return applies(tour);
  });
}

// Waits for the page to settle (and any dialog to close), then runs the
// first unseen tour that applies, if one comes along within about eight
// seconds: the edit form, say, opening once its event has loaded.
function look() {
  clearInterval(waiting);
  if (quiet || toursHere().every((tour) => isSeen(tour.id))) {
    return;
  }
  let tries = 0;
  waiting = setInterval(() => {
    tries += 1;
    if (tries > 16) {
      clearInterval(waiting);
      return;
    }
    if (tries < 2 || run || dialogOpen()) {
      return;
    }
    const tour = due();
    if (!tour) {
      return;
    }
    clearInterval(waiting);
    const steps = stepsOf(tour, { replay: false });
    if (!steps.length) {
      markSeen([tour.id]);
      look();
      return;
    }
    begin(steps, { ids: [tour.id], replay: false });
  }, 500);
}

// The ? button: every tour that applies here, as one.
function replay() {
  if (run) {
    return;
  }
  clearInterval(waiting);
  const tours = toursHere().filter(applies);
  const steps = tours.flatMap((tour) => stepsOf(tour, { replay: true }));
  if (steps.length) {
    begin(steps, { ids: tours.map((tour) => tour.id), replay: true });
  }
}

// Called by a page when something with a tour of its own may have just
// appeared (the Registration details card after an RSVP, the upgrade
// section at checkout): looks for an unseen tour to show, as on load.
export function checkTours() {
  if (!pageName || run) {
    return;
  }
  look();
}

// Called once by a page's module when its content has drawn (the feed, the
// event, the account, the event list). Shows the header's ? button and
// starts watching for tours to show.
export function startTours(name) {
  if (pageName) {
    return;
  }
  pageName = name;
  const button = document.getElementById('tourBtn');
  if (button) {
    button.hidden = false;
    button.addEventListener('click', replay);
  }
  // A tab opened (js/tabs.js): its tour, if it has one still to see.
  document.addEventListener('tabchange', () => {
    quiet = false;
    if (!run) {
      look();
    }
  });
  onChange(label);
  look();
}
