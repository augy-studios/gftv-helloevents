// The pick-lists on the edit form (time zones, countries, currencies) and
// the country names the public pages show. Names come from the browser's own
// Intl data, in the reader's language, so nothing is fetched and the lists
// are as complete as the browser is.
//
// The currency field works like the currency converter's
// (currency-converter/main-site/script.js): a search box with a list of
// "SGD — Singapore Dollar" suggestions, read back by its three-letter code.

import { t as translate, getLocale } from '../assets/i18n/i18n.js';
import { createElement } from './ui.js';

// Pinned to the top of their lists, in this order.
export const PINNED_COUNTRIES = ['SG', 'MY', 'ID'];
export const PINNED_CURRENCIES = ['SGD', 'MYR', 'IDR'];
const PINNED_TIME_ZONES = ['Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];

// ISO 3166-1 alpha-2: every country and territory. Intl can name a region
// but cannot list them, so the codes are here.
const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /\b([A-Z]{3})\b/;

// Intl.DisplayNames for one kind of name in the reader's language, or null
// where the browser has none.
function displayNames(type) {
  try {
    return new Intl.DisplayNames([getLocale(), 'en'], { type, fallback: 'code' });
  } catch {
    return null;
  }
}

function sortByName(entries) {
  const collator = new Intl.Collator(getLocale());
  return entries.sort((first, second) => collator.compare(first.name, second.name));
}

// A divider between the pinned entries and the rest of a list.
function divider() {
  return createElement('option', { disabled: true, text: '──────────' });
}

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

// A country's name from its code ("SG" -> "Singapore"). Anything that is not
// a code (a country typed before the list existed) is shown as it is.
export function countryName(value) {
  if (!value) {
    return '';
  }
  if (!COUNTRY_CODE.test(value)) {
    return value;
  }
  const names = displayNames('region');
  if (!names) {
    return value;
  }
  return names.of(value);
}

// The code for a country typed by name before the list existed ("Singapore"
// -> "SG"), matched in English or the reader's language; '' when none.
function countryCodeFor(name) {
  const wanted = name.trim().toLowerCase();
  const lists = [displayNames('region')];
  try {
    lists.push(new Intl.DisplayNames(['en'], { type: 'region' }));
  } catch {
    // English names are a bonus; the reader's own are enough.
  }
  for (const names of lists.filter(Boolean)) {
    const match = COUNTRY_CODES.find((code) => names.of(code).toLowerCase() === wanted);
    if (match) {
      return match;
    }
  }
  return '';
}

// Fills a country <select>: a blank choice, Singapore, Malaysia and
// Indonesia, then every other country by name. A value typed before the list
// existed is matched to its country, or kept as its own choice so saving
// never loses it. Returns the value the select was set to.
export function fillCountrySelect(select, current) {
  const names = displayNames('region');
  const nameOf = (code) => {
    if (names) {
      return names.of(code);
    }
    return code;
  };
  const rest = sortByName(
    COUNTRY_CODES.filter((code) => !PINNED_COUNTRIES.includes(code)).map((code) => ({ code, name: nameOf(code) }))
  );
  const options = [createElement('option', { value: '', text: translate('manage.country-choose') })];
  let value = '';
  if (current) {
    value = current;
  }
  if (value && !COUNTRY_CODES.includes(value)) {
    const code = countryCodeFor(value);
    if (code) {
      value = code;
    } else {
      options.push(createElement('option', { value, text: value }));
    }
  }
  options.push(...PINNED_COUNTRIES.map((code) => createElement('option', { value: code, text: nameOf(code) })));
  options.push(divider());
  options.push(...rest.map((entry) => createElement('option', { value: entry.code, text: entry.name })));
  select.replaceChildren(...options);
  select.value = value;
  return value;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

// Every zone the browser knows, plus UTC (some leave it out of the list).
function allTimeZones() {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [...PINNED_TIME_ZONES];
  }
  if (!zones.includes('UTC')) {
    zones = [...zones, 'UTC'];
  }
  return zones;
}

// "GMT+8" for a zone, now; '' if the browser cannot say.
function offsetOf(timeZone, now) {
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(now);
    const zonePart = parts.find((part) => part.type === 'timeZoneName');
    if (zonePart) {
      return zonePart.value;
    }
  } catch {
    // An unknown zone has no offset to show.
  }
  return '';
}

// "Asia/Kuala Lumpur (GMT+8)".
function timeZoneLabel(timeZone, now) {
  const offset = offsetOf(timeZone, now);
  const name = timeZone.replace(/_/g, ' ');
  if (offset) {
    return `${name} (${offset})`;
  }
  return name;
}

// Fills a time zone <select>: the zones of Singapore, Malaysia and
// Indonesia first, then every zone grouped by region (Africa, America, Asia,
// ...). A saved zone the browser does not list is kept as a choice.
export function fillTimeZoneSelect(select, current) {
  const now = new Date();
  const zones = allTimeZones();
  const option = (zone) => createElement('option', { value: zone, text: timeZoneLabel(zone, now) });
  const groups = new Map();
  for (const zone of zones) {
    let region = 'Other';
    if (zone.includes('/')) {
      region = zone.split('/')[0];
    }
    if (!groups.has(region)) {
      groups.set(region, []);
    }
    groups.get(region).push(zone);
  }
  const children = [];
  if (current && !zones.includes(current)) {
    children.push(option(current));
  }
  children.push(createElement('optgroup', { label: translate('manage.timezone-common') }, PINNED_TIME_ZONES.map(option)));
  for (const [region, regionZones] of [...groups.entries()].sort()) {
    children.push(createElement('optgroup', { label: region }, regionZones.sort().map(option)));
  }
  select.replaceChildren(...children);
  if (current) {
    select.value = current;
  }
}

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

// Every currency code the browser knows, pinned ones first.
function currencyCodes() {
  let codes = [];
  try {
    codes = Intl.supportedValuesOf('currency');
  } catch {
    codes = [...PINNED_CURRENCIES];
  }
  return [...PINNED_CURRENCIES, ...codes.filter((code) => !PINNED_CURRENCIES.includes(code))];
}

// "SGD — Singapore Dollar", as the search box shows a currency.
export function currencyLabel(code) {
  if (!code) {
    return '';
  }
  const names = displayNames('currency');
  if (!names) {
    return code;
  }
  const name = names.of(code);
  if (!name || name === code) {
    return code;
  }
  return `${code} — ${name}`;
}

// Fills the currency suggestions (a <datalist>): Singapore dollar, ringgit
// and rupiah first, then the rest by code.
export function fillCurrencyList(datalist) {
  datalist.replaceChildren(...currencyCodes().map((code) => createElement('option', { value: currencyLabel(code) })));
}

// The three-letter code in what was typed or picked ("SGD — Singapore
// Dollar", "sgd", "Singapore Dollar" are all "SGD"); otherwise what was
// typed, so the server can name the field.
export function currencyCodeFrom(text) {
  const typed = String(text).trim();
  if (typed === '') {
    return '';
  }
  const coded = typed.match(CURRENCY_CODE);
  if (coded) {
    return coded[1];
  }
  const wanted = typed.toLowerCase();
  const names = displayNames('currency');
  const match = currencyCodes().find((code) => {
    if (code.toLowerCase() === wanted) {
      return true;
    }
    if (names && names.of(code).toLowerCase() === wanted) {
      return true;
    }
    return false;
  });
  if (match) {
    return match;
  }
  return typed.toUpperCase();
}
