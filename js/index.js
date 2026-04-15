/**
 * Index page — infinite scroll with background prefetch.
 *
 * Flow:
 *  1. Initial fetch: 100 papers. Show first 25, buffer remaining 75.
 *  2. Intersection Observer fires when user nears the bottom.
 *     → splice 25 from buffer into DOM.
 *  3. When buffer drops below 50 (user ~halfway through), start prefetching
 *     the next 100. ArXiv rate-limit (3.2 s) is enforced inside fetchArxiv.
 *  4. Repeat until results exhausted.
 */

const SHOW_BATCH        = 25;   // revealed per scroll trigger
const FETCH_BATCH       = 100;  // fetched from API per call
const PREFETCH_TRIGGER  = 50;   // start next fetch when buffer < this

// ── State ──────────────────────────────────────────────────────
const state = {
  query:      '',
  category:   '',
  sortBy:     'submittedDate',
  sortOrder:  'descending',
  view:       'feed',   // 'feed' | 'trending'

  shown:       [],   // paper objects already in DOM
  buffer:      [],   // fetched, waiting to be shown
  nextStart:   0,    // next API offset
  total:       0,

  loading:     false,
  prefetching: false,
  exhausted:   false,
};

let epoch    = 0;   // incremented on each new search; stale async ops check this
let observer = null;

// ── Init ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params   = new URLSearchParams(location.search);
  state.query    = params.get('q')   || '';
  state.category = params.get('cat') || '';
  state.view     = params.get('view') || 'feed';
  const sortParam = params.get('sort') || '';

  document.getElementById('searchInput').value = state.query;

  if (state.category) {
    highlightCatLink(state.category);
    openGroupForCat(state.category);
  }

  setupObserver();
  bindEvents();

  if (state.view === 'trending') {
    setNavActive('trending');
    loadTrending();
  } else if (sortParam === 'popular') {
    state.sortBy   = 'lastUpdatedDate';
    state.sortOrder = 'descending';
    setNavActive('top');
    loadFresh();
  } else {
    state.sortBy   = 'submittedDate';
    state.sortOrder = 'descending';
    setNavActive('latest');
    loadFresh();
  }
});

// ── Intersection Observer ──────────────────────────────────────
function setupObserver() {
  observer = new IntersectionObserver(
    (entries) => { if (entries[0].isIntersecting) showMore(); },
    { rootMargin: '400px' },
  );
  observer.observe(document.getElementById('sentinel'));
}

// ── Events ─────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = document.getElementById('searchInput').value.trim();

    const directId = parseArxivInput(raw);
    if (directId) {
      location.href = `paper.html?id=${encodeURIComponent(directId)}`;
      return;
    }

    state.query    = raw;
    state.category = '';
    state.view     = 'feed';
    highlightCatLink('');
    setNavActive('latest');
    pushUrl();
    loadFresh();
  });

  document.getElementById('sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    const cat = btn.dataset.cat;
    if (state.category === cat) {
      state.category = '';
      highlightCatLink('');
    } else {
      state.category = cat;
      state.query    = '';
      document.getElementById('searchInput').value = '';
      highlightCatLink(cat);
    }
    state.view  = 'feed';
    state.start = 0;
    setNavActive('latest');
    pushUrl();
    loadFresh();
  });

  document.getElementById('navLatest')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.view      = 'feed';
    state.query     = '';
    state.category  = '';
    state.sortBy    = 'submittedDate';
    state.sortOrder = 'descending';
    document.getElementById('searchInput').value = '';
    highlightCatLink('');
    setNavActive('latest');
    history.replaceState(null, '', location.pathname);
    loadFresh();
  });

  document.getElementById('navTop')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.view      = 'feed';
    state.query     = '';
    state.category  = '';
    state.sortBy    = 'lastUpdatedDate';
    state.sortOrder = 'descending';
    document.getElementById('searchInput').value = '';
    highlightCatLink('');
    setNavActive('top');
    history.replaceState(null, '', '?sort=popular');
    loadFresh();
  });

  document.getElementById('navTrending')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.view = 'trending';
    setNavActive('trending');
    history.replaceState(null, '', '?view=trending');
    loadTrending();
  });
}

