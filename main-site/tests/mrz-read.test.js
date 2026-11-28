// Reading a passport's machine-readable zone (api/_lib/mrz-read.js): check
// digits, repairs by position and check digit, when a repair is too unsure
// to trust, finding the zone on a photo, and the identity hash's G/6 and
// L/1 fold. No OCR here (tests/live/helloid-mrz-bench.js runs it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SUPABASE_URL = 'https://project.supabase.co';

const mrz = await import('../api/_lib/mrz-read.js');
const { identityHashOf } = await import('../api/_lib/id-checks.js');

// ICAO 9303's own specimen passport, second line.
const SPECIMEN = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

test('check digits are ICAO 9303\'s', () => {
  assert.equal(mrz.checkDigit('L898902C3'), '6');
  assert.equal(mrz.checkDigit('740812'), '2');
  assert.equal(mrz.checkDigit('120415'), '9');
  assert.equal(mrz.checkDigit('<<<<<<<<<<<<<<'), '0');
});

test('a passport line read right is kept as it is, and trusted', () => {
  assert.deepEqual(mrz.repairSecondLine(SPECIMEN), { line: SPECIMEN, score: mrz.FULL_SCORE, cost: 0, ambiguous: false });
});

test('letters where only digits go, and digits where only letters go, are put right for free', () => {
  // The nationality's O read as 0; the birth date's 1 as I; the expiry's 0
  // as O: each place holds only one kind, so nothing is guessed.
  const read = 'L898902C36UT07408I22F12O4159ZE184226B<<<<<10';
  assert.deepEqual(mrz.repairSecondLine(read), { line: SPECIMEN, score: mrz.FULL_SCORE, cost: 0, ambiguous: false });
});

test('a look-alike in the document number is swapped back when its check digit says so', () => {
  const read = 'L8989O2C36UTO7408122F1204159ZE184226B<<<<<10';
  const repaired = mrz.repairSecondLine(read);
  assert.equal(repaired.line, SPECIMEN);
  assert.equal(repaired.cost, 1);
  assert.equal(repaired.ambiguous, false);
});

test('a character too many is dropped, but a repair with a close rival is not trusted', () => {
  // Extra filler at the end: one place to drop it that keeps every check.
  const tail = mrz.repairSecondLine(`${SPECIMEN.slice(0, 43)}<${SPECIMEN.slice(43)}`);
  assert.equal(tail.line, SPECIMEN);
  // An extra character inside the document number: put right, but another
  // reading, one edit dearer, holds as well, so it is ambiguous.
  const inside = mrz.repairSecondLine(`0${SPECIMEN}`);
  assert.equal(inside.line, SPECIMEN);
  assert.equal(inside.ambiguous, true);
  // A character missing: a filler put back.
  const short = mrz.repairSecondLine(SPECIMEN.slice(0, 40) + SPECIMEN.slice(41));
  assert.equal(short.line, SPECIMEN);
});

test('the passport\'s first line keeps its name and loses misread filler', () => {
  const { lines } = mrz.repairTd3(['P<UT0ERIKSSON<<ANNA<MARIA<<<<<L<LLLLLLL<L<LL', SPECIMEN]);
  assert.equal(lines[0], 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<');
  assert.equal(mrz.cleanNameFiller('TAN<<LEE<<<<<<<'), 'TAN<<LEE<<<<<<<', 'a given name of filler-like letters stays');
  assert.equal(mrz.cleanNameFiller('TAN<<LI<L<<<LLL<'), 'TAN<<LI<<<<<<<<<');
  assert.equal(mrz.cleanNameFiller('TAN<<ANNA<<<<LLLL<L<'), 'TAN<<ANNA<<<<<<<<<<<');
  assert.equal(mrz.cleanNameFiller('TAN<<ANNA<MARIA<<<'), 'TAN<<ANNA<MARIA<<<', 'a second given name stays');
});

test('the identity hash folds G into 6 and L into 1, which no check digit tells apart', () => {
  assert.equal(mrz.checkDigit('A3955G1GU'), mrz.checkDigit('A3955616U'), 'the same check digit either way');
  const read = identityHashOf({ documentNumber: 'A3955G1GU', documentCountry: 'GBR' });
  assert.equal(read, identityHashOf({ documentNumber: 'A3955616U', documentCountry: 'GBR' }));
  assert.equal(identityHashOf({ documentNumber: 'L898902C3', documentCountry: 'UTO' }), identityHashOf({ documentNumber: '1898902C3', documentCountry: 'UTO' }));
  assert.notEqual(read, identityHashOf({ documentNumber: 'A3955616U', documentCountry: 'SGP' }));
  assert.equal(identityHashOf({ documentNumber: '', documentCountry: 'GBR' }), null);
});

// A page photographed on a table, turned a little: a heading and lines of
// details above, and two long rows of character-sized blocks at the
// bottom, the zone. Drawn as shapes, so no fonts are needed.
async function pagePhoto(angle) {
  const blocks = [];
  for (const [row, top] of [[0, 740], [1, 810]]) {
    for (let index = 0; index < 44; index += 1) {
      const filler = (row === 0 && index > 20) || (row === 1 && index > 28 && index < 42);
      const height = filler ? 6 : 40;
      blocks.push(`<rect x="${40 + index * 26.5}" y="${top + 40 - height}" width="18" height="${height}" fill="#111"/>`);
    }
  }
  const details = [190, 250, 310].map((top) => `<rect x="420" y="${top}" width="300" height="26" fill="#333"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1250" height="880">
    <rect width="1250" height="880" fill="#eef3f0"/><rect x="60" y="60" width="700" height="40" fill="#203060"/>
    <rect x="60" y="150" width="300" height="390" fill="#c8c8c8"/>${details}${blocks.join('')}</svg>`;
  const page = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(page)
    .rotate(angle, { background: '#8a6a4a' })
    .extend({ top: 200, bottom: 280, left: 200, right: 200, background: '#8a6a4a' })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('the zone is found low on a photo, straightened and cropped to its width', async () => {
  for (const angle of [0, 3, -4]) {
    const zone = await mrz.findZone(await pagePhoto(angle));
    assert.ok(zone, `found at ${angle} degrees`);
    const size = await sharp(zone).metadata();
    assert.equal(size.width, 1600);
    // Two lines, not the page: wide and short.
    assert.ok(size.height < 400, `${size.height} high at ${angle} degrees`);
    assert.ok(size.height > 60, `${size.height} high at ${angle} degrees`);
  }
  // A photo with nothing low on it has no zone.
  const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal(await mrz.findZone(blank), null);
});
