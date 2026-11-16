/**
 * Microlink link check (https://microlink.io/docs/api/getting-started/overview).
 * Some sites hide page status from the browser. Microlink loads the page on its servers and
 * returns the real status, so a 404 on a site like bit.ly can be confirmed.
 * The free plan needs no key but allows only a few requests a day for each visitor,
 * so answers are cached for a day and only links the browser can't confirm are sent.
 */

const API = 'https://api.microlink.io/';
const CACHE_KEY = 'link-rescue:microlink';
const DAY = 24 * 60 * 60 * 1000;
const UNREACHABLE = ['EUNREACHABLE', 'ETIMEOUT', 'ENOTFOUND', 'EHOSTUNREACH'];

function load() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || { urls: {} };
  } catch {
    return { urls: {} };
  }
}

function save(store) {
  const now = Date.now();
  Object.entries(store.urls).forEach(([url, entry]) => {
    if (now - entry.at > DAY) delete store.urls[url];
  });
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // Storage is full or blocked: checks still work, they just aren't remembered.
  }
}

/**
 * Asks Microlink for the real status of a page.
 * @param {string} url The address to check
 * @returns {Promise<object>} One of:
 *   `{ status, finalUrl }` the page answered,
 *   `{ unreachable: true }` the site can't be reached,
 *   `{ limited: true }` today's free checks are used up,
 *   `{ failed: true }` the check didn't work
 */
export default async function remoteCheck(url) {
  const store = load();
  const cached = store.urls[url];
  if (cached && Date.now() - cached.at < DAY) return cached.result;
  if (store.limitedUntil && Date.now() < store.limitedUntil) return { limited: true };

  let resp;
  let json;
  try {
    resp = await fetch(`${API}?${new URLSearchParams({ url })}`, { signal: AbortSignal.timeout(30000) });
    json = await resp.json();
  } catch {
    return { failed: true };
  }

  if (resp.status === 429 || json.code === 'ERATE') {
    const reset = Number(resp.headers.get('x-rate-limit-reset'));
    store.limitedUntil = reset ? reset * 1000 : Date.now() + DAY;
    save(store);
    return { limited: true };
  }

  let result;
  if (json.status === 'success' && json.statusCode) {
    result = { status: json.statusCode, finalUrl: json.data?.url || url };
  } else if (UNREACHABLE.includes(json.code)) {
    result = { unreachable: true };
  } else {
    return { failed: true };
  }
  store.urls[url] = { at: Date.now(), result };
  save(store);
  return result;
}
