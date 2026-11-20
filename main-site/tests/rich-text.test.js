// Rich text descriptions (migrations/020): what the sanitizer keeps from
// the editor, from Word and Google Docs, and what it never lets through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cleanDescription, displayDescription, descriptionText, descriptionPictureIds } = await import('../api/_lib/rich-text.js');
const rules = await import('../api/_lib/event-rules.js');

const clean = (html) => cleanDescription(html).html;
const GALLERY_ID = '0b6a3c7e-1f7a-4a0e-9b1e-2f6d7c8a9e01';
const STICKER_ID = '1c7b4d8f-2a8b-4b1f-8c2f-3a7e8d9bae02';

test('the editor\'s own formatting is kept as it is', () => {
  const html = '<h2>Schedule</h2><p style="text-align: center">Doors at <strong>7pm</strong>, <em>dress up</em>, '
    + '<u>bring ID</u>, <s>no tickets at the door</s>, H<sub>2</sub>O, 2<sup>nd</sup></p>'
    + '<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul><ol start="3"><li>Three</li></ol>'
    + '<blockquote><p>A quote</p></blockquote><hr>'
    + '<p><span style="color: #c8285a; background-color: #ffff00; font-family: &quot;Georgia&quot;, serif, var(--emoji-fonts); font-size: 24px">Big red</span></p>'
    + '<table><tbody><tr><th><p>Time</p></th><td style="background-color: #ffe0e0"><p>Panel</p></td></tr></tbody></table>'
    + '<p><a href="https://example.org/tickets">Tickets</a></p><p style="margin-left: 2em">Indented</p>';
  assert.equal(clean(html), html);
  // Cleaning what was cleaned changes nothing.
  assert.equal(clean(clean(html)), clean(html));
});

