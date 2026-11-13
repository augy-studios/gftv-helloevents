// The public event feed: upcoming, dates to come, or past, by kind.

import '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { errorText } from '../ui.js';
import { eventCard } from '../cards.js';

const byId = (id) => document.getElementById(id);
const state = { when: 'upcoming', kind: '', offset: 0, events: [], next: null };
// Counts feed requests, so an answer that arrives after a newer request was
// made is dropped.
let latestRequest = 0;

// Marks the button in the group whose attribute matches value as pressed.
function markPressed(groupId, attributeName, value) {
  document.querySelectorAll(`#${groupId} [${attributeName}]`).forEach((button) => {
    button.setAttribute('aria-pressed', String(button.getAttribute(attributeName) === value));
  });
}

function render() {
  const feed = byId('feed');
  feed.replaceChildren(...state.events.map(eventCard));
  feed.setAttribute('aria-busy', 'false');
  byId('feedEmpty').hidden = state.events.length > 0;
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

// Cards are built in code, so they are rebuilt in the new language.
onChange(() => {
  if (state.events.length) {
    render();
  }
});

load();
