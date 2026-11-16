/**
 * Link Rescue link-check service: a Cloudflare Worker.
 *
 * Browsers can't read the status of pages on sites like bit.ly (they don't send CORS headers).
 * This Worker loads the page on Cloudflare's servers and returns the real status to the panel.
 *
 *   GET /check?url=https://bit.ly/abc
 *   → { "status": 404, "finalUrl": "https://bit.ly/abc" }
 *   → { "unreachable": true }            the site can't be reached
 *
 * Free plan: 100,000 requests a day. On a custom domain, answers are also cached for an hour
 * (Cloudflare's cache has no effect on workers.dev addresses; the panel caches answers itself).
 * Paste this whole file into a new Worker in the Cloudflare dashboard (see worker/README.md).
 */

// Only Link Rescue may call this: in Experience Workspace, on Edge Delivery sites,
// or in local development.
const ALLOWED_ORIGINS = [
  /^https:\/\/da\.live$/,
  /^https:\/\/[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(page|live)$/,
  /^http:\/\/localhost(:\d+)?$/,
];

const TIMEOUT_MS = 10000;
const CACHE_SECONDS = 3600;

// Never let the Worker be used to reach private or internal addresses.
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.some((re) => re.test(origin));
  return allowed ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  } : {};
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...extra },
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
    return { status: resp.status, finalUrl: resp.url || target };
  } catch (e) {
    return e.name === 'AbortError' ? { timeout: true } : { unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (origin && !ALLOWED_ORIGINS.some((re) => re.test(origin))) {
      return json({ error: 'This origin may not use the link check.' }, 403, origin);
    }

    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/' || pathname === '/status') return json({ ok: true, service: 'link-rescue-check' }, 200, origin);
    if (pathname !== '/check' || request.method !== 'GET') return json({ error: 'Use GET /check?url=…' }, 404, origin);

    let target;
    try {
      target = new URL(searchParams.get('url') || '');
    } catch {
      return json({ error: 'Pass a full web address in ?url=' }, 400, origin);
    }
    if (!/^https?:$/.test(target.protocol) || BLOCKED_HOSTS.some((re) => re.test(target.hostname))) {
      return json({ error: 'Only public web addresses can be checked.' }, 400, origin);
    }

    // Cached answers keep the Worker fast (works on a custom domain; a no-op on workers.dev).
    const cache = caches.default;
    const cacheKey = new Request(`https://link-rescue-cache/${encodeURIComponent(target.href)}`);
    const cached = await cache.match(cacheKey);
    if (cached) return json(await cached.json(), 200, origin, { 'X-Cache': 'hit' });

    const result = await checkUrl(target.href);
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
      headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` },
    })));
    return json(result, 200, origin, { 'X-Cache': 'miss' });
  },
};
