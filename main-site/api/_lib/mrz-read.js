// Reading a passport's machine-readable zone (MRZ) from a photo, for HelloID
// (helloid.js readMrz). Three steps, each measured on generated passport
// photos (tests/live/helloid-mrz-bench.js) before it was kept:
//
//   1. Find the zone (findZone): the photo straightened (the angle whose rows
//      of edges stand out most), then the lowest two or three long lines of
//      text, cropped to their width. The old way, the bottom 45% of the
//      whole photo, is read too, as a second picture.
//   2. Read it with Tesseract and a model trained on MRZ text alone
//      (models/mrz.traineddata.gz, models/README.md), not the general
//      English one, which turns the "<" filler into L, C and K.
//   3. Repair a passport's (TD3) second line by what each place may hold
//      (repairTd3): digits where only digits go, letters where only letters
//      go, a character too many or too few, and look-alikes in the document
//      and personal numbers, the cheapest reading whose check digits hold.
//
// Check digits catch only nine wrong readings in ten, and with many
// readings to choose from, one can pass by luck. So a reading is trusted
// as it was read, or repaired only when it is the one clear answer and a
// second picture's reading agrees; anything else is "ambiguous", and the
// check goes to GFTV's admins instead of approving itself. Its document
// number is then left unchecked; its dates still count only when their own
// check digits hold.

import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Check digits and repairs (no pictures: tested in tests/idcheck-checkin.test.js)
// ---------------------------------------------------------------------------

// ICAO 9303's check digit: each character's value (0-9, A=10 to Z=35, "<"
// 0) times 7, 3, 1 in turn, summed, mod 10.
export function checkDigit(text) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let value = 0;
    if (code >= 48 && code <= 57) {
      value = code - 48;
    } else if (code >= 65 && code <= 90) {
      value = code - 55;
    }
    sum += value * weights[index % 3];
  }
  return String(sum % 10);
}

function checks(field, digit) {
  return checkDigit(field) === digit;
}

// For a place that holds only digits, or only letters.
const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6', A: '4' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };

function mapped(text, table) {
  return [...text].map((character) => {
    if (Object.prototype.hasOwnProperty.call(table, character)) {
      return table[character];
    }
    return character;
  }).join('');
}

// What a character in a document or personal number is often misread as,
// among the swaps a check digit can tell apart. G and 6, and L and 1, are
// 10 apart in the check digit's sum (G is 16, L is 21), so no check digit
// ever tells them apart: identityHashOf (id-checks.js) folds them together
// instead.
const LOOKALIKES = {
  0: ['O', 'Q', 'D'], O: ['0', 'Q', 'D'], Q: ['0', 'O'], D: ['0', 'O'],
  1: ['I', 'T'], I: ['1', 'T', 'L'], T: ['1', 'I', '7'], L: ['I'], 7: ['T'],
  2: ['Z'], Z: ['2'], 5: ['S'], S: ['5'], 8: ['B'], B: ['8'], G: ['C'], C: ['G'], 4: ['A'], A: ['4'],
};

// Every way a number could read with up to `most` look-alikes swapped:
// [{ text, cost }], cost the number of swaps.
function numberReadings(field, most) {
  const readings = [{ text: field, cost: 0 }];
  const spots = [];
  for (let index = 0; index < field.length; index += 1) {
    if (Object.prototype.hasOwnProperty.call(LOOKALIKES, field[index])) {
      spots.push(index);
    }
  }
  const grow = (from, characters, used) => {
    for (let spot = from; spot < spots.length; spot += 1) {
      for (const other of LOOKALIKES[field[spots[spot]]]) {
        const next = [...characters];
        next[spots[spot]] = other;
        readings.push({ text: next.join(''), cost: used + 1 });
        if (used + 1 < most) {
          grow(spot + 1, next, used + 1);
        }
      }
    }
  };
  grow(0, [...field], 0);
  return readings;
}

// The filler after a name ("ANNA<<<<<<"), often misread as L, C, K, E or I
// between the "<"s ("ANNA<<<L<LLLL<L"): from the end, each piece that
// looks like misread filler (a single one of those letters, or one of them
// repeated) goes back to "<", up to the first given name, which always
// stays (LEE, LI). The text keeps its length.
function looksLikeFiller(piece) {
  if (!/^[LCKEI]+$/.test(piece)) {
    return false;
  }
  return new Set(piece).size === 1;
}

