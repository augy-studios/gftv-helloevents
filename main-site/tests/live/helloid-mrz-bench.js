// How well HelloID reads passports' machine-readable zones (helloid.js
// readMrz), on generated passport photos: made-up people and numbers, with
// correct check digits, drawn as a photo page and then photographed badly
// (turned, from far away, blurred, dim and noisy). Slow, and needs the
// fonts it names (the MRZ's own OCR-B is not free to ship; these are
// monospace fonts most Linux systems have): not part of npm test.
//
//   node tests/live/helloid-mrz-bench.js [count] [seed]
//
// It prints, for each kind of photo, how many were read right, and over
// all of them:
//   read right   every check digit held and the number and name are right
//   WRONG        claimed checked, but the number is wrong: this one must
//                stay at 0, as a wrong number defeats the check that one
//                passport is not used on two accounts
//   ambiguous    read, but sent to the admins as unclear
// Run it before and after changing readMrz, mrz-read.js or the model.
import sharp from 'sharp';

process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
const { readMrz, namesMatch } = await import('../../api/_lib/helloid.js');
const { checkDigit } = await import('../../api/_lib/mrz-read.js');

const count = Number(process.argv[2] || 60);
let seed = Number(process.argv[3] || 7) >>> 0;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const digits = (length) => Array.from({ length }, () => Math.floor(random() * 10)).join('');
const letter = () => String.fromCharCode(65 + Math.floor(random() * 26));
const twoDigits = (low, high) => String(low + Math.floor(random() * (high - low))).padStart(2, '0');
const monthDay = () => `${String(1 + Math.floor(random() * 12)).padStart(2, '0')}${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
// G and L are read as 6 and 1 for the identity hash (id-checks.js): the
// same here.
const folded = (number) => String(number).replace(/G/g, '6').replace(/L/g, '1');

function person() {
  return {
    surname: pick(['TAN', 'LIM', 'NG', 'WONG', 'ABDULLAH', 'RAMASAMY', 'SUBRAMANIAM', 'OCONNOR', 'LEE', 'GOH', 'BIN OSMAN', 'ERIKSSON']),
    given: pick(['WEI LING', 'AHMAD', 'PRIYA', 'JUN HAO', 'SITI NUR', 'ARJUN', 'MEI', 'KAI', 'DIVYA', 'MUHAMMAD IRFAN', 'ANNA MARIA', 'QI']),
    state: pick(['SGP', 'MYS', 'IDN', 'PHL', 'THA', 'AUS', 'GBR', 'IND', 'CHN']),
    number: `${letter()}${digits(7)}${letter()}`,
    birth: `${twoDigits(60, 99)}${monthDay()}`,
    expiry: `${twoDigits(28, 36)}${monthDay()}`,
    sex: pick(['M', 'F']),
  };
}

function zoneLines(who) {
  const name = `${who.surname.replace(/ /g, '<')}<<${who.given.replace(/ /g, '<')}`;
  const first = `P<${who.state}${name}`.padEnd(44, '<').slice(0, 44);
  const documentNumber = who.number.padEnd(9, '<');
  const personal = '<'.repeat(14);
  const start = `${documentNumber}${checkDigit(documentNumber)}${who.state}${who.birth}${checkDigit(who.birth)}${who.sex}${who.expiry}${checkDigit(who.expiry)}${personal}${checkDigit(personal)}`;
  const composite = start.slice(0, 10) + start.slice(13, 20) + start.slice(21, 43);
  return [first, start + checkDigit(composite)];
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function photo(lines, who, look) {
  const width = 1250;
  const height = 880;
  const waves = Array.from({ length: 30 }, (unused, row) => `<path d="M0 ${row * 30} Q 300 ${row * 30 + 25} 625 ${row * 30} T 1250 ${row * 30}" stroke="#b9d4c9" stroke-width="2" fill="none"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#eaf2f1"/>${waves}
  <rect x="60" y="150" width="300" height="390" fill="#c8c8c8"/><circle cx="210" cy="300" r="85" fill="#9a8a7a"/>
  <text x="60" y="90" font-family="Liberation Sans" font-size="40" fill="#203060">REPUBLIC OF TESTLAND PASSPORT</text>
  <g font-family="Liberation Sans" fill="#222" font-size="30">
   <text x="420" y="200">${escape(who.surname)}</text><text x="420" y="260">${escape(who.given)}</text>
   <text x="420" y="320">${who.birth}  ${who.number}</text>
  </g>
  <g font-family="${look.font}" font-size="44" fill="#111">
   <text x="40" y="${height - 120}" textLength="1170" lengthAdjust="spacingAndGlyphs">${escape(lines[0])}</text>
   <text x="40" y="${height - 50}" textLength="1170" lengthAdjust="spacingAndGlyphs">${escape(lines[1])}</text>
  </g></svg>`;
  let page = await sharp(Buffer.from(svg)).png().toBuffer();
  if (look.blur) {
    page = await sharp(page).blur(look.blur).toBuffer();
  }
  let picture = await sharp(page).rotate(look.rotate || 0, { background: '#8a6a4a' }).png().toBuffer();
  if (look.margin) {
    picture = await sharp(picture).extend({ top: look.margin, bottom: Math.round(look.margin * 1.4), left: look.margin, right: look.margin, background: '#8a6a4a' }).toBuffer();
  }
  let pipeline = sharp(picture);
  if (look.dim) {
    pipeline = pipeline.linear(look.dim, 10);
  }
  if (look.noise) {
    const size = await sharp(picture).metadata();
    const noise = await sharp({ create: { width: size.width, height: size.height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: look.noise } } }).png().toBuffer();
    pipeline = sharp(await pipeline.png().toBuffer()).composite([{ input: noise, blend: 'overlay' }]);
  }
  return pipeline.jpeg({ quality: look.quality || 80 }).toBuffer();
}

const fonts = ['DejaVu Sans Mono', 'Liberation Mono', 'JetBrains Mono'];
const looks = [
  { name: 'clean' },
  { name: 'turned', rotate: 3, margin: 120 },
  { name: 'blurry', blur: 1.6, quality: 60 },
  { name: 'dim, noisy', dim: 0.6, noise: 40, quality: 70 },
  { name: 'far away', margin: 420, quality: 75 },
  { name: 'tilted, far', rotate: -5, margin: 300, blur: 1, quality: 65 },
];

const tally = {};
const totals = { right: 0, wrong: 0, ambiguous: 0, time: 0 };
for (let index = 0; index < count; index += 1) {
  const who = person();
  const look = looks[index % looks.length];
  const font = fonts[Math.floor(index / looks.length) % fonts.length];
  const picture = await photo(zoneLines(who), who, { ...look, font });
  const started = Date.now();
  const read = await readMrz(picture);
  totals.time += Date.now() - started;
  const claimed = [read.found, read.documentChecked, read.birthChecked, read.expiryChecked].every(Boolean);
  const right = [claimed, folded(read.documentNumber) === folded(who.number), namesMatch(read.nameField || '', `${who.given} ${who.surname}`)].every(Boolean);
  if (!tally[look.name]) {
    tally[look.name] = { right: 0, of: 0 };
  }
  tally[look.name].of += 1;
  if (right) {
    tally[look.name].right += 1;
    totals.right += 1;
  }
  if (claimed && folded(read.documentNumber) !== folded(who.number)) {
    totals.wrong += 1;
    console.log(`WRONG #${index}: ${who.number} read as ${read.documentNumber}`);
  }
  if (read.ambiguous) {
    totals.ambiguous += 1;
  }
}
for (const [name, each] of Object.entries(tally)) {
  console.log(`${name.padEnd(12)} ${each.right}/${each.of}`);
}
console.log(`read right ${totals.right}/${count}, WRONG ${totals.wrong}, ambiguous ${totals.ambiguous}, ${Math.round(totals.time / count)} ms each`);
process.exit(0);
