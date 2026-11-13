// QR codes, drawn locally with the vendored qrcode-generator (MIT), so they
// work offline and the address is never sent to a third-party QR service.
// Pages that use this load /js/vendor/qrcode.js first, which defines the
// global `qrcode`.

function matrix(text) {
  const qrCode = window.qrcode(0, 'M');
  qrCode.addData(text);
  qrCode.make();
  return qrCode;
}

// An SVG string: a light square and one path for the dark modules. Colours
// come from --qr-fg and --qr-bg in CSS, so the code stays dark on light in
// every theme, which is what scanners need.
export function qrSvg(text, label) {
  const qrCode = matrix(text);
  const moduleCount = qrCode.getModuleCount();
  const quietZone = 2;
  const size = moduleCount + quietZone * 2;
  let pathData = '';
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qrCode.isDark(row, column)) {
        pathData += `M${column + quietZone} ${row + quietZone}h1v1h-1z`;
      }
    }
  }
  // The label (or the text itself) names the picture for screen readers.
  let labelText = label;
  if (!labelText) {
    labelText = text;
  }
  const title = String(labelText).replace(/[<&>"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${title}"><rect width="${size}" height="${size}"/><path d="${pathData}"/></svg>`;
}

// A PNG for saving or printing, always black on white.
export function qrPngUrl(text, scale = 12) {
  const qrCode = matrix(text);
  const moduleCount = qrCode.getModuleCount();
  const quietZone = 4;
  const size = (moduleCount + quietZone * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  // A print rule rather than a theme colour, the same pair as --qr-bg/--qr-fg.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#000000';
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qrCode.isDark(row, column)) {
        context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }
  return canvas.toDataURL('image/png');
}

export function downloadQr(text, filename) {
  const link = document.createElement('a');
  link.href = qrPngUrl(text);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
