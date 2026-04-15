/**
 * Paper detail page — fetches paper + comments, handles comment submission.
 */

let realtimeChannel = null;

window.addEventListener('DOMContentLoaded', async () => {
  const params  = new URLSearchParams(location.search);
  const paperId = params.get('id');

  if (!paperId) {
    renderError('No paper ID provided. <a href="index.html">Go back home.</a>');
    return;
  }

  try {
    const [paper, comments] = await Promise.all([
      ArXiv.getById(paperId),
      Comments.getAll(paperId),
    ]);

    if (!paper) {
      renderError(`Paper <code>${esc(paperId)}</code> not found on arXiv.`);
      return;
    }

    // Update page title
    document.title = truncate(paper.title, 60) + ' — ForgeXiv';

    renderPaper(paper, comments);
    setupCommentForm(paper.id);
    subscribeRealtime(paper.id);

    // Re-render comment form when auth state changes (login/logout mid-session)
    if (typeof Auth !== 'undefined') {
      window.addEventListener('auth:change', () => {
        const formBox = document.querySelector('.comment-form-box');
        if (formBox) formBox.outerHTML = renderCommentForm();
        setupCommentForm(paper.id);
      });
      window.addEventListener('profile:loaded', () => {
        const formBox = document.querySelector('.comment-form-box');
        if (formBox) formBox.outerHTML = renderCommentForm();
        setupCommentForm(paper.id);
      });
    }
  } catch (err) {
    console.error(err);
    renderError(err.message);
  }
});

// ── Render paper ────────────────────────────────────────────
function renderPaper(p, comments) {
  const top  = topCategory(p.primaryCategory);
  const cats = p.categories.slice(0, 5).map((c) =>
    `<span class="cat-badge ${topCategory(c)}">${esc(c)}</span>`
  ).join('');

  const authors = p.authors.map((a) => esc(a)).join(', ');

  const submittedDate = fmtDate(p.published);
  const updatedDate   = fmtDate(p.updated);
  const showUpdated   = p.updated && p.updated !== p.published;

  const doi = p.doi
    ? `<div class="meta-item"><span class="label">DOI</span><span class="val"><a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener">${esc(p.doi)}</a></span></div>`
    : '';

  const jref = p.journalRef
    ? `<div class="meta-item"><span class="label">Journal</span><span class="val">${esc(p.journalRef)}</span></div>`
    : '';

  const arxivComment = p.arxivComment
    ? `<div class="meta-item"><span class="label">Note</span><span class="val">${esc(p.arxivComment)}</span></div>`
    : '';

  const tree = Comments.buildTree(comments);
  const commentCount = comments.length;

  document.getElementById('pageContent').innerHTML = `
    <!-- ── Paper header ── -->
    <div class="paper-header">
      <a class="paper-back" href="javascript:history.back()">← Back</a>
      <div class="paper-tags thread-tags">${cats}</div>
      <h1 class="paper-title">${esc(p.title)}</h1>
      <div class="paper-authors">${authors}</div>
      <div class="paper-meta">
        <span><strong>Submitted:</strong> ${submittedDate}</span>
        ${showUpdated ? `<span><strong>Updated:</strong> ${updatedDate}</span>` : ''}
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-3)">
          arXiv:<strong style="color:var(--text-2)">${esc(p.id)}</strong>
        </span>
      </div>
    </div>

    <!-- ── Abstract + sidebar ── -->
    <div class="paper-body">
      <div class="abstract-section">
        <h2>Abstract</h2>
        <p class="abstract-text">${esc(p.summary)}</p>
      </div>

      <div class="paper-sidebar-box">
        <h3>Paper Links</h3>
        <div id="favBtnMount"></div>
        <div class="paper-links">
          <a class="paper-link-btn primary" href="${esc(p.pdfLink)}" target="_blank" rel="noopener">↓ PDF</a>
          <a class="paper-link-btn" href="${esc(p.absLink)}" target="_blank" rel="noopener">arXiv Page ↗</a>
          <a class="paper-link-btn" href="https://arxiv.org/html/${esc(p.id)}" target="_blank" rel="noopener">HTML Version ↗</a>
          <a class="paper-link-btn" href="https://scholar.google.com/scholar?q=${encodeURIComponent(p.title)}" target="_blank" rel="noopener">Google Scholar ↗</a>
          <a class="paper-link-btn" href="https://www.semanticscholar.org/search?q=${encodeURIComponent(p.title)}&sort=Relevance" target="_blank" rel="noopener">Semantic Scholar ↗</a>
        </div>
        <div class="meta-row">
          <div class="meta-item">
            <span class="label">arXiv ID</span>
            <span class="val">${esc(p.id)}</span>
          </div>
          ${doi}
          ${jref}
          ${arxivComment}
        </div>
      </div>
    </div>

    <!-- ── Comments ── -->
    <section class="comments-section" id="comments">
      <div class="comments-header">
        <h2>Discussion</h2>
        <span class="count" id="commentCount">${commentCount} comment${commentCount !== 1 ? 's' : ''}</span>
      </div>

      ${renderCommentForm()}

      <div id="commentList">
        ${tree.length ? tree.map(renderComment).join('') : renderNoComments()}
      </div>
    </section>
  `;

  // Render LaTeX in title and abstract (comments intentionally excluded)
  renderMath(document.querySelector('.paper-title'));
  renderMath(document.querySelector('.abstract-text'));

  // Mount favourite button
  const favMount = document.getElementById('favBtnMount');
  if (favMount && typeof Collections !== 'undefined') {
    Collections.renderButton(p.id, favMount, false);
  }
}

