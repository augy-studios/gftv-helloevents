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

import { db, T } from './supabase.js';

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

function foldWith(text, ambiguous) {
  const base = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  let out = '';
  for (const ch of base) {
    const mapped = ambiguous[ch] ?? LOOKALIKE[ch] ?? ch;
    if (/^[a-z0-9]$/.test(mapped)) out += mapped;
  }
  return out;
}

// Every folded reading of a name.
export function foldings(text) {
  return [...new Set(AMBIGUOUS.map((a) => foldWith(text, a)))];
}

// The canonical folded form, for storing an admin's word.
export function fold(text) {
  return foldWith(text, AMBIGUOUS[0]);
}

function words(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}@$|!+€£]+/u)
    .filter(Boolean)
    .flatMap((w) => foldings(w));
}

// The first listed word a name contains, or null. custom: folded terms.
export function blockedTerm(name, custom = []) {
  const whole = foldings(name);
  for (const term of [...BUILT_IN.anywhere, ...custom]) {
    if (term.length >= 3 && whole.some((f) => f.includes(term))) return term;
  }
  const tokens = new Set(words(name));
  for (const term of BUILT_IN.wholeWord) if (tokens.has(term)) return term;
  return null;
}

export const BUILT_IN_TERMS = [...BUILT_IN.anywhere, ...BUILT_IN.wholeWord];

// ---------------------------------------------------------------------------
// The admins' list, cached per function instance for a minute.
// ---------------------------------------------------------------------------

let cache = { at: 0, terms: [] };

export function forgetNameFilters() {
  cache = { at: 0, terms: [] };
}

export async function customTerms() {
  if (Date.now() - cache.at < 60_000) return cache.terms;
  const { data, error } = await db().from(T.nameFilters).select('term').limit(2000);
  if (error) {
    // A missing table (003 not run yet) or a hiccup: the built-in list still
    // applies.
    console.error('[helloevents] name filters:', error.message);
    return cache.terms;
  }
  cache = { at: Date.now(), terms: (data ?? []).map((r) => r.term) };
  return cache.terms;
}

// The word a public username or display name may not use, or null.
export async function refusedName(name) {
  return blockedTerm(name, await customTerms());
}
