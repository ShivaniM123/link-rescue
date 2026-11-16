/**
 * Lists and reads the pages of a site in Document Authoring, for folder and site-wide scans.
 */
import { toWebPath, toSourcePath } from './links.js';

const DA = 'https://admin.da.live';
export const MAX_PAGES = 500;

async function listFolder(folder, ctx, fetcher) {
  const items = [];
  let token;
  do {
    const headers = token ? { 'da-continuation-token': token } : {};
    // eslint-disable-next-line no-await-in-loop
    const resp = await fetcher(`${DA}/list/${ctx.org}/${ctx.repo}${folder}`, { headers });
    if (!resp.ok) throw new Error(`The folder ${folder || '/'} couldn't be listed (${resp.status}).`);
    // eslint-disable-next-line no-await-in-loop
    const page = await resp.json();
    if (Array.isArray(page)) items.push(...page);
    token = resp.headers.get('da-continuation-token');
  } while (token);
  return items;
}

/**
 * Finds every page in a folder and its sub-folders.
 * @param {string} folder Folder path, '' for the whole site
 * @param {object} ctx Site context
 * @param {Function} fetcher fetch() with the author's sign-in
 * @param {Function} onProgress Called with the number of pages found so far
 * @returns {Promise<{pages: string[], truncated: boolean}>} Web paths of the pages
 */
export async function listPages(folder, ctx, fetcher, onProgress) {
  const prefix = `/${ctx.org}/${ctx.repo}`;
  const pages = [];
  const queue = [folder];
  while (queue.length && pages.length < MAX_PAGES) {
    const batch = queue.splice(0, 4);
    // eslint-disable-next-line no-await-in-loop
    const lists = await Promise.all(batch.map((f) => listFolder(f, ctx, fetcher)));
    lists.flat().forEach((item) => {
      const path = item.path?.startsWith(prefix) ? item.path.slice(prefix.length) : null;
      if (!path) return;
      if (!item.ext) queue.push(path);
      else if (item.ext === 'html' && pages.length < MAX_PAGES) pages.push(toWebPath(path));
    });
    onProgress?.(pages.length);
  }
  return { pages: pages.sort(), truncated: queue.length > 0 || pages.length >= MAX_PAGES };
}

/** The Document Authoring source address of a page. */
export function sourceUrl(ctx, webPath) {
  return `${DA}/source/${ctx.org}/${ctx.repo}${toSourcePath(webPath)}`;
}

/** The folder a page sits in, '' for the site root. */
export function folderOf(webPath) {
  const parts = webPath.split('/').filter(Boolean);
  if (webPath.endsWith('/')) return parts.length ? `/${parts.join('/')}` : '';
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '';
}
