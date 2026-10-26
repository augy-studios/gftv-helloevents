// assets/i18n/locales.js
// Every locale file, imported statically so switching needs no request.
// Adding a language: one import, one entry in `locales`, one in `registry`,
// then add the file to the service worker precache and bump its version
// (i18n-retrofit-spec.md section 13).
import en from './en.json' with { type: 'json' };

export const locales = { en };

export const registry = [
  { code: 'en', name: 'English', dir: 'ltr' },
];