export function cleanNameFiller(text) {
  const given = text.indexOf('<<');
  if (given < 0) {
    return text;
  }
  let name = text.replace(/<+$/, '');
  for (;;) {
    const match = name.match(/^(.*?)<+([A-Z]+)$/);
    if (!match || match[1].length <= given || !looksLikeFiller(match[2])) {
      break;
    }
    name = match[1];
  }
  return name.padEnd(text.length, '<');
}

// The parts of a TD3 second line its last check digit covers.
function composite(line) {
  return line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43);
}

// The personal number's check digit: "<" (or 0) for one left blank.
function personalChecks(line) {
  const personal = line.slice(28, 42);
  if (/^<+$/.test(personal)) {
    return ['<', '0'].includes(line[42]);
  }
  return checks(personal, line[42]);
}

// How many of a TD3 second line's five check digits hold.
export const FULL_SCORE = 5;
function td3Score(line) {
  return [
    checks(line.slice(0, 9), line[9]),
    checks(line.slice(13, 19), line[19]),
    checks(line.slice(21, 27), line[27]),
    personalChecks(line),
    checks(composite(line), line[43]),
  ].filter(Boolean).length;
}

// A TD3 second line of 44, put right where it is certain (the dates and
// check digits hold only digits, the nationality only letters, the sex M,
// F or "<"), then every reading of its document and personal numbers:
// [{ line, cost }].
function secondLineReadings(line, baseCost) {
  let personalCheck = '<';
  if (line[42] !== '<') {
    personalCheck = mapped(line[42], TO_DIGIT);
  }
  let sex = line[20];
  if (!/[MF<]/.test(sex)) {
    sex = '<';
    if (['H', 'N'].includes(line[20])) {
      sex = 'M';
    } else if (['P', 'E'].includes(line[20])) {
      sex = 'F';
    }
  }
  const middle = mapped(line[9], TO_DIGIT) + mapped(line.slice(10, 13), TO_LETTER) + mapped(line.slice(13, 20), TO_DIGIT) + sex + mapped(line.slice(21, 28), TO_DIGIT);
  const personal = line.slice(28, 42);
  let personals = [{ text: personal, cost: 0 }];
  if (!/^<+$/.test(personal)) {
    personals = numberReadings(personal, 1);
  }
  const readings = [];
  for (const documentNumber of numberReadings(line.slice(0, 9), 2)) {
    for (const personalNumber of personals) {
      readings.push({
        line: documentNumber.text + middle + personalNumber.text + personalCheck + mapped(line[43], TO_DIGIT),
        cost: baseCost + documentNumber.cost + personalNumber.cost,
      });
    }
  }
  return readings;
}

// The second line as read: often a character long or short, and with
// look-alikes in its numbers. Every reading within a few edits (a character
// dropped or put back costs one, a swap one), and the cheapest whose check
// digits hold best: { line, score, cost, ambiguous }. Ambiguous when
// another reading holds as well and costs at most one edit more.
export function repairSecondLine(raw) {
  // rank: 0 for an edit beside the filler, where OCR drops and adds "<"
  // most, 1 elsewhere; it only breaks ties.
  const besideFiller = (index) => [raw[index - 1], raw[index]].includes('<');
  const shapes = [];
  if (raw.length === 44) {
    shapes.push({ text: raw, cost: 0, rank: 0 });
  } else if (raw.length === 45) {
    for (let index = 0; index < 45; index += 1) {
      shapes.push({ text: raw.slice(0, index) + raw.slice(index + 1), cost: 1, rank: Number(raw[index] !== '<') });
    }
  } else if (raw.length === 46) {
    for (let first = 0; first < 46; first += 1) {
      for (let second = first + 1; second < 46; second += 1) {
        shapes.push({ text: raw.slice(0, first) + raw.slice(first + 1, second) + raw.slice(second + 1), cost: 2, rank: 1 });
      }
    }
  } else if (raw.length === 43) {
    for (let index = 0; index <= 43; index += 1) {
      shapes.push({ text: `${raw.slice(0, index)}<${raw.slice(index)}`, cost: 1, rank: Number(!besideFiller(index)) });
    }
  } else {
    shapes.push({ text: raw.padEnd(44, '<').slice(0, 44), cost: 3, rank: 1 });
  }
  const readings = [];
  for (const shape of shapes) {
    for (const reading of secondLineReadings(shape.text, shape.cost)) {
      readings.push({ ...reading, rank: shape.rank, score: td3Score(reading.line) });
    }
  }
  let best = readings[0];
  for (const reading of readings) {
    if (reading.score !== best.score) {
      if (reading.score > best.score) {
        best = reading;
      }
    } else if (reading.cost < best.cost || (reading.cost === best.cost && reading.rank < best.rank)) {
      best = reading;
    }
  }
  const rivals = new Set(readings.filter((reading) => [reading.score === best.score, reading.cost <= best.cost + 1].every(Boolean)).map((reading) => reading.line));
  return { line: best.line, score: best.score, cost: best.cost, ambiguous: rivals.size > 1 };
}

