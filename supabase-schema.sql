-- ============================================================
-- ArXiv Forum — Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor > New query
-- ============================================================

create table if not exists comments (
  id          uuid        default gen_random_uuid() primary key,
  paper_id    text        not null,
  author_name text        not null default 'Anonymous',
  content     text        not null,
  parent_id   uuid        references comments(id) on delete cascade,
  created_at  timestamptz default now() not null
);

create index if not exists idx_comments_paper_id   on comments(paper_id);
create index if not exists idx_comments_created_at on comments(created_at);
create index if not exists idx_comments_parent_id  on comments(parent_id);

-- Row-Level Security
alter table comments enable row level security;

-- Anyone can read comments
drop policy if exists "public read" on comments;
create policy "public read"
  on comments for select
  using (true);

-- Anyone can post, with basic length guards (replaced by Phase 2 policy below)
drop policy if exists "public insert" on comments;
create policy "public insert"
  on comments for insert
  with check (
    length(content)     between 1 and 5000 and
    length(author_name) between 1 and 100
  );

-- ============================================================
-- Query cache — shared across all users
-- Each row = one ArXiv API response (up to 100 papers)
-- ============================================================

create table if not exists query_cache (
  cache_key   text        primary key,           -- URLSearchParams string
  feed        jsonb       not null,              -- { totalResults, papers: [...] }
  cached_at   timestamptz default now() not null,
  expires_at  timestamptz not null               -- cached_at + 4h (fresh) to 24h (stale)
);

create index if not exists idx_query_cache_expires on query_cache(expires_at);

alter table query_cache enable row level security;

drop policy if exists "public read"   on query_cache;
drop policy if exists "public insert" on query_cache;
drop policy if exists "public update" on query_cache;
drop policy if exists "public delete" on query_cache;

create policy "public read"   on query_cache for select using (true);
create policy "public insert" on query_cache for insert with check (true);
create policy "public update" on query_cache for update using (true);
create policy "public delete" on query_cache for delete using (true);

-- ============================================================
-- Phase 2 — Auth, Profiles, Forum, Collections
-- ============================================================

-- ── Profiles ─────────────────────────────────────────────────
-- One row per auth user. Auto-created by trigger on sign-up.
create table if not exists profiles (
  id           uuid        primary key references auth.users(id) on delete cascade,
  username     text        not null unique,
  display_name text        not null default '',
  bio          text        not null default '',
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null,

  constraint username_format check (username ~ '^[a-z0-9_-]{3,30}$'),
  constraint bio_length       check (length(bio) <= 500),
  constraint display_name_len check (length(display_name) <= 80)
);

create index if not exists idx_profiles_username on profiles(username);

alter table profiles enable row level security;

drop policy if exists "profiles: public read"  on profiles;
drop policy if exists "profiles: owner insert" on profiles;
drop policy if exists "profiles: owner update" on profiles;

create policy "profiles: public read"
  on profiles for select using (true);

create policy "profiles: owner insert"
  on profiles for insert
  with check (auth.uid() = id);

