/* eslint no-use-before-define: ["error", { "functions": false }] */
/**
 * Link Rescue: an Experience Workspace panel that finds broken links on the page
 * being edited and fixes them in one click, using the Wayback Machine to rescue dead pages.
 */
import { extractLinks, toWebPath, toSourcePath } from './lib/links.js';
import { checkLink, formatDate } from './lib/checks.js';
import { applyChange, reverseChange } from './lib/fixes.js';
import { saveNowUrl } from './lib/wayback.js';

const SDK_URL = 'https://da.live/nx/utils/sdk.js';
const DA_SOURCE = 'https://admin.da.live/source';
const CONCURRENCY = 4;
const ORDER = {
  error: 0, warning: 1, unknown: 2, ok: 3, skip: 4,
};
// After a fix, the editor can briefly send the old page before it picks up the change.
const HOLD_MS = 6000;

const state = {
  mode: 'demo',
  sdk: null,
  ctx: null,
  html: '',
  links: [],
  results: new Map(),
  filter: 'attention',
  editable: true,
  busy: false,
  fixed: [],
  undo: null,
  hold: null,
};

const app = document.getElementById('app');

/* ---------- helpers ---------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fetcher(url, opts) {
  if (state.sdk?.actions?.daFetch) return state.sdk.actions.daFetch(url, opts);
  return fetch(url, opts);
}

function sourceUrl() {
  const { org, repo, path } = state.ctx;
  return `${DA_SOURCE}/${org}/${repo}${toSourcePath(path)}`;
}

function editUrl(webPath) {
  const { org, repo } = state.ctx;
  const p = webPath.endsWith('/') ? `${webPath}index` : webPath;
  return `https://da.live/edit#/${org}/${repo}${p}`;
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

/* ---------- checking ---------- */

function resultFor(link) {
  return state.results.get(link.href);
}

