// The description editor's toolbar icons (rich-editor.js), drawn like the
// site's own (js/icons.js): 24 by 24, a 2-pixel line, round ends. A button
// asks for one with data-rich-icon="<name>".

const PATHS = {
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M19 4h-9M14 20H5M15 4L9 20',
  underline: 'M6 4v6a6 6 0 0 0 12 0V4M4 21h16',
  strike: 'M16.5 6.5C15.8 4.6 14.1 3.5 12 3.5c-2.7 0-4.5 1.6-4.5 3.8 0 1.4.8 2.4 2.2 3.1M4 12h16M7.5 17.5c.7 1.9 2.5 3 4.7 3 2.8 0 4.8-1.6 4.8-4 0-1-.4-1.9-1-2.5',
  subscript: 'M4 5l8 10M12 5l-8 10M16 15.5c.3-1 1.1-1.5 2-1.5 1.1 0 2 .7 2 1.7 0 2-4 2.3-4 4.3h4',
  superscript: 'M4 9l8 10M12 9l-8 10M16 5.5c.3-1 1.1-1.5 2-1.5 1.1 0 2 .7 2 1.7 0 2-4 2.3-4 4.3h4',
  colour: 'M6 16L12 3l6 13M8.5 11h7',
  highlight: 'M9 11l-5 5v3h8l2-2M20 11l-4.5 4.5a2 2 0 0 1-2.8 0l-4.2-4.2a2 2 0 0 1 0-2.8L13 4',
  clear: 'M4 7V4h16v3M10 4L7 20M5 20h5M14 14l6 6M20 14l-6 6',
  'align-left': 'M3 6h18M3 10h12M3 14h18M3 18h12',
  'align-center': 'M3 6h18M6 10h12M3 14h18M6 18h12',
  'align-right': 'M3 6h18M9 10h12M3 14h18M9 18h12',
  'align-justify': 'M3 6h18M3 10h18M3 14h18M3 18h18',
  bullets: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  numbers: 'M10 6h11M10 12h11M10 18h11M4 4h1v4M4 14h2l-2 3h2M3.5 8h2.5',
  outdent: 'M21 6H11M21 12H11M21 18H11M7 8l-4 4 4 4',
  indent: 'M21 6H11M21 12H11M21 18H11M3 8l4 4-4 4',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  unlink: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7M3 3l18 18',
  picture: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  hr: 'M3 12h18M8 6h8M8 18h8',
  emoji: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
};

export function hydrateRichIcons(root) {
  for (const holder of root.querySelectorAll('[data-rich-icon]')) {
    const path = PATHS[holder.getAttribute('data-rich-icon')];
    if (!path) {
      continue;
    }
    holder.classList.add('icon');
    holder.setAttribute('aria-hidden', 'true');
    holder.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  }
}