// A passport's two lines as read, repaired: { lines, score, cost,
// ambiguous }. The first line holds the type, the issuing state (letters)
// and the name (letters and "<").
export function repairTd3([first, second]) {
  let line = first.padEnd(44, '<').slice(0, 44);
  line = `P${line[1]}${mapped(line.slice(2, 5), TO_LETTER)}${cleanNameFiller(mapped(line.slice(5), TO_LETTER))}`;
  const repaired = repairSecondLine(second);
  return { lines: [line, repaired.line], score: repaired.score, cost: repaired.cost, ambiguous: repaired.ambiguous };
}

// ---------------------------------------------------------------------------
// Finding the zone on a photo
// ---------------------------------------------------------------------------

const WORK_WIDTH = 640;
const EDGE_STEP = 40;
const ANGLES = [-6, -4, -3, -2, -1, 0, 1, 2, 3, 4, 6];

// Where the brightness jumps from one pixel to the next across a row: 1 for
// an edge, 0 for none.
function edgeMap(data, width, height) {
  const edges = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 1; column < width - 1; column += 1) {
      const at = row * width + column;
      if (Math.abs(data[at + 1] - data[at - 1]) > EDGE_STEP) {
        edges[at] = 1;
      }
    }
  }
  return edges;
}

function rowCounts(edges, width, height) {
  const rows = new Float64Array(height);
  for (let row = 0; row < height; row += 1) {
    let count = 0;
    for (let column = 0; column < width; column += 1) {
      count += edges[row * width + column];
    }
    rows[row] = count;
  }
  return rows;
}

function variance(values) {
  let mean = 0;
  for (const value of values) {
    mean += value / values.length;
  }
  let total = 0;
  for (const value of values) {
    total += (value - mean) ** 2;
  }
  return total;
}

// The bands of rows with many edges (lines of text): [[top, bottom]].
function textBands(rows, width) {
  const sorted = [...rows].sort((left, right) => left - right);
  const threshold = Math.max(width * 0.12, sorted[Math.floor(rows.length / 2)] * 2);
  const bands = [];
  let start = -1;
  for (let row = 0; row < rows.length; row += 1) {
    const inText = rows[row] > threshold;
    if (inText && start < 0) {
      start = row;
    }
    if ((!inText || row === rows.length - 1) && start >= 0) {
      if (row - start >= 3) {
        bands.push([start, row]);
      }
      start = -1;
    }
  }
  return bands;
}

// The lowest two or three bands in the lower part of the page, of about the
// same height and close together: the zone's lines.
function zoneBands(bands, height) {
  const lower = bands.filter(([top]) => top > height * 0.35);
  if (lower.length === 0) {
    return null;
  }
  const picked = [lower[lower.length - 1]];
  for (let index = lower.length - 2; index >= 0 && picked.length < 3; index -= 1) {
    const [top, bottom] = lower[index];
    const lineHeight = picked[0][1] - picked[0][0];
    if (picked[0][0] - bottom > lineHeight * 2.5 || Math.abs(bottom - top - lineHeight) > lineHeight * 0.6) {
      break;
    }
    picked.unshift(lower[index]);
  }
  return picked;
}

// The text's columns in those rows: runs of columns with edges, joined
// across gaps narrower than the spaces between characters, the widest run.
function textColumns(edges, width, top, bottom, gap) {
  const columns = new Float64Array(width);
  for (let row = top; row < bottom; row += 1) {
    for (let column = 0; column < width; column += 1) {
      columns[column] += edges[row * width + column];
    }
  }
  let best = { left: 0, right: width - 1, size: -1 };
  let runStart = -1;
  let lastEdge = -1;
  for (let column = 0; column <= width; column += 1) {
    if (column < width && columns[column] > 0) {
      if (runStart < 0 || column - lastEdge > gap) {
        if (runStart >= 0 && lastEdge - runStart > best.size) {
          best = { left: runStart, right: lastEdge, size: lastEdge - runStart };
        }
        runStart = column;
      }
      lastEdge = column;
    }
  }
  if (runStart >= 0 && lastEdge - runStart > best.size) {
    best = { left: runStart, right: lastEdge, size: lastEdge - runStart };
  }
  return best;
}

