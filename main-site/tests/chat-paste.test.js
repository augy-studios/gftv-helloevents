// Pasting into the description editor from Discord and Telegram
// (js/rich-text.js): their HTML without the app's theme, emoji pictures as
// emoji, and plain text with markdown in it as formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'htmlparser2';

const { cleanRichTree, pasteSource, markdownToHtml } = await import('../js/rich-text.js');

// htmlparser2's tree, read the way js/rich-text.js asks (as
// api/_lib/rich-text.js reads it).
const ADAPTER = {
  type(node) {
    if (node.type === 'text') {
      return 'text';
    }
    if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      return 'element';
    }
    return 'other';
  },
  tag: (node) => String(node.name).toLowerCase(),
  attr(node, name) {
    if (!node.attribs || !Object.hasOwn(node.attribs, name)) {
      return null;
    }
    return node.attribs[name];
  },
  children(node) {
    if (!Array.isArray(node.children)) {
      return [];
    }
    return node.children;
  },
  text: (node) => String(node.data),
};

// What pasting this HTML puts in the editor, as rich-editor.js asks for it.
function paste(html) {
  const tree = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  return cleanRichTree(tree, ADAPTER, { mode: 'paste', source: pasteSource(html) }).html;
}

// What pasting this plain text puts in, or null for plain text as it was.
function pasteText(text) {
  const html = markdownToHtml(text);
  if (html === null) {
    return null;
  }
  return paste(html);
}

// The browser's copy of Discord's dark theme, on the selection.
const DISCORD_THEME = 'color: rgb(219, 222, 225); font-family: &quot;gg sans&quot;, &quot;Noto Sans&quot;, sans-serif; font-size: 16px; '
  + 'font-weight: 400; white-space: pre-wrap; background-color: rgb(49, 51, 56);';

test('where pasted HTML was copied from', () => {
  assert.equal(pasteSource(`<span style="${DISCORD_THEME}">hi</span>`), 'discord');
  assert.equal(pasteSource('<div class="markup__75297 messageContent_c19a55">hi</div>'), 'discord');
  assert.equal(pasteSource('<img class="emoji" src="https://discord.com/assets/abc.svg" alt="😀">'), 'discord');
  assert.equal(pasteSource('<b data-entity-type="MessageEntityBold">hi</b>'), 'telegram');
  assert.equal(pasteSource('<img class="emoji" src="https://web.telegram.org/k/assets/img/emoji/1f600.png" alt="😀">'), 'telegram');
  // A link to either, in a document from elsewhere, is not a copy from it.
  assert.equal(pasteSource('<p><a href="https://discord.gg/abc">Join</a> <a href="https://t.me/group">us</a></p>'), '');
  assert.equal(pasteSource('<p style="color:#ff0000">Word</p>'), '');
});

test('a Discord message keeps its formatting and line breaks, without Discord\'s theme', () => {
  const html = `<meta charset="utf-8"><div class="markup__75297 messageContent_c19a55" style="${DISCORD_THEME}">`
    + 'Doors at <strong>7pm</strong>, <em>dress up</em>, <u>bring ID</u>, <s>no tickets</s>\nSecond line'
    + '<span class="spoilerContent_aa" role="button"><span class="spoilerInnerContainer_aa">secret</span></span> '
    + '<code class="inlineCode_aa" style="font-family: &quot;gg mono&quot;, monospace; background-color: rgb(43, 45, 49);">npm test</code> '
    + '<a class="anchor_aa" href="https://example.org/tickets" style="color: rgb(0, 168, 252);">Tickets</a></div>'
    + '<div class="blockquoteContainer_aa"><div class="blockquoteDivider_aa"></div><blockquote>Quoted</blockquote></div>'
    + '<h1 style="font-size: 24px">Schedule</h1><ul><li>One</li><li>Two</li></ul>';
  assert.equal(paste(html), '<p>Doors at <strong>7pm</strong>, <em>dress up</em>, <u>bring ID</u>, <s>no tickets</s><br>Second line'
    + 'secret <span style="font-family: monospace">npm test</span> <a href="https://example.org/tickets">Tickets</a></p>'
    + '<blockquote><p>Quoted</p></blockquote><h2>Schedule</h2><ul><li>One</li><li>Two</li></ul>');
});

test('emoji pictures go in as emoji; avatars and Discord\'s message header do not go in as pictures or headings', () => {
  const html = '<li class="messageListItem_aa"><img class="avatar_aa" src="https://cdn.discordapp.com/avatars/1/abc.webp?size=80" alt=" ">'
    + '<h3 class="header_aa"><span class="username_aa">Fox</span> <span class="timestamp_aa"><time>Today at 17:00</time></span></h3>'
    + '<div class="markup__75297">Hi <span class="emojiContainer_aa"><img class="emoji" src="https://discord.com/assets/abc.svg" alt="👋🏽"></span>'
    + ' <img class="emoji" src="https://cdn.discordapp.com/emojis/123.webp?size=48" alt=":blobfox:"></div></li>';
  assert.equal(paste(html), '<ul><li>Fox Today at 17:00<br>Hi 👋🏽 :blobfox:</li></ul>');
  // From any site: an emoji picture is its emoji; a photo is still a picture.
  assert.equal(paste('<p>Yay <img src="https://example.org/1f389.png" alt="🎉"> <img src="https://example.org/photo.jpg" alt="Our venue"></p>'),
    '<p>Yay 🎉 <img data-pending-src="https://example.org/photo.jpg" alt=""></p>');
  // A picture sent in a Discord message is still copied into the gallery.
  assert.equal(paste('<div class="markup__75297">Look</div><img src="https://media.discordapp.net/attachments/1/2/venue.png" alt="venue.png">'),
    '<p>Look</p><p><img data-pending-src="https://media.discordapp.net/attachments/1/2/venue.png" alt=""></p>');
});

