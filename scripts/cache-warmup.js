'use strict';

/**
 * ForgeXiv Cache Warmup
 *
 * Fetches arXiv data for every sidebar category, the Latest feed,
 * the Popular feed, and current Trending papers, then writes results
 * into the Supabase query_cache table.
 *
 * Cache keys are built with the exact same URLSearchParams logic used
 * in arxiv.js so the browser hits L2 (Supabase) on first load instead
 * of going all the way to the arXiv API.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 */

const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const { DOMParser }    = require('@xmldom/xmldom');

// ── Config ─────────────────────────────────────────────────────

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ARXIV_BASE      = 'https://export.arxiv.org/api/query';
const RATE_LIMIT_MS   = 3500;   // arXiv requires >= 3 s between requests
const MAX_RESULTS     = 100;
const CACHE_STALE_MS  = 24 * 60 * 60 * 1000;  // expire after 24 h (matches arxiv.js)
const MAX_RETRIES     = 3;
const RETRY_BASE_MS   = 5000;

// Default query used by the Latest and Popular feeds when no category/search is set.
// Must match the fallback in arxiv.js ArXiv.search().
const DEFAULT_QUERY = 'all:machine learning OR all:physics OR all:mathematics';

// Every category shown in the "Browse by Category" sidebar in index.html
const SIDEBAR_CATEGORIES = [
  // Computer Science
  'cs.AI', 'cs.LG', 'cs.CV', 'cs.CL', 'cs.RO',
  'cs.NE', 'cs.DS', 'cs.PL', 'cs.SE', 'cs.CR',
  // Mathematics
  'math.AG', 'math.AP', 'math.NT', 'math.PR', 'math.ST', 'math.CO', 'math.OC',
  // Physics
  'quant-ph', 'cond-mat', 'hep-th', 'hep-ph', 'astro-ph', 'gr-qc', 'physics.bio-ph',
  // Statistics
  'stat.ML', 'stat.TH', 'stat.ME', 'stat.AP',
  // Biology (q-bio)
  'q-bio.NC', 'q-bio.QM', 'q-bio.GN', 'q-bio.BM',
  // Economics / Finance
  'econ.EM', 'econ.TH', 'q-fin.ST', 'q-fin.TR',
  // Engineering & Systems
  'eess.SP', 'eess.IV', 'eess.SY',
];

// ── arXiv fetching ──────────────────────────────────────────────

let _lastFetchAt = 0;

async function fetchArxiv(queryString, retries = 0) {
  // Enforce rate limit
  const waited = Date.now() - _lastFetchAt;
  if (_lastFetchAt > 0 && waited < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - waited);
  }
  _lastFetchAt = Date.now();

  const text = await httpsGet(`${ARXIV_BASE}?${queryString}`);

  if (text.trim().toLowerCase().startsWith('rate exceeded')) {
    if (retries >= MAX_RETRIES) throw new Error('arXiv rate limit — max retries reached');
    const wait = RETRY_BASE_MS * (retries + 1);
    console.warn(`    ⚠ Rate exceeded — retrying in ${wait / 1000}s...`);
    await sleep(wait);
    _lastFetchAt = 0;
    return fetchArxiv(queryString, retries + 1);
  }

  return text;
}

// ── Supabase cache write ────────────────────────────────────────

async function sbWrite(cacheKey, feed) {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_STALE_MS);
  const { error } = await db.from('query_cache').upsert(
    { cache_key: cacheKey, feed, cached_at: now.toISOString(), expires_at: expiresAt.toISOString() },
    { onConflict: 'cache_key' },
  );
  if (error) throw new Error(`Supabase write: ${error.message}`);
}

// ── Warm a single feed (Latest or Popular) ─────────────────────

