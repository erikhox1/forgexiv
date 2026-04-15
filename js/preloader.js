/**
 * Background preloader — warms the cache for popular categories while the
 * user is browsing. Runs silently after the main content finishes loading.
 *
 * Strategy: stale-while-revalidate
 *   • If a category is already cached and fresh  → skip entirely
 *   • If a category is cached but stale          → re-fetch in background
 *   • If a category is missing                   → fetch and store
 *
 * Respects ArXiv's 3-second rate limit through the shared fetchArxiv clock.
 */

const PRELOAD_CATEGORIES = [
  'cs.AI', 'cs.LG', 'cs.CV', 'cs.CL', 'cs.RO',
  'quant-ph', 'cond-mat', 'hep-th',
  'stat.ML',
  'math.CO', 'math.PR',
  'q-bio.NC',
];

const PRELOAD_MAX_RESULTS = 100;
const PRELOAD_SORT        = 'submittedDate';

let _running  = false;
let _intervalId = null;

const AUTO_REFRESH_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Entry point — call this after the page's main content has loaded.
 * Waits a short delay so the initial user-facing request gets priority.
 * After the first run completes, schedules automatic re-runs every 4 hours.
 */
async function startBackgroundPreload(delayMs = 4000) {
  if (_running) return;
  _running = true;

  await sleep(delayMs);

  const todo = PRELOAD_CATEGORIES.filter(cat => needsFetch(cat));

  if (todo.length === 0) {
    setStatus('');
    _running = false;
    _scheduleAutoRefresh();
    return;
  }

  let done = 0;
  for (const cat of todo) {
    setStatus(`Caching ${cat}… (${done}/${todo.length})`);
    try {
      await ArXiv.search({ category: cat, maxResults: PRELOAD_MAX_RESULTS, sortBy: PRELOAD_SORT });
      done++;
    } catch (err) {
      console.warn('[preload] Failed:', cat, err.message);
    }
  }

  // Clean up localStorage entries older than 24 h
  const evicted = window._arxivCache.cacheEvict(24 * 60 * 60 * 1000);
  if (evicted) console.log(`[preload] Evicted ${evicted} local cache entries`);

  // Clean up expired Supabase rows (fire-and-forget)
  window._arxivCache.sbCacheEvictExpired().then(n => {
    if (n) console.log(`[preload] Evicted ${n} Supabase cache rows`);
  });

  setStatus(done > 0 ? `✓ ${done} categor${done === 1 ? 'y' : 'ies'} cached` : '');
  setTimeout(() => setStatus(''), 3500);
  _running = false;
  _scheduleAutoRefresh();
}

/**
 * Set up a one-shot 4-hour timer that forces a full re-cache of all
 * popular categories, then reschedules itself. Uses setTimeout rather
 * than setInterval so a long-running fetch cycle never overlaps itself.
 */
function _scheduleAutoRefresh() {
  if (_intervalId) return; // already scheduled
  _intervalId = setTimeout(async () => {
    _intervalId = null;
    console.log('[preload] Auto-refresh triggered (4-hour cycle)');
    // Force all categories to be treated as stale so needsFetch returns true
    _forceStale();
    _running = false; // allow re-entry
    await startBackgroundPreload(0); // no initial delay for scheduled runs
  }, AUTO_REFRESH_MS);
}

/**
 * Mark all preloaded category entries as stale by back-dating their
 * timestamps in localStorage so cacheGet returns stale=true.
 * This lets us reuse the existing needsFetch() logic without duplicating it.
 */
function _forceStale() {
  const CACHE_PREFIX  = 'axf-';
  const FORCE_AGE_MS  = 5 * 60 * 60 * 1000; // pretend they are 5 h old → stale

  for (const cat of PRELOAD_CATEGORIES) {
    const params = new URLSearchParams({
      search_query: `cat:${cat}`,
      start:        '0',
      max_results:  String(PRELOAD_MAX_RESULTS),
      sortBy:       PRELOAD_SORT,
      sortOrder:    'descending',
    });
    const storageKey = CACHE_PREFIX + params.toString();
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      parsed.ts = Date.now() - FORCE_AGE_MS; // back-date timestamp
      localStorage.setItem(storageKey, JSON.stringify(parsed));
    } catch { /* ignore */ }
  }
}

/** True when the category is missing from cache or stale and needs refreshing. */
function needsFetch(cat) {
  const params = new URLSearchParams({
    search_query: `cat:${cat}`,
    start:        '0',
    max_results:  String(PRELOAD_MAX_RESULTS),
    sortBy:       PRELOAD_SORT,
    sortOrder:    'descending',
  });
  const entry = window._arxivCache.cacheGet(params.toString());
  return !entry || entry.stale; // null = missing, stale=true = needs refresh
}

/** Update the small status badge in the footer area. */
function setStatus(msg) {
  const el = document.getElementById('preloadStatus');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

window.startBackgroundPreload = startBackgroundPreload;
