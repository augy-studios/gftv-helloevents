// The Telegram bot, the notices and the emails in the language of the
// account they go to (migrations/029, gftvevents_accounts.locale): the same
// four languages as the site (assets/i18n/locales.js). The site saves the
// language someone uses to their account (js/app.js), so the bot, their
// reminders, every other notice and their code emails follow it.
//
// The strings are in bot-text/<code>.js, en.js the source of truth, kept
// apart from the site's JSON so the pages do not carry the bot's strings and
// the functions do not carry the pages'. The lookup is the site runtime's
// (assets/i18n/i18n.js): {placeholders}, plurals by CLDR category with
// .other as the fallback, then English, then the key itself.

import en from './bot-text/en.js';
import zhSG from './bot-text/zh-SG.js';
import ms from './bot-text/ms.js';
import ta from './bot-text/ta.js';

export const DEFAULT_LOCALE = 'en';

const TABLES = { en, 'zh-SG': zhSG, ms, ta };

// The site's codes, in the site's order.
export const BOT_LOCALES = Object.keys(TABLES);

// The tag Intl formats dates, times and country names with: each language
// as written in Singapore ("Fri, 6 Aug 2032", "2032年8月6日周五").
const INTL_TAGS = { en: 'en-SG', 'zh-SG': 'zh-SG', ms: 'ms-SG', ta: 'ta-SG' };

// One of BOT_LOCALES, matched without regard to case ("zh-sg"), or null.
export function knownLocale(code) {
  if (typeof code !== 'string') {
    return null;
  }
  const lower = code.toLowerCase();
  const match = BOT_LOCALES.find((each) => each.toLowerCase() === lower);
  if (match) {
    return match;
  }
  return null;
}

// The language to write in: the code when it is one of BOT_LOCALES,
// English otherwise (an account that never picked one).
export function botLocale(code) {
  const known = knownLocale(code);
  if (known) {
    return known;
  }
  return DEFAULT_LOCALE;
}

// The language of a chat with no account linked, from its Telegram app's
// language (message.from.language_code, an IETF tag such as "zh-hans" or
// "ms"): Chinese of any kind is zh-SG; anything not offered is English.
export function localeFromTelegram(languageCode) {
  if (typeof languageCode !== 'string' || languageCode === '') {
    return DEFAULT_LOCALE;
  }
  const exact = knownLocale(languageCode);
  if (exact) {
    return exact;
  }
  const base = languageCode.split(/[-_]/)[0].toLowerCase();
  if (base === 'zh') {
    return 'zh-SG';
  }
  return botLocale(base);
}

export function intlTag(locale) {
  return INTL_TAGS[botLocale(locale)];
}

function lookup(locale, key) {
  const table = TABLES[locale];
  if (table && Object.prototype.hasOwnProperty.call(table, key)) {
    return table[key];
  }
  return undefined;
}

function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    if (params && name in params) {
      return String(params[name]);
    }
    return whole;
  });
}

// The string for key in locale, with params filled in. A params.count picks
// the plural form.
export function botT(locale, key, params) {
  const code = botLocale(locale);
  let chosen = key;
  if (params && typeof params.count === 'number') {
    const category = new Intl.PluralRules(intlTag(code)).select(params.count);
    if (lookup(code, `${key}.${category}`) !== undefined) {
      chosen = `${key}.${category}`;
    } else {
      chosen = `${key}.other`;
    }
  }
  let text = lookup(code, chosen);
  if (text === undefined) {
    text = lookup(DEFAULT_LOCALE, chosen);
  }
  if (text === undefined) {
    return key;
  }
  return interpolate(text, params);
}

// botT with the locale fixed: const t = translator('ms'); t('notice.new').
export function translator(locale) {
  const code = botLocale(locale);
  return (key, params) => botT(code, key, params);
}

// A list of names in one line ("Lunch, Dinner"; "午餐、晚餐").
export function joinList(locale, items) {
  return items.join(botT(locale, 'list.separator'));
}

// For tests/bot-text.test.js: every language's strings.
export function allTables() {
  return TABLES;
}