async function warmFeed(sortBy) {
  // Build params exactly as arxiv.js ArXiv.search() does for no query/category
  const params = new URLSearchParams({
    search_query: DEFAULT_QUERY,
    start:        '0',
    max_results:  String(MAX_RESULTS),
    sortBy,
    sortOrder:    'descending',
  });
  const cacheKey = params.toString();
  const xml  = await fetchArxiv(cacheKey);
  const feed = parseFeed(xml);
  if (!feed.papers.length) return 0; // arXiv returned nothing — skip, don't error
  await sbWrite(cacheKey, feed);
  return feed.papers.length;
}

// ── Warm a single sidebar category ─────────────────────────────

async function warmCategory(category) {
  // Build params exactly as arxiv.js ArXiv.search({ category }) does
  const params = new URLSearchParams({
    search_query: `cat:${category}`,
    start:        '0',
    max_results:  String(MAX_RESULTS),
    sortBy:       'submittedDate',
    sortOrder:    'descending',
  });
  const cacheKey = params.toString();
  const xml  = await fetchArxiv(cacheKey);
  const feed = parseFeed(xml);
  if (!feed.papers.length) return 0; // category may be empty or an alias — skip, don't error
  await sbWrite(cacheKey, feed);
  return feed.papers.length;
}

// ── Warm trending paper metadata ────────────────────────────────

async function warmTrending() {
  // 1. Find trending paper IDs from Supabase (last 7 days, most commented)
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db
    .from('comments')
    .select('paper_id')
    .gte('created_at', since);

  if (error) throw new Error(`Supabase trending query: ${error.message}`);
  if (!rows || rows.length === 0) return 0;

  // Count by paper_id, take top 50
  const counts = {};
  for (const { paper_id } of rows) {
    counts[paper_id] = (counts[paper_id] ?? 0) + 1;
  }
  const topIds = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([id]) => id.replace(/v\d+$/, ''));

  if (topIds.length === 0) return 0;

  // 2. One batched arXiv call for all trending papers
  const params = new URLSearchParams({ id_list: topIds.join(',') });
  const xml    = await fetchArxiv(params.toString());
  const feed   = parseFeed(xml);

  // 3. Cache each paper individually — key matches arxiv.js getByIds()
  for (const paper of feed.papers) {
    const key        = new URLSearchParams({ id_list: paper.id }).toString();
    const singleFeed = { totalResults: 1, startIndex: 0, papers: [paper] };
    await sbWrite(key, singleFeed);
  }

  return feed.papers.length;
}

// ── XML parsing (ported from arxiv.js, uses @xmldom/xmldom) ────

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const numTag = (name) => {
    const direct = doc.getElementsByTagName(name)[0];
    if (direct) return parseInt(direct.textContent || '0');
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      if (el.localName === name) return parseInt(el.textContent || '0');
    }
    return 0;
  };

  return {
    totalResults: numTag('totalResults'),
    startIndex:   numTag('startIndex'),
    papers:       Array.from(doc.getElementsByTagName('entry')).map(parseEntry),
  };
}

