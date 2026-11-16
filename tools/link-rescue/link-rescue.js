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
import { startFresh } from './lib/linkcheck.js';
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
  scans: { folder: null, pick: null },
  // "Select pages": the site's pages, the ones ticked, the search, and whether the list is open.
  picker: {
    status: 'idle', pages: [], selected: new Set(), filter: '', open: false, truncated: false,
  },
  links: [],
  // Link lists from the last check, per scope. Checks only run on open and on "Check again".
  lists: {},
  // Links fixed since the last check, per scope: they drop off the list without a new check.
  fixed: { page: new Set(), folder: new Set(), pick: new Set() },
  // The addresses on the open page at the last check, to notice when the page changes.
  checkedHrefs: null,
  changed: false,
  results: new Map(),
  editable: true,
  busy: false,
  confirm: null,
  // The link whose "Update link" form is open (by key, which survives re-checks).
  editing: null,
  // Which list the Broken / Working tabs show.
  view: 'broken',
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
    const scanned = state.scans.pick?.html.get(path) ?? state.scans.folder?.html.get(path);
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

/** Stores a page's HTML everywhere it's used (the link lists only change on a check). */
function storePage(path, html) {
  if (path === state.ctx.path) state.pageHtml = html;
  ['folder', 'pick'].forEach((scope) => {
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

function hrefsOf(html) {
  return new Set(extractLinks(html, state.ctx).map((l) => l.href));
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Builds a scope's link list from the pages read, and checks its links. */
function check(scope) {
  if (scope === 'page') {
    state.lists.page = state.pageHtml ? mergeLinks([[state.ctx.path, state.pageHtml]]) : [];
    state.checkedHrefs = hrefsOf(state.pageHtml);
    state.changed = false;
  } else {
    const run = state.scans[scope];
    state.lists[scope] = run?.status === 'done' ? mergeLinks([...run.html.entries()]) : [];
  }
  state.fixed[scope].clear();
  if (scope === state.scope) {
    state.links = state.lists[scope];
    runChecks();
  }
  render();
}

/** Links still to show: the last check, minus links fixed since. */
function visibleLinks() {
  const fixed = state.fixed[state.scope];
  return state.links.filter((l) => !fixed.has(l.key));
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
  // The first copy of the page is checked straight away; later edits only show a note.
  if (!state.lists.page) {
    check('page');
    return;
  }
  const changed = !sameSet(hrefsOf(html), state.checkedHrefs);
  if (changed !== state.changed) {
    state.changed = changed;
    render();
  }
}

/* ---------- folder and site scans ---------- */

function folderPath() {
  return folderOf(state.ctx.path);
}

async function scan(scope, chosen) {
  const folder = scope === 'folder' ? folderPath() : '';
  const run = {
    status: 'listing', found: 0, read: 0, total: 0, html: new Map(), truncated: false, failed: [],
  };
  state.scans[scope] = run;
  render();
  try {
    let pages;
    if (chosen) {
      pages = chosen;
    } else if (state.mode === 'demo') {
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
  if (state.scans[scope] === run && run.status === 'done') check(scope);
  else render();
}

function setScope(scope) {
  if (scope === state.scope) return;
  state.scope = scope;
  state.confirm = null;
  state.links = state.lists[scope] || [];
  // A scope is checked the first time it's opened; after that it shows its last check.
  if (!state.lists[scope]) {
    if (scope === 'page') check('page');
    else if (scope === 'pick') openPicker();
    else if (!state.scans[scope]) scan(scope);
  }
  render();
}

/* ---------- "Select pages" ---------- */

async function openPicker() {
  const { picker } = state;
  picker.open = true;
  picker.filter = '';
  render();
  if (picker.status === 'ready' || picker.status === 'loading') return;
  picker.status = 'loading';
  picker.found = 0;
  render();
  try {
    if (state.mode === 'demo') {
      picker.pages = Object.keys(DEMO_PAGES).sort();
    } else {
      const listed = await listPages('', state.ctx, fetcher, (found) => {
        picker.found = found;
        render();
      });
      picker.pages = listed.pages;
      picker.truncated = listed.truncated;
    }
    if (!picker.pages.includes(state.ctx.path)) picker.pages.unshift(state.ctx.path);
    if (!picker.selected.size) picker.selected.add(state.ctx.path);
    picker.status = 'ready';
  } catch (e) {
    picker.status = 'error';
    picker.error = e.message;
  }
  render();
}

function pickerMatches(path) {
  const q = state.picker.filter.trim().toLowerCase();
  return !q || path.toLowerCase().includes(q);
}

function checkPicked() {
  const { picker } = state;
  if (!picker.selected.size) return;
  picker.open = false;
  scan('pick', picker.pages.filter((pg) => picker.selected.has(pg)));
}

function recheck() {
  state.results.clear();
  startFresh();
  if (state.scope === 'page') check('page');
  else if (state.scope === 'pick') checkPicked();
  else scan(state.scope);
}

/** Marks links as fixed in every scope where all the pages they're on were changed. */
function markFixed(undo, fixed) {
  const done = new Map();
  undo.forEach(({ path, done: changes }) => changes.forEach(({ link }) => {
    if (!done.has(link.key)) done.set(link.key, new Set());
    done.get(link.key).add(path);
  }));
  Object.entries(state.lists).forEach(([scope, list]) => {
    list.forEach((l) => {
      const paths = done.get(l.key);
      if (!paths || !l.pages.every((pg) => paths.has(pg.path))) return;
      if (fixed) state.fixed[scope].add(l.key);
      else state.fixed[scope].delete(l.key);
    });
  });
  // Keep the open page's addresses in step, so our own fix doesn't count as a page change.
  undo.filter((u) => u.path === state.ctx.path).forEach(({ done: changes }) => {
    changes.forEach(({ link, suggestion }) => {
      state.checkedHrefs?.delete(fixed ? link.href : suggestion.to);
      state.checkedHrefs?.add(fixed ? suggestion.to : link.href);
    });
  });
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
    markFixed(undo, true);
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
    markFixed(undo, false);
    state.undo = null;
    state.hold = null;
    toast('Fix undone.');
  } catch (e) {
    toast(e.message);
  } finally {
    state.busy = false;
    render();
  }
}

function bulkItems() {
  return visibleLinks().map((link) => {
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
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>',
};

function icon(name, cls = '') {
  return `<svg class="lr-icon ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Broken: confirmed problems, each card's badge says what was found (Not found, Old domain…).
// Links that couldn't be checked (the site blocks checks or doesn't answer) have their own tab.
const TO_FIX = ['error', 'warning'];
const BROKEN_TITLE = 'Broken links';

function counts() {
  const c = {
    error: 0, warning: 0, ok: 0, pending: 0, unknown: 0, skip: 0,
  };
  visibleLinks().forEach((l) => {
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
    const total = visibleLinks().length;
    const done = total - c.pending;
    return {
      cls: 'pending', title: 'Checking links…', text: `${done} of ${total}`, progress: done / total,
    };
  }
  const on = state.scope === 'page' ? '' : ` across ${scopeName()}`;
  const broken = c.error + c.warning;
  // "1 broken link · 1 not checked": the same words as the tabs.
  const notChecked = c.unknown ? ` · ${c.unknown} not checked` : '';
  const openThem = `Open the not-checked ${c.unknown === 1 ? 'link' : 'links'} once to make sure ${c.unknown === 1 ? 'it works' : 'they work'}.`;
  if (broken) {
    return {
      cls: 'error',
      title: `${plural(broken, 'broken link')}${notChecked}${on}`,
      text: c.unknown ? `Fix the broken ${broken === 1 ? 'link' : 'links'} before you publish. ${openThem}` : 'Fix them before you publish.',
    };
  }
  if (c.unknown) return { cls: 'unknown', title: `No broken links${notChecked}${on}`, text: openThem };
  return { cls: 'ok', title: `All links look good${on}`, text: 'Safe to publish.' };
}

/** The Broken / Working (/ Not checked) tabs, with their counts. */
function stats(c) {
  const broken = c.error + c.warning;
  const tab = (view, cls, label, n) => `
    <button type="button" role="tab" class="lr-stat lr-${cls}${n ? '' : ' lr-zero'}" data-view="${view}" aria-selected="${state.view === view}">
      <span>${label}</span><strong>${n}</strong>
    </button>`;
  return `<div class="lr-stats" role="tablist" aria-label="Links">
    ${tab('broken', 'error', 'Broken', broken)}
    ${tab('working', 'ok', 'Working', c.ok)}
    ${c.unknown ? tab('unchecked', 'unknown', 'Not checked', c.unknown) : ''}
  </div>`;
}

/** The link text, and the address under it unless the text already is the address. */
function textAndAddress(link) {
  const href = link.info.url?.href || link.href;
  const text = (link.text || '').trim();
  const same = text && [link.href, href].some((h) => h && h.replace(/\/$/, '') === text.replace(/\/$/, ''));
  if (same) {
    return {
      text: `<a class="lr-text lr-text-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}${icon('external')}</a>`,
      address: '',
    };
  }
  return {
    text: `<p class="lr-text">${esc(text || '(no link text)')}</p>`,
    address: `<a class="lr-url" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(link.href)}">${icon('external')}<span>${esc(link.href || '(empty)')}</span></a>`,
  };
}

/** Where a working redirect or short link sends readers. */
function workingNote(link) {
  const res = resultFor(link);
  let note = res.label;
  if (res.leadsTo) {
    const to = esc(res.leadsTo.replace(/^https?:\/\//, ''));
    const host = esc((link.info.url?.hostname || '').replace(/^www\./, ''));
    note += res.label === 'Short link' ? ` · ${host} forwards readers to ${to}` : ` · forwards readers to ${to}`;
  }
  if (link.pages.length > 1) note += ` · on ${plural(link.pages.length, 'page')}`;
  return note;
}

/** The links that work, listed on request (Working tile). */
function workingList() {
  const links = visibleLinks()
    .filter((l) => resultFor(l)?.severity === 'ok')
    .sort((a, b) => b.pages.length - a.pages.length || a.href.localeCompare(b.href));
  if (!links.length) return '<p class="lr-empty-line">No working links found.</p>';
  const rows = links.map((l) => {
    const { text, address } = textAndAddress(l);
    return `
    <li>
      ${text}
      ${address}
      <span class="lr-note">${workingNote(l)}</span>
    </li>`;
  }).join('');
  return `<section class="lr-group lr-ok">
    <h2>${icon('ok')}Working links <b>${links.length}</b></h2>
    <ul class="lr-working">${rows}</ul>
  </section>`;
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

function card(link, groupTitle) {
  const res = resultFor(link);
  // The group heading already says "Broken" or "Not confirmed": only show more specific labels.
  const badge = res.label.toLowerCase() === groupTitle.toLowerCase() ? '' : `<span class="lr-badge">${esc(res.label)}</span>`;
  const disabled = state.busy || !state.editable ? ' disabled' : '';
  const suffix = link.pages.length > 1 ? ` on ${link.pages.length} pages` : '';
  // Each fix shows where it leads (or why it's offered) under the button.
  const fixes = res.suggestions.map((s, i) => `
    <div class="lr-fix">
      <button type="button" class="lr-btn quiet" data-fix="${esc(link.id)}" data-index="${i}"${s.to ? ` title="${esc(s.to)}"` : ''}${disabled}>${esc(s.label)}${esc(suffix)}</button>
      ${s.note ? `<span class="lr-note">${esc(s.note)}</span>` : ''}
    </div>`).join('');
  const { text, address } = textAndAddress(link);
  return `
    <article class="lr-card lr-${res.severity}">
      <div class="lr-card-top">
        ${text}
        ${badge}
      </div>
      ${address}
      <p class="lr-msg">${esc(res.message)}${link.count > 1 && state.scope === 'page' ? ` Used ${link.count} times on this page.` : ''}</p>
      ${archiveLine(res)}
      ${pagesLine(link)}
      ${res.editPath && state.mode !== 'demo' ? `<a class="lr-action-link" href="${esc(editUrl(res.editPath))}" target="_blank" rel="noopener">Open that page to publish it</a>` : ''}
      ${state.editing === link.key ? editForm(link, suffix) : `
      ${!fixes && res.severity === 'error' && !res.editPath ? '<p class="lr-note">No working replacement found. Update the link with an address you know works.</p>' : ''}
      <div class="lr-fixes">${fixes}
        <div class="lr-fix"><button type="button" class="lr-btn primary lr-update" data-edit="${esc(link.key)}"${disabled}>${icon('edit')}Update link</button></div>
      </div>`}
    </article>`;
}

/** The "Update link" form: like the editor's link dialog, for every page the link is on. */
function editForm(link, suffix) {
  const plainText = link.text || '';
  return `<form class="lr-edit" data-key="${esc(link.key)}" novalidate>
    <label>Address
      <input name="href" type="text" inputmode="url" autocomplete="off" spellcheck="false" value="${esc(link.href)}" required>
    </label>
    <label>Link text
      <input name="text" type="text" autocomplete="off" value="${esc(plainText)}" data-original="${esc(plainText)}">
    </label>
    <p class="lr-note lr-edit-error" role="alert" hidden></p>
    <div class="lr-edit-actions">
      <button type="submit" class="lr-btn primary"${state.busy ? ' disabled' : ''}>Save${esc(suffix)}</button>
      <button type="button" class="lr-btn quiet" data-action="cancel-edit">Cancel</button>
    </div>
  </form>`;
}

/** The links to fix, in groups: broken, outdated, not confirmed. Links on the most pages first. */
function groupedList() {
  const links = visibleLinks()
    .filter((l) => TO_FIX.includes(resultFor(l)?.severity))
    .sort((a, b) => TO_FIX.indexOf(resultFor(a).severity) - TO_FIX.indexOf(resultFor(b).severity)
      || b.pages.length - a.pages.length || b.count - a.count);
  if (!links.length) return '';
  return `<section class="lr-group lr-error">
    <h2>${icon('error')}${BROKEN_TITLE} <b>${links.length}</b><span>Fix these before you publish</span></h2>
    <div class="lr-list">${links.map((l) => card(l, BROKEN_TITLE)).join('')}</div>
  </section>`;
}

/** Links that couldn't be checked: the site blocks checks or doesn't answer. */
function uncheckedList() {
  const links = visibleLinks()
    .filter((l) => resultFor(l)?.severity === 'unknown')
    .sort((a, b) => b.pages.length - a.pages.length || a.href.localeCompare(b.href));
  if (!links.length) return '<p class="lr-empty-line">Every link was checked.</p>';
  return `<section class="lr-group lr-unknown">
    <h2>${icon('unknown')}Not checked <b>${links.length}</b><span>These may well work: open each one once to make sure</span></h2>
    <div class="lr-list">${links.map((l) => card(l, 'Not checked')).join('')}</div>
  </section>`;
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
  options.push(['pick', 'Select pages']);
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
  let where = state.ctx?.path;
  if (state.scope === 'folder') where = folderPath();
  if (state.scope === 'pick') where = plural(state.picker.selected.size, 'selected page');
  return `<header class="lr-head">
    <span class="lr-logo" aria-hidden="true"></span>
    <div class="lr-title">
      <h1>Link Rescue</h1>
      ${state.ctx ? `<p class="lr-page" title="${esc(where)}">${icon('page')}<span>${esc(where)}</span></p>` : ''}
    </div>
    ${state.ctx ? `<button type="button" class="lr-icon-btn" data-action="recheck" aria-label="Check again" title="Check again"${canRecheck ? '' : ' disabled'}>${icon('refresh')}</button>` : ''}
  </header>`;
}

/** Reads the open form, so a re-render (e.g. a check finishing) doesn't lose typing. */
function readDraft() {
  const form = app.querySelector('.lr-edit');
  if (!form) return null;
  const active = document.activeElement;
  const focused = active?.matches?.('.lr-edit input') ? active.name : null;
  return {
    key: form.dataset.key,
    href: form.elements.href.value,
    text: form.elements.text.value,
    focused,
    selection: focused ? [active.selectionStart, active.selectionEnd] : null,
  };
}

function restoreDraft(draft) {
  const form = app.querySelector('.lr-edit');
  if (!form) return;
  if (draft && draft.key === form.dataset.key) {
    form.elements.href.value = draft.href;
    form.elements.text.value = draft.text;
    if (draft.focused) {
      const input = form.elements[draft.focused];
      input.focus();
      input.setSelectionRange(...draft.selection);
    }
  } else {
    form.elements.href.focus();
    form.elements.href.select();
  }
}

function render() {
  const draft = readDraft();
  const active = document.activeElement;
  const search = active?.matches?.('.lr-picker-search') ? [active.selectionStart, active.selectionEnd] : null;
  const list = app.querySelector('.lr-picker-list');
  const scroll = list ? list.scrollTop : 0;
  renderPanel();
  restoreDraft(draft);
  const newList = app.querySelector('.lr-picker-list');
  if (newList) newList.scrollTop = scroll;
  if (search) {
    const input = app.querySelector('.lr-picker-search');
    input?.focus();
    input?.setSelectionRange(...search);
  }
}

function pickerView() {
  const { picker } = state;
  if (picker.status === 'loading' || picker.status === 'idle') {
    return `<section class="lr-verdict lr-pending">${icon('pending', 'lr-verdict-icon')}<div><strong>Finding pages…</strong><span>${picker.found || 0} so far</span></div></section>${skeleton()}`;
  }
  if (picker.status === 'error') {
    return `<section class="lr-verdict lr-error">${icon('error', 'lr-verdict-icon')}<div><strong>The pages couldn't be listed</strong><span>${esc(picker.error)}</span></div></section>`;
  }
  const n = picker.selected.size;
  const shown = picker.pages.filter(pickerMatches);
  const items = picker.pages.map((pg) => `
    <li${pickerMatches(pg) ? '' : ' hidden'}><label>
      <input type="checkbox" data-pick="${esc(pg)}"${picker.selected.has(pg) ? ' checked' : ''}>
      ${icon('page')}<span>${esc(pg)}</span>${pg === state.ctx.path ? '<em>this page</em>' : ''}
    </label></li>`).join('');
  return `<section class="lr-picker" aria-label="Choose pages to check">
    <div class="lr-picker-head"><strong>Choose pages to check</strong><span class="lr-picker-count">${n} of ${picker.pages.length} selected</span></div>
    <input type="search" class="lr-picker-search" placeholder="Search pages" value="${esc(picker.filter)}" aria-label="Search pages">
    <div class="lr-picker-tools">
      <button type="button" class="lr-link-btn" data-action="pick-all">Select all${picker.filter ? ' shown' : ''}</button>
      <button type="button" class="lr-link-btn" data-action="pick-none">Clear</button>
    </div>
    <ul class="lr-picker-list">${items}</ul>
    <p class="lr-note lr-picker-empty"${shown.length ? ' hidden' : ''}>No pages match.</p>
    ${picker.truncated ? `<p class="lr-note">Only the first ${MAX_PAGES} pages are listed.</p>` : ''}
    <div class="lr-picker-actions">
      <button type="button" class="lr-btn primary" data-action="pick-check"${n ? '' : ' disabled'}>Check ${plural(n, 'page')}</button>
      ${state.lists.pick ? '<button type="button" class="lr-btn quiet" data-action="pick-cancel">Cancel</button>' : ''}
    </div>
  </section>`;
}

/** Updates the picker's count and button without re-rendering (keeps focus and scroll). */
function updatePicker() {
  const { picker } = state;
  const n = picker.selected.size;
  const count = app.querySelector('.lr-picker-count');
  if (count) count.textContent = `${n} of ${picker.pages.length} selected`;
  const button = app.querySelector('[data-action="pick-check"]');
  if (button) {
    button.textContent = `Check ${plural(n, 'page')}`;
    button.disabled = !n;
  }
  const all = app.querySelector('[data-action="pick-all"]');
  if (all) all.textContent = `Select all${picker.filter ? ' shown' : ''}`;
  let shown = 0;
  app.querySelectorAll('.lr-picker-list li').forEach((li) => {
    const match = pickerMatches(li.querySelector('[data-pick]').dataset.pick);
    li.hidden = !match;
    if (match) shown += 1;
  });
  const empty = app.querySelector('.lr-picker-empty');
  if (empty) empty.hidden = shown > 0;
}

function renderPanel() {
  if (state.error) {
    app.innerHTML = `
      ${header(false)}
      <section class="lr-verdict lr-error">${icon('error', 'lr-verdict-icon')}<div><strong>${esc(state.error.title)}</strong><span>${esc(state.error.text)}</span></div></section>
      <button type="button" class="lr-btn quiet" data-action="demo">Show the demo instead</button>`;
    return;
  }
  if (state.scope === 'pick' && state.picker.open) {
    app.innerHTML = `
      ${header(false)}
      ${state.mode === 'demo' ? notice('Demo pages. Open Link Rescue from Experience Workspace to check your own site.') : ''}
      ${scopeTabs()}
      ${pickerView()}`;
    return;
  }
  const c = counts();
  const v = verdict(c);
  const ready = state.scope === 'page' || state.scans[state.scope]?.status === 'done';
  const checked = ready && state.links.length && !c.pending;
  const bulk = checked ? bulkItems() : [];
  const scanning = !ready && state.scans[state.scope]?.status !== 'error';
  const toFix = c.error + c.warning;
  if (state.view === 'unchecked' && !c.unknown && checked) state.view = 'broken';
  let body = '';
  if (checked && state.view === 'working') body = workingList();
  else if (checked && state.view === 'unchecked') body = uncheckedList();
  else if (checked) body = toFix ? groupedList() : allGood(c);
  else if (scanning || c.pending || (state.scope === 'page' && !state.pageHtml)) body = skeleton();
  app.innerHTML = `
    ${header(!state.busy && !c.pending && !scanning)}
    ${state.mode === 'demo' ? notice('Demo pages. Open Link Rescue from Experience Workspace to check your own site.') : ''}
    ${!state.editable ? notice('You can view this page but not edit it, so fixes are turned off.') : ''}
    ${state.changed ? `<p class="lr-notice lr-changed">${icon('info')}<span>The page's links changed since the last check.</span><button type="button" class="lr-link-btn" data-action="recheck"${state.busy || c.pending ? ' disabled' : ''}>Check again</button></p>` : ''}
    ${scopeTabs()}
    ${state.scope === 'pick' ? `<p class="lr-picked">${icon('page')}<span>${plural(state.picker.selected.size, 'page')} selected</span><button type="button" class="lr-link-btn" data-action="pick-open"${state.busy || scanning ? ' disabled' : ''}>Change pages</button></p>` : ''}
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
    ${bulk.length > 1 && !state.confirm && state.view === 'broken' ? `<button type="button" class="lr-btn primary lr-bulk" data-action="bulk"${state.busy || !state.editable ? ' disabled' : ''}>Apply ${bulk.length} safe fixes</button>` : ''}
    ${body}`;
}

app.addEventListener('click', (e) => {
  const fix = e.target.closest('[data-fix]');
  if (fix) {
    const link = state.links.find((l) => l.id === fix.dataset.fix);
    const suggestion = resultFor(link)?.suggestions[Number(fix.dataset.index)];
    if (link && suggestion) requestFixes([{ link, suggestion }]);
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    state.editing = edit.dataset.edit;
    render();
    return;
  }
  const scope = e.target.closest('[data-scope]');
  if (scope) {
    setScope(scope.dataset.scope);
    return;
  }
  const view = e.target.closest('[data-view]');
  if (view) {
    state.view = view.dataset.view;
    render();
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'recheck') recheck();
  if (action === 'pick-open') openPicker();
  if (action === 'pick-check') checkPicked();
  if (action === 'pick-cancel') {
    state.picker.open = false;
    render();
  }
  if (action === 'pick-all' || action === 'pick-none') {
    state.picker.pages.filter(pickerMatches).forEach((pg) => {
      if (action === 'pick-all') state.picker.selected.add(pg);
      else state.picker.selected.delete(pg);
    });
    app.querySelectorAll('[data-pick]').forEach((box) => {
      box.checked = state.picker.selected.has(box.dataset.pick);
    });
    updatePicker();
  }
  if (action === 'bulk') requestFixes(bulkItems());
  if (action === 'confirm') applyFixes(state.confirm.items);
  if (action === 'cancel') {
    state.confirm = null;
    render();
  }
  if (action === 'cancel-edit') {
    state.editing = null;
    render();
  }
  if (action === 'demo') {
    state.error = null;
    startDemo();
  }
});

function showEditError(form, message) {
  const el = form.querySelector('.lr-edit-error');
  el.textContent = message;
  el.hidden = false;
  form.elements.href.focus();
}

app.addEventListener('submit', (e) => {
  const form = e.target.closest('.lr-edit');
  if (!form) return;
  e.preventDefault();
  const link = state.links.find((l) => l.key === form.dataset.key);
  if (!link) return;
  const to = form.elements.href.value.trim();
  const text = form.elements.text.value;
  const textChanged = text !== form.elements.text.dataset.original;
  if (!to) {
    showEditError(form, 'Enter an address.');
    return;
  }
  try {
    // Relative addresses (/page) are fine; anything else must be a full web address.
    const parsed = new URL(to, 'https://example.com');
    if (!/^(https?|mailto|tel):$/.test(parsed.protocol)) throw new Error();
  } catch {
    showEditError(form, 'That isn\'t a valid web address.');
    return;
  }
  if (to === link.href && !textChanged) {
    state.editing = null;
    render();
    return;
  }
  const suggestion = {
    type: 'replace', label: 'Update link', to, safe: false,
  };
  if (textChanged) {
    suggestion.text = text;
    suggestion.oldText = link.text;
  }
  state.editing = null;
  requestFixes([{ link, suggestion }]);
});

app.addEventListener('change', (e) => {
  const box = e.target.closest?.('[data-pick]');
  if (!box) return;
  if (box.checked) state.picker.selected.add(box.dataset.pick);
  else state.picker.selected.delete(box.dataset.pick);
  updatePicker();
});

app.addEventListener('input', (e) => {
  if (e.target.matches?.('.lr-picker-search')) {
    state.picker.filter = e.target.value;
    updatePicker();
    return;
  }
  const error = e.target.closest?.('.lr-edit')?.querySelector('.lr-edit-error');
  if (error) error.hidden = true;
});

app.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.closest?.('.lr-edit')) {
    state.editing = null;
    render();
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
