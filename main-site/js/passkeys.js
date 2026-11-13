// The browser half of passkeys: turning the server's JSON options into what
// navigator.credentials expects, and the result back into JSON. Written out
// by hand rather than vendoring a library; it is two conversions.

export function passkeysSupported() {
  if (typeof window.PublicKeyCredential !== 'function') {
    return false;
  }
  const credentials = navigator.credentials;
  if (credentials === null || credentials === undefined) {
    return false;
  }
  if (typeof credentials.create === 'function') {
    return true;
  }
  return false;
}

function fromBase64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A list of credentials from the server with each id turned into bytes; an
// absent list (null or undefined) is an empty one.
function credentialList(list) {
  let credentials = list;
  if (credentials === null || credentials === undefined) {
    credentials = [];
  }
  return credentials.map((item) => ({ ...item, id: fromBase64url(item.id) }));
}

// The browser gives null when it does not know how the authenticator is
// attached; that is sent as undefined, so JSON leaves the field out.
function attachmentOf(credential) {
  const attachment = credential.authenticatorAttachment;
  if (attachment === null) {
    return undefined;
  }
  return attachment;
}

// Adds a passkey: asks the browser to make one from the server's options,
// and returns the result as the JSON the server checks.
export async function createPasskey(options) {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: credentialList(options.excludeCredentials),
    },
  });
  if (!credential) {
    throw new Error('no credential');
  }
  // getTransports() is missing in some browsers; then the list is empty.
  let transports;
  if (credential.response.getTransports !== null && credential.response.getTransports !== undefined) {
    transports = credential.response.getTransports();
  }
  if (transports === null || transports === undefined) {
    transports = [];
  }
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: attachmentOf(credential),
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      attestationObject: toBase64url(credential.response.attestationObject),
      transports,
    },
  };
}

// Signs in with a passkey: asks the browser for one of the server's allowed
// credentials, and returns the signed answer as the JSON the server checks.
export async function usePasskey(options) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      allowCredentials: credentialList(options.allowCredentials),
    },
  });
  if (!assertion) {
    throw new Error('no assertion');
  }
  let userHandle;
  if (assertion.response.userHandle) {
    userHandle = toBase64url(assertion.response.userHandle);
  }
  return {
    id: assertion.id,
    rawId: toBase64url(assertion.rawId),
    type: assertion.type,
    clientExtensionResults: assertion.getClientExtensionResults(),
    authenticatorAttachment: attachmentOf(assertion),
    response: {
      clientDataJSON: toBase64url(assertion.response.clientDataJSON),
      authenticatorData: toBase64url(assertion.response.authenticatorData),
      signature: toBase64url(assertion.response.signature),
      userHandle,
    },
  };
}

// The person closed the prompt, or it timed out, or the browser refused to
// show it. Browsers report all three as NotAllowedError.
export function wasCancelled(error) {
  if (error === null || error === undefined) {
    return false;
  }
  if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
    return true;
  }
  return false;
}

// The error code to show for a failed passkey prompt, so the page always says
// what happened rather than going quiet. An error already carrying a server
// code is passed through. The browser's own reason goes to the console, which
// is the first thing to look at when a passkey will not work on a device.
export function passkeyErrorCode(error) {
  let errorName;
  let errorMessage;
  if (error !== null && error !== undefined) {
    if (error.code) {
      return error.code;
    }
    errorName = error.name;
    errorMessage = error.message;
  }
  console.warn('[passkey]', errorName, errorMessage);
  if (wasCancelled(error)) {
    return 'passkey_cancelled';
  }
  if (errorName === 'InvalidStateError') {
    return 'passkey_exists';
  }
  return 'passkey_failed';
}
