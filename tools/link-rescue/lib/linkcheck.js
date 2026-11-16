/**
 * Server-side link check, for sites that hide page status from the browser (e.g. bit.ly).
 *
 * - Your own link-check Worker (worker/link-check.js), when the panel address has
 *   `?checker=https://link-rescue.<you>.workers.dev`. Free plan: ~100,000 checks a day.
 * - Otherwise Microlink (https://microlink.io/), whose free plan needs no key but allows
 *   only a few requests a day for each visitor.
 * Answers are cached for a day and only links the browser can't confirm are sent.
 */

const API = 'https://api.microlink.io/';

/** The link-check Worker set on the panel address, if any. */
function workerUrl() {
  const value = new URLSearchParams(window.location.search).get('checker');
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function askWorker(base, url) {
  try {
    const resp = await fetch(`${base}/check?${new URLSearchParams({ url })}`, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return { failed: true };
    const json = await resp.json();
    if (json.status) return { status: json.status, finalUrl: json.finalUrl || url };
    if (json.unreachable) return { unreachable: true };
    return { failed: true };
  } catch {
    return { failed: true };
  }
}
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

function remember(store, url, result) {
  store.urls[url] = { at: Date.now(), result };
  // A working page reached by a redirect is known to work too, e.g. after it's suggested as a fix.
  if (result.status < 400 && result.finalUrl && result.finalUrl !== url) {
    const { status, finalUrl } = result;
    store.urls[finalUrl] = { at: Date.now(), result: { status, finalUrl } };
  }
  save(store);
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

  const worker = workerUrl();
  if (worker) {
    const answer = await askWorker(worker, url);
    if (!answer.failed) remember(store, url, answer);
    return answer;
  }

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
  remember(store, url, result);
  return result;
}
