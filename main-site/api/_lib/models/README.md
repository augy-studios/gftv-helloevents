# Models kept in this repository

## `mrz.traineddata.gz`

A Tesseract LSTM model trained on machine-readable zone (MRZ) text only:
OCR-B capitals, digits and the `<` filler. `api/_lib/helloid.js` reads
passports' MRZ with it (`readMrz`), in place of Tesseract's general English
model, which misreads the filler as L, C and K.

- From the npm package [`web-mrz-reader`](https://www.npmjs.com/package/web-mrz-reader)
  2.0.3 (`public/model/mrz.traineddata.gz`), by ilhan negis, published
  23 September 2026, source <https://github.com/eringen/web-mrz-reader>.
- Copied rather than installed: the package runs a postinstall script and
  asks for tesseract.js 5 as a peer, while this site uses tesseract.js 7.
- SHA-256 `edd49cab2f9615e0ad612039f5bb4606456a0507deb03858dd3c19c872387f69`.
- Licence: ISC, as the package declares:

> Copyright (c) 2026 ilhan negis
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
> SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
> OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
> CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

To replace it with a model of your own (trained with
[tesstrain](https://github.com/tesseract-ocr/tesstrain) on OCR-B text, A to Z,
0 to 9 and `<` only), keep the file name, then run
`node tests/live/helloid-mrz-bench.js` before and after to compare.
