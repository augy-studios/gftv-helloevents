// Cloudflare Turnstile, the "are you a person" check on the public forms:
// sign-in, sign-up and starting a password reset (api/_lib/turnstile.js).
// The same module as gftv-linktree, plus the action taken from the markup.
//
// Each form has a container in its HTML:
//   <div class="human-check cf-turnstile" id="humanCheck" data-action="login"></div>
// Cloudflare's script (api.js, rendered explicitly so the widget can be reset
// after every try) loads only when such a form is shown, and only when the
// site hands out a site key (/api/public/config). Without one (a local or
// preview deploy with no TURNSTILE_SECRET) no widget is drawn, nothing is
// sent, and the server skips the check too. The widget follows the page's
// light or dark mode, drawn again when the mode changes.

import { api, ApiError } from './api.js';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// The JSON field the token goes in, Cloudflare's own name for it.
export const TOKEN_FIELD = 'cf-turnstile-response';

let keyPromise = null;
let scriptPromise = null;

function siteKey() {
  keyPromise ??= api('/api/public/config').then((d) => d.turnstileSiteKey || null).catch(() => {
    keyPromise = null;
    return null;
  });
  return keyPromise;
}

function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error('turnstile'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

const mode = () => (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light');

// A widget in container, for the container's data-action ("login",
// "signup", "reset"; the server checks the token was made for it).
// Returns
//   fields()  the body fields to add to the request: {} when the site has
//             no key (send nothing), or throws human_check_pending while
//             the check is not ready;
//   reset()   after every submit, since a token works only once.
export function humanCheck(container, action = container?.dataset.action) {
  let widget = null;
  let current = null;
  let drawnIn = null;
  let enabled = false;

  const ready = (async () => {
    const key = await siteKey();
    if (!key || !container) return;
    enabled = true;
    const turnstile = await loadScript();
    const draw = () => {
      if (drawnIn === mode()) return;
      if (widget !== null) turnstile.remove(widget);
      current = null;
      drawnIn = mode();
      widget = turnstile.render(container, {
        sitekey: key,
        action,
        theme: drawnIn,
        size: 'flexible',
        callback: (token) => { current = token; },
        'expired-callback': () => { current = null; },
        'error-callback': () => { current = null; },
      });
    };
    draw();
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  })().catch(() => {});

  return {
    async fields() {
      await ready;
      if (!enabled) return {};
      if (!current) throw new ApiError('human_check_pending', 0);
      return { [TOKEN_FIELD]: current };
    },
    reset() {
      current = null;
      if (widget !== null && window.turnstile) window.turnstile.reset(widget);
    },
  };
}
