// ESLint 9 flat config: `npm run lint`.
//
// It enforces Augy's code style decisions for help desk #18 (decisions 5 and
// 7): no ternaries, braces on every if / else / for / while, names of at
// least two letters, and no `&&`, `||`, `??` or `?.` used to produce a value.
// `&&` and `||` inside an `if` condition are fine; they are conditions, not
// values. Arrow functions stay.
//
// Files are split by where they run, so each gets the right globals:
//   - js/       browser modules (js/analytics.js is a classic script)
//   - sw.js     the service worker, a classic script
//   - api/, scripts/ and the config files   Node ES modules
//
// Not linted (decision 4: only HelloEvents' own code is rewritten): the
// shared GFTV spec copies, the translations in assets/i18n/, the vendored QR
// library, and the tests.

import js from '@eslint/js';
import globals from 'globals';

// Decision 5: `&&` and `||` may not produce a value. Each selector is one
// place a value goes; a LogicalExpression anywhere else (an `if`, `while` or
// `for` condition, or inside a larger condition) is still allowed.
// `[operator!='??']` leaves `??` to its own rule below, so it is reported
// once.
const valueMessage =
  'Decision 5: `&&` / `||` used as a value is shorthand. Write an `if` / `else` block that sets the value.';
const logicalAsValue = [
  "VariableDeclarator > LogicalExpression[operator!='??'].init",
  "AssignmentExpression > LogicalExpression[operator!='??'].right",
  "ReturnStatement > LogicalExpression[operator!='??'].argument",
  "Property > LogicalExpression[operator!='??'].value",
  "ArrowFunctionExpression > LogicalExpression[operator!='??'].body",
  "CallExpression > LogicalExpression[operator!='??'].arguments",
].map((selector) => ({ selector, message: valueMessage }));

const styleRules = {
  // Decision 7 (and 5): no ternaries `a ? b : c`. Use `if` / `else`.
  'no-ternary': 'error',

  // Decision 7 (and 5): braces on every `if`, `else`, `for` and `while`.
  curly: ['error', 'all'],

  // Decision 7: no one-letter names. `id` and `to` are named as exceptions
  // in decision 7's job. Property names are not checked: field names from the
  // API, the database and outside services (SimpleWebAuthn's `rp`, web-push's
  // keys, Telegram's fields) must not be renamed, and the look-alike letter
  // table in api/_lib/name-filter.js is keyed by single letters on purpose.
  'id-length': ['error', { min: 2, exceptions: ['id', 'to'], properties: 'never' }],

  // Decision 5: the other shorthand forms.
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ChainExpression',
      message: 'Decision 5: optional chaining `?.` is shorthand. Check for null / undefined in an `if` block.',
    },
    {
      selector: "LogicalExpression[operator='??']",
      message: 'Decision 5: `??` is shorthand. Check for null / undefined in an `if` block.',
    },
    {
      selector: "AssignmentExpression[operator='??='], AssignmentExpression[operator='||='], AssignmentExpression[operator='&&=']",
      message: 'Decision 5: `??=`, `||=` and `&&=` are shorthand. Write an `if` block that assigns.',
    },
    ...logicalAsValue,
  ],
};

export default [
  {
    // Decision 4: not HelloEvents' own code, so not rewritten or linted.
    // node_modules/ is ignored by ESLint already; migrations/ sits outside
    // this folder (../migrations) and holds only SQL.
    ignores: [
      'js/theme.js',
      'js/official-bar.js',
      'js/update-bar.js',
      'js/prepaint.js',
      'js/icons.js',
      'js/codes.js',
      'js/vendor/',
      'assets/i18n/',
      'tests/',
      'migrations/',
    ],
  },

  // ESLint's recommended checks (undefined names, unreachable code and the
  // like), for every linted file.
  js.configs.recommended,

  // The code style rules, for every linted file.
  {
    rules: styleRules,
  },

  // Browser modules.
  {
    files: ['js/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  // Loaded with a plain <script> tag on the public pages.
  {
    files: ['js/analytics.js'],
    languageOptions: {
      sourceType: 'script',
    },
  },

  // The service worker, registered as a classic script.
  {
    files: ['sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },

  // The API (Vercel Node functions), scripts and config files: Node ES
  // modules ("type": "module" in package.json).
  {
    files: ['api/**/*.js', 'scripts/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // The API strips control characters (\u0000 to \u001f) out of names,
  // labels and event text on purpose, so a regular expression that matches
  // them is intended there.
  {
    files: ['api/**/*.js'],
    rules: {
      'no-control-regex': 'off',
    },
  },
];