async function runChecks() {
  const queue = state.links.filter((l) => !state.results.has(l.href));
  queue.forEach((l) => state.results.set(l.href, null));
  render();
  const worker = async () => {
    while (queue.length) {
      const link = queue.shift();
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await checkLink(link, state.ctx, fetcher);
      } catch (e) {
        res = {
          severity: 'unknown', label: 'Not checked', message: `The check failed: ${e.message}`, suggestions: [],
        };
      }
      // Skip results from before a "Check again".
      if (state.results.has(link.href)) state.results.set(link.href, res);
      render();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function setHtml(html) {
  if (html === state.html) return;
  state.html = html;
  state.links = extractLinks(html, state.ctx);
  // Results stay cached by address, so an Undo or a re-added link shows straight away.
  runChecks();
}

function recheck() {
  state.results.clear();
  const { html } = state;
  state.html = '';
  setHtml(html);
}

/* ---------- fixing ---------- */

async function readSource() {
  const resp = await fetcher(sourceUrl(), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`The page couldn't be read (${resp.status}).`);
  if (resp.permissions && !resp.permissions.includes('write')) state.editable = false;
  return resp.text();
}

async function writeSource(html) {
  const body = new FormData();
  body.append('data', new Blob([html], { type: 'text/html' }));
  const resp = await fetcher(sourceUrl(), { method: 'POST', body });
  if (!resp.ok) throw new Error(`The page couldn't be saved (${resp.status}).`);
}

/**
 * Applies fixes to the page.
 * Outside the demo, it saves the editor first, edits the saved page and writes it back.
 * Document Authoring then pushes the change into the open editor.
 */
async function applyFixes(items) {
  if (!items.length || state.busy) return;
  if (!state.editable) {
    toast('This page is read-only for you, so links can\'t be fixed here.');
    return;
  }
  state.busy = true;
  render();
  try {
    let before = state.html;
    if (state.mode !== 'demo') {
      await withTimeout(state.sdk.actions.saveDocument?.().catch(() => null), 3000, null);
      before = await readSource();
    }
    let html = before;
    const done = [];
    items.forEach(({ link, suggestion }) => {
      const out = applyChange(html, link.href, suggestion);
      if (out.count) {
        html = out.html;
        done.push({ link, suggestion, count: out.count });
      }
    });
    if (!done.length) {
      toast('That link isn\'t in the saved page yet. Wait a few seconds and try again.');
      return;
    }
    if (state.mode !== 'demo') await writeSource(html);
    state.hold = { until: Date.now() + HOLD_MS, hrefs: done.map((d) => d.link.href) };
    state.undo = { before, after: html, done };
    done.forEach(({ link, suggestion, count }) => {
      state.fixed.unshift({
        from: link.href, to: suggestion.to, type: suggestion.type, label: suggestion.label, count,
      });
    });
    setHtml(html);
    const n = done.reduce((sum, d) => sum + d.count, 0);
    toast(`${n} link${n === 1 ? '' : 's'} fixed.`, { label: 'Undo', run: undoLast });
  } catch (e) {
    toast(e.message);
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
    let html;
    if (state.mode === 'demo') {
      html = undo.before;
    } else {
      const current = await readSource();
      if (current === undo.after) {
        html = undo.before;
      } else {
        // The page changed since the fix: only reverse the link changes.
        html = current;
        undo.done.forEach(({ link, suggestion }) => {
          const rev = reverseChange(link.href, suggestion);
          if (rev) html = applyChange(html, rev.from, rev.change).html;
        });
      }
      await writeSource(html);
    }
    state.hold = null;
    const undone = new Set(undo.done.map((d) => d.link.href));
    state.fixed = state.fixed.filter((f) => !undone.has(f.from));
    state.undo = null;
    setHtml(html);
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

function verdict(c) {
  if (!state.links.length && !state.html) return { cls: 'pending', title: 'Reading the page…', text: '' };
  if (!state.links.length) return { cls: 'ok', title: 'No links on this page', text: 'Add links and they\'re checked as you go.' };
  if (c.pending) return { cls: 'pending', title: `Checking links… ${state.links.length - c.pending} of ${state.links.length}`, text: '' };
  if (c.error) {
    return {
      cls: 'error',
      title: `${c.error} broken link${c.error === 1 ? '' : 's'}: fix before you publish`,
      text: c.warning ? `${c.warning} more could be better.` : '',
    };
  }
  if (c.warning) return { cls: 'warning', title: 'Nothing broken. A few links could be better', text: `${c.warning} to review.` };
  return { cls: 'ok', title: 'All links look good. Safe to publish', text: `${c.ok} link${c.ok === 1 ? '' : 's'} checked.` };
}

function archiveLine(res, link) {
  if (res.snapshot) {
    return `<p class="lr-archive"><span class="lr-wb" aria-hidden="true"></span>Archived ${esc(formatDate(res.snapshot.date))} · <a href="${esc(res.snapshot.url)}" target="_blank" rel="noopener">View copy</a></p>`;
  }
  if (res.noArchive) {
    return `<p class="lr-archive"><span class="lr-wb" aria-hidden="true"></span>No archived copy yet · <a href="${esc(saveNowUrl(link.info.url.href))}" target="_blank" rel="noopener">Save one now</a></p>`;
  }
  return '';
}

function card(link) {
  const res = resultFor(link);
  const severity = res ? res.severity : 'pending';
  const text = link.text || '(no link text)';
  const disabled = state.busy || !state.editable ? ' disabled' : '';
  const suggestions = (res?.suggestions || []).map((s, i) => `
    <li>
      <button type="button" class="lr-btn ${i === 0 ? 'primary' : 'secondary'}" data-fix="${esc(link.id)}" data-index="${i}"${disabled}>${esc(s.label)}</button>
      ${s.note ? `<span class="lr-note">${esc(s.note)}</span>` : ''}
    </li>`).join('');
  return `
    <article class="lr-card lr-${severity}">
      <header>
        <span class="lr-badge">${esc(res ? res.label : 'Checking')}</span>
        ${link.count > 1 ? `<span class="lr-count" title="Used ${link.count} times on this page">${link.count}×</span>` : ''}
      </header>
      <p class="lr-text">${esc(text)}</p>
      <a class="lr-url" href="${esc(link.info.url?.href || link.href)}" target="_blank" rel="noopener" title="${esc(link.href)}">${esc(link.href || '(empty)')}</a>
      ${res ? `<p class="lr-msg">${esc(res.message)}</p>` : ''}
      ${res ? archiveLine(res, link) : ''}
      ${res?.editPath && state.mode !== 'demo' ? `<p class="lr-msg"><a href="${esc(editUrl(res.editPath))}" target="_blank" rel="noopener">Open that page to preview and publish it</a></p>` : ''}
      ${suggestions ? `<ul class="lr-fixes">${suggestions}</ul>` : ''}
    </article>`;
}

function visibleLinks() {
  const sorted = [...state.links].sort((a, b) => {
    const ra = resultFor(a);
    const rb = resultFor(b);
    return (ORDER[ra?.severity] ?? 2.5) - (ORDER[rb?.severity] ?? 2.5);
  });
  if (state.filter === 'all') return sorted;
  return sorted.filter((l) => {
    const r = resultFor(l);
    return !r || ['error', 'warning', 'unknown'].includes(r.severity);
  });
}

function fixedList() {
  if (!state.fixed.length) return '<p class="lr-empty">Nothing fixed yet.</p>';
  return state.fixed.map((f) => `
    <article class="lr-card lr-fixed">
      <header><span class="lr-badge">Fixed${f.count > 1 ? ` · ${f.count}×` : ''}</span></header>
      <p class="lr-url lr-old">${esc(f.from)}</p>
      <p class="lr-url">${f.type === 'unlink' ? 'Link removed, text kept' : `→ ${esc(f.to)}`}</p>
    </article>`).join('');
}

function render() {
  const c = counts();
  const v = verdict(c);
  const bulk = c.pending ? [] : bulkItems();
  const list = state.filter === 'fixed' ? fixedList() : visibleLinks().map(card).join('');
  const attention = c.error + c.warning + c.unknown;
  app.innerHTML = `
    <div class="lr-head">
      <div>
        <h1><span class="lr-logo" aria-hidden="true"></span>Link Rescue</h1>
        <p class="lr-page" title="${esc(state.ctx?.path)}">${esc(state.ctx ? `${state.ctx.path}` : '')}</p>
      </div>
      <button type="button" class="lr-btn secondary" data-action="recheck"${state.busy || c.pending ? ' disabled' : ''}>Check again</button>
    </div>
    ${state.mode === 'demo' ? '<p class="lr-demo">Demo page. Open Link Rescue from Experience Workspace to check your own page.</p>' : ''}
    ${!state.editable ? '<p class="lr-demo">You can view this page but not edit it, so fixes are turned off.</p>' : ''}
    <section class="lr-verdict lr-${v.cls}" aria-live="polite">
      <strong>${esc(v.title)}</strong>
      ${v.text ? `<span>${esc(v.text)}</span>` : ''}
      ${c.pending ? `<div class="lr-progress"><span style="width:${Math.round(((state.links.length - c.pending) / Math.max(state.links.length, 1)) * 100)}%"></span></div>` : ''}
    </section>
    ${bulk.length > 1 ? `<button type="button" class="lr-btn primary lr-bulk" data-action="bulk"${state.busy || !state.editable ? ' disabled' : ''}>Apply ${bulk.length} suggested fixes</button>` : ''}
    <div class="lr-tabs" role="tablist">
      <button type="button" role="tab" data-filter="attention" aria-selected="${state.filter === 'attention'}">Needs attention <b>${attention}</b></button>
      <button type="button" role="tab" data-filter="all" aria-selected="${state.filter === 'all'}">All <b>${state.links.length}</b></button>
      <button type="button" role="tab" data-filter="fixed" aria-selected="${state.filter === 'fixed'}">Fixed <b>${state.fixed.length}</b></button>
    </div>
    <div class="lr-list">${list || (state.links.length ? '<p class="lr-empty">Nothing needs attention.</p>' : '')}</div>
    <footer class="lr-foot">Archived copies by the <a href="https://web.archive.org/" target="_blank" rel="noopener">Internet Archive Wayback Machine</a>.</footer>`;
}

app.addEventListener('click', (e) => {
  const fix = e.target.closest('[data-fix]');
  if (fix) {
    const link = state.links.find((l) => l.id === fix.dataset.fix);
    const suggestion = resultFor(link)?.suggestions[Number(fix.dataset.index)];
    if (link && suggestion) applyFixes([{ link, suggestion }]);
    return;
  }
  const tab = e.target.closest('[data-filter]');
  if (tab) {
    state.filter = tab.dataset.filter;
    render();
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'recheck') recheck();
  if (action === 'bulk') applyFixes(bulkItems());
});

/* ---------- start-up ---------- */

async function loadSdk() {
  if (window.parent === window) return null;
  try {
    const { default: sdkPromise } = await import(SDK_URL);
    return await withTimeout(sdkPromise, 3000, null);
  } catch {
    return null;
  }
}

function demoContext() {
  const host = window.location.hostname.match(/^[a-z0-9-]+--([a-z0-9-]+)--([a-z0-9-]+)\.aem\.(page|live)$/i);
  return {
    org: host?.[2] || 'shivanim123',
    repo: host?.[1] || 'link-rescue',
    branch: 'main',
    path: '/demo/spring-update',
    hosts: [],
  };
}

async function startDemo() {
  state.mode = 'demo';
  state.ctx = demoContext();
  render();
  const resp = await fetch(new URL('./demo/sample.html', import.meta.url));
  setHtml(await resp.text());
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
      timer = setTimeout(() => setHtml(html), state.html ? 800 : 0);
    });
  }
  try {
    const html = await readSource();
    if (!state.html) setHtml(html);
  } catch (e) {
    if (state.mode === 'da') toast(e.message);
  }
}

(async () => {
  const sdk = new URLSearchParams(window.location.search).has('demo') ? null : await loadSdk();
  if (sdk?.context?.org) await startEditor(sdk);
  else await startDemo();
})();
