/**
 * Auth — owns the Supabase client singleton and user session.
 *
 * All other modules call Auth.client() instead of constructing their own.
 * Fires window CustomEvent 'auth:change' with { detail: { user, session } }
 * on every session transition (sign-in, sign-out, token refresh).
 */

let _client  = null;
let _session = null;
let _user    = null;

function _createClient() {
  const cfg = window.ARXIV_FORUM_CONFIG;
  if (!cfg || cfg.SUPABASE_URL.includes('YOUR_PROJECT_ID')) return null;
  return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
}

function _getClient() {
  if (_client) return _client;
  _client = _createClient();
  return _client;
}

function _broadcast(user, session) {
  _user    = user;
  _session = session;
  window.dispatchEvent(new CustomEvent('auth:change', { detail: { user, session } }));
}

// Restore session and subscribe to future changes
(function _init() {
  const db = _getClient();
  if (!db) return;

  db.auth.getSession().then(({ data: { session } }) => {
    _broadcast(session?.user ?? null, session ?? null);
  });

  db.auth.onAuthStateChange((_event, session) => {
    _broadcast(session?.user ?? null, session ?? null);
  });
})();

const Auth = {
  /** The shared Supabase client (null if not configured). */
  client() { return _getClient(); },

  /** Current user object or null. */
  user() { return _user; },

  /** Current session or null. */
  session() { return _session; },

  /** True if Supabase credentials are present. */
  isConfigured() {
    const cfg = window.ARXIV_FORUM_CONFIG;
    return !!(cfg && !cfg.SUPABASE_URL.includes('YOUR_PROJECT_ID'));
  },

  /** Email + password sign-up. `username` and `displayName` are stored in user metadata
   *  so the DB trigger can create the profile row on confirm. */
  async signUp(email, password, username, displayName) {
    const db = _getClient();
    if (!db) throw new Error('Auth not configured');
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { username: username.toLowerCase(), display_name: displayName } },
    });
    if (error) throw error;
    return data;
  },

  /** Email + password sign-in. */
  async signIn(email, password) {
    const db = _getClient();
    if (!db) throw new Error('Auth not configured');
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  /** Google OAuth redirect flow. */
  async signInWithGoogle() {
    const db = _getClient();
    if (!db) throw new Error('Auth not configured');
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href },
    });
    if (error) throw error;
  },

  /** Sign out. */
  async signOut() {
    const db = _getClient();
    if (db) await db.auth.signOut();
  },

  /** Fetch any user's public profile by username. */
  async getProfile(username) {
    const db = _getClient();
    if (!db) return null;
    const { data } = await db
      .from('profiles')
      .select('*')
      .eq('username', username)
      .maybeSingle();
    return data ?? null;
  },

  /** Fetch the currently-logged-in user's own profile. */
  async getMyProfile() {
    const db = _getClient();
    if (!db || !_user) return null;
    const { data } = await db
      .from('profiles')
      .select('*')
      .eq('id', _user.id)
      .maybeSingle();
    return data ?? null;
  },

  /** Update the current user's profile fields. */
  async updateProfile({ username, displayName, bio }) {
    const db = _getClient();
    if (!db || !_user) throw new Error('Not signed in');
    const { data, error } = await db
      .from('profiles')
      .update({
        username:     username.toLowerCase(),
        display_name: displayName,
        bio,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', _user.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};

window.Auth = Auth;
// Backward-compat shim: arxiv.js calls window.sbClient?.()
window.sbClient = () => Auth.client();

// ── Shared utilities (available to all pages that load auth.js) ──

/** HTML-escape a value for safe injection into innerHTML. */
window.esc = function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

/** Human-readable relative time (e.g. "3h ago"). Falls back to fmtDate. */
window.relTime = function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  if (typeof fmtDate === 'function') return fmtDate(iso);
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};