// ── Comment form ────────────────────────────────────────────
function renderCommentForm() {
  if (!Comments.isConfigured()) {
    return `
      <div class="comments-unconfigured">
        Comments are disabled. To enable them, add your Supabase credentials to
        <code>js/config.js</code> and run the schema from <code>supabase-schema.sql</code>.
      </div>`;
  }

  const user    = typeof Auth !== 'undefined' ? Auth.user() : null;
  const profile = window._currentProfile;

  const nameField = user && profile
    ? `<div class="comment-posting-as">
         Commenting as <a href="profile.html?user=${esc(profile.username)}">${esc(profile.display_name || profile.username)}</a>
       </div>`
    : `<input type="text" id="authorName" placeholder="Your name (optional)" maxlength="100" />`;

  return `
    <div class="comment-form-box">
      <h3>Join the Discussion</h3>
      <form class="comment-form" id="commentForm">
        ${nameField}
        <textarea
          id="commentContent"
          placeholder="Share your thoughts, questions, or insights about this paper…"
          maxlength="5000"
          required
        ></textarea>
        <div class="form-row">
          <button type="submit" class="btn btn-primary" id="submitBtn">Post Comment</button>
          <span class="form-error" id="formError"></span>
        </div>
      </form>
    </div>`;
}

function renderNoComments() {
  return `
    <div class="empty-state" style="padding:32px 0">
      <div style="font-size:1.8rem">💬</div>
      <p>No comments yet. Be the first to start the discussion.</p>
    </div>`;
}

// ── Single comment ───────────────────────────────────────────
function renderComment(c, isReply = false) {
  const replies = (c.replies || []).map((r) => renderComment(r, true)).join('');
  return `
    <div class="comment" id="comment-${c.id}" data-id="${c.id}">
      <div class="comment-header">
        ${c.username
          ? `<a class="comment-author" href="profile.html?user=${esc(c.username)}">${esc(c.author_name || c.username || 'Anonymous')}</a>`
          : `<span class="comment-author">${esc(c.author_name || 'Anonymous')}</span>`}
        <span class="comment-time">${relativeTime(c.created_at)}</span>
        ${!isReply && Comments.isConfigured()
          ? `<button class="reply-btn" onclick="toggleReplyForm('${c.id}')">Reply</button>`
          : ''}
      </div>
      <div class="comment-body">${esc(c.content)}</div>
      ${replies ? `<div class="comment-replies">${replies}</div>` : '<div class="comment-replies" id="replies-' + c.id + '"></div>'}
      <div id="reply-form-${c.id}"></div>
    </div>`;
}

// ── Setup form submission ────────────────────────────────────
function setupCommentForm(paperId) {
  const form = document.getElementById('commentForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitComment(paperId, null);
  });
}

