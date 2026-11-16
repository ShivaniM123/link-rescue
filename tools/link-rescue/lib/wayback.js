/**
 * Internet Archive Wayback Machine integration.
 * Uses the public Availability API (https://archive.org/help/wayback_api.php),
 * which needs no key and allows calls from the browser.
 */

const API = 'https://archive.org/wayback/available';
const cache = new Map();

function parseTimestamp(ts) {
  if (!ts || ts.length < 8) return null;
  const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10) || '00'}:${ts.slice(10, 12) || '00'}:00Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function query(url, timestamp) {
  const params = new URLSearchParams({ url });
  if (timestamp) params.set('timestamp', timestamp);
  const resp = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`Wayback Machine answered ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || 'Wayback Machine error');
  return json.archived_snapshots?.closest || null;
}

function yearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

/**
 * Finds the most recent good archived copy of a URL.
 * @param {string} url The original address
 * @returns {Promise<{url: string, date: Date|null, timestamp: string}|null>}
 *   The snapshot, or null when the page was never archived
 */
export async function findSnapshot(url) {
  if (cache.has(url)) return cache.get(url);
  const run = (async () => {
    let snap;
    try {
      snap = await query(url);
    } catch {
      // The archive sometimes times out on the first lookup; one retry is usually enough.
      snap = await query(url);
    }
    // The latest capture can be of the error page itself: look further back for a good copy.
    if (snap && snap.status && snap.status !== '200') snap = await query(url, yearsAgo(2));
    if (!snap || !snap.available || (snap.status && snap.status !== '200')) return null;
    return {
      url: snap.url.replace(/^http:\/\//, 'https://'),
      timestamp: snap.timestamp,
      date: parseTimestamp(snap.timestamp),
    };
  })();
  cache.set(url, run);
  run.catch(() => cache.delete(url));
  return run;
}

/** The page where anyone can ask the Wayback Machine to save a copy now. */
export function saveNowUrl(url) {
  return `https://web.archive.org/save/${url}`;
}
