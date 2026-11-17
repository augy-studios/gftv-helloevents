// The English / 中文 switcher over an event's two descriptions: a group of
// buttons, each with data-lang and aria-pressed, that shows one language at
// a time. The edit form switches between the two text boxes it needs filled
// in; the event page between the two descriptions, starting with the
// reader's choice from last time, or Chinese for a browser set to Chinese.

const STORAGE_KEY = 'gftv-helloevents-description-lang';

// group: the element holding the buttons. onSelect(lang) shows that
// language. Returns { select(lang), buttons }.
export function startLangSwitch(group, onSelect) {
  const buttons = [...group.querySelectorAll('[data-lang]')];

  function select(lang) {
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
    }
    onSelect(lang);
  }

  group.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (button) {
      select(button.dataset.lang);
    }
  });
  return { select, buttons };
}

// The language a reader last picked on an event page, else Chinese for a
// browser set to Chinese, else English.
export function preferredDescriptionLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') {
      return saved;
    }
  } catch {
    // Storage blocked: fall back on the browser's languages.
  }
  let languages = [];
  if (Array.isArray(navigator.languages)) {
    languages = navigator.languages;
  }
  if (languages.some((language) => language.toLowerCase().startsWith('zh'))) {
    return 'zh';
  }
  return 'en';
}

// Remembers the reader's pick for the next event page.
export function rememberDescriptionLang(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Storage blocked: the pick lasts for this page only.
  }
}
