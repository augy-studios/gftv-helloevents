// What the end-to-end tests put in place of outside services, shared by the
// browser side (fixtures.js) and the server side (server.js) so the two
// halves of each stub agree.
//
// Turnstile: the server runs with Cloudflare's published test keys, which
// can never check a real token, and answers siteverify itself. In the
// browser, Cloudflare's script is replaced by TURNSTILE_SCRIPT below, which
// draws no iframe and hands the page a token at once: the callback the page
// gave render() gets "e2e-turnstile-pass.<action>.<count>", and every reset()
// hands out the next one, the way the real widget runs a new challenge.

export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

// A token from TURNSTILE_SCRIPT, with the action it was made for.
export const PASSING_TOKEN = /^e2e-turnstile-pass\.([a-z-]*)\.\d+$/;

// Served for https://challenges.cloudflare.com/turnstile/v0/api.js. It marks
// the container with the site key it was drawn with, so a test can see the
// page drew the widget.
export const TURNSTILE_SCRIPT = `
(function () {
  var widgets = {};
  var count = 0;
  function issue(id) {
    var widget = widgets[id];
    if (!widget) {
      return;
    }
    widget.issued += 1;
    var action = '';
    if (widget.options.action) {
      action = widget.options.action;
    }
    var token = 'e2e-turnstile-pass.' + action + '.' + widget.issued;
    widget.token = token;
    if (typeof widget.options.callback === 'function') {
      widget.options.callback(token);
    }
  }
  window.turnstile = {
    render: function (container, options) {
      count += 1;
      var id = 'e2e-widget-' + count;
      var element = container;
      if (typeof container === 'string') {
        element = document.querySelector(container);
      }
      if (element) {
        element.setAttribute('data-e2e-turnstile', options.sitekey);
      }
      widgets[id] = { options: options, issued: 0, token: null };
      issue(id);
      return id;
    },
    reset: function (id) {
      issue(id);
    },
    remove: function (id) {
      delete widgets[id];
    },
    getResponse: function (id) {
      if (!widgets[id]) {
        return undefined;
      }
      return widgets[id].token;
    }
  };
})();
`;