function parseEntry(e) {
  const tag = (name) => {
    for (const el of Array.from(e.getElementsByTagName(name))) {
      if (el.localName === name) return el.textContent?.trim() ?? '';
    }
    return '';
  };

  const byLocal = (name) => {
    for (const el of Array.from(e.getElementsByTagName('*'))) {
      if (el.localName === name) return el;
    }
    return null;
  };

  const rawId   = tag('id');
  const idMatch = rawId.match(/arxiv\.org\/abs\/(.+)$/i);
  const id      = (idMatch ? idMatch[1] : rawId).replace(/v\d+$/, '');

  const authors = [];
  for (const authorEl of Array.from(e.getElementsByTagName('author'))) {
    const nameEl = authorEl.getElementsByTagName('name')[0];
    if (nameEl) authors.push(nameEl.textContent.trim());
  }

  const categories = [];
  for (const c of Array.from(e.getElementsByTagName('category'))) {
    const term = c.getAttribute('term');
    if (term) categories.push(term);
  }

  let pdfLink = `https://arxiv.org/pdf/${id}`;
  let absLink = `https://arxiv.org/abs/${id}`;
  for (const l of Array.from(e.getElementsByTagName('link'))) {
    const type = l.getAttribute('type') ?? '';
    const rel  = l.getAttribute('rel')  ?? '';
    const href = l.getAttribute('href') ?? '';
    if (type === 'application/pdf')      pdfLink = href;
    if (rel  === 'alternate' && href)    absLink = href;
  }

  return {
    id, authors, categories, pdfLink, absLink,
    primaryCategory: byLocal('primary_category')?.getAttribute('term') ?? categories[0] ?? '',
    title:           tag('title').replace(/\s+/g, ' '),
    summary:         tag('summary').replace(/\s+/g, ' '),
    published:       tag('published'),
    updated:         tag('updated'),
    doi:             byLocal('doi')?.textContent?.trim()         ?? '',
    journalRef:      byLocal('journal_ref')?.textContent?.trim() ?? '',
    arxivComment:    byLocal('comment')?.textContent?.trim()     ?? '',
  };
}

// ── Utilities ───────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ForgeXiv Cache Warmup — ${new Date().toUTCString()}`);
  console.log('='.repeat(60));

  let totalPapers = 0;
  let errors      = 0;

  // ── 1. Latest feed ───────────────────────────────────────────
  console.log('\n[1] Latest feed (submittedDate)…');
  try {
    const n = await warmFeed('submittedDate');
    console.log(`    ✓ ${n} papers cached`);
    totalPapers += n;
  } catch (err) {
    console.error(`    ✗ ${err.message}`);
    errors++;
  }

  // ── 2. Popular feed ──────────────────────────────────────────
  console.log('\n[2] Popular feed (lastUpdatedDate)…');
  try {
    const n = await warmFeed('lastUpdatedDate');
    console.log(`    ✓ ${n} papers cached`);
    totalPapers += n;
  } catch (err) {
    console.error(`    ✗ ${err.message}`);
    errors++;
  }

  // ── 3. Sidebar categories ────────────────────────────────────
  console.log(`\n[3] Sidebar categories (${SIDEBAR_CATEGORIES.length} total)…`);
  for (let i = 0; i < SIDEBAR_CATEGORIES.length; i++) {
    const cat = SIDEBAR_CATEGORIES[i];
    const tag = `[${String(i + 1).padStart(2)}/${SIDEBAR_CATEGORIES.length}] ${cat}`;
    try {
      const n = await warmCategory(cat);
      if (n > 0) {
        console.log(`    ✓ ${tag}: ${n} papers`);
        totalPapers += n;
      } else {
        console.log(`    – ${tag}: 0 papers (empty or aliased category, skipped)`);
      }
    } catch (err) {
      console.error(`    ✗ ${tag}: ${err.message}`);
      errors++;
    }
  }

  // ── 4. Trending papers ───────────────────────────────────────
  console.log('\n[4] Trending paper metadata…');
  try {
    const n = await warmTrending();
    if (n > 0) {
      console.log(`    ✓ ${n} trending papers cached`);
      totalPapers += n;
    } else {
      console.log('    – No trending papers yet');
    }
  } catch (err) {
    console.error(`    ✗ ${err.message}`);
    errors++;
  }

  // ── 5. Evict expired rows ────────────────────────────────────
  console.log('\n[5] Evicting expired cache rows…');
  try {
    const { count, error } = await db
      .from('query_cache')
      .delete({ count: 'exact' })
      .lt('expires_at', new Date().toISOString());
    if (error) throw error;
    console.log(`    ✓ ${count ?? 0} expired rows removed`);
  } catch (err) {
    console.error(`    ✗ ${err.message}`);
  }

  // ── Summary ──────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done in ${elapsed}s — ${totalPapers} papers written, ${errors} error(s)`);
  console.log('='.repeat(60) + '\n');

  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
