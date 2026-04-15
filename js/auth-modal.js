/**
 * Auth modal UI — Google sign-in and header user menu.
 * Depends on auth.js (Auth object + auth:change event).
 */

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" style="flex-shrink:0">
  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
</svg>`;

document.addEventListener('DOMContentLoaded', () => {
  _injectModal();
  _injectSetupModal();
  _injectHeaderControls();
});

window.addEventListener('auth:change', ({ detail: { user } }) => {
  _updateHeader(user);
});

// ── Sign-in modal ────────────────────────────────────────────
function _injectModal() {
  const el = document.createElement('div');
  el.id = 'authModal';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="auth-overlay" onclick="closeAuthModal()"></div>
    <div class="auth-box" role="dialog" aria-modal="true" aria-label="Sign in to ForgeXiv">
      <button class="auth-close" onclick="closeAuthModal()" aria-label="Close">×</button>
      <div class="auth-logo">ForgeXiv</div>
      <p class="auth-tagline">Join the discussion on arXiv research</p>
      <button class="auth-google-btn" onclick="authWithGoogle()" id="googleSignInBtn">
        ${GOOGLE_SVG} Continue with Google
      </button>
      <div class="auth-msg" id="authMsg"></div>
    </div>
  `;
  document.body.appendChild(el);
}

