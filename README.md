# Property — Mount Claremont 2+ bed search

A small website for browsing **2+ bedroom rentals and homes for sale** around
Mount Claremont, WA (Claremont, Swanbourne, Cottesloe, Floreat, Nedlands,
Dalkeith). Built to share with family.

- **For Rent** and **To Buy** tabs, shown as a **photo dashboard** (lead photo per home)
- **♥ Favourite** any home and **✕ Hide** ones you're not interested in — with **Undo** and a **Hidden** tab to restore from
- Favourites/hidden are **saved to the cloud** (visible on any device, and you can see what Mum picked) — with automatic fall-back to per-device saving if no cloud store is connected
- An **adjustable price range** that's **saved** on the device (drag the sliders, tap Save)
- A **Refresh** button to pull the latest data

## How it works

```
Domain.com.au ──(Firecrawl renders + we parse embedded JSON)──> data/listings.json ──> index.html (the website)
                         ▲                                              ▲                      │
              scraper/scrape_domain.py                      build step (manual run)            ▼
                                                                                  /api/state ──> Vercel KV
                                                                          (Mum's ♥ favourites / ✕ hidden, table: picks)
```

- `index.html` — the whole website (self-contained: inline CSS + JS, no build step). Reads `data/listings.json` and talks to `/api/state` for favourites/hidden.
- `scraper/scrape_domain.py` — **the build script.** Python (standard library only). Uses [Firecrawl](https://firecrawl.dev) to fetch each Domain suburb search page (Domain blocks plain scrapers), then parses the listings (incl. lead photo) out of the page's embedded `__NEXT_DATA__` JSON. **1 Firecrawl credit per page.** Run it whenever you want to rebuild the dashboard data.
- `api/state.js` — a small Vercel serverless function that stores Mum's favourites/hidden in **Postgres (Neon)** via `@neondatabase/serverless`. It auto-creates its `picks` table on first use. If no database URL is present it returns `configured:false` and the site falls back to per-device saving.
- `config.json` — the search definition (suburbs, min bedrooms, default price ranges). Edit this to change what's searched; both the scraper and website read it.
- `data/listings.json` — the scraper's output (what the website shows).
- `.github/workflows/scrape.yml` — optional: can run the scraper on a schedule and commit refreshed data (not required for manual runs).

## Setup

### 1. Firecrawl key (required for scraping)

Get a free key at <https://firecrawl.dev> (1,000 credits/month; a daily run uses ~400).

**Local runs:** copy `scraper/.env.example` to `scraper/.env` and paste your key:
```
FIRECRAWL_API_KEY=fc-xxxxxxxx
```
(`scraper/.env` is gitignored — it never gets committed.)

**The 6am GitHub Action:** add the key as a repository secret —
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret** →
name `FIRECRAWL_API_KEY`, value your key.

### 2. Build the dashboard data (run the scraper)
This is the **build step** — run it whenever you want fresh listings + photos:
```bash
cd scraper
python scrape_domain.py
```
Writes `data/listings.json`. Commit + push it and Vercel redeploys with the new homes.

## Mum's favourites / hidden (cloud sync)

The website saves Mum's **♥ favourites** and **✕ hidden** homes via `api/state.js`,
stored in a **Postgres (Neon)** database. With no database connected it falls back to
saving on her device only. To make her picks **synced and visible to you on any device**:

1. Vercel dashboard → your project → **Storage** → **Create Database** → choose
   **Postgres (Neon)** → connect it to the project. (Or attach an existing Neon DB and
   add its `DATABASE_URL` under **Settings → Environment Variables**.)
2. Vercel injects `DATABASE_URL` / `POSTGRES_URL` automatically. **Redeploy.**

That's it — `api/state.js` reads those env vars, **auto-creates its `picks` table** on
first use, and starts syncing. No SQL to run by hand. To see what Mum has saved, open
`https://your-site.vercel.app/api/state` (returns her favourites + hidden lists as JSON),
or query `SELECT * FROM picks;` in the Neon console.

> **Never commit the database URL.** It lives only in Vercel's env vars (and, for local
> `vercel dev`, a gitignored `.env.local`). `.env*` files are already gitignored.

## Changing the search

Edit `config.json`:
- `locations` — add/remove suburbs (suburb name, postcode, state)
- `minBedrooms` — currently `2`
- `defaultRanges` — the default price slider positions for rent and buy

## Deploy (Vercel)

Plain static HTML — no build step.
1. <https://vercel.com/new> → import `woodid012/property`
2. Framework preset: **Other** → **Deploy**

Vercel serves `index.html` and redeploys on every push (including the 6am data commits).
You'll get a URL like `https://property-woodid012.vercel.app` — that's the link to send Mum.
