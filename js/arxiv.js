/**
 * ArXiv API client.
 * Primary:  Netlify serverless function (production / netlify dev)
 * Fallback: corsproxy.io — used automatically when the function is unreachable
 *           (e.g. opening index.html directly from the filesystem).
 */

const PROXY        = '/.netlify/functions/arxiv';
const ARXIV_BASE   = 'https://export.arxiv.org/api/query';
const CORS_PROXY   = 'https://corsproxy.io/?';

// ── Response cache ─────────────────────────────────────────────
// ArXiv's own docs say results only change once per day (midnight UTC),
// so caching for a few hours is safe and dramatically cuts API calls.
const CACHE_PREFIX     = 'axf-';
const CACHE_FRESH_MS   = 4  * 60 * 60 * 1000;  // <4 h  → serve directly
const CACHE_STALE_MS   = 24 * 60 * 60 * 1000;  // 4-24 h → serve but schedule bg refresh
                                                 // >24 h  → evict, must re-fetch

/**
 * Returns { feed, stale } if found, null if missing/expired.
 * stale=true means the data is old enough to warrant a background refresh.
 */
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { ts, feed } = JSON.parse(raw);
    const age = Date.now() - ts;
    if (age > CACHE_STALE_MS) { localStorage.removeItem(CACHE_PREFIX + key); return null; }
    return { feed, stale: age > CACHE_FRESH_MS };
  } catch { return null; }
}

function cacheSet(key, feed) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), feed }));
  } catch {
    // Storage full — evict all cached entries and try once more
    cacheEvictAll();
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), feed })); } catch {}
  }
}

/** Remove all cache entries older than maxAgeMs (default: evict everything). */
function cacheEvict(maxAgeMs = 0) {
  const now = Date.now();
  let removed = 0;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    try {
      const { ts } = JSON.parse(localStorage.getItem(key));
      if (now - ts > maxAgeMs) { localStorage.removeItem(key); removed++; }
    } catch { localStorage.removeItem(key); removed++; }
  }
  return removed;
}

function cacheEvictAll() { cacheEvict(0); }

// ── L2 cache: Supabase (shared across all users) ───────────────
// Fresh  = cached_at < 4 h ago  → serve directly
// Stale  = cached_at 4–24 h ago → serve immediately, refresh in BG
// Expired = > 24 h ago          → ignored (Supabase cleanup removes these)

const SB_FRESH_MS = 4  * 60 * 60 * 1000;
const SB_STALE_MS = 24 * 60 * 60 * 1000;

async function sbCacheGet(key) {
  const db = window.sbClient?.();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('query_cache')
      .select('feed, cached_at')
      .eq('cache_key', key)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error || !data) return null;
    const age = Date.now() - new Date(data.cached_at).getTime();
    return { feed: data.feed, stale: age > SB_FRESH_MS };
  } catch { return null; }
}

async function sbCacheSet(key, feed) {
  const db = window.sbClient?.();
  if (!db) return;
  try {
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + SB_STALE_MS);
    await db.from('query_cache').upsert({
      cache_key:  key,
      feed,
      cached_at:  now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }, { onConflict: 'cache_key' });
  } catch (e) { console.warn('[sb-cache] write failed:', e.message); }
}

/** Delete all rows past their expires_at — run periodically from the preloader. */
async function sbCacheEvictExpired() {
  const db = window.sbClient?.();
  if (!db) return 0;
  try {
    const { count } = await db
      .from('query_cache')
      .delete({ count: 'exact' })
      .lt('expires_at', new Date().toISOString());
    return count ?? 0;
  } catch { return 0; }
}

// ── Rate limiting (in-memory only — resets on page load) ───────
// Only kicks in for genuine API calls; cache hits bypass it entirely.
let _lastFetchAt   = 0;
const RATE_LIMIT_MS = 3500;
const RETRY_WAIT_MS = 5000;
const MAX_RETRIES   = 3;

