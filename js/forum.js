/**
 * Forum — data layer + page controller for forum.html.
 *
 * URL routing:
 *   forum.html          → post list
 *   forum.html?post=ID  → post detail + replies
 */

// ── Data layer ─────────────────────────────────────────────────
const Forum = {
  /**
   * Fetch top-level posts (parent_id IS NULL), newest first.
   * Returns posts enriched with author username/display_name.
   */
  async getPosts({ limit = 20, offset = 0 } = {}) {
    const db = Auth.client();
    if (!db) return { posts: [], total: 0 };

    const [postsRes, countRes] = await Promise.all([
      db.from('forum_posts')
        .select('*')
        .is('parent_id', null)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      db.from('forum_posts')
        .select('id', { count: 'exact', head: true })
        .is('parent_id', null)
        .eq('is_deleted', false),
    ]);

    const posts = postsRes.data ?? [];
    const total = countRes.count ?? 0;

    // Enrich with author profile
    const userIds = [...new Set(posts.map(p => p.user_id))];
    const authors = await Forum._fetchProfiles(userIds);

    return {
      posts: posts.map(p => ({ ...p, ...authors[p.user_id] })),
      total,
    };
  },

  /** Fetch a single post by id, enriched with author info. */
  async getPost(id) {
    const db = Auth.client();
    if (!db) return null;
    const { data } = await db
      .from('forum_posts')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (!data) return null;
    const authors = await Forum._fetchProfiles([data.user_id]);
    return { ...data, ...authors[data.user_id] };
  },

  /**
   * Fetch ALL replies in a thread (root_id = postId OR id = postId),
   * enriched with author info. Client builds the tree.
   */
  async getReplies(postId) {
    const db = Auth.client();
    if (!db) return [];
    const { data } = await db
      .from('forum_posts')
      .select('*')
      .eq('root_id', postId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true });

    const replies = data ?? [];
    const userIds = [...new Set(replies.map(p => p.user_id))];
    const authors = await Forum._fetchProfiles(userIds);
    return replies.map(p => ({ ...p, ...authors[p.user_id] }));
  },

  /** Get the count of direct replies to a post. */
  async getReplyCount(postId) {
    const db = Auth.client();
    if (!db) return 0;
    const { count } = await db
      .from('forum_posts')
      .select('id', { count: 'exact', head: true })
      .eq('root_id', postId)
      .eq('is_deleted', false);
    return count ?? 0;
  },

  /** Get reply counts for multiple posts at once. Returns { [postId]: count }. */
  async getReplyCountsFor(postIds) {
    const db = Auth.client();
    if (!db || !postIds.length) return {};
    const { data } = await db
      .from('forum_posts')
      .select('root_id')
      .in('root_id', postIds)
      .eq('is_deleted', false);
    const counts = {};
    for (const row of data ?? []) {
      counts[row.root_id] = (counts[row.root_id] ?? 0) + 1;
    }
    return counts;
  },

  /** Create a top-level post. Returns the new post. */
  async create({ title, body, paperId = null }) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) throw new Error('Sign in to post');
    const { data, error } = await db
      .from('forum_posts')
      .insert({
        user_id:  user.id,
        title:    title.trim().slice(0, 200),
        body:     body.trim().slice(0, 20000),
        paper_id: paperId || null,
      })
      .select().single();
    if (error) throw error;
    return data;
  },

  /** Create a reply. parentPost must have { id, root_id, parent_id }. */
  async createReply({ body, parentPost }) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) throw new Error('Sign in to reply');
    const rootId = parentPost.root_id ?? parentPost.id;
    const { data, error } = await db
      .from('forum_posts')
      .insert({
        user_id:   user.id,
        title:     '',
        body:      body.trim().slice(0, 20000),
        parent_id: parentPost.id,
        root_id:   rootId,
      })
      .select().single();
    if (error) throw error;
    const authors = await Forum._fetchProfiles([user.id]);
    return { ...data, ...authors[user.id] };
  },

  /**
   * Vote on a post ('like' | 'dislike').
   * Clicking the active vote type removes it (toggle off).
   * Returns updated { like_count, dislike_count, myVote }.
   */
  async vote(postId, voteType) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) throw new Error('Sign in to vote');

    const { data: existing } = await db
      .from('forum_votes')
      .select('vote_type')
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .maybeSingle();

    if (existing?.vote_type === voteType) {
      // Toggle off
      await db.from('forum_votes')
        .delete()
        .eq('user_id', user.id).eq('post_id', postId);
    } else if (existing) {
      // Switch vote
      await db.from('forum_votes')
        .update({ vote_type: voteType })
        .eq('user_id', user.id).eq('post_id', postId);
    } else {
      // New vote
      await db.from('forum_votes')
        .insert({ user_id: user.id, post_id: postId, vote_type: voteType });
    }

    // Fetch updated counts
    const { data: updated } = await db
      .from('forum_posts')
      .select('like_count, dislike_count')
      .eq('id', postId)
      .single();

    const myVote = existing?.vote_type === voteType ? null : voteType;
    return { ...(updated ?? {}), myVote };
  },

  /** Get the current user's vote on a post (null if none). */
  async getMyVote(postId) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) return null;
    const { data } = await db
      .from('forum_votes')
      .select('vote_type')
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .maybeSingle();
    return data?.vote_type ?? null;
  },

  /** Batch fetch votes for the current user across multiple posts. */
  async getMyVotesFor(postIds) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user || !postIds.length) return {};
    const { data } = await db
      .from('forum_votes')
      .select('post_id, vote_type')
      .eq('user_id', user.id)
      .in('post_id', postIds);
    const map = {};
    for (const row of data ?? []) map[row.post_id] = row.vote_type;
    return map;
  },

  /** Fetch all top-level posts by a user (for profile page). */
  async getByUser(userId, { limit = 20, offset = 0 } = {}) {
    const db = Auth.client();
    if (!db) return [];
    const { data } = await db
      .from('forum_posts')
      .select('*')
      .eq('user_id', userId)
      .is('parent_id', null)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    return data ?? [];
  },

  /** Build a tree from a flat replies array (same pattern as Comments.buildTree). */
  buildTree(flat) {
    const map   = new Map();
    const roots = [];
    for (const r of flat) map.set(r.id, { ...r, replies: [] });
    for (const r of map.values()) {
      if (r.parent_id && map.has(r.parent_id)) {
        map.get(r.parent_id).replies.push(r);
      } else {
        roots.push(r);
      }
    }
    return roots;
  },

  /** Internal: fetch profiles for a list of user IDs. Returns { [userId]: { username, display_name } }. */
  async _fetchProfiles(userIds) {
    if (!userIds.length) return {};
    const db = Auth.client();
    if (!db) return {};
    const { data } = await db
      .from('profiles')
      .select('id, username, display_name')
      .in('id', userIds);
    const map = {};
    for (const p of data ?? []) map[p.id] = { username: p.username, display_name: p.display_name };
    return map;
  },
};