// ── Trending ───────────────────────────────────────────────────
async function loadTrending() {
  const myEpoch = ++epoch;

  document.getElementById('paperList').innerHTML = '';
  document.getElementById('bottomLoader').style.display = 'none';
  document.getElementById('endMessage').style.display   = 'none';
  document.getElementById('activeFilterRow').style.display = 'none';
  renderSkeleton();
  renderFeedInfo('Loading trending…');

  if (!Comments.isConfigured()) {
    document.getElementById('paperList').innerHTML = `
      <li class="empty-state">
        <div style="font-size:2rem">💬</div>
        <p>Trending requires Supabase comments to be configured.</p>
      </li>`;
    renderFeedInfo('Trending unavailable');
    return;
  }

  try {
    const trending = await Comments.trending(50);

    if (myEpoch !== epoch) return;

    if (trending.length === 0) {
      document.getElementById('paperList').innerHTML = `
        <li class="empty-state">
          <div style="font-size:2rem">📊</div>
          <p>No trending papers yet.</p>
          <p style="margin-top:6px;font-size:13px;color:var(--text-3)">
            Papers with comments in the last 7 days will appear here.
          </p>
        </li>`;
      renderFeedInfo('No trending papers this week');
      return;
    }

    // Fetch paper metadata; uses batch API call for uncached papers
    const papers = await ArXiv.getByIds(trending.map(t => t.paper_id));

    if (myEpoch !== epoch) return;

    // Build count lookup, filter out any ID mismatches, sort by count descending
    const countMap = Object.fromEntries(trending.map(t => [t.paper_id, t.count]));
    const withComments = papers.filter(p => (countMap[p.id] ?? 0) > 0);
    withComments.sort((a, b) => (countMap[b.id] ?? 0) - (countMap[a.id] ?? 0));

    if (withComments.length === 0) {
      document.getElementById('paperList').innerHTML = `
        <li class="empty-state">
          <div style="font-size:2rem">📊</div>
          <p>No trending papers yet.</p>
          <p style="margin-top:6px;font-size:13px;color:var(--text-3)">
            Papers with comments in the last 7 days will appear here.
          </p>
        </li>`;
      renderFeedInfo('No trending papers this week');
      return;
    }

    const list = document.getElementById('paperList');
    list.innerHTML = '';
    withComments.forEach((p, i) => {
      list.insertAdjacentHTML('beforeend', threadHTML(p, countMap[p.id], i + 1, true));
    });

    renderMath(list);
    const n = withComments.length;
    renderFeedInfo(`<strong>${n}</strong> paper${n !== 1 ? 's' : ''} trending this week`);

    const endEl = document.getElementById('endMessage');
    endEl.textContent = `All ${n} trending paper${n !== 1 ? 's' : ''} shown`;
    endEl.style.display = 'block';
  } catch (err) {
    if (myEpoch !== epoch) return;
    renderError(err.message);
  }
}

// ── Load fresh (new search / category) ─────────────────────────
async function loadFresh() {
  const myEpoch = ++epoch;

  // Reset
  state.shown      = [];
  state.buffer     = [];
  state.nextStart  = 0;
  state.total      = 0;
  state.loading    = true;
  state.prefetching = false;
  state.exhausted  = false;

  document.getElementById('paperList').innerHTML = '';
  document.getElementById('bottomLoader').style.display = 'none';
  document.getElementById('endMessage').style.display   = 'none';
  renderActiveFilter();
  renderSkeleton();
  renderFeedInfo('Loading…');

  try {
    const feed = await ArXiv.search({
      query:      state.query,
      category:   state.category,
      start:      0,
      maxResults: FETCH_BATCH,
      sortBy:     state.sortBy,
      sortOrder:  state.sortOrder,
    });

    if (myEpoch !== epoch) return;

    state.total      = feed.totalResults;
    state.nextStart  = FETCH_BATCH;
    state.buffer     = feed.papers;

    if (feed.papers.length < FETCH_BATCH) state.exhausted = true;

    if (feed.papers.length === 0) {
      document.getElementById('paperList').innerHTML = emptyHTML();
      renderFeedInfo('No results found');
      return;
    }

    // Show first batch immediately
    await showMore(myEpoch);

    // Queue prefetch of next 100 (rate-limit delay is inside fetchArxiv)
    if (!state.exhausted) prefetch(myEpoch);

  } catch (err) {
    if (myEpoch !== epoch) return;
    renderError(err.message);
  } finally {
    if (myEpoch === epoch) state.loading = false;
  }
}

