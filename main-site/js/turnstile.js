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

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// The JSON field the token goes in, Cloudflare's own name for it.
export const TOKEN_FIELD = 'cf-turnstile-response';

let keyPromise = null;
let scriptPromise = null;

// The site key, or null when the site has none. Asked for once; a failed
// request is asked again next time.
function siteKey() {
  if (keyPromise === null || keyPromise === undefined) {
    keyPromise = api('/api/public/config')
      .then((config) => {
        if (config.turnstileSiteKey) {
          return config.turnstileSiteKey;
        }
        return null;
      })
      .catch(() => {
        keyPromise = null;
        return null;
      });
  }
  return keyPromise;
}

// Cloudflare's script, loaded once; a failed load is tried again next time.
function loadScript() {
  if (scriptPromise === null || scriptPromise === undefined) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.turnstile) {
          resolve(window.turnstile);
        } else {
          reject(new Error('turnstile'));
        }
      };
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(new Error('turnstile'));
      };
      document.head.append(script);
    });
  }
  return scriptPromise;
}

const mode = () => {
  if (document.documentElement.getAttribute('data-mode') === 'dark') {
    return 'dark';
  }
  return 'light';
};

// A widget in container, for the container's data-action ("login",
// "signup", "reset"; the server checks the token was made for it) unless an
// action is given.
// Returns
//   fields()  the body fields to add to the request: {} when the site has
//             no key (send nothing), or throws human_check_pending while
//             the check is not ready;
//   reset()   after every submit, since a token works only once.
export function humanCheck(container, action) {
  let widgetAction = action;
  if (widgetAction === undefined && container !== null && container !== undefined) {
    widgetAction = container.dataset.action;
  }
  let widgetId = null;
  let currentToken = null;
  let drawnInMode = null;
  let enabled = false;

  // Once the site key and Cloudflare's script are in, draws the widget, and
  // draws it again whenever the page switches between light and dark.
  // Without a key or a container nothing is drawn, and fields() sends nothing.
  const ready = (async () => {
    const key = await siteKey();
    if (!key || !container) {
      return;
    }
    enabled = true;
    const turnstile = await loadScript();
    // Draws the widget in the page's mode, replacing one drawn in the other.
    const draw = () => {
      if (drawnInMode === mode()) {
        return;
      }
      if (widgetId !== null) {
        turnstile.remove(widgetId);
      }
      currentToken = null;
      drawnInMode = mode();
      widgetId = turnstile.render(container, {
        sitekey: key,
        action: widgetAction,
        theme: drawnInMode,
        size: 'flexible',
        callback: (token) => {
          currentToken = token;
        },
        'expired-callback': () => {
          currentToken = null;
        },
        'error-callback': () => {
          currentToken = null;
        },
      });
    };
    draw();
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  })().catch(() => {});

  return {
    async fields() {
      await ready;
      if (!enabled) {
        return {};
      }
      if (!currentToken) {
        throw new ApiError('human_check_pending', 0);
      }
      return { [TOKEN_FIELD]: currentToken };
    },
    reset() {
      currentToken = null;
      if (widgetId !== null && window.turnstile) {
        window.turnstile.reset(widgetId);
      }
    },
  };
}
