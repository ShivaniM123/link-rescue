/**
 * Link Rescue link-check service: a Cloudflare Worker.
 *
 * Loads a link on Cloudflare's servers and returns its real status, so Link Rescue can tell
 * a working link (200) from a broken one (404) on any site, including ones like bit.ly that
 * hide the status from the browser.
 *
 *   GET /check?url=https://bit.ly/abc
 *   → { "status": 404, "finalUrl": "https://bit.ly/abc" }
 *   → { "unreachable": true }            the site can't be reached
 *   → { "timeout": true }                the site didn't answer in time
 *
 * It answers any page (Experience Workspace loads extensions from its own addresses), returns
 * only a status code, and refuses private or internal addresses.
 * Free plan: 100,000 requests a day.
 * Paste this whole file into the Worker in the Cloudflare dashboard (see worker/README.md).
 */

const TIMEOUT_MS = 10000;
const CACHE_SECONDS = 3600;

// Never let the Worker be used to reach private or internal addresses.
const BLOCKED_HOSTS = [
  /^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i,
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./,
  /^\[?::1\]?$/, /^\[?f[cd][0-9a-f]{2}:/i, /^\[?fe80:/i,
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

async function checkUrl(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkRescue/1.0; +https://www.aem.live/)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    // Only the status is needed: don't download the page.
    resp.body?.cancel();
    // Cloudflare's own codes when it can't reach a site (530: the domain doesn't exist).
    if ([521, 522, 523, 525, 526, 530].includes(resp.status)) return { unreachable: true };
    return { status: resp.status, finalUrl: resp.url || target };
  } catch (e) {
    return e.name === 'AbortError' ? { timeout: true } : { unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/' || pathname === '/status') return json({ ok: true, service: 'link-rescue-check', version: 2 });
    if (pathname !== '/check' || request.method !== 'GET') return json({ error: 'Use GET /check?url=…' }, 404);

    let target;
    try {
      target = new URL(searchParams.get('url') || '');
    } catch {
      return json({ error: 'Pass a full web address in ?url=' }, 400);
    }
    if (!/^https?:$/.test(target.protocol) || BLOCKED_HOSTS.some((re) => re.test(target.hostname))) {
      return json({ error: 'Only public web addresses can be checked.' }, 400);
    }

    // Cached answers keep the Worker fast (works on a custom domain; a no-op on workers.dev).
    // `fresh=1` (sent by "Check again") skips the cache.
    const cache = caches.default;
    const cacheKey = new Request(`https://link-rescue-cache/${encodeURIComponent(target.href)}`);
    if (searchParams.get('fresh') !== '1') {
      const cached = await cache.match(cacheKey);
      if (cached) return json(await cached.json(), 200, { 'X-Cache': 'hit' });
    }

    const result = await checkUrl(target.href);
    if (!result.timeout) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
        headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` },
      })));
    }
    return json(result, 200, { 'X-Cache': 'miss' });
  },
};
