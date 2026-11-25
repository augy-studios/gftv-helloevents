// assets/i18n/locales.js
// Every locale file, imported statically so switching needs no request.
// Adding a language: one import, one entry in `locales`, one in `registry`,
// then add the file to the service worker precache and bump its version
// (i18n-retrofit-spec.md section 13).
import en from './en.json' with { type: 'json' };
import zhSG from './zh-SG.json' with { type: 'json' };
import ms from './ms.json' with { type: 'json' };
import ta from './ta.json' with { type: 'json' };

export const locales = { en, 'zh-SG': zhSG, ms, ta };

export const registry = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'zh-SG', name: '中文（新加坡）', dir: 'ltr' },
  { code: 'ms', name: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'ta', name: 'தமிழ்', dir: 'ltr' },
];