create policy "profiles: owner update"
  on profiles for update
  using  (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a profile row when a new user is confirmed.
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  v_username     text;
  v_display_name text;
  v_base         text;
  v_suffix       int := 0;
begin
  v_display_name := coalesce(
    new.raw_user_meta_data->>'display_name',
    new.raw_user_meta_data->>'full_name',
    ''
  );

  -- Derive base username from metadata, then email prefix, then uuid
  v_base := coalesce(
    nullif(lower(regexp_replace(new.raw_user_meta_data->>'username', '[^a-z0-9_-]', '', 'g')), ''),
    nullif(lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_-]', '', 'g')), ''),
    'user'
  );
  if length(v_base) < 3 then
    v_base := 'user_' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;
  v_base     := substr(v_base, 1, 25);
  v_username := v_base;

  -- Ensure uniqueness by appending a counter
  loop
    exit when not exists (select 1 from public.profiles where username = v_username);
    v_suffix   := v_suffix + 1;
    v_username := v_base || v_suffix::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, v_display_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ── comments: add user_id ────────────────────────────────────
alter table comments
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_comments_user_id on comments(user_id);

drop policy if exists "public insert"          on comments;
drop policy if exists "comments: public insert" on comments;
create policy "comments: public insert"
  on comments for insert
  with check (
    length(content)     between 1 and 5000 and
    length(author_name) between 1 and 100  and
    (user_id is null or user_id = auth.uid())
  );

-- ── Collections ───────────────────────────────────────────────
create table if not exists collections (
  id         uuid        default gen_random_uuid() primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null default 'Favorites',
  created_at timestamptz default now() not null,

  constraint collection_name_len check (length(name) between 1 and 60),
  unique (user_id, name)
);

create index if not exists idx_collections_user_id on collections(user_id);

alter table collections enable row level security;

drop policy if exists "collections: public read"  on collections;
drop policy if exists "collections: owner insert" on collections;
drop policy if exists "collections: owner delete" on collections;

create policy "collections: public read"
  on collections for select using (true);

create policy "collections: owner insert"
  on collections for insert
  with check (auth.uid() = user_id);

create policy "collections: owner delete"
  on collections for delete
  using (auth.uid() = user_id);

-- ── Collection Items ──────────────────────────────────────────
create table if not exists collection_items (
  collection_id uuid        not null references collections(id) on delete cascade,
  paper_id      text        not null,
  added_at      timestamptz default now() not null,
  primary key (collection_id, paper_id)
);

create index if not exists idx_col_items_collection on collection_items(collection_id);
create index if not exists idx_col_items_paper      on collection_items(paper_id);

alter table collection_items enable row level security;

drop policy if exists "collection_items: public read"  on collection_items;
drop policy if exists "collection_items: owner insert" on collection_items;
drop policy if exists "collection_items: owner delete" on collection_items;

create policy "collection_items: public read"
  on collection_items for select using (true);

create policy "collection_items: owner insert"
  on collection_items for insert
  with check (
    exists (
      select 1 from collections c
      where c.id = collection_id and c.user_id = auth.uid()
    )
  );

create policy "collection_items: owner delete"
  on collection_items for delete
  using (
    exists (
      select 1 from collections c
      where c.id = collection_id and c.user_id = auth.uid()
    )
  );

-- ── Forum Posts ───────────────────────────────────────────────
-- parent_id: direct parent (null = top-level post)
-- root_id:   top-level ancestor (null = this IS root). Enables one-query tree fetch.
create table if not exists forum_posts (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  title         text        not null default '',
  body          text        not null,
  paper_id      text,
  parent_id     uuid        references forum_posts(id) on delete cascade,
  root_id       uuid        references forum_posts(id) on delete cascade,
  like_count    integer     not null default 0 check (like_count    >= 0),
  dislike_count integer     not null default 0 check (dislike_count >= 0),
  is_deleted    boolean     not null default false,
  created_at    timestamptz default now() not null,

  constraint title_len check (length(title) <= 200),
  constraint body_len  check (length(body) between 1 and 20000)
);

create index if not exists idx_forum_posts_root_id  on forum_posts(root_id);
create index if not exists idx_forum_posts_user_id  on forum_posts(user_id);
create index if not exists idx_forum_posts_paper_id on forum_posts(paper_id);
create index if not exists idx_forum_posts_created  on forum_posts(created_at desc)
  where parent_id is null and is_deleted = false;

alter table forum_posts enable row level security;

drop policy if exists "forum_posts: public read"       on forum_posts;
drop policy if exists "forum_posts: auth insert"       on forum_posts;
drop policy if exists "forum_posts: owner soft-delete" on forum_posts;

create policy "forum_posts: public read"
  on forum_posts for select using (true);

create policy "forum_posts: auth insert"
  on forum_posts for insert
  with check (auth.uid() = user_id);

create policy "forum_posts: owner soft-delete"
  on forum_posts for update
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Forum Votes ───────────────────────────────────────────────
create table if not exists forum_votes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  post_id    uuid not null references forum_posts(id) on delete cascade,
  vote_type  text not null check (vote_type in ('like', 'dislike')),
  created_at timestamptz default now() not null,
  primary key (user_id, post_id)
);

create index if not exists idx_forum_votes_post on forum_votes(post_id);

alter table forum_votes enable row level security;

drop policy if exists "forum_votes: public read"   on forum_votes;
drop policy if exists "forum_votes: auth insert"   on forum_votes;
drop policy if exists "forum_votes: owner update"  on forum_votes;
drop policy if exists "forum_votes: owner delete"  on forum_votes;

create policy "forum_votes: public read"
  on forum_votes for select using (true);

create policy "forum_votes: auth insert"
  on forum_votes for insert
  with check (
    auth.uid() = user_id and
    exists (select 1 from forum_posts where id = post_id and parent_id is null)
  );

create policy "forum_votes: owner update"
  on forum_votes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "forum_votes: owner delete"
  on forum_votes for delete
  using (auth.uid() = user_id);

-- Trigger: keep like_count / dislike_count denormalised on forum_posts
create or replace function sync_vote_counts()
returns trigger language plpgsql security definer as $$
declare v_post_id uuid;
begin
  v_post_id := coalesce(new.post_id, old.post_id);
  update forum_posts set
    like_count    = (select count(*) from forum_votes where post_id = v_post_id and vote_type = 'like'),
    dislike_count = (select count(*) from forum_votes where post_id = v_post_id and vote_type = 'dislike')
  where id = v_post_id;
  return coalesce(new, old);
end;
$$;

create or replace trigger on_vote_change
  after insert or update or delete on forum_votes
  for each row execute procedure sync_vote_counts();
