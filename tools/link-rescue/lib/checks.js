/**
 * Checks links and suggests fixes.
 * Internal links: the site's publishing status (admin.hlx.page) and its source (admin.da.live).
 * External links: browser requests, plus the Wayback Machine for archived copies.
 */
import { toSourcePath, toWebPath, modernizeLegacy } from './links.js';
import findSnapshot from './wayback.js';
import remoteCheck from './linkcheck.js';

const TIMEOUT = 10000;
const pageListCache = new Map();

export function formatDate(date) {
  if (!date) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function result(severity, label, message, extra = {}) {
  return {
    severity, label, message, suggestions: [], ...extra,
  };
}

/**
 * A suggested new address.
 * `safe` fixes keep readers on the same content, so they can be applied in bulk.
 */
function replaceWith(label, to, note, safe = true) {
  return {
    type: 'replace', label, to, note, safe,
  };
}

/* ---------- internal pages ---------- */

async function pageStatus(webPath, ctx, fetcher) {
  const url = `https://admin.hlx.page/status/${ctx.org}/${ctx.repo}/${ctx.branch || 'main'}${webPath}`;
  const resp = await fetcher(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  return {
    live: json.live?.status,
    preview: json.preview?.status,
    redirect: json.live?.redirectLocation || json.preview?.redirectLocation,
  };
}

async function sourceExists(webPath, ctx, fetcher) {
  const url = `https://admin.da.live/source/${ctx.org}/${ctx.repo}${toSourcePath(webPath)}`;
  const resp = await fetcher(url, { method: 'HEAD' });
  if (resp.status === 404) return false;
  return resp.ok ? true : null;
}

async function listPages(folder, ctx, fetcher) {
  const key = `${ctx.org}/${ctx.repo}${folder}`;
  if (pageListCache.has(key)) return pageListCache.get(key);
  const run = (async () => {
    const resp = await fetcher(`https://admin.da.live/list/${key}`);
    if (!resp.ok) return [];
    const items = await resp.json();
    const prefix = `/${ctx.org}/${ctx.repo}`;
    return (Array.isArray(items) ? items : [])
      .filter((item) => item.ext === 'html' && item.path?.startsWith(prefix))
      .map((item) => item.path.slice(prefix.length).replace(/\.html$/, '').replace(/\/index$/, '/'));
  })().catch(() => []);
  pageListCache.set(key, run);
  return run;
}

function tokens(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function similarity(a, b) {
  const lastA = a.split('/').filter(Boolean).pop() || 'index';
  const lastB = b.split('/').filter(Boolean).pop() || 'index';
  const ta = new Set(tokens(lastA));
  const tb = new Set(tokens(lastB));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = shared / (new Set([...ta, ...tb]).size || 1);
  const chars = 1 - editDistance(lastA, lastB) / Math.max(lastA.length, lastB.length, 1);
  return Math.max(jaccard, chars);
}

/** Finds existing pages whose address is close to a missing one. */
async function closestPages(webPath, ctx, fetcher) {
  const parts = webPath.split('/').filter(Boolean);
  const folders = new Set(['']);
  if (parts.length > 1) folders.add(`/${parts.slice(0, -1).join('/')}`);
  const lists = await Promise.all([...folders].map((f) => listPages(f, ctx, fetcher)));
  const skip = new Set(['/nav', '/footer', ctx.path]);
  return [...new Set(lists.flat())]
    .filter((p) => !skip.has(p) && p !== webPath)
    .map((p) => ({ path: p, score: similarity(webPath, p) }))
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

async function checkSitePage(webPath, ctx, fetcher, intro = '') {
  const [status, source] = await Promise.all([
    pageStatus(webPath, ctx, fetcher).catch(() => null),
    sourceExists(webPath, ctx, fetcher).catch(() => null),
  ]);
  if (!status) {
    return result('unknown', 'Not checked', `${intro}The site's publishing status couldn't be read for ${webPath}.`);
  }
  const name = webPath === '/' ? 'The home page (/)' : `The page ${webPath}`;
  if (status.redirect) {
    const r = result('warning', 'Redirects', `${intro}${name} redirects to ${status.redirect}.`);
    r.suggestions.push(replaceWith(`Use ${status.redirect}`, status.redirect));
    return r;
  }
  if (status.live === 200) return result('ok', 'Live', `${intro}${name} is published.`);
  if (status.preview === 200) {
    return result('warning', 'Not published', `${intro}${name} is only in preview, so readers get "page not found" until it's published.`, { editPath: webPath });
  }
  if (source) {
    return result('warning', 'Draft only', `${intro}${name} is a draft that hasn't been previewed or published.`, { editPath: webPath });
  }
  const r = result('error', 'Missing page', `${intro}No page at ${webPath}, so readers get "page not found".`);
  const close = await closestPages(webPath, ctx, fetcher);
  close.forEach((c) => r.suggestions.push(replaceWith(`Use ${c.path}`, c.path, 'Closest existing page', false)));
  return r;
}

/* ---------- external sites ---------- */

/**
 * Asks the browser to load a URL.
 * A normal request gives the real status when the site allows it (CORS).
 * Otherwise an opaque request still tells us whether the site answers at all.
 */
async function probe(url) {
  try {
    const resp = await fetch(url, {
      mode: 'cors', redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT),
    });
    return {
      confirmed: true, status: resp.status, redirected: resp.redirected, finalUrl: resp.url,
    };
  } catch (e) {
    if (e.name === 'TimeoutError') return { confirmed: false, timeout: true };
  }
  try {
    await fetch(url, {
      mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT),
    });
    return { confirmed: false, reachable: true };
  } catch (e) {
    return { confirmed: false, reachable: false, timeout: e.name === 'TimeoutError' };
  }
}

const EDS_HOST = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(?:hlx|aem)\.(page|live)$/i;

/**
 * Asks Edge Delivery whether a page exists on any public Edge Delivery site
 * (`branch--site--org.aem.page` / `.aem.live`).
 * @returns {Promise<boolean|null>} true / false, or null when it can't tell
 */
// Why an Edge Delivery status check failed, by address (shown with "couldn't be checked").
const edsProblems = new Map();

async function edsPageExists(url) {
  const m = url.hostname.match(EDS_HOST);
  if (!m) return null;
  const [, ref, site, org, tier] = m;
  edsProblems.delete(url.href);
  try {
    const resp = await fetch(`https://admin.hlx.page/status/${org}/${site}/${ref}${toWebPath(url.pathname)}`, {
      credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT),
    });
    if (resp.status === 404) return false;
    if (!resp.ok) {
      edsProblems.set(url.href, `Edge Delivery status answered ${resp.status}`);
      return null;
    }
    const json = await resp.json();
    const status = tier === 'live' ? json.live?.status : json.preview?.status;
    if (status === 200) return true;
    return status === 404 ? false : null;
  } catch (e) {
    edsProblems.set(url.href, `Edge Delivery status couldn't be reached (${e.name}: ${e.message})`);
    return null;
  }
}

function sameAddress(a, b) {
  const norm = (u) => u.replace(/#.*$/, '').replace(/\/$/, '');
  return norm(a) === norm(b);
}

async function addArchive(r, href, { offer }) {
  try {
    const snap = await findSnapshot(href);
    r.snapshot = snap;
    if (snap && offer) {
      r.suggestions.unshift(replaceWith(`Use the archived copy from ${formatDate(snap.date)}`, snap.url, 'Wayback Machine'));
    }
  } catch {
    // The archive is unavailable: show the link check without archive details.
  }
  return r;
}

/** Turns a page status (from the browser, Edge Delivery or the link-check Worker) into a result. */
async function fromStatus(href, status, finalUrl) {
  if (status === 404 || status === 410) {
    const r = result('error', status === 404 ? 'Not found' : 'Gone', `The page is gone (${status} ${status === 404 ? 'Not Found' : 'Gone'}).`);
    await addArchive(r, href, { offer: true });
    return r;
  }
  if (status >= 500) {
    const r = result('warning', 'Server error', `The site returned an error (${status}). It may be down.`);
    return addArchive(r, href, { offer: true });
  }
  if (status >= 400) {
    return result('warning', `Error ${status}`, `The site refused the request (${status}). It may need a login.`);
  }
  if (finalUrl && !sameAddress(finalUrl, href)) {
    const r = result('warning', 'Moved', `Now redirects to ${finalUrl}.`);
    r.suggestions.push(replaceWith('Use the new address', finalUrl, 'Where the old link ends up'));
    return r;
  }
  return addArchive(result('ok', 'Working', `The page loads (${status}).`), href, { offer: false });
}

async function checkExternal(link) {
  const { url, insecure } = link.info;
  const { href } = url;

  if (insecure) {
    const https = href.replace(/^http:/, 'https:');
    const p = await probe(https);
    const works = p.confirmed ? p.status < 400 : p.reachable;
    const r = result('warning', 'Not secure', 'Uses http://, which browsers may block or warn about.');
    if (works) r.suggestions.push(replaceWith('Switch to https://', https, 'The secure address works'));
    else r.message += ' The https:// version doesn\'t answer either.';
    return addArchive(r, href, { offer: !works });
  }

  if (url.hostname === 'web.archive.org' && url.pathname.startsWith('/web/')) {
    return result('ok', 'Archived copy', 'A saved copy in the Wayback Machine.');
  }

  const exists = await edsPageExists(url);
  if (exists === false) return fromStatus(href, 404, href);
  if (exists === true) return fromStatus(href, 200, href);

  const p = await probe(href);
  if (p.confirmed) return fromStatus(href, p.status, p.redirected ? p.finalUrl : href);

  // The browser couldn't see the page status: ask the link-check Worker to load the page instead.
  const remote = await remoteCheck(href);
  if (remote.status) return fromStatus(href, remote.status, remote.finalUrl);
  if (remote.unreachable || (!p.reachable && !p.timeout)) {
    const r = result('error', 'Unreachable', 'The site can\'t be reached. It may have shut down.');
    await addArchive(r, href, { offer: true });
    return r;
  }
  if (p.timeout || remote.timedOut) {
    const r = result('warning', 'Timed out', 'The site took too long to answer. It may be down.');
    return addArchive(r, href, { offer: true });
  }
  // The site answers, but it hides the page status from the browser: it may still be a 404.
  return addArchive(
    result('unknown', 'Not confirmed', `${url.hostname} hides page status from the browser, and ${[edsProblems.get(href), remote.reason].filter(Boolean).join('; ') || 'the link check failed'}.`),
    href,
    { offer: false },
  );
}

/* ---------- replacement suggestions ---------- */

// Link shorteners: their home page is never a useful replacement.
const SHORTENERS = /^(www\.)?(bit\.ly|t\.co|goo\.gl|tinyurl\.com|ow\.ly|buff\.ly|rebrand\.ly|is\.gd|cutt\.ly|tiny\.cc)$/i;

/**
 * Checks that an address works in the browser (or on Edge Delivery), and where it ends up.
 * @param {string} href The address
 * @returns {Promise<string|null>} The working address, or null
 */
async function workingAddress(href) {
  const url = new URL(href);
  const eds = await edsPageExists(url);
  if (eds !== null) return eds ? url.href : null;
  const p = await probe(url.href);
  if (p.confirmed) {
    if (p.status >= 400) return null;
    return p.redirected && p.finalUrl ? p.finalUrl : url.href;
  }
  return p.reachable ? url.href : null;
}

function shortAddress(href) {
  return href.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Offers the site's home page for a page that's gone on a site that still works.
 */
async function addReplacements(r, link) {
  const { url } = link.info;
  if (!['Not found', 'Gone'].includes(r.label) || url.pathname === '/' || SHORTENERS.test(url.hostname)) return r;
  const home = await workingAddress(`${url.origin}/`);
  if (home && !r.suggestions.some((sg) => sameAddress(sg.to, home))) {
    r.suggestions = [replaceWith('Use the site\'s home page', home, shortAddress(home), false), ...r.suggestions];
  }
  return r;
}

/* ---------- entry point ---------- */

async function checkOne(link, ctx, fetcher) {
  const { info } = link;
  switch (info.kind) {
    case 'skip':
      return result('skip', info.reason === 'anchor' ? 'Jump link' : info.reason, 'Not a web page, so it isn\'t checked.');
    case 'empty':
      return result('error', 'Empty link', 'This link has no address.');
    case 'invalid':
      return result('error', 'Invalid', 'This address isn\'t a valid URL.');
    case 'editor': {
      if (!info.internal) {
        const target = `https://main--${info.repo}--${info.org}.aem.live${info.webPath}`;
        const r = result('error', 'Editor link', 'Opens the editor, which readers can\'t use.');
        if (info.org && info.repo) r.suggestions.push(replaceWith('Use the published page', target));
        return r;
      }
      const r = await checkSitePage(info.webPath, ctx, fetcher, 'Opens the editor, which readers can\'t use. ');
      if (r.severity === 'ok') r.message = 'Opens the editor, which readers can\'t use.';
      r.severity = 'error';
      r.label = 'Editor link';
      r.suggestions = [replaceWith(`Use ${info.webPath}`, info.webPath, 'Link to the page itself')];
      return r;
    }
    case 'localhost': {
      const r = result('error', 'Local address', 'Points to someone\'s own computer (localhost).');
      r.suggestions.push(replaceWith(`Use ${info.webPath}`, info.webPath));
      return r;
    }
    case 'legacy': {
      const next = new URL(modernizeLegacy(info.url));
      const exists = await edsPageExists(next);
      if (exists === false) {
        const r = result('error', 'Not found', 'This page no longer exists, on the old or the new domain.');
        await addArchive(r, info.url.href, { offer: true });
        return r;
      }
      const r = result('warning', 'Old domain', 'Uses a retired hlx domain.');
      r.suggestions.push(exists
        ? replaceWith(`Use the ${next.hostname.split('.').slice(-2).join('.')} address`, next.href, 'The page exists there')
        : replaceWith(`Use the ${next.hostname.split('.').slice(-2).join('.')} address`, next.href, 'Open it once to check', false));
      return r;
    }
    case 'internal': {
      const r = await checkSitePage(info.webPath, ctx, fetcher);
      if (info.host === 'page') {
        // A link to the preview site: readers on the live site would jump to preview.
        const msg = 'Points to the preview site instead of the live one.';
        if (r.severity === 'ok') {
          r.severity = 'warning';
          r.label = 'Preview link';
          r.message = msg;
        } else {
          r.message = `${msg} ${r.message}`;
        }
        if (r.severity !== 'error') {
          const to = `${info.webPath}${info.url.search}${info.url.hash}`;
          r.suggestions.unshift(replaceWith(`Use ${to}`, to, 'Works on preview and live'));
        }
      }
      return r;
    }
    default:
      return checkExternal(link);
  }
}

/**
 * Checks one link.
 * @param {object} link A link from extractLinks()
 * @param {object} ctx Site context
 * @param {Function} fetcher fetch() that adds the author's sign-in when available
 * @returns {Promise<object>} The check result with suggestions
 */
export async function checkLink(link, ctx, fetcher) {
  const r = await checkOne(link, ctx, fetcher);
  if (['external', 'legacy'].includes(link.info.kind) && r.severity === 'error') {
    return addReplacements(r, link);
  }
  return r;
}
