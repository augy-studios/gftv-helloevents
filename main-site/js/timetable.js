// The timetable on the event page (migrations/014), drawn the way the editor
// picked:
//
//   timeline  day by day, a line down the side with a dot at each time of
//             day something happens, and beside it what happens then and
//             its note. A step has a time only: no end, no room. It counts
//             as going on until the next step's time.
//   grid      a timetable, which the visitor sees as a table or a list
//             (a Table / List switch, remembered in their browser):
//   table     one day at a time (a button per day), a column per room used
//             that day and a row per half hour, each item a block as tall
//             as it lasts, like a con's printed schedule. Items in the same
//             room at the same time share the column side by side.
//   list      every item in time order, day by day, its times on the left.
//
// The timeline is a literal line: a dot for each time of day something
// happens, with what happens then beside it.
//
// Both show what is on now: those items are highlighted and marked "Now",
// the ones already over are faded, and the next ones (once the timetable
// has begun) are marked "Next". The grid also draws a line across the day
// at the current time. This is worked out in the browser from the moments
// the server sends (startsAt, endsAt) and kept up to date every half minute
// without redrawing, so a scrolled grid stays where it is.
//
// The days, times and rooms are shown as the editor typed them: wall-clock
// in the event's own zone, which the section says.

import { t as translate, getLocale } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';

// An item with no end lasts this long (api/_lib/event-rules.js
// TIMETABLE_DEFAULT_MINUTES).
const DEFAULT_MINUTES = 30;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
// How many colours rooms cycle through (style.css .tt-c0 to .tt-c5).
const ROOM_COLOURS = 6;
const TICK_MS = 30_000;

