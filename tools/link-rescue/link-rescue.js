/* eslint no-use-before-define: ["error", { "functions": false }] */
/**
 * Link Rescue: an Experience Workspace panel that finds broken links and fixes them in one click,
 * using the Wayback Machine to rescue dead pages.
 * It checks the open page as you edit, and can scan its folder or the whole site.
 */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { extractLinks, toWebPath } from './lib/links.js';
import { checkLink, formatDate } from './lib/checks.js';
import { applyChange, reverseChange } from './lib/fixes.js';
import {
  listPages, sourceUrl, folderOf, MAX_PAGES,
} from './lib/site.js';

const SDK_TIMEOUT = 4000;
const CONCURRENCY = 4;
// After a fix, the editor can briefly send the old page before it picks up the change.
const HOLD_MS = 6000;
const DEMO_PAGES = {
  '/demo/spring-update': 'sample.html',
  '/demo/about-us': 'about.html',
};

const state = {
  mode: 'demo',
  sdk: null,
  ctx: null,
  scope: 'page',
  pageHtml: '',
  // Folder and site scans: web path -> links on that page.
  scans: { folder: null, site: null },
  links: [],
  results: new Map(),
  editable: true,
  busy: false,
  confirm: null,
  undo: null,
  hold: null,
  error: null,
};

const app = document.getElementById('app');

/* ---------- helpers ---------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function demoFetch(url, opts) {
  // The demo pages only exist in this extension, so report them as published.
  const status = url.match(/\/status\/[^/]+\/[^/]+\/[^/]+(\/.*)$/);
  if (status && DEMO_PAGES[status[1]]) {
    const body = JSON.stringify({ live: { status: 200 }, preview: { status: 200 } });
    return Promise.resolve(new Response(body));
  }
  return fetch(url, opts);
}

function fetcher(url, opts) {
  if (state.mode === 'demo') return demoFetch(url, opts);
  if (state.sdk?.actions?.daFetch) return state.sdk.actions.daFetch(url, opts);
  return fetch(url, opts);
}

function editUrl(webPath) {
  const { org, repo } = state.ctx;
  const p = webPath.endsWith('/') ? `${webPath}index` : webPath;
  const view = state.mode === 'ew' ? 'canvas' : 'edit';
  return `https://da.live/${view}#/${org}/${repo}${p}`;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => { setTimeout(() => r(fallback), ms); })]);
}

let toastTimer;
function toast(message, action) {
  let el = document.querySelector('.lr-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'lr-toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button" class="lr-link-btn">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').addEventListener('click', () => { el.classList.remove('show'); action.run(); });
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 9000 : 4000);
}

/* ---------- reading pages ---------- */

