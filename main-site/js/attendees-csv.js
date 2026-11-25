// The attendee list as a CSV file, for the edit form's "Download CSV"
// button (js/pages/manage.js builds the rows from what the list shows).
//
// csvText turns rows (arrays of cells) into RFC 4180 text: every cell
// quoted when it holds a comma, quote or line break, lines ended with CRLF,
// and a byte order mark first so spreadsheet apps read it as UTF-8 (names
// in Chinese, emoji). A cell an attendee typed that starts with = + - @ or
// a tab could run as a formula in a spreadsheet, so it gets a leading
// apostrophe (OWASP's advice on CSV injection).

const FORMULA_START = /^[=+\-@\t\r]/;

function cellText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value);
  if (typeof value !== 'number' && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvText(rows) {
  return `\uFEFF${rows.map((row) => row.map(cellText).join(',')).join('\r\n')}\r\n`;
}

// Saves text as a file named name on the viewer's device.
export function downloadCsv(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