test('scripts, event handlers and dangerous links never get through', () => {
  const out = clean('<p onclick="alert(1)">Hi<script>alert(1)</script><img src=x onerror="alert(2)">'
    + '<a href="javascript:alert(3)">link</a><iframe src="https://evil.example"></iframe>'
    + '<span style="background: url(https://evil.example/x.png)">bg</span>'
    + '<svg><script>alert(4)</script></svg><style>p{}</style></p>');
  assert.equal(out, '<p>Hilinkbg</p>');
  assert.equal(clean('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(clean('<p style="color: red; font-family: x;}body{color:red">x</p>').includes('}'), false);
  // An attribute value can never close its quote.
  assert.equal(clean('<p><span style=\'font-family: "a\\" onmouseover=alert(1)"\'>x</span></p>').includes('onmouseover'), false);
});

test('Word\'s and Google Docs\' formatting is kept; Automatic black and white page backgrounds follow the theme', () => {
  // Google Docs: everything in <b style="font-weight:normal">, formatting on spans.
  const docs = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;">'
    + '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;">Bold</span>'
    + '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#ff0000;font-style:italic;text-decoration:underline;">red</span></p></b>';
  assert.equal(clean(docs), '<p><strong><span style="font-family: &quot;Arial&quot;, sans-serif, var(--emoji-fonts); font-size: 15px">Bold</span></strong>'
    + '<em><u><span style="color: #ff0000; font-family: &quot;Arial&quot;, sans-serif, var(--emoji-fonts); font-size: 15px">red</span></u></em></p>');

  // Word: MsoNormal paragraphs, windowtext, and list paragraphs as real lists.
  const word = '<p class=MsoNormal style="margin-left:0cm"><span style="font-size:12.0pt;color:windowtext;background:white">Plain</span>'
    + '<b><span style="color:#2F5496">Blue</span></b></p>'
    + '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><!--[if !supportLists]--><span style="mso-list:Ignore">1.<span>&nbsp;</span></span><!--[endif]-->First</p>'
    + '<p class=MsoListParagraphCxSpMiddle style="mso-list:l0 level2 lfo1"><!--[if !supportLists]--><span style="mso-list:Ignore">a.<span>&nbsp;</span></span><!--[endif]-->Inner</p>'
    + '<p class=MsoListParagraphCxSpLast style="mso-list:l0 level1 lfo1"><!--[if !supportLists]--><span style="mso-list:Ignore">2.<span>&nbsp;</span></span><!--[endif]-->Second</p>';
  assert.equal(clean(word), '<p><span style="font-size: 16px">Plain</span><strong><span style="color: #2f5496">Blue</span></strong></p>'
    + '<ol><li>First<ol><li>Inner</li></ol></li><li>Second</li></ol>');
});

test('highlighted text stays readable on its highlight in dark mode', () => {
  assert.equal(clean('<p><span style="background-color:#ffff00;color:#000000">Tickets back!</span></p>'),
    '<p><span style="color: #111111; background-color: #ffff00">Tickets back!</span></p>');
  assert.equal(clean('<p><span style="background-color:#1c4587">Dark</span></p>'), '<p><span style="color: #f5f5f5; background-color: #1c4587">Dark</span></p>');
  assert.equal(clean('<p><span style="background-color:#ffff00;color:#ff0000">Red on yellow</span></p>'), '<p><span style="color: #ff0000; background-color: #ffff00">Red on yellow</span></p>');
  const once = clean('<p><mark>Marked</mark></p>');
  assert.equal(clean(once), once, 'cleaning again changes nothing');
});

test('pictures are stored as references, and shown from this site\'s addresses only', () => {
  const stored = clean(`<p>Look <img src="/api/events/gallery-image?slug=x&amp;v=abc" data-gallery-id="${GALLERY_ID}" width="800" height="600">`
    + `<video src="/api/stickers/image?id=1" data-sticker-id="${STICKER_ID}"></video><img src="https://elsewhere.example/a.png"></p>`);
  assert.equal(stored, `<p>Look <img data-gallery-id="${GALLERY_ID}"><img data-sticker-id="${STICKER_ID}"></p>`);
  assert.deepEqual(descriptionPictureIds(stored), { galleryIds: [GALLERY_ID], stickerIds: [STICKER_ID] });

  const row = {
    description_pictures: {
      gallery: new Map([[GALLERY_ID, { src: '/api/events/gallery-image?slug=meet&v=Name', width: 800, height: 600, video: '' }]]),
      stickers: new Map([[STICKER_ID, { src: '/api/stickers/image?id=s&v=still', width: 512, height: 512, video: '/api/stickers/image?id=s&v=video' }]]),
    },
  };
  assert.equal(displayDescription(row, stored), '<p>Look <img src="/api/events/gallery-image?slug=meet&amp;v=Name" width="800" height="600" alt="" loading="lazy" '
    + `data-gallery-id="${GALLERY_ID}"><img class="rich-sticker" src="/api/stickers/image?id=s&amp;v=still" width="512" height="512" alt="" loading="lazy" `
    + `data-sticker-id="${STICKER_ID}" data-video="/api/stickers/image?id=s&amp;v=video"></p>`);
  // A picture no longer there is left out.
  assert.equal(displayDescription({}, stored), '<p>Look</p>');
});

test('plain text from before is read as paragraphs, and descriptions turn into plain text for previews', () => {
  assert.equal(clean('First line\nsecond line\n\nNext <para>'), '<p>First line<br>second line</p><p>Next &lt;para&gt;</p>');
  assert.equal(displayDescription({}, 'Old text\nline two'), '<p>Old text<br>line two</p>');
  assert.equal(descriptionText('<h2>Title</h2><p>One <strong>two</strong><br>three</p><ul><li>a</li><li>b</li></ul>'), 'Title\nOne two\nthree\na\nb');
});

test('plain text shows its markdown as formatting, and a typed <br> as a line break', () => {
  const typed = '📍 Location:<br>GV VivoCity<br>(https://maps.app.goo.gl/abc)<br><br>💰 S$8 per person';
  assert.equal(displayDescription({}, typed), '<p>📍 Location:<br>GV VivoCity<br>(<a href="https://maps.app.goo.gl/abc" target="_blank" rel="noopener noreferrer nofollow">'
    + 'https://maps.app.goo.gl/abc</a>)</p><p>💰 S$8 per person</p>');
  assert.equal(descriptionText(typed), '📍 Location:\nGV VivoCity\n(https://maps.app.goo.gl/abc)\n💰 S$8 per person');
  assert.equal(clean('# Meet\n\nBring **water** and *snacks*, see [the map](https://example.org/map)\n\n- one\n- two'),
    '<h2>Meet</h2><p>Bring <strong>water</strong> and <em>snacks</em>, see <a href="https://example.org/map">the map</a></p><ul><li>one</li><li>two</li></ul>');
  // Rich text an editor saved with the <br> still typed out as text.
  assert.equal(displayDescription({}, '<p>Line one&lt;br&gt;line two&lt;BR /&gt;three &lt;b&gt;</p>'), '<p>Line one<br>line two<br>three &lt;b&gt;</p>');
});

test('a description is required, has length limits, and a blank editor counts as blank', () => {
  const base = { title: 'Meet', description: '<p>x</p>', descriptionZh: '<p>x</p>', kind: 'furmeet', status: 'draft', priceType: 'free', startDate: '2027-01-01', timezone: 'Asia/Singapore' };
  assert.equal(rules.validateEvent({ ...base, description: '<p><br></p>' }).field, 'description');
  assert.equal(rules.validateEvent({ ...base, description: `<p><img data-gallery-id="${GALLERY_ID}"></p>` }).ok, true, 'a picture alone is a description');
  assert.equal(rules.validateEvent({ ...base, description: `<p>${'x'.repeat(20001)}</p>` }).field, 'description');
  assert.equal(rules.validateEvent(base).fields.description, '<p>x</p>');
});

test('a gallery picture keeps its own crop in a description, shown as the cropped part', () => {
  assert.equal(clean(`<p><img data-gallery-id="${GALLERY_ID}" data-crop="0.1,0.2,0.5,0.25"></p>`), `<p><img data-gallery-id="${GALLERY_ID}" data-crop="0.1,0.2,0.5,0.25"></p>`);
  // A crop that is not one, or that keeps the whole picture, is dropped.
  for (const crop of ['0.6,0,0.5,0.5', 'x', '0,0,1,1', '0.1,0.1,0.001,0.5', '-0.1,0,0.5,0.5']) {
    assert.equal(clean(`<p><img data-gallery-id="${GALLERY_ID}" data-crop="${crop}"></p>`), `<p><img data-gallery-id="${GALLERY_ID}"></p>`, crop);
  }
  // Stickers are never cropped.
  assert.equal(clean(`<p><img data-sticker-id="${STICKER_ID}" data-crop="0.1,0.2,0.5,0.25"></p>`), `<p><img data-sticker-id="${STICKER_ID}"></p>`);
  const row = { description_pictures: { gallery: new Map([[GALLERY_ID, { src: '/api/events/gallery-image?slug=meet&v=Name', width: 2000, height: 1000 }]]), stickers: new Map() } };
  assert.equal(displayDescription(row, `<p><img data-gallery-id="${GALLERY_ID}" data-crop="0.1,0.2,0.5,0.25"></p>`),
    '<p><img src="/api/events/gallery-image?slug=meet&amp;v=Name&amp;crop=0.1%2C0.2%2C0.5%2C0.25" width="1000" height="250" alt="" loading="lazy" '
    + `data-gallery-id="${GALLERY_ID}" data-crop="0.1,0.2,0.5,0.25"></p>`);
});

test('emoji of every kind are kept exactly, up to the latest edition', async () => {
  const emoji = [
    '😀', '🫫', '🫪', '🫯', // Emoji 1.0 to 18.0
    '👋🏽', '🫹🏿', // skin tones
    '👩🏽‍💻', '🧑‍🧑‍🧒‍🧒', '🏳️‍🌈', '❤️‍🔥', // zero-width-joiner sequences
    '1️⃣', '#️⃣', // keycaps
    '🇸🇬', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', // a flag, and a subdivision flag made of tag characters
    '☺️', '✈️', // with the emoji variation selector
  ];
  const text = emoji.join(' ');
  assert.equal(clean(`<p>${text}</p>`), `<p>${text}</p>`);
  assert.equal(clean(`<h2><span style="font-size:24px">${emoji[1]}</span> Party</h2>`), `<h2><span style="font-size: 24px">${emoji[1]}</span> Party</h2>`);
  assert.equal(descriptionText(`<p>${text}</p>`), text);
  // Every emoji in the picker's data goes through untouched.
  const { readFile } = await import('node:fs/promises');
  const data = JSON.parse(await readFile(new URL('../assets/emoji/emoji.json', import.meta.url), 'utf8'));
  const all = data.groups.flatMap((group) => group.emoji.flatMap((item) => [item[0], ...(item[2] || [])]));
  assert.ok(all.length > 3000);
  const joined = all.join(' ');
  assert.equal(clean(`<p>${joined}</p>`), `<p>${joined}</p>`);
  assert.ok(all.includes('🫫'), 'Emoji 18.0 is in the picker');
});

test('a gallery picture keeps its size in a description; stickers and unknown sizes do not', () => {
  assert.equal(clean(`<p><img data-gallery-id="${GALLERY_ID}" data-crop="0.1,0,0.5,0.5" data-size="medium"></p>`), `<p><img data-gallery-id="${GALLERY_ID}" data-crop="0.1,0,0.5,0.5" data-size="medium"></p>`);
  assert.equal(clean(`<p><img data-gallery-id="${GALLERY_ID}" data-size="huge"></p>`), `<p><img data-gallery-id="${GALLERY_ID}"></p>`);
  assert.equal(clean(`<p><img data-sticker-id="${STICKER_ID}" data-size="small"></p>`), `<p><img data-sticker-id="${STICKER_ID}"></p>`);
  const row = { description_pictures: { gallery: new Map([[GALLERY_ID, { src: '/api/events/gallery-image?slug=meet&v=Name', width: 800, height: 600 }]]), stickers: new Map() } };
  assert.match(displayDescription(row, `<p><img data-gallery-id="${GALLERY_ID}" data-size="small"></p>`), /data-gallery-id="[^"]+" data-size="small">/);
});
