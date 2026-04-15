# arXiv·Forum

A forum-style ArXiv wrapper with a comment section. Browse preprints like forum threads, add discussion to any paper.

**Stack:** Vanilla JS + HTML/CSS · ArXiv API (via Netlify serverless proxy) · Supabase (comments) · Netlify (hosting)

---

## Quick Start

### 1. Clone / open the folder

```
C:\Users\erikh\Desktop\arxiv_wrapper\
```

### 2. Set up Supabase (free tier, no card required)

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Once created, open **SQL Editor → New query** and paste the contents of `supabase-schema.sql`, then run it
3. Go to **Settings → API** and copy:
   - **Project URL** (looks like `https://abcdef.supabase.co`)
   - **anon / public key**
4. Open `js/config.js` and replace the placeholder values:

```js
window.ARXIV_FORUM_CONFIG = {
  SUPABASE_URL:      'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY_HERE',
};
```

> Without Supabase configured, the app still works — papers load fine, but the comment form is hidden.

### 3. Install the Netlify CLI (once)

```bash
npm install -g netlify-cli
```

### 4. Run locally

```bash
cd C:\Users\erikh\Desktop\arxiv_wrapper
netlify dev
```

Open [http://localhost:8888](http://localhost:8888).

The Netlify serverless function (`netlify/functions/arxiv.js`) proxies requests to `export.arxiv.org` and adds CORS headers so the browser can fetch XML safely.

---

## Deploy to Netlify (free hosting)

```bash
netlify login
netlify init          # link to a new or existing site
netlify deploy --prod
```

Or connect your GitHub repo in the Netlify dashboard for automatic deploys on push.

---

## File Structure

```
arxiv_wrapper/
├── index.html                  — Forum home: search & browse
├── paper.html                  — Paper detail + comments
├── style.css                   — All styles
├── js/
│   ├── config.js               — Supabase credentials (edit this)
│   ├── arxiv.js                — ArXiv API client + XML parser
│   ├── comments.js             — Supabase comment CRUD + real-time
│   ├── index.js                — Index page logic
│   └── paper.js                — Paper page logic
├── netlify/
│   └── functions/
│       └── arxiv.js            — Proxy: adds CORS to ArXiv responses
├── netlify.toml                — Netlify build config
├── supabase-schema.sql         — Run this in Supabase SQL Editor
└── README.md
```

---

## Features

- **Search** — Full-text and field-prefixed (e.g. `au:LeCun`, `ti:attention`, `cat:cs.AI`)
- **Browse by category** — Collapsible sidebar with all major arXiv subjects
- **Forum threads** — Papers listed as threads with author, date, category badges
- **Pagination** — Navigate large result sets
- **Paper detail** — Full abstract, metadata, links to PDF / HTML / Semantic Scholar
- **Comments** — Anonymous comments with optional name, nested replies (1 level)
- **Real-time** — New comments appear live via Supabase Realtime
- **"NEW" badge** — Papers submitted within the last 7 days are highlighted

---

## ArXiv Search Syntax

| Prefix | Field         | Example          |
|--------|---------------|------------------|
| `ti:`  | Title         | `ti:transformer` |
| `au:`  | Author        | `au:Hinton`      |
| `abs:` | Abstract      | `abs:diffusion`  |
| `cat:` | Category      | `cat:cs.LG`      |
| `all:` | All fields    | `all:neural`     |

Combine: `au:LeCun AND cat:cs.CV`

---

## Notes

- ArXiv rate-limits to ~1 request per 3 seconds. The app doesn't batch-fire requests, so normal browsing is well within limits.
- Supabase free tier: 500 MB database, 50,000 monthly active users — more than enough for personal/small community use.
- Netlify free tier: 125k function invocations/month — plenty for a small forum.