async function fetchArxiv(params, _retries = 0) {
  // Enforce in-session rate limit before hitting the network
  const since = Date.now() - _lastFetchAt;
  if (_lastFetchAt > 0 && since < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - since));
  }
  _lastFetchAt = Date.now();

  const qs = params.toString();
  let text = null;

  // 1. Try the Netlify function (works in production and with `netlify dev`)
  try {
    const res = await fetch(`${PROXY}?${qs}`);
    if (res.ok) text = await res.text();
  } catch (_) { /* fall through */ }

  // 2. Fallback: public CORS proxy (handy when opening the file directly)
  if (!text) {
    const url = `${ARXIV_BASE}?${qs}`;
    const res = await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`ArXiv request failed (${res.status})`);
    text = await res.text();
  }

  // ArXiv returns plain "Rate exceeded." when throttled — back off and retry
  if (text.trim().toLowerCase().startsWith('rate exceeded')) {
    if (_retries >= MAX_RETRIES) throw new Error('ArXiv rate limit — try again in a few seconds');
    const wait = RETRY_WAIT_MS * (_retries + 1);
    console.warn(`[arxiv] Rate exceeded — retrying in ${wait / 1000}s`);
    await new Promise(r => setTimeout(r, wait));
    _lastFetchAt = 0;
    return fetchArxiv(params, _retries + 1);
  }

  return text;
}

const ArXiv = {
  /**
   * Search papers.
   * @param {object} opts
   * @param {string}  opts.query       - Free text or prefixed (ti:, au:, abs:, cat:, all:)
   * @param {string}  opts.category    - e.g. "cs.AI"
   * @param {number}  opts.start       - Pagination offset
   * @param {number}  opts.maxResults
   * @param {string}  opts.sortBy      - 'submittedDate' | 'lastUpdatedDate' | 'relevance'
   * @param {string}  opts.sortOrder   - 'descending' | 'ascending'
   */
  async search({
    query      = '',
    category   = '',
    start      = 0,
    maxResults = 25,
    sortBy     = 'submittedDate',
    sortOrder  = 'descending',
  } = {}) {
    let sq = query.trim();

    if (category && !sq) {
      sq = `cat:${category}`;
    } else if (category && sq) {
      sq = `(${sq}) AND cat:${category}`;
    }

    // Default: show recent papers when nothing is specified
    if (!sq) sq = 'all:machine learning OR all:physics OR all:mathematics';

    const params = new URLSearchParams({
      search_query: sq,
      start:        String(start),
      max_results:  String(maxResults),
      sortBy,
      sortOrder,
    });

    const cacheKey = params.toString();

    // ── L1: localStorage (instant) ──────────────────────────
    const l1 = cacheGet(cacheKey);
    if (l1 && !l1.stale) return l1.feed;

    // ── L2: Supabase (shared, fast) ─────────────────────────
    const l2 = await sbCacheGet(cacheKey);
    if (l2) {
      cacheSet(cacheKey, l2.feed);                       // warm L1
      if (l2.stale) scheduleRevalidate(params, cacheKey); // refresh in BG if stale
      return l2.feed;
    }

    // Serve stale L1 immediately while fetching fresh data
    if (l1?.stale) {
      scheduleRevalidate(params, cacheKey);
      return l1.feed;
    }

    // ── L3: ArXiv API ───────────────────────────────────────
    const feed = parseFeed(await fetchArxiv(params));
    if (feed.papers.length) {
      cacheSet(cacheKey, feed);           // store in L1
      sbCacheSet(cacheKey, feed);         // store in L2 (fire-and-forget)
    }
    return feed;
  },

  /**
   * Fetch multiple papers by ArXiv ID in a single API call.
   * Checks L1 (localStorage) and L2 (Supabase) per ID first; only the
   * truly uncached IDs hit the ArXiv API, batched as one id_list request.
   * Returns papers in the same order as the input ids array.
   */
  async getByIds(ids) {
    if (!ids.length) return [];
    const cleanIds = [...new Set(ids.map(id => id.replace(/v\d+$/, '')))];

    const found    = new Map(); // id → paper
    const needed   = [];

    // L1 pass (synchronous)
    for (const id of cleanIds) {
      const key = new URLSearchParams({ id_list: id }).toString();
      const l1  = cacheGet(key);
      if (l1 && !l1.stale && l1.feed.papers[0]) {
        found.set(id, l1.feed.papers[0]);
      } else {
        needed.push(id);
      }
    }

    // L2 pass (parallel Supabase lookups for remaining IDs)
    const stillNeeded = [];
    await Promise.all(needed.map(async (id) => {
      const key = new URLSearchParams({ id_list: id }).toString();
      const l2  = await sbCacheGet(key);
      if (l2 && l2.feed.papers[0]) {
        cacheSet(key, l2.feed);
        found.set(id, l2.feed.papers[0]);
      } else {
        stillNeeded.push(id);
      }
    }));

    // L3 pass: one batched API call for everything still missing
    if (stillNeeded.length) {
      const params = new URLSearchParams({ id_list: stillNeeded.join(',') });
      const feed   = parseFeed(await fetchArxiv(params));
      for (const paper of feed.papers) {
        const singleFeed = { totalResults: 1, startIndex: 0, papers: [paper] };
        const key        = new URLSearchParams({ id_list: paper.id }).toString();
        cacheSet(key, singleFeed);
        sbCacheSet(key, singleFeed);
        found.set(paper.id, paper);
      }
    }

    return cleanIds.map(id => found.get(id)).filter(Boolean);
  },

  /** Fetch a single paper by its ArXiv ID (e.g. "1706.03762"). */
  async getById(id) {
    const cleanId  = id.replace(/v\d+$/, '');
    const params   = new URLSearchParams({ id_list: cleanId });
    const cacheKey = params.toString();

    const l1 = cacheGet(cacheKey);
    if (l1 && !l1.stale) return l1.feed.papers[0] ?? null;

    const l2 = await sbCacheGet(cacheKey);
    if (l2) {
      cacheSet(cacheKey, l2.feed);
      return l2.feed.papers[0] ?? null;
    }

    if (l1?.stale) return l1.feed.papers[0] ?? null;

    const feed = parseFeed(await fetchArxiv(params));
    if (feed.papers.length) {
      cacheSet(cacheKey, feed);
      sbCacheSet(cacheKey, feed);
    }
    return feed.papers[0] ?? null;
  },
};

