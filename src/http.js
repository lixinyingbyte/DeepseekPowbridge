export async function httpRequest(url, opts) {
  const options = opts || {};
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body == null ? null : options.body;
  const timeoutMs = options.timeoutMs || 120000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