async function submitComment(paperId, parentId) {
  const isReply = parentId !== null;

  let nameInput, contentInput, submitBtn, errorEl;
  if (isReply) {
    const container = document.getElementById(`reply-form-${parentId}`);
    nameInput    = container.querySelector('.reply-author');
    contentInput = container.querySelector('.reply-content');
    submitBtn    = container.querySelector('.reply-submit');
    errorEl      = container.querySelector('.form-error');
  } else {
    nameInput    = document.getElementById('authorName');
    contentInput = document.getElementById('commentContent');
    submitBtn    = document.getElementById('submitBtn');
    errorEl      = document.getElementById('formError');
  }

  // Use logged-in profile display name, or the typed name, or Anonymous
  const profile = window._currentProfile;
  const name    = (profile?.display_name) || nameInput?.value.trim() || 'Anonymous';
  const content = contentInput?.value.trim();

  if (!content) {
    errorEl.textContent = 'Please write something before posting.';
    return;
  }

  submitBtn.disabled      = true;
  submitBtn.textContent   = 'Posting…';
  errorEl.textContent     = '';

  try {
    const newComment = await Comments.post(paperId, name, content, parentId);
    newComment.replies = [];

    if (isReply) {
      // Insert reply under parent
      const repliesContainer = document.getElementById(`replies-${parentId}`);
      if (repliesContainer) {
        repliesContainer.insertAdjacentHTML('beforeend', renderComment(newComment, true));
      }
      // Close reply form
      document.getElementById(`reply-form-${parentId}`).innerHTML = '';
    } else {
      // Append to top-level list
      const listEl = document.getElementById('commentList');
      const empty  = listEl.querySelector('.empty-state');
      if (empty) listEl.innerHTML = '';
      listEl.insertAdjacentHTML('beforeend', renderComment(newComment, false));
      contentInput.value = '';
      nameInput.value    = '';
    }

    updateCommentCount(1);
  } catch (err) {
    console.error(err);
    errorEl.textContent = 'Failed to post: ' + err.message;
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = isReply ? 'Post Reply' : 'Post Comment';
  }
}

// ── Reply form toggle ────────────────────────────────────────
window.toggleReplyForm = function (parentId) {
  const container = document.getElementById(`reply-form-${parentId}`);
  if (!container) return;

  if (container.innerHTML) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="inline-reply-form">
      <input type="text" class="reply-author" placeholder="Your name (optional)" maxlength="100" />
      <textarea class="reply-content" placeholder="Write a reply…" maxlength="5000" rows="3"></textarea>
      <div class="form-row">
        <button class="btn btn-primary btn-sm reply-submit"
          onclick="submitReply('${parentId}')">Post Reply</button>
        <button class="btn btn-sm"
          onclick="toggleReplyForm('${parentId}')">Cancel</button>
        <span class="form-error"></span>
      </div>
    </div>`;

  container.querySelector('.reply-content').focus();
};

window.submitReply = function (parentId) {
  const paperId = new URLSearchParams(location.search).get('id');
  submitComment(paperId, parentId);
};

// ── Real-time subscription ────────────────────────────────────
function subscribeRealtime(paperId) {
  if (!Comments.isConfigured()) return;
  realtimeChannel = Comments.subscribe(paperId, (newComment) => {
    newComment.replies = [];
    // Only add if not already in DOM (to avoid duplicates from own posts)
    if (!document.getElementById(`comment-${newComment.id}`)) {
      const listEl = document.getElementById('commentList');
      if (listEl) {
        const empty = listEl.querySelector('.empty-state');
        if (empty) listEl.innerHTML = '';
        if (!newComment.parent_id) {
          listEl.insertAdjacentHTML('beforeend', renderComment(newComment, false));
        } else {
          const repliesContainer = document.getElementById(`replies-${newComment.parent_id}`);
          if (repliesContainer) {
            repliesContainer.insertAdjacentHTML('beforeend', renderComment(newComment, true));
          }
        }
        updateCommentCount(1);
      }
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────
function updateCommentCount(delta) {
  const el = document.getElementById('commentCount');
  if (!el) return;
  const current = parseInt(el.dataset.count || el.textContent) || 0;
  const next = current + delta;
  el.dataset.count  = next;
  el.textContent    = `${next} comment${next !== 1 ? 's' : ''}`;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso);
}

function renderError(msg) {
  document.getElementById('pageContent').innerHTML = `
    <div class="empty-state" style="padding:60px 0">
      <div style="font-size:2rem">⚠️</div>
      <p>${msg}</p>
      <p style="margin-top:16px"><a class="btn" href="index.html">← Home</a></p>
    </div>`;
}

function doSearch(e) {
  e.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  const directId = parseArxivInput(q);
  if (directId) {
    location.href = `paper.html?id=${encodeURIComponent(directId)}`;
  } else {
    location.href = `index.html?q=${encodeURIComponent(q)}`;
  }
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
