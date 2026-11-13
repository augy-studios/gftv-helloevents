// The one way the browser talks to /api. JSON in, JSON out, cookies sent,
// and a failure always arrives as an ApiError carrying the server's code
// (or "offline"), which ui.js turns into a sentence in the reader's language.

// detail: the rest of the server's answer ({ field } for a form field the
// server refused).
export class ApiError extends Error {
  constructor(code, status, detail = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const fetchOptions = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, keepalive };
  if (body !== undefined) {
    fetchOptions.headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, fetchOptions);
  } catch {
    throw new ApiError('offline', 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* not JSON: handled below */
  }
  if (!response.ok || !data || data.ok === false) {
    // The server's own error code when it sent one; otherwise "offline" for
    // a 503 and "generic" for anything else.
    let code;
    if (data && data.error) {
      code = data.error;
    } else if (response.status === 503) {
      code = 'offline';
    } else {
      code = 'generic';
    }
    let detail = data;
    if (!detail) {
      detail = {};
    }
    throw new ApiError(code, response.status, detail);
  }
  return data;
}

export const post = (path, body) => api(path, { method: 'POST', body });
