/**
 * Finds the links in a page and works out what kind of link each one is.
 * Pure functions only: no network calls happen here.
 */

const SKIP_SCHEMES = /^(mailto|tel|sms|javascript|data|blob):/i;
const LEGACY_HOST = /\.hlx\.(page|live)$/i;
const AEM_HOST = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.aem\.(page|live)$/i;

/** Turns `/folder/page.html` or `/folder/` into the Edge Delivery web path. */
export function toWebPath(pathname) {
  let path = decodeURI(pathname || '/');
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/index(\.html)?$/, '/');
  path = path.replace(/\.html$/, '');
  return path;
}

/** Turns a web path into the Document Authoring source path (with extension). */
export function toSourcePath(webPath) {
  if (webPath.endsWith('/')) return `${webPath}index.html`;
  if (/\.[a-z0-9]+$/i.test(webPath.split('/').pop())) return webPath;
  return `${webPath}.html`;
}

/**
 * Describes one href relative to the site.
 * @param {string} href The href exactly as authored
 * @param {{org: string, repo: string, path: string, hosts?: string[]}} ctx Site context
 * @returns {object} The link kind and its parts
 */
function classifyHref(href, ctx) {
  const raw = (href || '').trim();
  if (!raw) return { kind: 'empty' };
  if (raw.startsWith('#')) return { kind: 'skip', reason: 'anchor' };
  if (SKIP_SCHEMES.test(raw)) return { kind: 'skip', reason: raw.split(':')[0].toLowerCase() };

  let url;
  try {
    const base = `https://main--${ctx.repo}--${ctx.org}.aem.live${ctx.path || '/'}`;
    url = new URL(raw, base);
  } catch {
    return { kind: 'invalid' };
  }
  if (!/^https?:$/.test(url.protocol)) return { kind: 'skip', reason: url.protocol.replace(':', '') };

  const host = url.hostname.toLowerCase();
  const isRelative = !/^[a-z]+:/i.test(raw) && !raw.startsWith('//');
  const sameSite = (o, r) => o.toLowerCase() === ctx.org.toLowerCase()
    && r.toLowerCase() === ctx.repo.toLowerCase();

  // Links to the authoring editor: readers can't open these.
  if (host === 'da.live' && url.hash.startsWith('#/')) {
    const [, org, repo, ...rest] = url.hash.slice(1).split('/');
    const webPath = toWebPath(`/${rest.join('/')}`);
    return {
      kind: 'editor', url, org, repo, webPath, internal: org && repo && sameSite(org, repo),
    };
  }

  if (host === 'localhost' || host === '127.0.0.1') {
    return { kind: 'localhost', url, webPath: toWebPath(url.pathname) };
  }

  const aem = host.match(AEM_HOST);
  if (aem && sameSite(aem[3], aem[2])) {
    return {
      kind: 'internal', url, webPath: toWebPath(url.pathname), host: aem[4],
    };
  }

  if (LEGACY_HOST.test(host)) return { kind: 'legacy', url };

  if (isRelative || (ctx.hosts || []).includes(host)) {
    return { kind: 'internal', url, webPath: toWebPath(url.pathname) };
  }

  return { kind: 'external', url, insecure: url.protocol === 'http:' };
}

/**
 * Lists the unique links in an HTML document or fragment.
 * @param {string} html Page HTML
 * @param {object} ctx Site context
 * @returns {Array<object>} One entry per unique href
 */
export function extractLinks(html, ctx) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const byHref = new Map();
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const existing = byHref.get(href);
    if (existing) {
      existing.count += 1;
      existing.text ||= text;
      return;
    }
    const info = classifyHref(href, ctx);
    byHref.set(href, {
      id: `l${byHref.size}`,
      href,
      text,
      count: 1,
      info,
    });
  });
  return [...byHref.values()];
}

/** Old hlx.page / hlx.live addresses move to aem.page / aem.live. */
export function modernizeLegacy(url) {
  const next = new URL(url.href);
  next.hostname = next.hostname.replace(/\.hlx\.(page|live)$/i, '.aem.$1');
  if (next.hostname === 'www.aem.live' || next.hostname === 'www.aem.page') {
    next.hostname = 'www.aem.live';
  }
  return next.href;
}
