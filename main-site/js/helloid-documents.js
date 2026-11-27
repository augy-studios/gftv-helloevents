// The documents HelloID takes, by issuing country (migrations/027), shared
// by the HelloID page (js/pages/helloid.js) and the server
// (api/me/helloid.js), which checks the pick is one of these.
//
// Each type says which sides to photograph and where a machine-readable
// zone (the lines of <<< that HelloID reads the name, date of birth and
// document number from) can be: a passport's on its photo page, many ID
// cards' and residence cards' on the back. A document without one is still
// taken; its name and date of birth are then typed by the person and the
// check goes to GFTV's admins.

export const DOCUMENT_TYPES = Object.freeze({
  passport: { icon: 'book', sides: ['front'], mrz: 'front' },
  national_id: { icon: 'id', sides: ['front', 'back'], mrz: 'back' },
  driving_licence: { icon: 'car', sides: ['front', 'back'], mrz: null },
  residence_permit: { icon: 'home', sides: ['front', 'back'], mrz: 'back' },
  passport_card: { icon: 'id', sides: ['front', 'back'], mrz: 'back' },
  state_id: { icon: 'id', sides: ['front', 'back'], mrz: null },
  work_pass: { icon: 'briefcase', sides: ['front', 'back'], mrz: null },
  health_insurance: { icon: 'heart', sides: ['front'], mrz: null },
  tax_card: { icon: 'file', sides: ['front'], mrz: null },
  social_security: { icon: 'shield', sides: ['front'], mrz: null },
});

// What most countries issue, in the order shown.
const USUAL = ['national_id', 'passport', 'driving_licence', 'residence_permit'];

// Countries whose documents differ from the usual list. Singapore's NRIC,
// Malaysia's MyKad and Indonesia's KTP have no machine-readable zone.
const BY_COUNTRY = Object.freeze({
  SG: [
    { type: 'national_id', mrz: null },
    { type: 'passport' },
    { type: 'driving_licence' },
    { type: 'work_pass' },
  ],
  MY: [
    { type: 'national_id', mrz: null },
    { type: 'passport' },
    { type: 'driving_licence' },
    { type: 'residence_permit' },
  ],
  ID: [
    { type: 'national_id', mrz: null },
    { type: 'passport' },
    { type: 'driving_licence' },
    { type: 'residence_permit' },
    { type: 'health_insurance' },
    { type: 'tax_card' },
    { type: 'social_security' },
  ],
  US: [
    { type: 'passport' },
    { type: 'passport_card' },
    { type: 'driving_licence' },
    { type: 'state_id' },
    { type: 'residence_permit' },
  ],
});

// The documents a country issues: [{ type, icon, sides, mrz }]. country: a
// two-letter code; anything unknown gets the usual list.
export function documentsFor(country) {
  let list = USUAL.map((type) => ({ type }));
  const code = String(country).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(BY_COUNTRY, code)) {
    list = BY_COUNTRY[code];
  }
  return list.map((entry) => ({ ...DOCUMENT_TYPES[entry.type], ...entry }));
}

// One document of a country, or null when that country has no such type.
export function documentOf(country, type) {
  const found = documentsFor(country).find((entry) => entry.type === type);
  if (!found) {
    return null;
  }
  return found;
}
