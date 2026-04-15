/**
 * Profile page controller — profile.html?user=username
 * Shows: bio, collections/favorites, forum posts, comment history.
 */

// esc() and relTime() are provided by auth.js (window.esc / window.relTime)

window.addEventListener('DOMContentLoaded', async () => {
  if (!document.getElementById('profileRoot')) return;

  const params   = new URLSearchParams(location.search);
  const username = params.get('user');

  if (!username) {
    renderProfileError('No username specified.');
    return;
  }

  // Load the profile data
  const profile = await Auth.getProfile(username);
  if (!profile) {
    renderProfileError(`User <strong>${esc(username)}</strong> not found.`);
    return;
  }

  document.title = `${esc(profile.display_name || profile.username)} — ForgeXiv`;

  renderProfileHeader(profile);
  _currentViewedProfile = profile;

  // Helper: show edit button if the logged-in user owns this profile
  const _syncEditBtn = (userId) => {
    const editBtn = document.getElementById('profileEditBtn');
    if (editBtn) editBtn.style.display = (userId === profile.id) ? 'inline-flex' : 'none';
  };

  // Check immediately using already-restored session (fixes navigation bug
  // where auth:change fired before listeners were registered)
  _syncEditBtn(Auth.user()?.id ?? null);
  if (window._currentProfile?.id === profile.id) _syncEditBtn(profile.id);

  window.addEventListener('auth:change', ({ detail: { user } }) => _syncEditBtn(user?.id ?? null));
  window.addEventListener('profile:loaded', ({ detail: { profile: mine } }) => _syncEditBtn(mine.id));

  // Load default tab (collections)
  switchProfileTab('collections', profile);
});

// ── Profile header ─────────────────────────────────────────────
function renderProfileHeader(profile) {
  const root = document.getElementById('profileRoot');
  root.innerHTML = `
    <div class="profile-header">
      <div class="profile-info">
        <div class="profile-display-name">${esc(profile.display_name || profile.username)}</div>
        <div class="profile-username">@${esc(profile.username)}</div>
        ${profile.bio ? `<div class="profile-bio">${esc(profile.bio)}</div>` : ''}
        <div class="profile-joined">Joined ${relTime(profile.created_at)}</div>
      </div>
      <button id="profileEditBtn" class="btn btn-sm" style="display:none"
        onclick="openEditProfile()">Edit Profile</button>
    </div>

    <!-- Edit form (hidden by default) -->
    <div id="profileEditForm" style="display:none" class="profile-edit-form">
      <h3>Edit Profile</h3>
      <form onsubmit="submitEditProfile(event)">
        <label>Username
          <input type="text" id="peUsername" value="${esc(profile.username)}" maxlength="30"
            pattern="[a-z0-9_\\-]{3,30}" required />
        </label>
        <label>Display name
          <input type="text" id="peDisplayName" value="${esc(profile.display_name)}" maxlength="80" required />
        </label>
        <label>Bio
          <textarea id="peBio" maxlength="500" rows="3">${esc(profile.bio)}</textarea>
        </label>
        <div class="form-row">
          <button type="submit" class="btn btn-primary" id="peBtn">Save</button>
          <button type="button" class="btn btn-sm" onclick="closeEditProfile()">Cancel</button>
          <span class="form-error" id="peError"></span>
        </div>
      </form>
    </div>

    <!-- Tabs -->
    <div class="profile-tabs" id="profileTabBar">
      <button class="profile-tab active" data-tab="collections" onclick="switchProfileTab('collections')">
        Collections
      </button>
      <button class="profile-tab" data-tab="posts" onclick="switchProfileTab('posts')">
        Forum Posts
      </button>
      <button class="profile-tab" data-tab="comments" onclick="switchProfileTab('comments')">
        Comments
      </button>
    </div>

    <div id="profileTabContent"></div>
  `;
}

// Store profile reference for tab switching
let _currentViewedProfile = null;

