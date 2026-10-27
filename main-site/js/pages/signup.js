// Create a public account. Signs in on success and goes on to ?next= or the
// account page, where 2FA and notifications can be switched on.

import { session } from '../app.js';
import { post } from '../api.js';
import { withBusy } from '../ui.js';
import { humanCheck } from '../turnstile.js';

const $ = (id) => document.getElementById(id);
const check = humanCheck($('humanCheck'), 'signup');

function nextPath() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(next) && !/^\/(login|signup|reset)/.test(next) ? next : '/account';
}

session.then((s) => { if (s.signedIn) location.replace(nextPath()); });

// Usernames are lowercase; help people get there as they type.
$('username').addEventListener('input', () => {
  const v = $('username').value;
  const clean = v.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (clean !== v) $('username').value = clean;
});

$('signupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy($('signupSubmit'), $('signupError'), async () => {
    try {
      await post('/api/auth/signup', {
        username: $('username').value,
        displayName: $('displayName').value,
        email: $('email').value,
        password: $('password').value,
        agree: $('agree').checked,
        humanCheck: await check.token(),
      });
      $('password').value = '';
      location.replace(nextPath());
    } finally {
      check.reset();
    }
  });
});