// ── First-time profile setup modal ──────────────────────────
function _injectSetupModal() {
  const el = document.createElement('div');
  el.id = 'setupModal';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="auth-overlay"></div>
    <div class="auth-box" role="dialog" aria-modal="true" aria-label="Set up your profile">
      <div class="auth-logo">Welcome to ForgeXiv!</div>
      <p class="auth-tagline">Choose a username and display name to get started.</p>
      <form class="auth-form" onsubmit="submitProfileSetup(event)">
        <label class="auth-field-label">Display name
          <input type="text" id="setupDisplayName" placeholder="e.g. Jane Smith"
            maxlength="80" required autocomplete="name" />
        </label>
        <label class="auth-field-label">Username
          <input type="text" id="setupUsername" placeholder="e.g. janesmith"
            maxlength="30" required autocomplete="username"
            pattern="[a-z0-9_\\-]{3,30}"
            oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_-]/g,'')" />
          <span class="auth-field-hint">3–30 chars · letters, numbers, _ -</span>
        </label>
        <div class="auth-msg" id="setupMsg"></div>
        <button type="submit" class="btn btn-primary auth-submit" id="setupBtn">Save &amp; Continue</button>
      </form>
    </div>
  `;
  document.body.appendChild(el);
}

// ── Header auth controls ─────────────────────────────────────
function _injectHeaderControls() {
  const inner = document.querySelector('.header-inner');
  if (!inner) return;

  const ctrl = document.createElement('div');
  ctrl.id = 'authControls';
  ctrl.className = 'auth-controls';
  ctrl.innerHTML = `
    <div id="authLoggedOut">
      <button class="btn btn-sm btn-primary" onclick="openAuthModal()">Sign In</button>
    </div>
    <div id="authLoggedIn" style="display:none">
      <div class="auth-user-menu" id="authUserMenu">
        <button class="auth-username-btn" onclick="toggleUserMenu(event)">
          <span id="authDisplayName">…</span><span class="auth-caret">▾</span>
        </button>
        <div class="auth-dropdown" id="authDropdown" style="display:none">
          <a href="#" id="authProfileLink" class="auth-dropdown-item">My Profile</a>
          <button class="auth-dropdown-item" onclick="doSignOut()">Sign Out</button>
        </div>
      </div>
    </div>
  `;
  const toggle = inner.querySelector('#themeToggle');
  if (toggle) inner.insertBefore(ctrl, toggle);
  else inner.appendChild(ctrl);

  // Sync header with already-restored session (auth:change may have fired
  // before DOMContentLoaded finished injecting these elements)
  _updateHeader(Auth.user());
}

function _updateHeader(user) {
  const out = document.getElementById('authLoggedOut');
  const inn = document.getElementById('authLoggedIn');
  if (!out || !inn) return;

  if (user) {
    out.style.display = 'none';
    inn.style.display = 'block';
    Auth.getMyProfile().then(profile => {
      if (!profile) return;
      const nameEl = document.getElementById('authDisplayName');
      if (nameEl) nameEl.textContent = profile.display_name || profile.username;
      const link = document.getElementById('authProfileLink');
      if (link) link.href = `profile.html?user=${encodeURIComponent(profile.username)}`;
      window._currentProfile = profile;
      window.dispatchEvent(new CustomEvent('profile:loaded', { detail: { profile } }));

      // First-time setup: prompt if display_name has never been set
      if (!profile.display_name) {
        _openSetupModal(profile);
      }
    });
  } else {
    out.style.display = 'flex';
    inn.style.display = 'none';
    window._currentProfile = null;
  }
}

function _openSetupModal(profile) {
  const modal = document.getElementById('setupModal');
  if (!modal) return;
  // Pre-fill username from auto-generated value
  const unInput = document.getElementById('setupUsername');
  if (unInput) unInput.value = profile.username || '';
  const dnInput = document.getElementById('setupDisplayName');
  if (dnInput) dnInput.value = '';
  document.getElementById('setupMsg').textContent = '';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setTimeout(() => dnInput?.focus(), 50);
}

// ── Modal controls ───────────────────────────────────────────
window.openAuthModal = function() {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  document.getElementById('authMsg').textContent = '';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
};

window.closeAuthModal = function() {
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeAuthModal();
    // Don't allow escaping the setup modal — user must complete it
  }
});

document.addEventListener('click', (e) => {
  const dd   = document.getElementById('authDropdown');
  const menu = document.getElementById('authUserMenu');
  if (dd && menu && !menu.contains(e.target)) dd.style.display = 'none';
});

// ── Auth actions ─────────────────────────────────────────────
window.authWithGoogle = async function() {
  const btn    = document.getElementById('googleSignInBtn');
  const msgEl  = document.getElementById('authMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
  try {
    await Auth.signInWithGoogle();
    // Page will redirect — no further action needed
  } catch (err) {
    if (msgEl) { msgEl.className = 'auth-msg error'; msgEl.textContent = err.message; }
    if (btn) { btn.disabled = false; btn.innerHTML = `${GOOGLE_SVG} Continue with Google`; }
  }
};

window.submitProfileSetup = async function(e) {
  e.preventDefault();
  const username    = document.getElementById('setupUsername').value.trim().toLowerCase();
  const displayName = document.getElementById('setupDisplayName').value.trim();
  const btn         = document.getElementById('setupBtn');
  const msgEl       = document.getElementById('setupMsg');

  if (!/^[a-z0-9_-]{3,30}$/.test(username)) {
    msgEl.className = 'auth-msg error';
    msgEl.textContent = 'Username: 3–30 chars, lowercase letters / numbers / _ -';
    return;
  }
  if (!displayName) {
    msgEl.className = 'auth-msg error';
    msgEl.textContent = 'Please enter a display name.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  msgEl.className = 'auth-msg';
  msgEl.textContent = '';

  try {
    const updated = await Auth.updateProfile({ username, displayName, bio: '' });
    // Update header immediately
    const nameEl = document.getElementById('authDisplayName');
    if (nameEl) nameEl.textContent = updated.display_name || updated.username;
    const link = document.getElementById('authProfileLink');
    if (link) link.href = `profile.html?user=${encodeURIComponent(updated.username)}`;
    window._currentProfile = updated;
    window.dispatchEvent(new CustomEvent('profile:loaded', { detail: { profile: updated } }));

    // Close setup modal
    document.getElementById('setupModal').style.display = 'none';
    document.body.style.overflow = '';
  } catch (err) {
    msgEl.className = 'auth-msg error';
    msgEl.textContent = err.message.includes('unique') || err.message.includes('duplicate')
      ? 'That username is already taken. Please choose another.'
      : err.message;
    btn.disabled = false;
    btn.textContent = 'Save & Continue';
  }
};

window.doSignOut = async function() {
  const dd = document.getElementById('authDropdown');
  if (dd) dd.style.display = 'none';
  await Auth.signOut();
};

window.toggleUserMenu = function(e) {
  e.stopPropagation();
  const dd = document.getElementById('authDropdown');
  if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
};
