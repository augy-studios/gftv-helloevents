// Environment access in one place, so a missing variable fails with its name
// rather than as an undefined somewhere downstream. See .env.example.

export function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing environment variable ${name}`);
  }
  return value.trim();
}

export function optionalEnv(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

// The public origin. Every state-changing request must come from it, and
// passkeys are bound to it unless WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN say
// otherwise.
export function siteUrl() {
  return optionalEnv('SITE_URL', 'https://events.globalfurry.tv').replace(/\/+$/, '');
}

export function siteOrigin() {
  return new URL(siteUrl()).origin;
}

export function siteHost() {
  return new URL(siteUrl()).host;
}
