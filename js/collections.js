/**
 * Collections — named paper favorites lists.
 * Exposes window.Collections.
 */

const Collections = {
  /** All collections belonging to the current user. */
  async getMine() {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) return [];
    const { data } = await db
      .from('collections')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    return data ?? [];
  },

  /** All collections (with items) for a given user ID — public profile view. */
  async getForUser(userId) {
    const db = Auth.client();
    if (!db) return [];
    const { data } = await db
      .from('collections')
      .select('*, collection_items(paper_id, added_at)')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    return data ?? [];
  },

  /** Create a new collection for the current user. */
  async create(name) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) throw new Error('Not signed in');
    const { data, error } = await db
      .from('collections')
      .insert({ user_id: user.id, name: name.trim().slice(0, 60) })
      .select().single();
    if (error) throw error;
    return data;
  },

  /** Delete a collection (cascade removes its items). */
  async remove(collectionId) {
    const db = Auth.client();
    if (!db) throw new Error('Not signed in');
    const { error } = await db.from('collections').delete().eq('id', collectionId);
    if (error) throw error;
  },

  /** Add a paper to a collection. */
  async addPaper(collectionId, paperId) {
    const db = Auth.client();
    if (!db || !Auth.user()) throw new Error('Not signed in');
    const { error } = await db
      .from('collection_items')
      .upsert({ collection_id: collectionId, paper_id: paperId },
               { onConflict: 'collection_id,paper_id' });
    if (error) throw error;
  },

  /** Remove a paper from a collection. */
  async removePaper(collectionId, paperId) {
    const db = Auth.client();
    if (!db || !Auth.user()) throw new Error('Not signed in');
    const { error } = await db
      .from('collection_items')
      .delete()
      .eq('collection_id', collectionId)
      .eq('paper_id', paperId);
    if (error) throw error;
  },

  /**
   * Return the IDs of the current user's collections that contain this paper.
   */
  async getCollectionsForPaper(paperId) {
    const db   = Auth.client();
    const user = Auth.user();
    if (!db || !user) return [];
    // Use inner join via foreign key to filter by user
    const { data } = await db
      .from('collection_items')
      .select('collection_id, collections!inner(user_id)')
      .eq('paper_id', paperId)
      .eq('collections.user_id', user.id);
    return (data ?? []).map(r => r.collection_id);
  },

  /** All papers in a collection, newest first. */
  async getPapers(collectionId) {
    const db = Auth.client();
    if (!db) return [];
    const { data } = await db
      .from('collection_items')
      .select('paper_id, added_at')
      .eq('collection_id', collectionId)
      .order('added_at', { ascending: false });
    return data ?? [];
  },

  /**
   * Render a favourite button for `paperId` into `container`.
   * compact=true → star icon only (for feed cards)
   * compact=false → "★ Save to collection" text button (for paper detail)
   */
  renderButton(paperId, container, compact = false) {
    const btn = document.createElement('button');
    btn.className  = compact ? 'fav-btn fav-btn-compact' : 'fav-btn';
    btn.dataset.paperId = paperId;
    btn.title      = 'Save to collection';
    btn.setAttribute('aria-label', 'Save to collection');
    btn.innerHTML  = compact ? '★' : '★ Save';

    const refresh = (ids) => {
      const saved = ids.length > 0;
      btn.classList.toggle('fav-saved', saved);
      btn.title = saved ? 'Saved — click to manage' : 'Save to collection';
      if (!compact) btn.innerHTML = saved ? '★ Saved' : '★ Save';
    };

    // Check current saved state
    if (Auth.user()) {
      Collections.getCollectionsForPaper(paperId).then(refresh);
    }

    // Re-check when auth state changes; bail out if the button was removed from DOM
    window.addEventListener('auth:change', ({ detail: { user } }) => {
      if (!document.contains(btn)) return;
      if (user) Collections.getCollectionsForPaper(paperId).then(refresh);
      else refresh([]);
    });

    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!Auth.user()) { openAuthModal('signin'); return; }
      await Collections._openPicker(paperId, btn, refresh);
    });

    container.appendChild(btn);
    return btn;
  },

  /** Collection-picker popover anchored near `anchorEl`. */
  async _openPicker(paperId, anchorEl, onUpdate) {
    document.querySelectorAll('.col-picker').forEach(p => p.remove());

    const [cols, savedIn] = await Promise.all([
      Collections.getMine(),
      Collections.getCollectionsForPaper(paperId),
    ]);
    const savedSet = new Set(savedIn);

    const picker = document.createElement('div');
    picker.className = 'col-picker';
    picker.innerHTML = `
      <div class="col-picker-title">Save to collection</div>
      <div class="col-picker-list" id="colPickerList">
        ${cols.length === 0 ? '<div class="col-picker-empty">No collections yet</div>' : ''}
        ${cols.map(c => `
          <label class="col-picker-item">
            <input type="checkbox" value="${esc(c.id)}"
              ${savedSet.has(c.id) ? 'checked' : ''} />
            ${esc(c.name)}
          </label>`).join('')}
      </div>
      <div class="col-picker-new">
        <input type="text" class="col-picker-input" placeholder="New collection…" maxlength="60" />
        <button class="btn btn-sm col-picker-add">+</button>
      </div>
      <div class="col-picker-err"></div>
    `;

    document.body.appendChild(picker);

    // Position below anchor
    const rect = anchorEl.getBoundingClientRect();
    picker.style.top  = `${rect.bottom + window.scrollY + 4}px`;
    picker.style.left = `${Math.min(rect.left + window.scrollX,
                                    window.innerWidth - 220)}px`;

    const errEl = picker.querySelector('.col-picker-err');

    picker.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', async () => {
        errEl.textContent = '';
        try {
          if (cb.checked) await Collections.addPaper(cb.value, paperId);
          else            await Collections.removePaper(cb.value, paperId);
          const ids = await Collections.getCollectionsForPaper(paperId);
          onUpdate(ids);
        } catch (err) {
          errEl.textContent = err.message;
          cb.checked = !cb.checked;
        }
      });
    });

    const addBtn   = picker.querySelector('.col-picker-add');
    const nameInput = picker.querySelector('.col-picker-input');

    addBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      errEl.textContent = '';
      try {
        const col = await Collections.create(name);
        await Collections.addPaper(col.id, paperId);
        nameInput.value = '';
        picker.querySelector('.col-picker-empty')?.remove();
        const list = picker.querySelector('#colPickerList');
        const lbl = document.createElement('label');
        lbl.className = 'col-picker-item';
        lbl.innerHTML = `<input type="checkbox" value="${esc(col.id)}" checked />${esc(name)}`;
        list.appendChild(lbl);
        const ids = await Collections.getCollectionsForPaper(paperId);
        onUpdate(ids);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!picker.contains(e.target) && e.target !== anchorEl) {
          picker.remove();
          document.removeEventListener('click', handler);
        }
      });
    }, 0);
  },
};

window.Collections = Collections;
