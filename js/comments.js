/**
 * Comment layer — backed by Supabase.
 * Uses Auth.client() (auth.js) as the shared Supabase client.
 * Falls back gracefully when Supabase is not configured.
 */

const Comments = {
  isConfigured() { return Auth.isConfigured(); },

  /** Fetch all comments for a paper, ordered oldest → newest. */
  async getAll(paperId) {
    const db = Auth.client();
    if (!db) return [];
    const { data, error } = await db
      .from('comments')
      .select('*')
      .eq('paper_id', paperId)
      .order('created_at', { ascending: true });
    if (error) { console.error(error); return []; }
    return data ?? [];
  },

  /** Post a new comment (or reply). Returns the inserted row. */
  async post(paperId, authorName, content, parentId = null) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db) throw new Error('Comments not configured');
    const { data, error } = await db
      .from('comments')
      .insert({
        paper_id:    paperId,
        author_name: (authorName || 'Anonymous').trim().slice(0, 100),
        content:     content.trim().slice(0, 5000),
        parent_id:   parentId ?? null,
        user_id:     user?.id ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Fetch comment counts for multiple paper IDs in a single query.
   * Returns { [paperId]: count }
   */
  async countFor(paperIds) {
    const db = Auth.client();
    if (!db || !paperIds.length) return {};
    const { data, error } = await db
      .from('comments')
      .select('paper_id')
      .in('paper_id', paperIds);
    if (error) return {};
    const counts = {};
    for (const row of data ?? []) {
      counts[row.paper_id] = (counts[row.paper_id] ?? 0) + 1;
    }
    return counts;
  },

  /** Real-time subscription for new comments on a paper. */
  subscribe(paperId, onInsert) {
    const db = Auth.client();
    if (!db) return null;
    return db
      .channel(`paper:${paperId}`)
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'comments',
        filter: `paper_id=eq.${paperId}`,
      }, (payload) => onInsert(payload.new))
      .subscribe();
  },

  unsubscribe(channel) {
    if (channel) channel.unsubscribe();
  },

  /**
   * Return the top N papers by comment count in the past 7 days.
   * Only papers with ≥1 comment are included.
   * Returns [{ paper_id, count }] sorted by count descending.
   */
  async trending(limit = 50) {
    const db = Auth.client();
    if (!db) return [];
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { data, error } = await db
        .from('comments')
        .select('paper_id')
        .gte('created_at', since);
      if (error || !data) return [];
      // Count by paper_id client-side (simple, correct for typical comment volumes)
      const counts = {};
      for (const row of data) {
        counts[row.paper_id] = (counts[row.paper_id] ?? 0) + 1;
      }
      return Object.entries(counts)
        .map(([paper_id, count]) => ({ paper_id, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    } catch { return []; }
  },

  /** Fetch all comments by a specific user (for profile page). */
  async getByUser(userId, { limit = 50 } = {}) {
    const db = Auth.client();
    if (!db) return [];
    const { data } = await db
      .from('comments')
      .select('id, paper_id, content, created_at, author_name')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  },

  /** Build a nested tree from a flat list of comments. */
  buildTree(flat) {
    const map  = new Map();
    const roots = [];
    for (const c of flat) { map.set(c.id, { ...c, replies: [] }); }
    for (const c of map.values()) {
      if (c.parent_id && map.has(c.parent_id)) {
        map.get(c.parent_id).replies.push(c);
      } else {
        roots.push(c);
      }
    }
    return roots;
  },
};

window.Comments = Comments;