test('a Telegram Web message keeps its formatting, without the theme', () => {
  const html = '<div class="translatable-message" style="color: rgb(255, 255, 255); background-color: rgb(33, 33, 33); font-family: Roboto, sans-serif; white-space: pre-wrap;">'
    + '<b data-entity-type="MessageEntityBold">Furmeet</b> this <i>Saturday</i>\n'
    + '<code class="text-entity-code">Room 4</code>, <a class="text-entity-link" href="https://example.org/map">map</a> '
    + '<img class="custom-emoji emoji" alt="🦊" data-document-id="5"></div>';
  assert.equal(paste(html), '<p><strong>Furmeet</strong> this <em>Saturday</em><br><span style="font-family: monospace">Room 4</span>, '
    + '<a href="https://example.org/map">map</a> 🦊</p>');
});

test('a copy from any dark-themed page loses its light grey on dark grey, but chosen colours stay', () => {
  assert.equal(paste('<span style="color: rgb(230, 230, 230); background-color: rgb(24, 24, 24)">Dark site</span>'), '<p>Dark site</p>');
  assert.equal(paste('<span style="color: #ffffff; background-color: #c8285a">Chosen</span>'),
    '<p><span style="color: #ffffff; background-color: #c8285a">Chosen</span></p>');
  assert.equal(paste('<span style="background-color: #ffff00">Highlight</span>'),
    '<p><span style="color: #111111; background-color: #ffff00">Highlight</span></p>');
});

test('Discord\'s markdown, from Copy Text, becomes formatting', () => {
  const text = '# Furmeet\n## Where\n**Bold** *italic* _also italic_ __underline__ ~~gone~~ ***both*** ||spoiler|| `code`\n'
    + '-# small print\n\n> quoted\n> more\n\n- one\n- two\n  - nested\n1. first\n2. second\n\n'
    + '```js\nconst a = 1;\nconsole.log(a);\n```\n'
    + 'See [the map](https://example.org/map) or <https://example.org/a> or https://example.org/b. <:blobfox:12345678> \\*not italic\\*';
  assert.equal(pasteText(text), '<h2>Furmeet</h2><h3>Where</h3>'
    + '<p><strong>Bold</strong> <em>italic</em> <em>also italic</em> <u>underline</u> <s>gone</s> <strong><em>both</em></strong> spoiler '
    + '<span style="font-family: monospace">code</span><br>small print</p>'
    + '<blockquote><p>quoted<br>more</p></blockquote>'
    + '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol><li>first</li><li>second</li></ol>'
    + '<p><span style="font-family: monospace">const a = 1;<br>console.log(a);</span></p>'
    + '<p>See <a href="https://example.org/map">the map</a> or <a href="https://example.org/a">https://example.org/a</a> or '
    + '<a href="https://example.org/b">https://example.org/b</a>. :blobfox: *not italic*</p>');
  // >>> quotes the rest of the message.
  assert.equal(pasteText('Intro\n>>> all\nof this'), '<p>Intro</p><blockquote><p>all<br>of this</p></blockquote>');
  // A numbered list keeps where it starts.
  assert.equal(pasteText('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>');
});

test('Telegram Desktop\'s plain text: its written-out links become links', () => {
  assert.equal(pasteText('Tickets (https://example.org/tickets?a=1&b=2)\nSee you!'),
    '<p>Tickets (<a href="https://example.org/tickets?a=1&amp;b=2">https://example.org/tickets?a=1&amp;b=2</a>)<br>See you!</p>');
});

test('plain text without markdown is pasted as it always was', () => {
  for (const text of ['Just words', 'Two\nlines\n\nand a paragraph', '2*3*4 = 24', 'my_snake_case_name', 'a * b * c', '#hashtag', 'price: $5 ~ $10', '10.30 pm']) {
    assert.equal(markdownToHtml(text), null, text);
  }
  // Text is always escaped.
  assert.equal(pasteText('**<script>alert(1)</script>**'), '<p><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong></p>');
  assert.equal(pasteText('[x](javascript:alert(1)) **y**'), '<p>[x](javascript:alert(1)) <strong>y</strong></p>');
  // A long line of marks is quick.
  const started = Date.now();
  markdownToHtml(`${'*a '.repeat(1300)}\n${'_'.repeat(3900)}`);
  assert.ok(Date.now() - started < 1000);
});
