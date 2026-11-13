// Create a public account. Signs in on success and goes on to ?next= or the
// account page, where 2FA and notifications can be switched on.

import { session } from '../app.js';
import { post } from '../api.js';
import { withBusy } from '../ui.js';
import { humanCheck } from '../turnstile.js';

const byId = (id) => document.getElementById(id);
const check = humanCheck(byId('humanCheck'));

// Only a path on this site, and not back to sign-in, sign-up or reset.
function nextPath() {
  let next = new URLSearchParams(location.search).get('next');
  if (!next) {
    next = '';
  }
  if (/^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(next) && !/^\/(login|signup|reset)/.test(next)) {
    return next;
  }
  return '/account';
}

session.then((currentSession) => {
  if (currentSession.signedIn) {
    location.replace(nextPath());
  }
});

// Usernames are lowercase; help people get there as they type.
byId('username').addEventListener('input', () => {
  const typed = byId('username').value;
  const clean = typed.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (clean !== typed) {
    byId('username').value = clean;
  }
});

byId('signupForm').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(byId('signupSubmit'), byId('signupError'), async () => {
    try {
      await post('/api/auth/signup', {
        username: byId('username').value,
        displayName: byId('displayName').value,
        email: byId('email').value,
        password: byId('password').value,
        agree: byId('agree').checked,
        ...(await check.fields()),
      });
      byId('password').value = '';
      location.replace(nextPath());
    } finally {
      check.reset();
    }
  });
});
