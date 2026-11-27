// The public event feed: upcoming, dates to come, or past, by kind.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { errorText } from '../ui.js';
import { eventCard } from '../cards.js';
import { startTours } from '../tour.js';

const byId = (id) => document.getElementById(id);
// q: the search as typed (sent as ?q=, kept in the page's address so a
// search can be shared or reloaded).
const state = { when: 'upcoming', kind: '', q: '', offset: 0, events: [], next: null };
const SEARCH_DELAY_MS = 300;
let searchTimer = null;
// Counts feed requests, so an answer that arrives after a newer request was
// made is dropped.
let latestRequest = 0;
// My RSVPs by event slug ({ rsvpNumber, ticketName, paymentStatus }), when
// signed in, so the feed's cards show my number for the events I am going to.
let mine = new Map();

// Fetches my RSVPs once signed in; the feed works without them.
async function loadMine() {
  const current = await session;
  if (!current || !current.signedIn) {
    return;
  }
  try {
    const rsvps = await api('/api/me/rsvps');
    mine = new Map([...rsvps.upcoming, ...rsvps.past].filter((rsvp) => rsvp.event).map((rsvp) => [rsvp.event.slug, rsvp]));
  } catch {
    mine = new Map();
  }
}

// A feed card, with my number on it when I am going.
function card(event) {
  const rsvp = mine.get(event.slug);
  if (!rsvp) {
    return eventCard(event);
  }
  return eventCard(event, { rsvpNumber: rsvp.rsvpNumber, ticketName: rsvp.ticketName, paymentStatus: rsvp.paymentStatus });
}

// Marks the button in the group whose attribute matches value as pressed.
function markPressed(groupId, attributeName, value) {
  document.querySelectorAll(`#${groupId} [${attributeName}]`).forEach((button) => {
    button.setAttribute('aria-pressed', String(button.getAttribute(attributeName) === value));
  });
}

function render() {
  const feed = byId('feed');
  feed.replaceChildren(...state.events.map(card));
  feed.setAttribute('aria-busy', 'false');
  byId('feedEmpty').hidden = state.events.length > 0;
  // Nothing found for a search says so, and what it looked for.
  if (state.q.trim()) {
    byId('feedEmpty').textContent = translate('home.search-empty', { search: state.q.trim() });
  } else {
    byId('feedEmpty').textContent = translate('home.empty');
  }
  byId('feedMore').hidden = state.next === null;
  byId('feedStatus').textContent = translate('home.count', { count: state.events.length });
}

// Fetches the feed for the chosen when and kind: from the start, or (append)
// the next page after what is shown.
async function load({ append = false } = {}) {
  latestRequest += 1;
  const thisRequest = latestRequest;
  byId('feedError').textContent = '';
  if (!append) {
    byId('feed').setAttribute('aria-busy', 'true');
  }
  let offset = 0;
  if (append) {
    offset = state.next;
  }
  const query = new URLSearchParams({ when: state.when, offset: String(offset) });
  if (state.kind) {
    query.set('kind', state.kind);
  }
  if (state.q.trim()) {
    query.set('q', state.q.trim());
  }
  try {
    const data = await api(`/api/events/feed?${query}`);
    if (thisRequest !== latestRequest) {
      return;
    }
    if (append) {
      state.events = [...state.events, ...data.events];
    } else {
      state.events = data.events;
    }
    state.next = data.nextOffset;
    render();
  } catch (error) {
    if (thisRequest !== latestRequest) {
      return;
    }
    byId('feed').setAttribute('aria-busy', 'false');
    if (!append) {
      byId('feed').replaceChildren();
    }
    byId('feedError').textContent = errorText(error);
  }
}

byId('whenPicker').addEventListener('click', (event) => {
  const button = event.target.closest('[data-when-filter]');
  if (!button) {
    return;
  }
  state.when = button.getAttribute('data-when-filter');
  markPressed('whenPicker', 'data-when-filter', state.when);
  load();
});

byId('kindPicker').addEventListener('click', (event) => {
  const button = event.target.closest('[data-kind]');
  if (!button) {
    return;
  }
  state.kind = button.getAttribute('data-kind');
  markPressed('kindPicker', 'data-kind', state.kind);
  load();
});

byId('feedMore').addEventListener('click', () => load({ append: true }));

// The search runs as it is typed, once typing pauses, and at once on Enter.
// The address keeps it (/?q=...), and leaves it out when it is cleared.
function search() {
  clearTimeout(searchTimer);
  const typed = byId('feedSearch').value;
  if (typed.trim() === state.q.trim()) {
    return;
  }
  state.q = typed;
  const address = new URL(location.href);
  if (typed.trim()) {
    address.searchParams.set('q', typed.trim());
  } else {
    address.searchParams.delete('q');
  }
  history.replaceState(null, '', address);
  load();
}

byId('feedSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, SEARCH_DELAY_MS);
});
byId('feedSearchForm').addEventListener('submit', (submitted) => {
  submitted.preventDefault();
  search();
});

// A search in the address (a shared link, or a reload) is the first one.
const searchedFor = new URLSearchParams(location.search).get('q');
if (searchedFor) {
  state.q = searchedFor.slice(0, 80);
  byId('feedSearch').value = state.q;
}

// Cards are built in code, so they are rebuilt in the new language.
onChange(() => {
  if (state.events.length) {
    render();
  }
});

// The tour once the first page of the feed has drawn (or failed to). My
// RSVPs come alongside; the cards are drawn again once they arrive.
const mineLoaded = loadMine();
Promise.all([load(), mineLoaded]).finally(() => startTours('home'));
mineLoaded.then(() => {
  if (mine.size > 0 && state.events.length) {
    render();
  }
});