async function readPage(path) {
  if (state.mode === 'demo') {
    if (path === state.ctx.path && state.pageHtml) return state.pageHtml;
    const scanned = state.scans.site?.html.get(path) ?? state.scans.folder?.html.get(path);
    if (scanned !== undefined) return scanned;
    const resp = await fetch(new URL(`./demo/${DEMO_PAGES[path]}`, import.meta.url));
    return resp.text();
  }
  const resp = await fetcher(sourceUrl(state.ctx, path), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${path} couldn't be read (${resp.status}).`);
  if (path === state.ctx.path && resp.permissions && !resp.permissions.includes('write')) {
    state.editable = false;
  }
  return resp.text();
}

async function writePage(path, html) {
  if (state.mode === 'demo') return;
  const body = new FormData();
  body.append('data', new Blob([html], { type: 'text/html' }));
  const resp = await fetcher(sourceUrl(state.ctx, path), { method: 'POST', body });
  if (!resp.ok) throw new Error(`${path} couldn't be saved (${resp.status}).`);
}

/** Stores a page's HTML everywhere it's used, then rebuilds the link list. */
function storePage(path, html) {
  if (path === state.ctx.path) state.pageHtml = html;
  ['folder', 'site'].forEach((scope) => {
    const run = state.scans[scope];
    if (run?.html.has(path)) run.html.set(path, html);
  });
}

/* ---------- link list ---------- */

function pageLinks(path, html) {
  return extractLinks(html, { ...state.ctx, path });
}

/** Merges the links of several pages: one entry per address, with the pages it's on. */
function mergeLinks(pages) {
  const byKey = new Map();
  pages.forEach(([path, html]) => {
    pageLinks(path, html).forEach((link) => {
      let entry = byKey.get(link.key);
      if (!entry) {
        entry = {
          ...link, id: `l${byKey.size}`, count: 0, pages: [],
        };
        byKey.set(link.key, entry);
      }
      entry.count += link.count;
      entry.text ||= link.text;
      entry.pages.push({ path, count: link.count });
    });
  });
  return [...byKey.values()];
}

function rebuild() {
  if (state.scope === 'page') {
    state.links = state.pageHtml ? mergeLinks([[state.ctx.path, state.pageHtml]]) : [];
  } else {
    const run = state.scans[state.scope];
    state.links = run?.status === 'done' ? mergeLinks([...run.html.entries()]) : [];
  }
  runChecks();
  render();
}

function resultFor(link) {
  return state.results.get(link.key);
}

async function runChecks() {
  const queue = state.links.filter((l) => !state.results.has(l.key));
  queue.forEach((l) => state.results.set(l.key, null));
  const worker = async () => {
    while (queue.length) {
      const link = queue.shift();
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await checkLink(link, { ...state.ctx, path: link.pages[0].path }, fetcher);
      } catch (e) {
        res = {
          severity: 'unknown', label: 'Not checked', message: `The check failed: ${e.message}`, suggestions: [],
        };
      }
      // Skip results from before a "Check again".
      if (state.results.has(link.key)) state.results.set(link.key, res);
      render();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function setPageHtml(html) {
  if (html === state.pageHtml) return;
  storePage(state.ctx.path, html);
  rebuild();
}

/* ---------- folder and site scans ---------- */

function folderPath() {
  return folderOf(state.ctx.path);
}

async function scan(scope) {
  const folder = scope === 'folder' ? folderPath() : '';
  const run = {
    status: 'listing', found: 0, read: 0, total: 0, html: new Map(), truncated: false, failed: [],
  };
  state.scans[scope] = run;
  render();
  try {
    let pages;
    if (state.mode === 'demo') {
      pages = Object.keys(DEMO_PAGES).filter((p) => p.startsWith(`${folder}/`));
    } else {
      const listed = await listPages(folder, state.ctx, fetcher, (found) => {
        run.found = found;
        render();
      });
      pages = listed.pages;
      run.truncated = listed.truncated;
    }
    run.status = 'reading';
    run.total = pages.length;
    render();
    const queue = [...pages];
    const worker = async () => {
      while (queue.length) {
        const path = queue.shift();
        try {
          // eslint-disable-next-line no-await-in-loop
          run.html.set(path, await readPage(path));
        } catch {
          run.failed.push(path);
        }
        run.read += 1;
        render();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    run.status = 'done';
  } catch (e) {
    run.status = 'error';
    run.error = e.message;
  }
  if (state.scans[scope] === run && state.scope === scope) rebuild();
  else render();
}

function setScope(scope) {
  if (scope === state.scope) return;
  state.scope = scope;
  state.confirm = null;
  if (scope !== 'page' && !state.scans[scope]) scan(scope);
  rebuild();
}

function recheck() {
  state.results.clear();
  if (state.scope === 'page') rebuild();
  else scan(state.scope);
}

/* ---------- fixing ---------- */

function pagesFor(items) {
  const byPage = new Map();
  items.forEach((item) => {
    item.link.pages.forEach(({ path }) => {
      if (!byPage.has(path)) byPage.set(path, []);
      byPage.get(path).push(item);
    });
  });
  return byPage;
}

/** Asks first when a fix changes more than the open page. */
function requestFixes(items) {
  if (!items.length || state.busy) return;
  const byPage = pagesFor(items);
  if (byPage.size > 1 || ![...byPage.keys()].includes(state.ctx.path)) {
    state.confirm = { items, pages: byPage.size };
    render();
    return;
  }
  applyFixes(items);
}

/**
 * Applies fixes to every page the links are on.
 * Each page is read from Document Authoring, changed and written back with the author's sign-in.
 * For the open page, the editor saves first, and Document Authoring then pushes the change into it.
 */
async function applyFixes(items) {
  if (!state.editable) {
    toast('This page is read-only for you, so links can\'t be fixed here.');
    return;
  }
  state.busy = true;
  state.confirm = null;
  render();
  const undo = [];
  const failed = [];
  let changed = 0;
  try {
    const byPage = pagesFor(items);
    if (byPage.has(state.ctx.path) && state.mode === 'ew') {
      await withTimeout(state.sdk.actions.saveDocument?.().catch(() => null), 3000, null);
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const [path, pageItems] of byPage) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const before = await readPage(path);
        let html = before;
        const done = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const { link, suggestion } of pageItems) {
          const out = applyChange(html, link.href, suggestion);
          if (out.count) {
            html = out.html;
            done.push({ link, suggestion });
            changed += out.count;
          }
        }
        if (done.length) {
          // eslint-disable-next-line no-await-in-loop
          await writePage(path, html);
          storePage(path, html);
          undo.push({
            path, before, after: html, done,
          });
        }
      } catch {
        failed.push(path);
      }
    }
    if (!undo.length) {
      toast(failed.length ? `The pages couldn't be saved: ${failed.join(', ')}` : 'Those links aren\'t in the saved pages yet. Wait a few seconds and try again.');
      return;
    }
    state.hold = { until: Date.now() + HOLD_MS, hrefs: items.map((i) => i.link.href) };
    state.undo = undo;
    rebuild();
    const where = undo.length > 1 ? ` on ${plural(undo.length, 'page')}` : '';
    const problem = failed.length ? ` ${plural(failed.length, 'page')} couldn't be saved.` : '';
    toast(`${plural(changed, 'link')} fixed${where}.${problem}`, { label: 'Undo', run: undoLast });
  } finally {
    state.busy = false;
    render();
  }
}

async function undoLast() {
  const { undo } = state;
  if (!undo || state.busy) return;
  state.busy = true;
  render();
  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of undo) {
      // eslint-disable-next-line no-await-in-loop
      const current = await readPage(entry.path);
      let html = entry.before;
      if (current !== entry.after) {
        // The page changed since the fix: only reverse the link changes.
        html = current;
        entry.done.forEach(({ link, suggestion }) => {
          const rev = reverseChange(link.href, suggestion);
          if (rev) html = applyChange(html, rev.from, rev.change).html;
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await writePage(entry.path, html);
      storePage(entry.path, html);
    }
    state.undo = null;
    state.hold = null;
    rebuild();
    toast('Fix undone.');
  } catch (e) {
    toast(e.message);
  } finally {
    state.busy = false;
    render();
  }
}

function bulkItems() {
  return state.links.map((link) => {
    const res = resultFor(link);
    if (!res || !['error', 'warning'].includes(res.severity)) return null;
    const suggestion = res.suggestions.find((s) => s.type === 'replace' && s.safe);
    return suggestion ? { link, suggestion } : null;
  }).filter(Boolean);
}

/* ---------- rendering ---------- */

const ICONS = {
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
  error: '<circle cx="8" cy="8" r="6.5"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  warning: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/>',
  unknown: '<circle cx="8" cy="8" r="6.5"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.6v.1"/>',
  ok: '<circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l2 2 3.6-4"/>',
  pending: '<circle cx="8" cy="8" r="6.5" stroke-dasharray="3 3"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9v4.5h-9v-9H7"/>',
  page: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.6v.1"/>',
};

function icon(name, cls = '') {
  return `<svg class="lr-icon ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

const GROUPS = [
  { severity: 'error', title: 'Broken', hint: 'Readers hit a dead end' },
  { severity: 'warning', title: 'Outdated', hint: 'Work for now, but should be updated' },
  { severity: 'unknown', title: 'Not confirmed', hint: 'Open these once to check them' },
];

function counts() {
  const c = {
    error: 0, warning: 0, ok: 0, pending: 0, unknown: 0, skip: 0,
  };
  state.links.forEach((l) => {
    const r = resultFor(l);
    if (!r) c.pending += 1;
    else c[r.severity in c ? r.severity : 'unknown'] += 1;
  });
  return c;
}

function scopeName() {
  if (state.scope === 'page') return 'this page';
  const n = state.scans[state.scope]?.html.size || 0;
  return plural(n, 'page');
}

function verdict(c) {
  const run = state.scans[state.scope];
  if (state.scope !== 'page' && run?.status !== 'done') {
    if (run?.status === 'error') return { cls: 'error', title: 'The scan stopped', text: run.error };
    if (run?.status === 'reading') {
      return {
        cls: 'pending', title: 'Reading pages…', text: `${run.read} of ${run.total}`, progress: run.read / Math.max(run.total, 1),
      };
    }
    return { cls: 'pending', title: 'Finding pages…', text: `${run?.found || 0} so far` };
  }
  if (!state.links.length && state.scope === 'page' && !state.pageHtml) return { cls: 'pending', title: 'Reading the page…' };
  if (!state.links.length) return { cls: 'ok', title: 'No links yet', text: `There are no links on ${scopeName()}.` };
  if (c.pending) {
    const done = state.links.length - c.pending;
    return {
      cls: 'pending', title: 'Checking links…', text: `${done} of ${state.links.length}`, progress: done / state.links.length,
    };
  }
  const on = state.scope === 'page' ? '' : ` across ${scopeName()}`;
  if (c.error) return { cls: 'error', title: `${plural(c.error, 'broken link')}${on}`, text: 'Fix them before you publish.' };
  if (c.warning) return { cls: 'warning', title: `No broken links${on}`, text: `${plural(c.warning, 'link')} could be better.` };
  if (c.unknown) return { cls: 'unknown', title: `No broken links found${on}`, text: `${plural(c.unknown, 'link')} couldn't be confirmed. Open them once to check.` };
  return { cls: 'ok', title: `All links look good${on}`, text: 'Safe to publish.' };
}

function stats(c) {
  const tiles = [
    ['error', 'Broken', c.error],
    ['warning', 'Outdated', c.warning],
    ['unknown', 'Unconfirmed', c.unknown],
    ['ok', 'Working', c.ok],
  ];
  return `<dl class="lr-stats">${tiles.map(([cls, label, n]) => `
    <div class="lr-stat lr-${cls}${n ? '' : ' lr-zero'}"><dt>${label}</dt><dd>${n}</dd></div>`).join('')}
  </dl>`;
}

function archiveLine(res) {
  if (!res.snapshot) return '';
  return `<p class="lr-archive"><span class="lr-wb" aria-hidden="true"></span>Archived ${esc(formatDate(res.snapshot.date))} · <a href="${esc(res.snapshot.url)}" target="_blank" rel="noopener">View copy</a></p>`;
}

function pageLink(path) {
  if (state.mode === 'demo') return `<span>${esc(path)}</span>`;
  return `<a href="${esc(editUrl(path))}" target="_blank" rel="noopener">${esc(path)}</a>`;
}

function pagesLine(link) {
  if (state.scope === 'page') return '';
  const shown = link.pages.slice(0, 5).map((p) => `<li>${icon('page')}${pageLink(p.path)}${p.count > 1 ? ` <span class="lr-count">${p.count}×</span>` : ''}</li>`).join('');
  const more = link.pages.length > 5 ? `<li class="lr-note">and ${link.pages.length - 5} more</li>` : '';
  return `<details class="lr-pages"${link.pages.length <= 3 ? ' open' : ''}><summary>On ${plural(link.pages.length, 'page')}</summary><ul>${shown}${more}</ul></details>`;
}

function card(link) {
  const res = resultFor(link);
  const disabled = state.busy || !state.editable ? ' disabled' : '';
  const suffix = link.pages.length > 1 ? ` on ${link.pages.length} pages` : '';
  const fixes = res.suggestions.map((s, i) => `
    <button type="button" class="lr-btn ${i === 0 ? 'primary' : 'quiet'}" data-fix="${esc(link.id)}" data-index="${i}"${s.note ? ` title="${esc(s.note)}"` : ''}${disabled}>${esc(s.label)}${esc(suffix)}</button>`).join('');
  const href = link.info.url?.href || link.href;
  return `
    <article class="lr-card lr-${res.severity}">
      <div class="lr-card-top">
        <p class="lr-text">${esc(link.text || '(no link text)')}</p>
        <span class="lr-badge">${esc(res.label)}</span>
      </div>
      <a class="lr-url" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(link.href)}">${icon('external')}<span>${esc(link.href || '(empty)')}</span></a>
      <p class="lr-msg">${esc(res.message)}${link.count > 1 && state.scope === 'page' ? ` Used ${link.count} times on this page.` : ''}</p>
      ${archiveLine(res)}
      ${pagesLine(link)}
      ${res.editPath && state.mode !== 'demo' ? `<a class="lr-action-link" href="${esc(editUrl(res.editPath))}" target="_blank" rel="noopener">Open that page to publish it</a>` : ''}
      ${fixes ? `<div class="lr-fixes">${fixes}</div>` : ''}
    </article>`;
}

/** The links to fix, in groups: broken, outdated, not confirmed. Links on the most pages first. */
function groupedList() {
  return GROUPS.map((g) => {
    const links = state.links
      .filter((l) => resultFor(l)?.severity === g.severity)
      .sort((a, b) => b.pages.length - a.pages.length || b.count - a.count);
    if (!links.length) return '';
    return `<section class="lr-group lr-${g.severity}">
      <h2>${icon(g.severity)}${g.title} <b>${links.length}</b><span>${g.hint}</span></h2>
      <div class="lr-list">${links.map(card).join('')}</div>
    </section>`;
  }).join('');
}

function skeleton() {
  return `<div class="lr-list" aria-hidden="true">${'<div class="lr-card lr-skeleton"><span></span><span></span><span></span></div>'.repeat(3)}</div>`;
}

function allGood(c) {
  return `<section class="lr-empty">
    ${icon('ok')}
    <strong>Nothing to fix</strong>
    <span>${plural(c.ok, 'link')} checked${c.skip ? `, ${c.skip} email or jump ${c.skip === 1 ? 'link' : 'links'} skipped` : ''}.</span>
  </section>`;
}

function scopeTabs() {
  const folder = folderPath();
  const options = [['page', 'This page']];
  if (folder) options.push(['folder', `Folder ${folder}`]);
  options.push(['site', 'All pages']);
  return `<div class="lr-scope" role="radiogroup" aria-label="What to check">${options.map(([value, label]) => `
    <button type="button" role="radio" data-scope="${value}" aria-checked="${state.scope === value}" title="${esc(label)}"${state.busy ? ' disabled' : ''}>${esc(label)}</button>`).join('')}
  </div>`;
}

function notice(text) {
  return `<p class="lr-notice">${icon('info')}<span>${esc(text)}</span></p>`;
}

function scanNotes() {
  const run = state.scans[state.scope];
  if (state.scope === 'page' || run?.status !== 'done') return '';
  const notes = [];
  if (run.truncated) notes.push(`Only the first ${MAX_PAGES} pages were checked.`);
  if (run.failed.length) notes.push(`${plural(run.failed.length, 'page')} couldn't be read: ${run.failed.slice(0, 3).join(', ')}${run.failed.length > 3 ? '…' : ''}`);
  return notes.map(notice).join('');
}

function confirmBar() {
  const { confirm } = state;
  if (!confirm) return '';
  return `<section class="lr-confirm" role="alertdialog" aria-label="Confirm fix">
    <p>This changes links on <strong>${plural(confirm.pages, 'page')}</strong> in Document Authoring. Nothing is published.</p>
    <div>
      <button type="button" class="lr-btn primary" data-action="confirm">Change ${plural(confirm.pages, 'page')}</button>
      <button type="button" class="lr-btn quiet" data-action="cancel">Cancel</button>
    </div>
  </section>`;
}

function header(canRecheck) {
  const where = state.scope === 'page' ? state.ctx?.path : `${folderPath() && state.scope === 'folder' ? folderPath() : 'Whole site'}`;
  return `<header class="lr-head">
    <span class="lr-logo" aria-hidden="true"></span>
    <div class="lr-title">
      <h1>Link Rescue</h1>
      ${state.ctx ? `<p class="lr-page" title="${esc(where)}">${icon('page')}<span>${esc(where)}</span></p>` : ''}
    </div>
    ${state.ctx ? `<button type="button" class="lr-icon-btn" data-action="recheck" aria-label="Check again" title="Check again"${canRecheck ? '' : ' disabled'}>${icon('refresh')}</button>` : ''}
  </header>`;
}

function render() {
  if (state.error) {
    app.innerHTML = `
      ${header(false)}
      <section class="lr-verdict lr-error">${icon('error', 'lr-verdict-icon')}<div><strong>${esc(state.error.title)}</strong><span>${esc(state.error.text)}</span></div></section>
      <button type="button" class="lr-btn quiet" data-action="demo">Show the demo instead</button>`;
    return;
  }
  const c = counts();
  const v = verdict(c);
  const ready = state.scope === 'page' || state.scans[state.scope]?.status === 'done';
  const checked = ready && state.links.length && !c.pending;
  const bulk = checked ? bulkItems() : [];
  const scanning = !ready && state.scans[state.scope]?.status !== 'error';
  const toFix = c.error + c.warning + c.unknown;
  let body = '';
  if (checked) body = toFix ? groupedList() : allGood(c);
  else if (scanning || c.pending || (state.scope === 'page' && !state.pageHtml)) body = skeleton();
  app.innerHTML = `
    ${header(!state.busy && !c.pending && !scanning)}
    ${state.mode === 'demo' ? notice('Demo pages. Open Link Rescue from Experience Workspace to check your own site.') : ''}
    ${!state.editable ? notice('You can view this page but not edit it, so fixes are turned off.') : ''}
    ${scopeTabs()}
    <section class="lr-verdict lr-${v.cls}" aria-live="polite">
      ${icon(v.cls, 'lr-verdict-icon')}
      <div>
        <strong>${esc(v.title)}</strong>
        ${v.text ? `<span>${esc(v.text)}</span>` : ''}
        ${v.progress !== undefined ? `<div class="lr-progress"><span style="width:${Math.round(v.progress * 100)}%"></span></div>` : ''}
      </div>
    </section>
    ${checked ? stats(c) : ''}
    ${scanNotes()}
    ${confirmBar()}
    ${bulk.length > 1 && !state.confirm ? `<button type="button" class="lr-btn primary lr-bulk" data-action="bulk"${state.busy || !state.editable ? ' disabled' : ''}>Apply ${bulk.length} safe fixes</button>` : ''}
    ${body}
    <footer class="lr-foot">Archived copies by the <a href="https://web.archive.org/" target="_blank" rel="noopener">Wayback Machine</a> · Link checks by <a href="https://microlink.io/" target="_blank" rel="noopener">Microlink</a></footer>`;
}

app.addEventListener('click', (e) => {
  const fix = e.target.closest('[data-fix]');
  if (fix) {
    const link = state.links.find((l) => l.id === fix.dataset.fix);
    const suggestion = resultFor(link)?.suggestions[Number(fix.dataset.index)];
    if (link && suggestion) requestFixes([{ link, suggestion }]);
    return;
  }
  const scope = e.target.closest('[data-scope]');
  if (scope) {
    setScope(scope.dataset.scope);
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'recheck') recheck();
  if (action === 'bulk') requestFixes(bulkItems());
  if (action === 'confirm') applyFixes(state.confirm.items);
  if (action === 'cancel') {
    state.confirm = null;
    render();
  }
  if (action === 'demo') {
    state.error = null;
    startDemo();
  }
});

/* ---------- start-up ---------- */

function demoContext() {
  const host = window.location.hostname.match(/^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.aem\.(page|live)$/i);
  return {
    org: host?.[3] || 'shivanim123',
    repo: host?.[2] || 'link-rescue',
    branch: 'main',
    path: '/demo/spring-update',
    hosts: [],
  };
}

async function startDemo() {
  state.mode = 'demo';
  state.sdk = null;
  state.ctx = demoContext();
  render();
  setPageHtml(await readPage(state.ctx.path));
}

/** True while the editor still shows a link that was just fixed. */
function isStale(html) {
  const { hold } = state;
  if (!hold || Date.now() > hold.until) return false;
  const hrefs = new Set(extractLinks(html, state.ctx).map((l) => l.href));
  return hold.hrefs.some((href) => hrefs.has(href));
}

async function startEditor(sdk) {
  state.sdk = sdk;
  const { context } = sdk;
  const params = new URLSearchParams(window.location.search);
  state.ctx = {
    org: context.org,
    repo: context.repo || context.site,
    branch: context.branch || 'main',
    path: toWebPath(context.path || '/'),
    hosts: (params.get('hosts') || '').split(',').filter(Boolean),
  };
  state.mode = sdk.capabilities?.liveDocument === 1 ? 'ew' : 'da';
  render();
  if (state.mode === 'ew') {
    let timer;
    sdk.actions.subscribeLiveDocument(({ html, editable }) => {
      state.editable = editable !== false;
      if (isStale(html)) return;
      clearTimeout(timer);
      // Wait for typing to pause before checking again.
      timer = setTimeout(() => setPageHtml(html), state.pageHtml ? 800 : 0);
    });
  }
  try {
    const html = await readPage(state.ctx.path);
    if (!state.pageHtml) setPageHtml(html);
  } catch (e) {
    if (!state.pageHtml) {
      state.error = { title: 'This page couldn\'t be read', text: e.message };
      render();
    }
  }
}

(async () => {
  const params = new URLSearchParams(window.location.search);
  const embedded = window.parent !== window && !params.has('demo');
  const sdk = embedded ? await withTimeout(DA_SDK, SDK_TIMEOUT, null) : null;
  if (sdk?.context?.org) {
    await startEditor(sdk);
  } else if (embedded) {
    state.error = {
      title: 'Couldn\'t connect to the editor',
      text: 'Reload Experience Workspace and open Link Rescue again.',
    };
    render();
  } else {
    await startDemo();
  }
})();
