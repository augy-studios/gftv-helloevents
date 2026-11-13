// Names a public account may not use, as a username or a display name, so
// nobody looks like GFTV staff or an official account (help desk #7,
// round 4). Staff names come from gftv.asia and are never checked.
//
// A name is "folded" before it is compared: lowercased, accents dropped,
// common look-alike letters from Cyrillic and Greek mapped to Latin, digits
// and symbols used as letters (leetspeak) mapped back, and everything that
// is not a letter or a digit removed, so "S.T.A.F.F", "5taff", "Ѕtaff" (with
// a Cyrillic S) and "s t a f f" all fold to "staff". "1" and "|" can stand
// for i or l, so both readings are tried.
//
// Two lists are checked: the built-in one below, and the words admins add in
// /manage (gftvevents_name_filters, migrations/003), cached for a minute.
// Built-in words of five letters or more, and every admin word, match
// anywhere in the folded name; the short built-in ones ("mod", "mods") only
// match a whole word, so "Modesty" is fine.
//
// Pure functions first, so tests/unit.test.js runs them directly.

import { database, TABLES } from './supabase.js';

const LOOKALIKE = {
  // Cyrillic
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', ё: 'e', һ: 'h', і: 'i', ї: 'i', ј: 'j', к: 'k', ӏ: 'l', м: 'm', н: 'h',
  о: 'o', р: 'p', ԛ: 'q', ѕ: 's', т: 't', у: 'y', х: 'x', ԝ: 'w', ь: 'b', г: 'r', п: 'n',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ω: 'w',
  // Leetspeak and symbols
  0: 'o', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '€': 'e', '£': 'l', '+': 't', '!': 'i',
};

// The two readings of the ambiguous ones.
const AMBIGUOUS = [{ 1: 'i', '|': 'i' }, { 1: 'l', '|': 'l' }];

const BUILT_IN = Object.freeze({
  anywhere: ['staff', 'official', 'admin', 'gftv', 'globalfurry', 'moderator', 'helloevents', 'sysop'],
  wholeWord: ['mod', 'mods', 'gm', 'dev'],
});

// The value as a string, with null and undefined read as ''.
function stringOrEmpty(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

// The letter one character stands for: its reading in ambiguous first, then
// the look-alike table, otherwise the character itself.
function letterFor(character, ambiguous) {
  const ambiguousReading = ambiguous[character];
  if (ambiguousReading !== null && ambiguousReading !== undefined) {
    return ambiguousReading;
  }
  const lookalike = LOOKALIKE[character];
  if (lookalike !== null && lookalike !== undefined) {
    return lookalike;
  }
  return character;
}

// One folded reading of text: lowercased, accents dropped, every character
// mapped to the letter it stands for, and anything that is not then a plain
// letter or digit left out.
function foldWith(text, ambiguous) {
  const base = stringOrEmpty(text)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  let folded = '';
  for (const character of base) {
    const letter = letterFor(character, ambiguous);
    if (/^[a-z0-9]$/.test(letter)) {
      folded += letter;
    }
  }
  return folded;
}

// Every folded reading of a name.
export function foldings(text) {
  return [...new Set(AMBIGUOUS.map((reading) => foldWith(text, reading)))];
}

// The canonical folded form, for storing an admin's word.
export function fold(text) {
  return foldWith(text, AMBIGUOUS[0]);
}

// Every folded reading of each word in text, for the whole-word list.
function foldedWords(text) {
  return stringOrEmpty(text)
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}@$|!+€£]+/u)
    .filter(Boolean)
    .flatMap((word) => foldings(word));
}

// The first listed word a name contains, or null. adminTerms: folded terms.
export function blockedTerm(name, adminTerms = []) {
  const nameFoldings = foldings(name);
  for (const term of [...BUILT_IN.anywhere, ...adminTerms]) {
    if (term.length >= 3 && nameFoldings.some((folding) => folding.includes(term))) {
      return term;
    }
  }
  const nameWords = new Set(foldedWords(name));
  for (const term of BUILT_IN.wholeWord) {
    if (nameWords.has(term)) {
      return term;
    }
  }
  return null;
}

export const BUILT_IN_TERMS = [...BUILT_IN.anywhere, ...BUILT_IN.wholeWord];

// ---------------------------------------------------------------------------
// The admins' list, cached per function instance for a minute.
// ---------------------------------------------------------------------------

const CACHE_MILLISECONDS = 60_000;

let cache = { fetchedAt: 0, terms: [] };

export function forgetNameFilters() {
  cache = { fetchedAt: 0, terms: [] };
}

export async function customTerms() {
  if (Date.now() - cache.fetchedAt < CACHE_MILLISECONDS) {
    return cache.terms;
  }
  const { data, error } = await database().from(TABLES.nameFilters).select('term').limit(2000);
  if (error) {
    // A missing table (003 not run yet) or a hiccup: the built-in list still
    // applies.
    console.error('[helloevents] name filters:', error.message);
    return cache.terms;
  }
  let rows = [];
  if (data !== null && data !== undefined) {
    rows = data;
  }
  cache = { fetchedAt: Date.now(), terms: rows.map((row) => row.term) };
  return cache.terms;
}

// The word a public username or display name may not use, or null.
export async function refusedName(name) {
  const adminTerms = await customTerms();
  return blockedTerm(name, adminTerms);
}
