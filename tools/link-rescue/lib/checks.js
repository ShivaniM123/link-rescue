/**
 * Checks links and suggests fixes.
 * Internal links: the site's publishing status (admin.hlx.page) and its source (admin.da.live).
 * External links: browser requests, plus the Wayback Machine for archived copies.
 */
import { toSourcePath, modernizeLegacy } from './links.js';
import { findSnapshot } from './wayback.js';

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

const UNLINK = { type: 'unlink', label: 'Remove the link, keep the text' };

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
    const r = result('warning', 'Redirects', `${intro}${name} redirects to ${status.redirect}. Link to the final page so readers skip the extra hop.`);
    r.suggestions.push(replaceWith(`Use ${status.redirect}`, status.redirect));
    return r;
  }
  if (status.live === 200) return result('ok', 'Live', `${intro}${name} is published.`);
  if (status.preview === 200) {
    return result('warning', 'Not published', `${intro}${name} is only in preview. Readers will get a "page not found" until you publish it too.`, { editPath: webPath });
  }
  if (source) {
    return result('warning', 'Draft only', `${intro}${name} exists as a draft but hasn't been previewed or published yet.`, { editPath: webPath });
  }
  const r = result('error', 'Missing page', `${intro}There's no page at ${webPath}. Readers will get a "page not found".`);
  const close = await closestPages(webPath, ctx, fetcher);
  close.forEach((c) => r.suggestions.push(replaceWith(`Use ${c.path}`, c.path, 'Closest existing page', false)));
  r.suggestions.push(UNLINK);
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
    if (!snap) r.noArchive = true;
  } catch {
    // The archive is unavailable: show the link check without archive details.
  }
  return r;
}

async function checkExternal(link) {
  const { url, insecure } = link.info;
  const { href } = url;

  if (insecure) {
    const https = href.replace(/^http:/, 'https:');
    const p = await probe(https);
    const works = p.confirmed ? p.status < 400 : p.reachable;
    const r = result('warning', 'Not secure', 'This link uses http://, so browsers may block it or warn readers.');
    if (works) r.suggestions.push(replaceWith('Switch to https://', https, 'The secure address works'));
    else r.message += ' The secure version of this address doesn\'t answer either.';
    return addArchive(r, href, { offer: !works });
  }

  if (url.hostname === 'web.archive.org' && url.pathname.startsWith('/web/')) {
    return result('ok', 'Archived copy', 'This links to a saved copy in the Wayback Machine, which stays online.');
  }

  const p = await probe(href);
  if (p.confirmed) {
    if (p.status === 404 || p.status === 410) {
      const r = result('error', 'Broken', `The page is gone (${p.status} ${p.status === 404 ? 'Not Found' : 'Gone'}).`);
      await addArchive(r, href, { offer: true });
      r.suggestions.push(UNLINK);
      return r;
    }
    if (p.status >= 500) {
      const r = result('warning', 'Server error', `The site answered with an error (${p.status}). It may be down for now.`);
      return addArchive(r, href, { offer: true });
    }
    if (p.status >= 400) {
      return result('warning', `Error ${p.status}`, `The site refused the request (${p.status}). It may need a login.`);
    }
    if (p.redirected && p.finalUrl && !sameAddress(p.finalUrl, href)) {
      const r = result('warning', 'Moved', `This page now redirects to ${p.finalUrl}.`);
      r.suggestions.push(replaceWith('Use the new address', p.finalUrl, 'Where the old link ends up'));
      return r;
    }
    return addArchive(result('ok', 'Working', `The page loads (${p.status}).`), href, { offer: false });
  }

  if (p.reachable) {
    return addArchive(
      result('ok', 'Site responds', 'The site answers. This site doesn\'t let the browser confirm the exact page, so open it once to be sure.'),
      href,
      { offer: false },
    );
  }

  const r = p.timeout
    ? result('warning', 'Timed out', 'The site took too long to answer. It may be slow or down.')
    : result('error', 'Unreachable', 'The site can\'t be reached. The domain may have shut down or the address is wrong.');
  await addArchive(r, href, { offer: true });
  if (r.severity === 'error') r.suggestions.push(UNLINK);
  return r;
}

/* ---------- entry point ---------- */

/**
 * Checks one link.
 * @param {object} link A link from extractLinks()
 * @param {object} ctx Site context
 * @param {Function} fetcher fetch() that adds the author's sign-in when available
 * @returns {Promise<object>} The check result with suggestions
 */
export async function checkLink(link, ctx, fetcher) {
  const { info } = link;
  switch (info.kind) {
    case 'skip':
      return result('skip', info.reason === 'anchor' ? 'Jump link' : info.reason, 'Not a web page, so it isn\'t checked.');
    case 'empty':
      return { ...result('error', 'Empty link', 'This link has no address.'), suggestions: [UNLINK] };
    case 'invalid':
      return { ...result('error', 'Invalid', 'This address isn\'t a valid URL.'), suggestions: [UNLINK] };
    case 'editor': {
      if (!info.internal) {
        const target = `https://main--${info.repo}--${info.org}.aem.live${info.webPath}`;
        const r = result('error', 'Editor link', 'This opens the authoring editor. Readers can\'t sign in to it.');
        if (info.org && info.repo) r.suggestions.push(replaceWith('Use the published page', target));
        return r;
      }
      const r = await checkSitePage(info.webPath, ctx, fetcher, 'This opens the authoring editor, which readers can\'t use. ');
      r.severity = 'error';
      r.label = 'Editor link';
      r.suggestions = [replaceWith(`Use ${info.webPath}`, info.webPath, 'Link to the page itself'), ...r.suggestions.filter((s) => s.type === 'unlink')];
      return r;
    }
    case 'localhost': {
      const r = result('error', 'Local address', 'This points to someone\'s own computer (localhost). Nobody else can open it.');
      r.suggestions.push(replaceWith(`Use ${info.webPath}`, info.webPath));
      return r;
    }
    case 'legacy': {
      const next = modernizeLegacy(info.url);
      const r = result('warning', 'Old domain', 'hlx.page and hlx.live are retired Edge Delivery domains. Use aem.page / aem.live instead.');
      r.suggestions.push(replaceWith('Use the aem.live address', next));
      return r;
    }
    case 'internal': {
      const r = await checkSitePage(info.webPath, ctx, fetcher);
      if (info.host === 'page') {
        // A link to the preview site: readers on the live site would jump to preview.
        const msg = 'This points to the preview site (aem.page), not the published site. ';
        r.message = msg + r.message;
        if (r.severity === 'ok') {
          r.severity = 'warning';
          r.label = 'Preview link';
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
