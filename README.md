# Property — Lake Claremont / Mount Claremont search

A small website for browsing **rentals and homes for sale** around
Lake Claremont / Mount Claremont, WA — Claremont, Swanbourne, Cottesloe, Floreat,
Nedlands, Dalkeith, Subiaco, Shenton Park, Daglish, Jolimont, Wembley. Built to
share with family.

Rentals are filtered to a minimum weekly rent and **exclude furnished homes**
(see `minRent` / `excludeFurnished` in `config.json`). The same suburb list is
used for both the **For Rent** and **To Buy** tabs.

- **For Rent** and **To Buy** tabs, shown as a **photo dashboard** (lead photo per home)
- **♥ Favourite** any home and **✕ Hide** ones you're not interested in — with **Undo** and a **Hidden** tab to restore from
- Favourites/hidden are **saved to the cloud** (visible on any device, and you can see what Mum picked) — with automatic fall-back to per-device saving if no cloud store is connected
- **Save settings** stores ALL the filters — bedrooms, suburbs, must-haves and budget — **to the cloud too**, so everyone on the link sees the same setup (chip/slider changes are a live preview until you tap Save)
- A **Refresh** button to pull the latest data

## How it works

```
Domain.com.au ──(pulled through a real Chrome — see below)──> data/listings.json ──> index.html (the website)
                                                                      │                       │
                                                                      ▼                       ▼
                                                          scraper/browser_pull.js   /api/state ──> Postgres (Neon)
                                                                                  (Mum's ♥ favourites / ✕ hidden, table: picks)
```

- `index.html` — the whole website (self-contained: inline CSS + JS, no build step). Reads `data/listings.json` and talks to `/api/state` for favourites/hidden.
- `data/listings.json` — the listings the website shows (each with a lead photo).
- `scraper/browser_pull.js` + `scraper/receiver.py` — **how the listings are refreshed.** Domain sits behind Akamai bot protection, so *server-side* scraping does not work (plain HTTP → 403, headless browsers → "Access Denied", Firecrawl → timeouts). The only reliable method is a **real browser**, so the data is pulled through your actual Chrome. See **Refreshing the listings** below.
- `api/state.js` — a small Vercel serverless function that stores Mum's favourites/hidden in **Postgres (Neon)** via `@neondatabase/serverless`. It auto-creates its `picks` table on first use. If no database URL is present it returns `configured:false` and the site falls back to per-device saving.
- `config.json` — the search definition (suburbs, min bedrooms, default price ranges). Edit this to change what's searched; a copy is embedded into `data/listings.json` on each pull.

## Refreshing the listings (no Firecrawl)

The simplest way: **ask Claude (in Claude Code, with the Chrome extension) to "pull the latest listings."**
It drives your real Chrome through the search pages for each suburb × {rent, sale},
extracts the embedded listing JSON, dedupes/sorts, and rewrites `data/listings.json`.
Commit + push it and Vercel redeploys with the fresh homes.

Under the hood (documented in `scraper/browser_pull.js`):
1. For each Domain search page, run the extractor — results accumulate in
   `localStorage._pull` (survives navigation).
2. `assemble()` dedupes to 2+ beds, splits rent/buy, sorts (price-on-application last)
   into `localStorage._final`.
3. `scraper/receiver.py` (a localhost helper) receives `_final` past Domain's CSP and
   writes it to disk; it's then merged with `config.json` + a timestamp into
   `data/listings.json`.

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

Vercel serves `index.html` and redeploys on every push (including when you push a
refreshed `data/listings.json`). You'll get a URL like
`https://property-woodid012.vercel.app` — that's the link to send Mum.