// ── Show next 25 from buffer ────────────────────────────────────
async function showMore(myEpoch) {
  myEpoch = myEpoch ?? epoch;
  if (state.buffer.length === 0) return;

  const batch  = state.buffer.splice(0, SHOW_BATCH);
  const offset = state.shown.length;

  let counts = {};
  if (Comments.isConfigured()) {
    counts = await Comments.countFor(batch.map(p => p.id));
  }
  if (myEpoch !== epoch) return; // stale

  state.shown.push(...batch);

  const list = document.getElementById('paperList');

  // Clear skeleton on first batch
  if (offset === 0) list.innerHTML = '';

  batch.forEach((p, i) => {
    list.insertAdjacentHTML('beforeend', threadHTML(p, counts[p.id] || 0, offset + i + 1));
  });

  renderMath(list);
  renderFeedInfo(buildFeedInfo());

  // Mount favourite buttons for newly added cards
  if (typeof Collections !== 'undefined') {
    list.querySelectorAll('.thread-fav-mount[data-paper-id]').forEach(mount => {
      if (mount.children.length === 0) {
        Collections.renderButton(mount.dataset.paperId, mount, true);
      }
    });
  }

  // Start prefetch when buffer is getting thin
  if (state.buffer.length < PREFETCH_TRIGGER && !state.prefetching && !state.exhausted) {
    prefetch(myEpoch);
  }

  // If buffer still has papers, the observer will call showMore again on scroll
  // If buffer is now empty and exhausted, show end message
  if (state.buffer.length === 0 && state.exhausted) {
    showEndMessage();
  }
}

// ── Background prefetch of next 100 ────────────────────────────
async function prefetch(myEpoch) {
  if (state.prefetching || state.exhausted) return;
  if (state.nextStart >= state.total)       { state.exhausted = true; return; }

  state.prefetching = true;
  document.getElementById('bottomLoader').style.display = 'flex';

  try {
    const feed = await ArXiv.search({
      query:      state.query,
      category:   state.category,
      start:      state.nextStart,
      maxResults: FETCH_BATCH,
      sortBy:     state.sortBy,
      sortOrder:  state.sortOrder,
    });

    if (myEpoch !== epoch) return;

    state.total      = feed.totalResults;
    state.nextStart += feed.papers.length;
    state.buffer.push(...feed.papers);

    if (feed.papers.length < FETCH_BATCH || state.nextStart >= state.total) {
      state.exhausted = true;
    }

  } catch (err) {
    console.error('Prefetch failed:', err);
  } finally {
    if (myEpoch === epoch) {
      state.prefetching = false;
      document.getElementById('bottomLoader').style.display = 'none';
      if (state.buffer.length === 0 && state.exhausted) showEndMessage();
    }
  }
}

// ── Renderers ──────────────────────────────────────────────────
function renderSkeleton() {
  const list = document.getElementById('paperList');
  list.innerHTML = Array.from({ length: 6 }, (_, i) => `
    <li class="thread">
      <div class="thread-num">${i + 1}</div>
      <div class="thread-body">
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <span class="skeleton" style="width:60px;height:18px;border-radius:20px"></span>
          <span class="skeleton" style="width:50px;height:18px;border-radius:20px"></span>
        </div>
        <div class="skeleton skel-title"></div>
        <div class="skeleton skel-meta"></div>
        <div class="skeleton skel-text"></div>
        <div class="skeleton skel-text s"></div>
      </div>
    </li>
  `).join('');
}

function threadHTML(p, commentCount, num, isTrending = false) {
  const cats = p.categories.slice(0, 3).map((c) =>
    `<span class="cat-badge ${topCategory(c)}">${esc(c)}</span>`
  ).join('');

  const authors = p.authors.slice(0, 4).map(shortName).join(', ')
    + (p.authors.length > 4 ? ` +${p.authors.length - 4}` : '');

  const abstract  = truncate(p.summary, 220);
  const fresh     = isRecent(p.published, 7);
  const paperUrl  = `paper.html?id=${encodeURIComponent(p.id)}`;
  const commentUrl = `${paperUrl}#comments`;

  const commentIcon = `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round"
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
  </svg>`;

  const commentBadge = isTrending
    ? `<a class="thread-comments hot-count" href="${commentUrl}">
        🔥 ${commentCount} comment${commentCount !== 1 ? 's' : ''}
       </a>`
    : `<a class="thread-comments" href="${commentUrl}">
        ${commentIcon}
        ${commentCount} comment${commentCount !== 1 ? 's' : ''}
       </a>`;

  return `
    <li class="thread" id="thread-${esc(p.id)}">
      <div class="thread-num">${num}</div>
      <div class="thread-body">
        <div class="thread-tags">${cats}</div>
        <h2 class="thread-title"><a href="${paperUrl}">${esc(p.title)}</a></h2>
        <div class="thread-authors">${esc(authors)}</div>
        <p class="thread-abstract">${esc(abstract)}</p>
        <div class="thread-footer">
          <span class="thread-date">${fmtDate(p.published)}</span>
          ${commentBadge}
          ${fresh ? '<span class="new-badge">NEW</span>' : ''}
          <span class="thread-fav-mount" data-paper-id="${esc(p.id)}"></span>
        </div>
      </div>
    </li>`;
}

