// Rich text in the browser: js/rich-text.js's rules run over the browser's
// own DOM. Used by the event page (showing a description), the edit form's
// editor (rich-editor.js: showing a saved description, and pasting) and the
// picture picker.
//
// HTML is always read with DOMParser, which builds an inert document: no
// script runs and no picture loads while it is read. What goes into the page
// is the HTML js/rich-text.js built from it, which holds only its own short
// list of elements and attributes.

import { cleanRichTree } from './rich-text.js';

const ADAPTER = {
  type(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return 'text';
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      return 'element';
    }
    return 'other';
  },
  tag(node) {
    return node.localName.toLowerCase();
  },
  attr(node, name) {
    return node.getAttribute(name);
  },
  children(node) {
    let parent = node;
    if (node.localName === 'template') {
      parent = node.content;
    }
    return [...parent.childNodes];
  },
  text(node) {
    return node.data;
  },
};

// Clean HTML for html, in mode ('render' or 'paste'; options as
// cleanRichTree takes them). Returns cleanRichTree's answer.
export function cleanHtml(html, options) {
  const document = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  return cleanRichTree(document.body, ADAPTER, options);
}

// The same for a live element (the editor itself).
export function cleanElement(element, options) {
  return cleanRichTree(element, ADAPTER, options);
}

// The site's Content-Security-Policy does not let HTML set style
// attributes, so a description's colours, fonts, sizes, alignment and
// indents (all from js/rich-text.js's short list) are applied again through
// the element's style object, which the policy allows.
export function applyInlineStyles(root) {
  for (const element of root.querySelectorAll('[style]')) {
    const text = element.getAttribute('style');
    element.style.cssText = text;
  }
}

// Clean HTML as DOM nodes, ready to go into a page.
export function richFragment(cleanedHtml) {
  const template = document.createElement('template');
  template.innerHTML = cleanedHtml;
  applyInlineStyles(template.content);
  return template.content;
}

// Whether this browser plays WebM video with its transparency. Safari (and
// every browser on an iPhone or iPad, which all use Safari's engine) does
// not, so it gets each video sticker's still picture.
export function playsTransparentWebm() {
  if (navigator.vendor === 'Apple Computer, Inc.') {
    return false;
  }
  const probe = document.createElement('video');
  return probe.canPlayType('video/webm; codecs="vp9"') !== '';
}

// Each video sticker (an <img class="rich-sticker" data-video>) in root as a
// looping, muted video, where this browser plays it; its still picture
// stays as the video's poster and as the fallback. editable: the editor, which
// keeps a video's still and id on it so the editor's HTML can be read back.
export function playStickers(root) {
  if (!playsTransparentWebm()) {
    return;
  }
  for (const image of root.querySelectorAll('img.rich-sticker[data-video]')) {
    const video = document.createElement('video');
    video.className = 'rich-sticker';
    video.src = image.getAttribute('data-video');
    video.poster = image.getAttribute('src');
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    for (const name of ['width', 'height', 'data-sticker-id']) {
      if (image.hasAttribute(name)) {
        video.setAttribute(name, image.getAttribute(name));
      }
    }
    video.setAttribute('data-still', image.getAttribute('src'));
    // A video that will not play falls back to the still picture.
    video.addEventListener('error', () => video.replaceWith(image), { once: true });
    image.replaceWith(video);
  }
}

// Shows a description the server sent (rich text, its pictures as this
// site's addresses) in container.
export function renderRichText(container, html) {
  const cleaned = cleanHtml(html, { mode: 'render' });
  container.replaceChildren(richFragment(cleaned.html));
  playStickers(container);
}