window.switchProfileTab = function(tab, profile) {
  profile = profile || _currentViewedProfile;
  if (!profile) return;

  document.querySelectorAll('.profile-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const content = document.getElementById('profileTabContent');
  if (!content) return;
  content.innerHTML = `<div class="loading-wrap"><span class="pulse"></span>Loading…</div>`;

  if (tab === 'collections') loadCollectionsTab(profile, content);
  else if (tab === 'posts')  loadPostsTab(profile, content);
  else if (tab === 'comments') loadCommentsTab(profile, content);
};

// ── Collections tab ────────────────────────────────────────────
async function loadCollectionsTab(profile, container) {
  try {
    const collections = await Collections.getForUser(profile.id);

    if (collections.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div style="font-size:2rem">📚</div>
        <p>No public collections yet.</p></div>`;
      return;
    }

    // For each collection, fetch paper metadata
    container.innerHTML = collections.map(col => `
      <div class="profile-collection">
        <div class="profile-col-header">
          <span class="profile-col-name">${esc(col.name)}</span>
          <span class="profile-col-count">${(col.collection_items || []).length} paper${(col.collection_items || []).length !== 1 ? 's' : ''}</span>
        </div>
        <div class="profile-col-papers" id="colpapers-${esc(col.id)}">
          ${(col.collection_items || []).length === 0
            ? '<div class="profile-col-empty">Empty collection</div>'
            : '<div class="loading-wrap" style="padding:12px 0"><span class="pulse"></span></div>'}
        </div>
      </div>`).join('');

    // Load paper metadata for each collection
    for (const col of collections) {
      const items = col.collection_items || [];
      if (items.length === 0) continue;

      const paperEl = document.getElementById(`colpapers-${col.id}`);
      if (!paperEl) continue;

      try {
        const papers = await ArXiv.getByIds(items.map(i => i.paper_id));
        paperEl.innerHTML = papers.length === 0
          ? '<div class="profile-col-empty">Papers unavailable</div>'
          : papers.map(p => `
              <a class="profile-paper-row" href="paper.html?id=${encodeURIComponent(p.id)}">
                <span class="profile-paper-title">${esc(p.title)}</span>
                <span class="profile-paper-meta">${esc(p.authors.slice(0,2).join(', '))}${p.authors.length > 2 ? ' +more' : ''} · ${typeof fmtDate === 'function' ? fmtDate(p.published) : ''}</span>
              </a>`).join('');
      } catch {
        paperEl.innerHTML = '<div class="profile-col-empty">Could not load papers</div>';
      }
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${esc(err.message)}</p></div>`;
  }
}

// ── Posts tab ──────────────────────────────────────────────────
async function loadPostsTab(profile, container) {
  try {
    const posts = await Forum.getByUser(profile.id, { limit: 30 });

    if (posts.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div style="font-size:2rem">📝</div>
        <p>No forum posts yet.</p></div>`;
      return;
    }

    container.innerHTML = posts.map(post => `
      <a class="profile-activity-row" href="forum.html?post=${encodeURIComponent(post.id)}">
        <span class="profile-activity-title">${esc(post.title || '(untitled)')}</span>
        <span class="profile-activity-meta">
          ${esc(relTime(post.created_at))}
          ${post.paper_id ? `· 📄 ${esc(post.paper_id)}` : ''}
          · 👍 ${post.like_count} 👎 ${post.dislike_count}
        </span>
      </a>`).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${esc(err.message)}</p></div>`;
  }
}

// ── Comments tab ───────────────────────────────────────────────
async function loadCommentsTab(profile, container) {
  try {
    const comments = await Comments.getByUser(profile.id, { limit: 50 });

    if (!comments || comments.length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div style="font-size:2rem">💬</div>
        <p>No comments yet.</p></div>`;
      return;
    }

    container.innerHTML = `<div class="profile-comments-list">
      ${comments.map(c => `
        <a class="profile-activity-row" href="paper.html?id=${encodeURIComponent(c.paper_id)}#comments">
          <span class="profile-activity-title">${esc(c.content.slice(0, 120))}${c.content.length > 120 ? '…' : ''}</span>
          <span class="profile-activity-meta">on arXiv:${esc(c.paper_id)} · ${esc(relTime(c.created_at))}</span>
        </a>`).join('')}
    </div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${esc(err.message)}</p></div>`;
  }
}

// ── Edit profile ───────────────────────────────────────────────
window.openEditProfile = function() {
  document.getElementById('profileEditForm').style.display = 'block';
  document.getElementById('profileEditBtn').style.display  = 'none';
};

window.closeEditProfile = function() {
  document.getElementById('profileEditForm').style.display = 'none';
  document.getElementById('profileEditBtn').style.display  = 'inline-flex';
  document.getElementById('peError').textContent = '';
};

window.submitEditProfile = async function(e) {
  e.preventDefault();
  const username    = document.getElementById('peUsername').value.trim().toLowerCase();
  const displayName = document.getElementById('peDisplayName').value.trim();
  const bio         = document.getElementById('peBio').value.trim();
  const btn         = document.getElementById('peBtn');
  const errorEl     = document.getElementById('peError');

  if (!/^[a-z0-9_-]{3,30}$/.test(username)) {
    errorEl.textContent = 'Username: 3–30 chars, lowercase letters / numbers / _ -';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  errorEl.textContent = '';

  try {
    await Auth.updateProfile({ username, displayName, bio });
    // Reload the page with the potentially new username
    location.href = `profile.html?user=${encodeURIComponent(username)}`;
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Save';
  }
};

// ── Error state ────────────────────────────────────────────────
function renderProfileError(msg) {
  const root = document.getElementById('profileRoot');
  if (root) root.innerHTML = `<div class="empty-state" style="padding:80px 0">
    <div style="font-size:2rem">⚠️</div>
    <p>${msg}</p>
    <p style="margin-top:16px"><a href="index.html" class="btn">← Home</a></p>
  </div>`;
}