function renderFeedInfo(text) {
  document.getElementById('feedInfo').innerHTML = text;
}

function buildFeedInfo() {
  const shown = state.shown.length;
  const total = state.total;
  const q = state.query    ? ` for <strong>${esc(state.query)}</strong>` : '';
  const c = state.category ? ` in <strong>${esc(state.category)}</strong>` : '';
  const sort = state.sortBy === 'lastUpdatedDate' ? ' · sorted by recently updated' : '';
  return `Showing <strong>${shown}</strong> of <strong>${total.toLocaleString()}</strong> papers${q}${c}${sort}`;
}

function renderActiveFilter() {
  const row = document.getElementById('activeFilterRow');
  if (state.category || state.query) {
    const label = state.category ? `Category: ${state.category}` : `Search: "${state.query}"`;
    row.style.display = 'block';
    row.innerHTML = `
      <span class="active-filter">
        ${esc(label)}
        <button onclick="clearSearch()" title="Clear filter">×</button>
      </span>`;
  } else {
    row.style.display = 'none';
    row.innerHTML = '';
  }
}

function renderError(msg) {
  document.getElementById('paperList').innerHTML = `
    <li class="empty-state">
      <div style="font-size:2rem">⚠️</div>
      <p>Failed to load papers.</p>
      <p style="font-size:12px;margin-top:6px;font-family:var(--font-mono);color:var(--text-3)">${esc(msg)}</p>
      <p style="margin-top:10px"><button class="btn btn-sm" onclick="loadFresh()">Retry</button></p>
    </li>`;
  renderFeedInfo('Error');
}

function emptyHTML() {
  return `<li class="empty-state">
    <div style="font-size:2rem">📭</div>
    <p>No papers found.</p>
    <p style="margin-top:6px"><button class="btn btn-sm" onclick="clearSearch()">Clear search</button></p>
  </li>`;
}

function showEndMessage() {
  const el = document.getElementById('endMessage');
  const n  = state.shown.length;
  el.textContent = `All ${n.toLocaleString()} papers loaded`;
  el.style.display = 'block';
}

// ── Helpers ────────────────────────────────────────────────────
function setNavActive(which) {
  document.getElementById('navLatest')?.classList.toggle('active', which === 'latest');
  document.getElementById('navTop')?.classList.toggle('active', which === 'top');
  document.getElementById('navTrending')?.classList.toggle('active', which === 'trending');
  document.getElementById('navForum')?.classList.remove('active');
}

function clearSearch() {
  state.query    = '';
  state.category = '';
  document.getElementById('searchInput').value = '';
  highlightCatLink('');
  pushUrl();
  loadFresh();
}

function highlightCatLink(cat) {
  document.querySelectorAll('.cat-link').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.cat === cat)
  );
}

function openGroupForCat(cat) {
  const physPrefixes = ['quant', 'cond', 'hep', 'astro', 'gr', 'nlin', 'nucl', 'physics'];
  if (physPrefixes.some(p => cat.startsWith(p))) {
    document.getElementById('grp-physics')?.classList.add('open');
    return;
  }
  const map = { cs: 'grp-cs', math: 'grp-math', stat: 'grp-stat',
    'q-bio': 'grp-bio', econ: 'grp-econ', 'q-fin': 'grp-econ', eess: 'grp-eess' };
  const prefix = cat.split('.')[0].split('-')[0];
  const id = map[prefix] || map[cat];
  if (id) document.getElementById(id)?.classList.add('open');
}

function pushUrl() {
  const params = new URLSearchParams();
  if (state.query)    params.set('q',   state.query);
  if (state.category) params.set('cat', state.category);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function toggleGroup(id) {
  document.getElementById(id)?.classList.toggle('open');
}

function shortName(full) {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return parts[parts.length - 1] + ', ' + parts[0][0] + '.';
}

function parseArxivInput(s) {
  const urlMatch = s.match(/arxiv\.org\/(?:abs|pdf|html|e-print)\/([^\s?#/]+)/i);
  if (urlMatch) return urlMatch[1].replace(/v\d+$/, '');

  const ar5ivMatch = s.match(/ar5iv\.org\/(?:abs|pdf)\/([^\s?#/]+)/i);
  if (ar5ivMatch) return ar5ivMatch[1].replace(/v\d+$/, '');

  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return s.replace(/v\d+$/, '');
  if (/^[a-z][a-z\-]*(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(s)) return s.replace(/v\d+$/, '');

  return null;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
