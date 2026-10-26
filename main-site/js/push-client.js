// Web Push in the browser: asking permission, subscribing this device with
// the site's VAPID public key, and unsubscribing. The service worker (sw.js)
// shows what arrives.

const fail = (code) => Object.assign(new Error(code), { code });

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  // The update bar registers the worker on load; wait for it, but not forever.
  const ready = navigator.serviceWorker.ready;
  const late = new Promise((_, reject) => setTimeout(() => reject(fail('push_no_worker')), 8000));
  return Promise.race([ready, late]);
}

// This device's subscription, or null. Answers at once: no waiting for a
// worker that may never register (some private windows).
export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

// The subscription as JSON for the server, after asking permission.
export async function subscribeDevice(publicKey) {
  if (!pushSupported()) throw fail('push_unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw fail('push_denied');
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  return sub.toJSON();
}

// The endpoint that was removed, or null.
export async function unsubscribeDevice() {
  const sub = await currentSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