// Grey pixels, one byte each: the photo at `width`, or (raw) pixels already
// grey, turned by `angle` degrees.
async function grey(input, { width = 0, angle = 0, raw = null } = {}) {
  const options = { limitInputPixels: 4000 * 4000 };
  if (raw) {
    options.raw = raw;
  }
  let pipeline = sharp(input, options);
  if (width) {
    pipeline = pipeline.resize({ width });
  }
  if (angle) {
    pipeline = pipeline.rotate(angle, { background: '#ffffff' });
  }
  return pipeline.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
}

// The zone, straightened and cropped, as a PNG 1600 wide; null when no
// lines of text are found low on the photo.
export async function findZone(bytes) {
  const upright = await sharp(bytes, { limitInputPixels: 4000 * 4000 }).rotate().grayscale().png().toBuffer();
  const small = await grey(upright, { width: WORK_WIDTH });
  let best = null;
  for (const angle of ANGLES) {
    let turned = small;
    if (angle !== 0) {
      turned = await grey(small.data, { angle, raw: { width: small.info.width, height: small.info.height, channels: 1 } });
    }
    if (turned.info.channels !== 1) {
      continue;
    }
    const edges = edgeMap(turned.data, turned.info.width, turned.info.height);
    const rows = rowCounts(edges, turned.info.width, turned.info.height);
    const spread = variance(rows);
    if (best === null || spread > best.spread) {
      best = { angle, spread, edges, rows, width: turned.info.width, height: turned.info.height };
    }
  }
  if (best === null) {
    return null;
  }
  const bands = zoneBands(textBands(best.rows, best.width), best.height);
  if (bands === null) {
    return null;
  }
  const lineHeight = (bands[bands.length - 1][1] - bands[0][0]) / bands.length;
  const top = Math.max(0, Math.floor(bands[0][0] - lineHeight * 0.5));
  const bottom = Math.min(best.height, Math.ceil(bands[bands.length - 1][1] + lineHeight * 0.5));
  const columns = textColumns(best.edges, best.width, top, bottom, Math.max(4, Math.round(lineHeight * 1.5)));
  const pad = Math.round(lineHeight);
  const left = Math.max(0, columns.left - pad);
  const right = Math.min(best.width - 1, columns.right + pad);

  // The same box on the whole photo, turned the same way.
  let full = upright;
  if (best.angle !== 0) {
    full = await sharp(upright).rotate(best.angle, { background: '#ffffff' }).png().toBuffer();
  }
  const size = await sharp(full).metadata();
  const scale = size.width / best.width;
  const box = { left: Math.floor(left * scale), top: Math.floor(top * scale) };
  box.width = Math.max(8, Math.min(size.width - box.left, Math.ceil((right - left) * scale)));
  box.height = Math.max(8, Math.min(size.height - box.top, Math.ceil((bottom - top) * scale)));
  return sharp(full).extract(box).normalise().resize({ width: 1600 }).png().toBuffer();
}

// The zone as a black and white picture, which reads better on a dim or
// noisy photo.
export function blackAndWhite(zone) {
  return sharp(zone).threshold(140).png().toBuffer();
}

// The bottom 45% of the photo, where a passport's zone is when the page
// fills the photo: the way HelloID read it first, kept as a fallback.
export async function bottomOfPhoto(bytes) {
  const meta = await sharp(bytes, { limitInputPixels: 4000 * 4000 }).rotate().metadata();
  let height = meta.height;
  let width = meta.width;
  if ([5, 6, 7, 8].includes(meta.orientation)) {
    height = meta.width;
    width = meta.height;
  }
  const top = Math.floor(height * 0.55);
  return sharp(bytes, { limitInputPixels: 4000 * 4000 })
    .rotate()
    .extract({ left: 0, top, width, height: height - top })
    .grayscale()
    .normalise()
    .resize({ width: 1600 })
    .png()
    .toBuffer();
}
