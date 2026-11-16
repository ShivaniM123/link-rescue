/**
 * Server-side link check, for sites that hide page status from the browser (e.g. bit.ly).
 * Uses this site's Cloudflare Worker (worker/link-check.js), which loads the page on
 * Cloudflare's servers and returns the real status. Free plan: about 100,000 checks a day.
 * `?checker=https://…workers.dev` on the panel address uses a different Worker.
 * Only links the browser can't check are sent, and answers are remembered for a day.
 */

const DEFAULT_WORKER = 'https://link-rescue.shanukakhani.workers.dev';
const CACHE_KEY = 'link-rescue:checks';
const DAY = 24 * 60 * 60 * 1000;

/** The link-check Worker to use. */
function workerUrl() {
  const value = new URLSearchParams(window.location.search).get('checker') || DEFAULT_WORKER;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : DEFAULT_WORKER;
  } catch {
    return DEFAULT_WORKER;
  }
}

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

function remember(url, result) {
  const store = load();
  store.urls[url] = { at: Date.now(), result };
  // A working page reached by a redirect is known to work too, e.g. after it's suggested as a fix.
  if (result.status < 400 && result.finalUrl && result.finalUrl !== url) {
    const { status, finalUrl } = result;
    store.urls[finalUrl] = { at: Date.now(), result: { status, finalUrl } };
  }
  save(store);
}

/**
 * Asks the link-check Worker for the real status of a page.
 * @param {string} url The address to check
 * @returns {Promise<object>} One of:
 *   `{ status, finalUrl }` the page answered,
 *   `{ unreachable: true }` the site can't be reached,
 *   `{ timedOut: true }` the site didn't answer in time,
 *   `{ failed: true }` the Worker couldn't be reached
 */
export default async function remoteCheck(url) {
  const cached = load().urls[url];
  if (cached && Date.now() - cached.at < DAY) return cached.result;
  try {
    const resp = await fetch(`${workerUrl()}/check?${new URLSearchParams({ url })}`, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return { failed: true, reason: `the link check answered ${resp.status}` };
    const json = await resp.json();
    if (json.timeout) return { timedOut: true };
    let result;
    if (json.status) result = { status: json.status, finalUrl: json.finalUrl || url };
    else if (json.unreachable) result = { unreachable: true };
    else return { failed: true, reason: 'the link check gave no status' };
    remember(url, result);
    return result;
  } catch (e) {
    return { failed: true, reason: `the link check couldn't be reached (${e.name}: ${e.message})` };
  }
}