// ─── XML parsing ─────────────────────────────────────────────────────────────

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length) {
    console.error('[arxiv] XML parse error — raw response:', xml.slice(0, 200));
    return { totalResults: 0, startIndex: 0, papers: [] };
  }

  // Use getElementsByTagName — querySelectorAll is unreliable on namespaced Atom XML
  const numTag = (name) => {
    // try prefixed name first, then local name via iteration
    const direct = doc.getElementsByTagName(name)[0];
    if (direct) return parseInt(direct.textContent || '0');
    for (const el of doc.getElementsByTagName('*')) {
      if (el.localName === name) return parseInt(el.textContent || '0');
    }
    return 0;
  };

  const entries = Array.from(doc.getElementsByTagName('entry'));
  const total   = numTag('totalResults');

  return {
    totalResults: total,
    startIndex:   numTag('startIndex'),
    papers:       entries.map(parseEntry),
  };
}

function parseEntry(e) {
  // Safe text getter by local tag name
  const tag = (name) => {
    const els = e.getElementsByTagName(name);
    for (const el of els) {
      if (el.localName === name) return el.textContent?.trim() ?? '';
    }
    return '';
  };

  const byLocal = (name) => {
    for (const el of e.getElementsByTagName('*')) {
      if (el.localName === name) return el;
    }
    return null;
  };

  // Extract bare ArXiv ID from the <id> URL
  const rawId = tag('id');
  const idMatch = rawId.match(/arxiv\.org\/abs\/(.+)$/i);
  const id = (idMatch ? idMatch[1] : rawId).replace(/v\d+$/, '');

  // Authors: grab all <name> children of <author> elements
  const authors = [];
  for (const authorEl of e.getElementsByTagName('author')) {
    const nameEl = authorEl.getElementsByTagName('name')[0];
    if (nameEl) authors.push(nameEl.textContent.trim());
  }

  // Categories
  const categories = [];
  for (const c of e.getElementsByTagName('category')) {
    const term = c.getAttribute('term');
    if (term) categories.push(term);
  }

  const primaryCategory =
    byLocal('primary_category')?.getAttribute('term') ?? categories[0] ?? '';

  // Links
  let pdfLink = `https://arxiv.org/pdf/${id}`;
  let absLink = `https://arxiv.org/abs/${id}`;
  for (const l of e.getElementsByTagName('link')) {
    const type = l.getAttribute('type') ?? '';
    const rel  = l.getAttribute('rel')  ?? '';
    const href = l.getAttribute('href') ?? '';
    if (type === 'application/pdf')  pdfLink = href;
    if (rel  === 'alternate' && href) absLink = href;
  }

  return {
    id,
    title:        tag('title').replace(/\s+/g, ' '),
    summary:      tag('summary').replace(/\s+/g, ' '),
    published:    tag('published'),
    updated:      tag('updated'),
    authors,
    categories,
    primaryCategory,
    pdfLink,
    absLink,
    doi:          byLocal('doi')?.textContent?.trim()         ?? '',
    journalRef:   byLocal('journal_ref')?.textContent?.trim() ?? '',
    arxivComment: byLocal('comment')?.textContent?.trim()     ?? '',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format an ISO date string to "Jan 12, 2024" */
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** Truncate a string to maxLen characters, ending with "…" if cut. */
function truncate(str, maxLen = 200) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, str.lastIndexOf(' ', maxLen)) + '…';
}