// What is drawn, for tick() to update: [{ node, startMs, endMs }], the grid's
// now line and the day it shows, and the timer.
let tracked = [];
// The timeline's dots: [{ node, startMs, spans }], one per time of day.
let stops = [];
let nowLine = null;
let timer = null;
let shownDay = null;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// "2026-12-11" as "Fri, 11 Dec" (short) or "Friday, 11 December".
function dayText(date, long = false) {
  const [year, month, day] = date.split('-').map(Number);
  let options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (long) {
    options = { weekday: 'long', day: 'numeric', month: 'long' };
  }
  return new Intl.DateTimeFormat(getLocale(), { ...options, timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

// "14:30" in the reader's way of writing times ("2:30 pm", "14:30").
function clockText(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(getLocale(), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}

// An item's times: "10:00", "10:00 to 12:30", or "21:00 to 01:00 (next day)".
function itemTimeText(item) {
  const start = clockText(item.start);
  if (!item.end) {
    return start;
  }
  let end = clockText(item.end);
  if (item.endsNextDay) {
    end = translate('event.timetable-next-day', { time: end });
  }
  return translate('event.timetable-range', { start, end });
}

// The zone's long name ("Singapore Standard Time"), or its id.
function zoneName(timeZone) {
  try {
    const part = new Intl.DateTimeFormat(getLocale(), { timeZone, timeZoneName: 'long' })
      .formatToParts(new Date())
      .find((each) => each.type === 'timeZoneName');
    if (part) {
      return part.value;
    }
  } catch {
    // An unknown zone: its id will do.
  }
  return timeZone;
}

// The wall-clock date and minutes since midnight in timeZone at moment ms:
// { date: "2026-12-11", minutes: 870 }.
function wallNow(ms, timeZone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ms))
        .map((part) => [part.type, part.value])
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    return { date: '', minutes: 0 };
  }
}

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// When an item starts and stops counting as on: its end, or
// DEFAULT_MINUTES after its start when it has none.
function itemSpan(item) {
  const startMs = Date.parse(item.startsAt);
  let endMs = startMs + DEFAULT_MINUTES * MINUTE_MS;
  if (item.endsAt) {
    endMs = Date.parse(item.endsAt);
  }
  return { startMs, endMs };
}

// Minutes from the start of the item's own day to its start and end (an
// end on the next day is past 1440).
function itemMinutes(item) {
  const [startHours, startMinutes] = item.start.split(':').map(Number);
  const start = startHours * 60 + startMinutes;
  let end = start + DEFAULT_MINUTES;
  if (item.end) {
    const [endHours, endMinutes] = item.end.split(':').map(Number);
    end = endHours * 60 + endMinutes;
    if (item.endsNextDay) {
      end += DAY_MINUTES;
    }
  }
  return { start, end };
}

function colourClass(item) {
  if (item.room === null) {
    return 'tt-cx';
  }
  return `tt-c${item.room % ROOM_COLOURS}`;
}

// The room's name and tag as a small label, or nothing for an item in none.
function roomLabel(timetable, item) {
  if (item.room === null) {
    return null;
  }
  const room = timetable.rooms[item.room];
  const children = [];
  if (room.tag) {
    children.push(createElement('span', { class: 'tt-room-tag', text: room.tag }));
  }
  children.push(createElement('span', { text: room.name }));
  return createElement('span', { class: `tt-room ${colourClass(item)}` }, children);
}

// The "Now" and "Next" marks every item carries, shown by tick().
function marks() {
  return [
    createElement('span', { class: 'tt-mark tt-mark-now', text: translate('event.timetable-now'), hidden: true }),
    createElement('span', { class: 'tt-mark tt-mark-next', text: translate('event.timetable-next'), hidden: true }),
  ];
}

function groupByDay(items) {
  const days = new Map();
  for (const item of items) {
    if (!days.has(item.date)) {
      days.set(item.date, []);
    }
    days.get(item.date).push(item);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

// One step hanging off a dot: what happens, and its note. A timeline item
// has only a time (shown on the dot), never an end or a room.
function timelineItem(item, span) {
  const children = [
    createElement('div', { class: 'tl-item-head' }, [createElement('h4', { class: 'tl-item-title', text: item.title }), ...marks()]),
  ];
  if (item.note) {
    children.push(createElement('p', { class: 'tt-note', text: item.note }));
  }
  const node = createElement('li', { class: 'tl-item' }, children);
  tracked.push({ node, ...span });
  return node;
}

// The timeline: for each day, a line down the side with a dot at each time
// something happens, and what happens then beside it ("12:00 pm: travel to
// the border"). A step has no end: it is what is going on from its time
// until the next step's (the last one, until the end of its day). tick()
// fills in the line up to the dots already reached, and rings the dot of
// the step going on now.
function renderTimeline(box, timetable) {
  // Every time of day with something at it, in order, across the days.
  const all = [];
  for (const item of timetable.items) {
    const last = all[all.length - 1];
    if (last && last.date === item.date && last.start === item.start) {
      last.items.push(item);
    } else {
      all.push({ date: item.date, start: item.start, startMs: Date.parse(item.startsAt), items: [item] });
    }
  }
  all.forEach((stop, index) => {
    const next = all[index + 1];
    if (next) {
      stop.endMs = next.startMs;
    } else {
      stop.endMs = stop.startMs + (DAY_MINUTES - itemMinutes(stop.items[0]).start) * MINUTE_MS;
    }
  });

  const sections = [];
  let section = null;
  for (const stop of all) {
    if (!section || section.date !== stop.date) {
      section = { date: stop.date, points: [] };
      sections.push(section);
    }
    const span = { startMs: stop.startMs, endMs: stop.endMs };
    const node = createElement('li', { class: 'tl-stop' }, [
      createElement('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
      createElement('p', { class: 'tl-time', text: clockText(stop.start) }),
      createElement('ul', { class: 'tl-items' }, stop.items.map((item) => timelineItem(item, span))),
    ]);
    stops.push({ node, startMs: stop.startMs, spans: [span] });
    section.points.push(node);
  }
  box.replaceChildren(createElement('div', { class: 'tt-timeline' }, sections.map((each) => createElement('section', { class: 'tl-day' }, [
    createElement('h3', { class: 'tt-day-title', text: dayText(each.date, true) }),
    createElement('ol', { class: 'tl-line' }, each.points),
  ]))));
}

// ---------------------------------------------------------------------------
// List: a timetable's other layout, for a visitor who switches to it (or a
// phone, to start with). Every item in time order, day by day: its times on
// the left, then what it is, its room and its note.
// ---------------------------------------------------------------------------

function renderList(box, timetable) {
  const sections = [];
  for (const [date, items] of groupByDay(timetable.items)) {
    const entries = items.map((item) => {
      const what = [
        createElement('div', { class: 'tt-entry-head' }, [createElement('h4', { class: 'tt-entry-title', text: item.title }), ...marks()]),
      ];
      const room = roomLabel(timetable, item);
      if (room) {
        what.push(room);
      }
      if (item.note) {
        what.push(createElement('p', { class: 'tt-note', text: item.note }));
      }
      const node = createElement('li', { class: `tt-entry ${colourClass(item)}` }, [
        createElement('p', { class: 'tt-entry-time', text: itemTimeText(item) }),
        createElement('div', { class: 'tt-entry-what' }, what),
      ]);
      tracked.push({ node, ...itemSpan(item) });
      return node;
    });
    sections.push(createElement('section', { class: 'tt-day' }, [
      createElement('h3', { class: 'tt-day-title', text: dayText(date, true) }),
      createElement('ol', { class: 'tt-list' }, entries),
    ]));
  }
  box.replaceChildren(createElement('div', { class: 'tt-timeline' }, sections));
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

// Places items sharing a column side by side where they overlap: each gets
// its lane and how many lanes its run of overlapping items needs.
function assignLanes(items) {
  const placed = items
    .map((item) => ({ item, ...itemMinutes(item), lane: 0, lanes: 1 }))
    .sort((first, second) => {
      if (first.start !== second.start) {
        return first.start - second.start;
      }
      return first.end - second.end;
    });
  let run = [];
  let laneEnds = [];
  let runEnd = -1;
  const closeRun = () => {
    for (const each of run) {
      each.lanes = laneEnds.length;
    }
    run = [];
    laneEnds = [];
  };
  for (const each of placed) {
    if (each.start >= runEnd) {
      closeRun();
    }
    let lane = laneEnds.findIndex((end) => end <= each.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(each.end);
    } else {
      laneEnds[lane] = each.end;
    }
    each.lane = lane;
    run.push(each);
    runEnd = Math.max(runEnd, each.end);
  }
  closeRun();
  return placed;
}

// Sets a number custom property (CSS draws with it; no inline style text).
function setNumber(node, name, value) {
  node.style.setProperty(name, String(value));
}

// One day as a grid: a header with each room used that day (and "Everywhere
// else" for items in none, when there are rooms), the half hours down the
// side, the blocks, and the now line.
function renderGridDay(box, timetable, items) {
  const used = [...new Set(items.map((item) => item.room))]
    .filter((room) => room !== null)
    .sort((first, second) => first - second);
  const columns = used.map((room) => ({ room, items: items.filter((item) => item.room === room) }));
  const unplaced = items.filter((item) => item.room === null);
  if (unplaced.length) {
    columns.push({ room: null, items: unplaced });
  }
  const showHeader = timetable.rooms.length > 0;

  const minutes = items.map(itemMinutes);
  const first = Math.floor(Math.min(...minutes.map((each) => each.start)) / 60) * 60;
  const last = Math.ceil(Math.max(...minutes.map((each) => each.end)) / 60) * 60;
  const span = Math.max(60, last - first);

  const grid = createElement('div', { class: 'tt-grid' });
  setNumber(grid, '--tt-cols', columns.length);
  setNumber(grid, '--tt-span', span);
  if (!showHeader) {
    grid.classList.add('no-header');
  }

  if (showHeader) {
    grid.append(createElement('div', { class: 'tt-corner', text: translate('event.timetable-time') }));
    for (const column of columns) {
      let head;
      if (column.room === null) {
        head = createElement('div', { class: 'tt-head tt-cx' }, [createElement('span', { class: 'tt-head-name', text: translate('event.timetable-general') })]);
      } else {
        const room = timetable.rooms[column.room];
        const parts = [];
        if (room.tag) {
          parts.push(createElement('span', { class: 'tt-head-tag', text: room.tag }));
        }
        parts.push(createElement('span', { class: 'tt-head-name', text: room.name }));
        head = createElement('div', { class: `tt-head tt-c${column.room % ROOM_COLOURS}` }, parts);
      }
      grid.append(head);
    }
  }

  // The half hours down the side, on the hour and the half hour.
  const times = createElement('div', { class: 'tt-times', 'aria-hidden': 'true' });
  for (let minute = first; minute < first + span; minute += 30) {
    const wall = minute % DAY_MINUTES;
    const label = `${String(Math.floor(wall / 60)).padStart(2, '0')}:${String(wall % 60).padStart(2, '0')}`;
    const mark = createElement('span', { class: 'tt-time', text: clockText(label) });
    setNumber(mark, '--tt-at', minute - first);
    times.append(mark);
  }
  grid.append(times);

  for (const column of columns) {
    let label = translate('event.timetable-general');
    if (column.room !== null) {
      label = timetable.rooms[column.room].name;
    }
    const blocks = assignLanes(column.items).map((each) => {
      const item = each.item;
      const children = [
        createElement('span', { class: 'tt-block-title', text: item.title }),
        createElement('span', { class: 'tt-block-time', text: itemTimeText(item) }),
      ];
      if (item.note) {
        children.push(createElement('span', { class: 'tt-block-note', text: item.note }));
      }
      children.push(...marks());
      let hover = `${item.title}\n${itemTimeText(item)}`;
      if (item.note) {
        hover = `${hover}\n${item.note}`;
      }
      const node = createElement('li', { class: `tt-block ${colourClass(item)}`, title: hover }, children);
      setNumber(node, '--tt-top', each.start - first);
      setNumber(node, '--tt-length', each.end - each.start);
      setNumber(node, '--tt-lane', each.lane);
      setNumber(node, '--tt-lanes', each.lanes);
      if (each.end - each.start < 45) {
        node.classList.add('is-short');
      }
      tracked.push({ node, ...itemSpan(item) });
      return node;
    });
    grid.append(createElement('ul', { class: 'tt-col', 'aria-label': label }, blocks));
  }

  nowLine = { node: createElement('div', { class: 'tt-now-line', hidden: true }, [createElement('span', { class: 'tt-now-label' })]), first, span };
  grid.append(nowLine.node);

  box.replaceChildren(createElement('div', { class: 'tt-grid-scroll' }, [grid]));
}

// The day the grid opens on: today in the event's zone when the timetable
// has it (or yesterday, while something from it runs past midnight),
// otherwise the first day.
function startingDay(days, timeZone) {
  const today = wallNow(Date.now(), timeZone);
  if (days.has(today.date)) {
    return today.date;
  }
  for (const [date, items] of days) {
    const stillRunning = items.some((item) => {
      if (!item.endsNextDay) {
        return false;
      }
      return Date.parse(item.endsAt) > Date.now();
    });
    if (nextDate(date) === today.date && stillRunning) {
      return date;
    }
  }
  return days.keys().next().value;
}

function renderGrid(box, dayBar, timetable, timeZone) {
  const days = groupByDay(timetable.items);
  if (!days.has(shownDay)) {
    shownDay = startingDay(days, timeZone);
  }
  const body = createElement('div');
  const buttons = [...days.keys()].map((date) => createElement('button', {
    class: 'tt-day-btn',
    type: 'button',
    'data-date': date,
    'aria-pressed': String(date === shownDay),
    text: dayText(date),
    onclick: () => {
      shownDay = date;
      for (const button of dayBar.children) {
        button.setAttribute('aria-pressed', String(button.dataset.date === date));
      }
      tracked = [];
      renderGridDay(body, timetable, days.get(date));
      tick(timeZone);
    },
  }));
  dayBar.replaceChildren(...buttons);
  dayBar.hidden = days.size < 2;
  renderGridDay(body, timetable, days.get(shownDay));
  box.replaceChildren(body);
}

// ---------------------------------------------------------------------------
// Now
// ---------------------------------------------------------------------------

// Marks what is on now, what is over and what is next, and moves the grid's
// now line.
function tick(timeZone) {
  const now = Date.now();
  const begun = tracked.some((each) => each.startMs <= now);
  let nextStart = Infinity;
  if (begun) {
    for (const each of tracked) {
      if (each.startMs > now && each.startMs < nextStart) {
        nextStart = each.startMs;
      }
    }
  }
  for (const each of tracked) {
    let on = false;
    if (each.startMs <= now && now < each.endMs) {
      on = true;
    }
    each.node.classList.toggle('is-now', on);
    each.node.classList.toggle('is-past', each.endMs <= now);
    each.node.querySelector('.tt-mark-now').hidden = !on;
    each.node.querySelector('.tt-mark-next').hidden = each.startMs !== nextStart;
  }
  // A dot is reached once its time has come (the line is drawn in up to
  // it), and on while something that started at it is on.
  for (const stop of stops) {
    const on = stop.spans.some((span) => {
      if (span.startMs > now) {
        return false;
      }
      return now < span.endMs;
    });
    stop.node.classList.toggle('is-reached', stop.startMs <= now);
    stop.node.classList.toggle('is-now', on);
  }
  if (!nowLine || !shownDay) {
    return;
  }
  const wall = wallNow(now, timeZone);
  let minute = null;
  if (wall.date === shownDay) {
    minute = wall.minutes;
  } else if (wall.date === nextDate(shownDay)) {
    minute = wall.minutes + DAY_MINUTES;
  }
  let inside = false;
  if (minute !== null && minute >= nowLine.first && minute <= nowLine.first + nowLine.span) {
    inside = true;
  }
  nowLine.node.hidden = !inside;
  if (inside) {
    setNumber(nowLine.node, '--tt-at', minute - nowLine.first);
    const time = `${String(Math.floor(wall.minutes / 60)).padStart(2, '0')}:${String(wall.minutes % 60).padStart(2, '0')}`;
    nowLine.node.querySelector('.tt-now-label').textContent = translate('event.timetable-now-line', { time: clockText(time) });
  }
}

// When the grid opens on a day that is under way, it starts scrolled to the
// now line (a little above it), not at the day's first hour.
function scrollToNow() {
  if (!nowLine || nowLine.node.hidden) {
    return;
  }
  const scroller = nowLine.node.closest('.tt-grid-scroll');
  const header = scroller.querySelector('.tt-corner');
  let headerHeight = 0;
  if (header) {
    headerHeight = header.offsetHeight;
  }
  scroller.scrollTop = Math.max(0, nowLine.node.offsetTop - headerHeight - 48);
}

// A timetable's layout, as this visitor last picked it with the Table / List
// switch, kept in this browser only: "table" or "list". Before any pick, a
// phone starts with the list (a grid of many rooms is a lot to scroll on a
// small screen) and anything wider with the table.
const LAYOUT_KEY = 'helloevents.timetableLayout';
const LAYOUTS = ['table', 'list'];
const NARROW = '(max-width: 640px)';

function chosenLayout() {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (LAYOUTS.includes(saved)) {
      return saved;
    }
  } catch {
    // No storage (a private window): the default below.
  }
  if (window.matchMedia(NARROW).matches) {
    return 'list';
  }
  return 'table';
}

function rememberLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Not kept; the switch still works on this page.
  }
}

// The last timetable drawn, so the switch can redraw it.
let current = null;

// Draws a timetable (the editor's "grid" view) as a table or a list, and
// marks the switch.
function drawTimetableLayout(box, dayBar, timetable, timeZone) {
  const layout = chosenLayout();
  for (const button of document.getElementById('timetableLayout').querySelectorAll('[data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
  }
  if (layout === 'table') {
    renderGrid(box, dayBar, timetable, timeZone);
  } else {
    dayBar.hidden = true;
    renderList(box, timetable);
  }
}

// Wires the Table / List switch once.
let switchWired = false;
function wireLayoutSwitch() {
  if (switchWired) {
    return;
  }
  switchWired = true;
  document.getElementById('timetableLayout').addEventListener('click', (event) => {
    const button = event.target.closest('[data-layout]');
    if (!button || !current || button.getAttribute('aria-pressed') === 'true') {
      return;
    }
    rememberLayout(button.dataset.layout);
    renderTimetable(current.timetable, current.timeZone);
    button.focus();
  });
}

// Draws the timetable into the event page's section (or hides the section
// when there is none), and keeps "now" up to date while the page is open.
// timetable: the event's timetable as the server sends it, or null.
export function renderTimetable(timetable, timeZone) {
  const section = document.getElementById('timetableBox');
  const box = document.getElementById('timetableBody');
  const dayBar = document.getElementById('timetableDays');
  tracked = [];
  stops = [];
  nowLine = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  section.hidden = !timetable;
  if (!timetable) {
    box.replaceChildren();
    dayBar.hidden = true;
    return;
  }
  document.getElementById('timetableZone').textContent = translate('event.timetable-zone', { zone: zoneName(timeZone) });
  current = { timetable, timeZone };
  const isTimetable = timetable.view === 'grid';
  // A timeline is an itinerary (a list of steps), and is called that, so it
  // is not taken for a timetable of rooms.
  const title = document.getElementById('timetableTitle');
  if (isTimetable) {
    title.setAttribute('data-i18n', 'event.timetable');
    title.textContent = translate('event.timetable');
  } else {
    title.setAttribute('data-i18n', 'event.itinerary');
    title.textContent = translate('event.itinerary');
  }
  section.classList.toggle('is-grid', isTimetable);
  // Only a timetable has the Table / List switch; a timeline is always the
  // line with its dots.
  document.getElementById('timetableLayout').hidden = !isTimetable;
  if (isTimetable) {
    wireLayoutSwitch();
    drawTimetableLayout(box, dayBar, timetable, timeZone);
  } else {
    dayBar.hidden = true;
    renderTimeline(box, timetable);
  }
  tick(timeZone);
  scrollToNow();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      tick(timeZone);
    }
  }, TICK_MS);
}
