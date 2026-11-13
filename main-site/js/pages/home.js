// The public event feed: upcoming, dates to come, or past, by kind.

import '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api } from '../api.js';
import { errorText } from '../ui.js';
import { eventCard } from '../cards.js';

const byId = (id) => document.getElementById(id);
const state = { when: 'upcoming', kind: '', offset: 0, events: [], next: null };
let request = 0;

function press(groupId, attr, value) {
  document.querySelectorAll(`#${groupId} [${attr}]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
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

async function load({ append = false } = {}) {
  const mine = ++request;
  byId('feedError').textContent = '';
  if (!append) byId('feed').setAttribute('aria-busy', 'true');
  const params = new URLSearchParams({ when: state.when, offset: String(append ? state.next : 0) });
  if (state.kind) params.set('kind', state.kind);
  try {
    const data = await api(`/api/events/feed?${params}`);
    if (mine !== request) return;
    state.events = append ? [...state.events, ...data.events] : data.events;
    state.next = data.nextOffset;
    render();
  } catch (error) {
    if (mine !== request) return;
    byId('feed').setAttribute('aria-busy', 'false');
    if (!append) byId('feed').replaceChildren();
    byId('feedError').textContent = errorText(error);
  }
}

byId('whenPicker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-when-filter]');
  if (!b) return;
  state.when = b.getAttribute('data-when-filter');
  press('whenPicker', 'data-when-filter', state.when);
  load();
});

byId('kindPicker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  state.kind = b.getAttribute('data-kind');
  press('kindPicker', 'data-kind', state.kind);
  load();
});

byId('feedMore').addEventListener('click', () => load({ append: true }));

// Cards are built in code, so they are rebuilt in the new language.
onChange(() => { if (state.events.length) render(); });

load();
