// Web Push in the browser: asking permission, subscribing this device with
// the site's VAPID public key, and unsubscribing. The service worker (sw.js)
// shows what arrives.

const fail = (code) => Object.assign(new Error(code), { code });

export function pushSupported() {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
    return true;
  }
  return false;
}

function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function waitForRegistration() {
  // The update bar registers the worker on load; wait for it, but not forever.
  const ready = navigator.serviceWorker.ready;
  const tooLate = new Promise((resolve, reject) => setTimeout(() => reject(fail('push_no_worker')), 8000));
  return Promise.race([ready, tooLate]);
}

// This device's subscription, or null. Answers at once: no waiting for a
// worker that may never register (some private windows).
export async function currentSubscription() {
  if (!pushSupported()) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      return await registration.pushManager.getSubscription();
    }
    return null;
  } catch {
    return null;
  }
}

// The subscription as JSON for the server, after asking permission. A device
// already subscribed keeps its subscription.
export async function subscribeDevice(publicKey) {
  if (!pushSupported()) {
    throw fail('push_unsupported');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw fail('push_denied');
  }
  const registration = await waitForRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription === null || subscription === undefined) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  }
  return subscription.toJSON();
}

// The endpoint that was removed, or null.
export async function unsubscribeDevice() {
  const subscription = await currentSubscription();
  if (!subscription) {
    return null;
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