/** Return true if the ISO date is within the last N days. */
function isRecent(iso, days = 7) {
  if (!iso) return false;
  const diff = Date.now() - new Date(iso).getTime();
  return diff < days * 86400 * 1000;
}

/** Top-level category (e.g. "cs.AI" → "cs", "quant-ph" → "physics") */
function topCategory(cat) {
  if (!cat) return 'other';
  if (cat.startsWith('cs'))     return 'cs';
  if (cat.startsWith('math'))   return 'math';
  if (cat.startsWith('stat'))   return 'stat';
  if (cat.startsWith('q-bio'))  return 'bio';
  if (cat.startsWith('econ'))   return 'econ';
  if (cat.startsWith('q-fin'))  return 'fin';
  if (cat.startsWith('eess'))   return 'eess';
  return 'physics';
}

/**
 * Render LaTeX inside an element using KaTeX auto-render.
 * Supports: $...$ \(...\) for inline, $$...$$ \[...\] for display.
 * Safe to call even if KaTeX hasn't loaded yet (no-ops gracefully).
 */
function renderMath(el) {
  if (!el || typeof renderMathInElement === 'undefined') return;
  renderMathInElement(el, {
    delimiters: [
      { left: '$$', right: '$$', display: true  },
      { left: '\\[', right: '\\]', display: true  },
      { left: '$',  right: '$',  display: false },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
    errorColor: 'var(--error)',
    // Ignore content inside code/pre tags
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
  });
}

// ── Stale-while-revalidate background refresh ─────────────────
const _revalidating = new Set();

function scheduleRevalidate(params, cacheKey) {
  if (_revalidating.has(cacheKey)) return; // already in flight
  _revalidating.add(cacheKey);
  setTimeout(async () => {
    try {
      const fresh = parseFeed(await fetchArxiv(params));
      if (fresh.papers.length) cacheSet(cacheKey, fresh);
    } catch (e) {
      console.warn('[cache] Background revalidation failed:', e.message);
    } finally {
      _revalidating.delete(cacheKey);
    }
  }, 0);
}

// Run once on load: evict entries older than 24 h
cacheEvict(24 * 60 * 60 * 1000);

window.ArXiv       = ArXiv;
window.fmtDate     = fmtDate;
window.truncate    = truncate;
window.isRecent    = isRecent;
window.topCategory = topCategory;
window.renderMath  = renderMath;
// Expose cache helpers for the preloader
window._arxivCache = { cacheGet, cacheSet, cacheEvict, sbCacheEvictExpired };