window.Forum = Forum;

// ══════════════════════════════════════════════════════════════
// Page controller — runs only on forum.html
// ══════════════════════════════════════════════════════════════

const FORUM_PAGE_SIZE = 20;
let _forumOffset = 0;
let _forumTotal  = 0;
let _forumLoading = false;

window.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('forumRoot')) return; // not on forum.html

  const params = new URLSearchParams(location.search);
  const postId = params.get('post');

  if (postId) {
    initPostDetail(postId);
  } else {
    initForumList();
  }
});

// ── Forum list ─────────────────────────────────────────────────
async function initForumList() {
  document.getElementById('forumListView').style.display  = 'block';
  document.getElementById('forumDetailView').style.display = 'none';

  // Show/hide create button based on auth
  const updateCreateBtn = (user) => {
    const btn = document.getElementById('forumCreateBtn');
    if (btn) btn.style.display = user ? 'inline-flex' : 'none';
  };
  window.addEventListener('auth:change', ({ detail: { user } }) => updateCreateBtn(user));
  updateCreateBtn(Auth.user());

  await loadForumPosts();
}

async function loadForumPosts(reset = true) {
  if (_forumLoading) return;
  _forumLoading = true;

  if (reset) { _forumOffset = 0; }

  const list    = document.getElementById('forumPostList');
  const moreBtn = document.getElementById('forumLoadMore');

  if (reset) list.innerHTML = _skeletonRows(4);

  try {
    const { posts, total } = await Forum.getPosts({ limit: FORUM_PAGE_SIZE, offset: _forumOffset });
    _forumTotal = total;

    if (reset) list.innerHTML = '';

    if (posts.length === 0 && reset) {
      list.innerHTML = `<div class="empty-state"><div style="font-size:2rem">📋</div>
        <p>No posts yet. Be the first!</p></div>`;
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    // Enrich with reply counts
    const replyCounts = await Forum.getReplyCountsFor(posts.map(p => p.id));
    // Enrich with my votes (if logged in)
    const myVotes = Auth.user()
      ? await Forum.getMyVotesFor(posts.map(p => p.id))
      : {};

    posts.forEach(post => {
      list.insertAdjacentHTML('beforeend',
        forumPostCardHTML(post, replyCounts[post.id] ?? 0, myVotes[post.id] ?? null));
    });

    _forumOffset += posts.length;

    if (moreBtn) {
      moreBtn.style.display = _forumOffset < _forumTotal ? 'block' : 'none';
    }

    document.getElementById('forumInfo').textContent =
      `${_forumTotal} post${_forumTotal !== 1 ? 's' : ''}`;

  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p>Failed to load posts: ${esc(err.message)}</p></div>`;
  } finally {
    _forumLoading = false;
  }
}

window.loadMoreForumPosts = function() { loadForumPosts(false); };

function forumPostCardHTML(post, replyCount, myVote) {
  const authorUrl = `profile.html?user=${encodeURIComponent(post.username || '')}`;
  const postUrl   = `forum.html?post=${encodeURIComponent(post.id)}`;
  const excerpt   = post.body.length > 200 ? post.body.slice(0, 200) + '…' : post.body;

  const paperChip = post.paper_id
    ? `<a class="forum-paper-chip" href="paper.html?id=${encodeURIComponent(post.paper_id)}">
         📄 ${esc(post.paper_id)}
       </a>`
    : '';

  return `
    <div class="forum-card" id="fcard-${esc(post.id)}">
      <div class="forum-card-title">
        <a href="${postUrl}">${esc(post.title || '(untitled)')}</a>
      </div>
      <div class="forum-card-meta">
        <a class="forum-author" href="${authorUrl}">${esc(post.display_name || post.username || 'Unknown')}</a>
        <span class="forum-date">${relFmtDate(post.created_at)}</span>
        ${paperChip}
      </div>
      <div class="forum-card-excerpt">${esc(excerpt)}</div>
      <div class="forum-card-footer">
        <span class="forum-votes">
          <button class="vote-btn ${myVote === 'like' ? 'voted' : ''}"
            onclick="castVote('${esc(post.id)}', 'like', this)"
            title="Like">
            👍 <span class="vote-count">${post.like_count}</span>
          </button>
          <button class="vote-btn dislike-btn ${myVote === 'dislike' ? 'voted' : ''}"
            onclick="castVote('${esc(post.id)}', 'dislike', this)"
            title="Dislike">
            👎 <span class="vote-count">${post.dislike_count}</span>
          </button>
        </span>
        <a class="forum-reply-count" href="${postUrl}">
          💬 ${replyCount} repl${replyCount !== 1 ? 'ies' : 'y'}
        </a>
      </div>
    </div>`;
}

// Vote from list view
window.castVote = async function(postId, voteType, btn) {
  if (!Auth.user()) { openAuthModal('signin'); return; }
  try {
    const result = await Forum.vote(postId, voteType);
    // Update the card's vote buttons
    const card = document.getElementById(`fcard-${postId}`);
    if (!card) return;
    card.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('voted'));
    if (result.myVote) {
      const selector = result.myVote === 'like' ? '.vote-btn:not(.dislike-btn)' : '.dislike-btn';
      card.querySelector(selector)?.classList.add('voted');
    }
    const counts = card.querySelectorAll('.vote-count');
    if (counts[0]) counts[0].textContent = result.like_count ?? 0;
    if (counts[1]) counts[1].textContent = result.dislike_count ?? 0;
  } catch (err) {
    console.error('Vote failed:', err.message);
  }
};

// ── Create post form ───────────────────────────────────────────
window.openCreatePost = function() {
  if (!Auth.user()) { openAuthModal('signin'); return; }
  document.getElementById('forumCreateForm').style.display =
    document.getElementById('forumCreateForm').style.display === 'none' ? 'block' : 'none';
};

window.submitCreatePost = async function(e) {
  e.preventDefault();
  const titleEl   = document.getElementById('fpTitle');
  const bodyEl    = document.getElementById('fpBody');
  const paperEl   = document.getElementById('fpPaperId');
  const errorEl   = document.getElementById('fpError');
  const btn       = document.getElementById('fpSubmitBtn');

  const title   = titleEl.value.trim();
  const body    = bodyEl.value.trim();
  const paperId = paperEl.value.trim() || null;

  if (!title) { errorEl.textContent = 'Title is required.'; return; }
  if (!body)  { errorEl.textContent = 'Post body is required.'; return; }

  btn.disabled = true;
  btn.textContent = 'Posting…';
  errorEl.textContent = '';

  try {
    const post = await Forum.create({ title, body, paperId });
    // Navigate to the new post
    location.href = `forum.html?post=${encodeURIComponent(post.id)}`;
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Post';
  }
};

// ── Post detail view ───────────────────────────────────────────
async function initPostDetail(postId) {
  document.getElementById('forumListView').style.display   = 'none';
  document.getElementById('forumDetailView').style.display = 'block';

  const content = document.getElementById('forumDetailContent');
  content.innerHTML = `<div class="loading-wrap"><span class="pulse"></span>Loading post…</div>`;

  try {
    const [post, replies, myVote] = await Promise.all([
      Forum.getPost(postId),
      Forum.getReplies(postId),
      Forum.getMyVote(postId),
    ]);

    if (!post) {
      content.innerHTML = `<div class="empty-state"><p>Post not found.</p>
        <a href="forum.html" class="btn btn-sm">← Back to Forum</a></div>`;
      return;
    }

    document.title = esc(post.title || 'Post') + ' — ForgeXiv Forum';

    const tree  = Forum.buildTree(replies);
    const paper = post.paper_id
      ? `<a class="forum-paper-chip" href="paper.html?id=${encodeURIComponent(post.paper_id)}">
           📄 ${esc(post.paper_id)}
         </a>`
      : '';

    content.innerHTML = `
      <a href="forum.html" class="paper-back">← Back to Forum</a>

      <div class="forum-detail-header">
        <h1 class="forum-detail-title">${esc(post.title || '(untitled)')}</h1>
        <div class="forum-card-meta">
          <a class="forum-author" href="profile.html?user=${encodeURIComponent(post.username || '')}">
            ${esc(post.display_name || post.username || 'Unknown')}
          </a>
          <span class="forum-date">${relFmtDate(post.created_at)}</span>
          ${paper}
        </div>
      </div>

      <div class="forum-detail-body">${esc(post.body)}</div>

      <div class="forum-vote-bar" id="detailVoteBar">
        <button class="vote-btn ${myVote === 'like' ? 'voted' : ''}" id="dvLike"
          onclick="detailVote('${esc(postId)}', 'like')">
          👍 <span id="dvLikeCount">${post.like_count}</span>
        </button>
        <button class="vote-btn dislike-btn ${myVote === 'dislike' ? 'voted' : ''}" id="dvDislike"
          onclick="detailVote('${esc(postId)}', 'dislike')">
          👎 <span id="dvDislikeCount">${post.dislike_count}</span>
        </button>
      </div>

      <div class="comments-section">
        <div class="comments-header">
          <h2>Replies</h2>
          <span class="count" id="replyCount">${replies.length} repl${replies.length !== 1 ? 'ies' : 'y'}</span>
        </div>

        ${renderReplyForm(postId, null)}

        <div id="replyList">
          ${tree.length ? tree.map(r => renderReply(r, postId)).join('') : renderNoReplies()}
        </div>
      </div>
    `;

    // Update vote bar if auth state changes
    window.addEventListener('auth:change', async ({ detail: { user } }) => {
      if (user) {
        const v = await Forum.getMyVote(postId);
        document.getElementById('dvLike')?.classList.toggle('voted', v === 'like');
        document.getElementById('dvDislike')?.classList.toggle('voted', v === 'dislike');
      } else {
        document.getElementById('dvLike')?.classList.remove('voted');
        document.getElementById('dvDislike')?.classList.remove('voted');
      }
    });

  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>Error: ${esc(err.message)}</p></div>`;
  }
}

window.detailVote = async function(postId, voteType) {
  if (!Auth.user()) { openAuthModal('signin'); return; }
  try {
    const result = await Forum.vote(postId, voteType);
    document.getElementById('dvLikeCount').textContent    = result.like_count ?? 0;
    document.getElementById('dvDislikeCount').textContent = result.dislike_count ?? 0;
    document.getElementById('dvLike')?.classList.toggle('voted', result.myVote === 'like');
    document.getElementById('dvDislike')?.classList.toggle('voted', result.myVote === 'dislike');
  } catch (err) {
    console.error('Vote failed:', err.message);
  }
};

// ── Reply rendering ────────────────────────────────────────────
function renderReply(r, rootId, depth = 0) {
  const indent = depth > 0 ? 'style="margin-left:24px;padding-left:14px;border-left:2px solid var(--border)"' : '';
  const replies = (r.replies || []).map(child => renderReply(child, rootId, depth + 1)).join('');
  const authorUrl = `profile.html?user=${encodeURIComponent(r.username || '')}`;

  return `
    <div class="comment" id="reply-${esc(r.id)}" ${indent}>
      <div class="comment-header">
        <a class="comment-author" href="${authorUrl}">${esc(r.display_name || r.username || 'Unknown')}</a>
        <span class="comment-time">${relTime(r.created_at)}</span>
        ${depth < 3 && Auth.isConfigured()
          ? `<button class="reply-btn" onclick="toggleForumReplyForm('${esc(r.id)}', '${esc(rootId)}')">Reply</button>`
          : ''}
      </div>
      <div class="comment-body">${esc(r.body)}</div>
      ${replies ? `<div class="comment-replies">${replies}</div>`
                : `<div class="comment-replies" id="subreplies-${esc(r.id)}"></div>`}
      <div id="rfform-${esc(r.id)}"></div>
    </div>`;
}

function renderNoReplies() {
  return `<div class="empty-state" style="padding:32px 0">
    <div style="font-size:1.8rem">💬</div>
    <p>No replies yet. Start the conversation.</p>
  </div>`;
}

function renderReplyForm(rootId, parentPost) {
  if (!Auth.isConfigured()) return '';
  return `
    <div class="comment-form-box" id="${parentPost ? 'rfbox-' + parentPost.id : 'rootReplyForm'}">
      <h3>${parentPost ? 'Write a Reply' : 'Join the Discussion'}</h3>
      <form class="comment-form" onsubmit="submitForumReply(event, '${esc(rootId)}', ${parentPost ? `'${esc(parentPost.id)}'` : 'null'})">
        <textarea placeholder="Write your reply…" class="rf-body" maxlength="20000" rows="4" required></textarea>
        <div class="form-row">
          <button type="submit" class="btn btn-primary rf-submit">Post Reply</button>
          ${parentPost ? `<button type="button" class="btn btn-sm" onclick="closeForumReplyForm('${esc(parentPost.id)}')">Cancel</button>` : ''}
          <span class="form-error rf-error"></span>
        </div>
      </form>
    </div>`;
}

window.toggleForumReplyForm = function(parentId, rootId) {
  const container = document.getElementById(`rfform-${parentId}`);
  if (!container) return;
  if (container.innerHTML) { container.innerHTML = ''; return; }
  if (!Auth.user()) { openAuthModal('signin'); return; }
  // Provide a minimal parentPost-like object
  container.innerHTML = renderReplyForm(rootId, { id: parentId });
  container.querySelector('.rf-body')?.focus();
};

window.closeForumReplyForm = function(parentId) {
  const container = document.getElementById(`rfform-${parentId}`);
  if (container) container.innerHTML = '';
};

window.submitForumReply = async function(e, rootId, parentId) {
  e.preventDefault();
  if (!Auth.user()) { openAuthModal('signin'); return; }

  const form    = e.target;
  const bodyEl  = form.querySelector('.rf-body');
  const errorEl = form.querySelector('.rf-error');
  const btn     = form.querySelector('.rf-submit');

  const body = bodyEl.value.trim();
  if (!body) { errorEl.textContent = 'Reply cannot be empty.'; return; }

  btn.disabled = true;
  btn.textContent = 'Posting…';
  errorEl.textContent = '';

  // Build a minimal parentPost object so createReply can compute root_id
  const parentPostObj = { id: parentId ?? rootId, root_id: parentId ? rootId : null };

  try {
    const reply = await Forum.createReply({ body, parentPost: parentPostObj });
    reply.replies = [];

    // Insert rendered reply
    if (parentId) {
      const subContainer = document.getElementById(`subreplies-${parentId}`);
      if (subContainer) subContainer.insertAdjacentHTML('beforeend', renderReply(reply, rootId, 1));
      closeForumReplyForm(parentId);
    } else {
      // Top-level reply (direct reply to root post)
      const listEl = document.getElementById('replyList');
      const empty  = listEl.querySelector('.empty-state');
      if (empty) listEl.innerHTML = '';
      listEl.insertAdjacentHTML('beforeend', renderReply(reply, rootId, 0));
      bodyEl.value = '';
    }

    // Update reply count
    const countEl = document.getElementById('replyCount');
    if (countEl) {
      const n = (parseInt(countEl.dataset.n || '0') || parseInt(countEl.textContent)) + 1;
      countEl.dataset.n  = n;
      countEl.textContent = `${n} repl${n !== 1 ? 'ies' : 'y'}`;
    }

  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post Reply';
  }
};

// ── Shared helpers ─────────────────────────────────────────────
// relTime() is provided by auth.js (window.relTime)
// esc()     is provided by auth.js (window.esc)

function relFmtDate(iso) {
  return iso ? fmtDate(iso) : '';
}

function _skeletonRows(n) {
  return Array.from({ length: n }, () => `
    <div class="forum-card" style="gap:10px">
      <div class="skeleton" style="height:18px;width:60%;margin-bottom:8px"></div>
      <div class="skeleton" style="height:12px;width:30%;margin-bottom:10px"></div>
      <div class="skeleton" style="height:12px;width:90%"></div>
    </div>`).join('');
}
