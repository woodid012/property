# Property — Mount Claremont 2-bed search

A single-page site listing 2-bedroom rentals and buys around Mount Claremont, WA
(Claremont, Swanbourne, Cottesloe, Floreat, Nedlands). Built to share with family.

- **For Rent** — 16 current 2-bed rentals, sorted by price
- **To Buy** — 2-bed apartments/units, $700k–$900k
- **Sold (last 12mo)** — 2-bed townhouse/villa comparables for price context

Each card links to its live Domain listing. The "See all current listings" buttons
always open today's Domain search results.

> Note: the cards are a snapshot (Domain has no public API to pull from in-browser).
> The "See all current" buttons are always live. Re-generate `index.html` to refresh the cards.

## Files

- `index.html` — the whole site (self-contained: inline CSS + JS, no dependencies)

## Deploy

### One-time: push to GitHub
```bash
cd C:\Projects\property
git init
git add .
git commit -m "Property listings page"
git branch -M main
git remote add origin https://github.com/woodid012/property.git
git push -u origin main
```

### Connect Vercel (auto-deploy on every push)
1. Go to https://vercel.com/new
2. Import the `woodid012/property` repo
3. Framework preset: **Other** (it's plain static HTML — no build step)
4. Click **Deploy**

Vercel serves `index.html` automatically. You'll get a URL like
`https://property-woodid012.vercel.app` — that's the link to send your mum.
Every `git push` after that redeploys automatically.

### Or deploy from the CLI instead
```bash
npm i -g vercel
cd C:\Projects\property
vercel --prod
```

## Updating later
Edit `index.html`, then:
```bash
git add . && git commit -m "Update listings" && git push
```
Vercel redeploys within seconds.
