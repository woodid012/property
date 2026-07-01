/*
 * browser_pull.js — how the listings are refreshed (NO Firecrawl, NO headless).
 * ============================================================================
 *
 * Domain.com.au sits behind Akamai bot protection. Every server-side / headless
 * approach is blocked (plain HTTP -> 403, headless browser -> "Access Denied").
 * The ONLY reliable method is a REAL, logged-in Chrome, driven by Claude through
 * the Chrome extension. To refresh, just ask Claude to "pull the latest listings".
 *
 * This file is the playbook Claude follows.
 *
 * ============================================================================
 * METHOD 2 — DIRECT NAVIGATION (CURRENT, use this — proven 2026-07)
 * ============================================================================
 * The legacy stepper below (METHOD 1) drives page changes with
 * `window.next.router.push()`. That started hanging the extension's CDP
 * Runtime.evaluate for 45s per call (the navigation destroys the JS context
 * mid-await, so the promise never resolves back). Do NOT use it.
 *
 * Instead, drive each page load with the extension's `navigate` tool
 * (top-level browser navigation), then run a small extractor per page:
 *
 *   For each suburb slug from config.json
 *   (slug = lowercase suburb, spaces->dashes, + '-<state>-<postcode>'):
 *     RENT:  navigate  https://www.domain.com.au/rent/<slug>/?price=500-3000
 *            -> run extractRent()                      (appends to _pull)
 *            then for features furnished / petsallowed / gardencourtyard:
 *            navigate  ...&features=<feature>
 *            -> run extractFeat('_furn'|'_pets'|'_court')  (appends ids)
 *     BUY:   navigate  https://www.domain.com.au/sale/<slug>/
 *            -> run extractBuy()                       (appends to _pull)
 *
 * Then exfil (STEP C below), build, commit, push — rent first, then buys, as
 * two pushes (`build_listings.py rent-only`, then `buy-only`).
 *
 * FIELD RULES (each one earned the hard way)
 * ------------------------------------------
 *  - HYDRATION RACE: right after navigate, __NEXT_DATA__ may not be populated
 *    yet — extractors return {captured:0,total:null}. That is NOT a block;
 *    just re-run the extractor (or use the wait-loop built into the snippets
 *    below). A real block has "Access Denied" in document.title.
 *  - AKAMAI: rental *feature-filter* URLs are the usual trigger; /sale/ pages
 *    almost never block. On "Access Denied": STOP hitting Domain entirely
 *    (every extra hit re-arms it), wait ~20 min hands-off, then retry starting
 *    from the suburb's UNFILTERED page (no ?price=). If only a feature filter
 *    blocks but the unfiltered page loads, skip that one filter rather than
 *    burning the cooldown — the suburb just loses that flag for a day.
 *  - INTERIM COMMIT ON BLOCK: before going quiet for a cooldown, exfil what
 *    has been captured so far (exfil hits localhost only — it cannot re-arm
 *    Akamai) and build+commit+push it as an interim update, MERGED so suburbs
 *    not yet re-scraped keep yesterday's rows instead of vanishing from the
 *    site. (Merge: load the previous data/listings.json, re-tag its rows for
 *    the missing suburbs with _kind and re-add their pets/courtyard ids, and
 *    append them to the bundle before running build_listings.py.)
 *  - Only page 1 (~20 cards) of each search is captured, by design — keeps the
 *    pull small and under Akamai's radar. Totals of 100+ per suburb exist;
 *    paginating would multiply Domain hits and block risk.
 *  - localStorage survives reloads and Chrome restarts (per profile), so
 *    captured data is never lost by a crash — reconnect and continue.
 *
 * EXTRACTORS (stash in localStorage so each page-call is one tiny eval):
 *   localStorage._extractRent / _extractFeat / _extractBuy — see bottom of
 *   this file for the reference implementations.
 *
 * ============================================================================
 * METHOD 1 — LEGACY STEPPER (kept for reference; router.push hangs CDP)
 * ============================================================================
 *
 * WHY IT LOOKS THE WAY IT DOES (lessons from the field)
 * -----------------------------------------------------
 *  - Direct navigation to a *filtered* URL (?price=…, ?features=…) returned 404
 *    in early sessions, but Next.js CLIENT-SIDE navigation did not. (This is no
 *    longer true — filtered URLs load fine via top-level navigation now, which
 *    is what METHOD 2 relies on.)
 *  - Furnished / pets / courtyard are NOT in the listing-card JSON. They are only
 *    expressible as Domain "feature" filters. So for each rental suburb we run the
 *    base search plus one search per feature, and keep the matching ids as sets.
 *  - Some router.push transitions do a FULL reload, wiping window globals — but
 *    NOT localStorage. So all state (job queue, cursor, results) lives in
 *    localStorage and every step re-reads it. This makes the pull reload-proof
 *    and resumable: if it dies, just run the stepper again.
 *  - Akamai throttles bursts. Pace ~4s between navigations; if you still get
 *    "Access Denied", STOP (each hit re-arms it), wait ~10–30 min hands-off, then
 *    resume — the stepper detects denial and refuses to advance, so nothing is
 *    lost or double-counted.
 *
 * FLOW
 * ----
 *   1. Start the receiver:           python scraper/receiver.py
 *   2. Open any Domain page in Chrome (e.g. https://www.domain.com.au/rent/...).
 *   3. STEP A — build the job queue + reset buffers (run once).
 *   4. STEP B — run the stepper repeatedly (once per job) until it reports done.
 *              Each call settles the current page, extracts it, and pushes the
 *              next. 5 jobs per suburb (rent base + 3 feature queries + buy).
 *   5. STEP C — exfiltrate the bundle to scraper/_pull_final.json (via receiver).
 *   6. Build + ship:                 python scraper/build_listings.py
 *                                    git add data/listings.json && git commit && git push
 *
 * The search definition (suburbs, minRent, excludeFurnished) lives in config.json.
 */

// ── STEP A — build the job queue + reset buffers (run ONCE) ──────────────────
// Mirrors config.json. Each rental suburb => base search + furnished/pets/courtyard
// feature searches; each suburb also => a sale search. Buy jobs go last so the
// rentals can be built & shipped first if you want two separate pushes.
function buildQueue(slugs) {
  const storeOf = { furnished: '_furn', petsallowed: '_pets', gardencourtyard: '_court' };
  const feats = ['furnished', 'petsallowed', 'gardencourtyard'];
  const rentJobs = [], buyJobs = [];
  for (const s of slugs) {
    rentJobs.push({ kind: 'rent', slug: s, path: '/rent/' + s + '/?price=500-3000' });
    for (const f of feats)
      rentJobs.push({ kind: 'rent', slug: s, feat: f, store: storeOf[f],
                      path: '/rent/' + s + '/?price=500-3000&features=' + f });
    buyJobs.push({ kind: 'buy', slug: s, path: '/sale/' + s + '/' });
  }
  const jobs = rentJobs.concat(buyJobs);
  localStorage.setItem('_jobs', JSON.stringify(jobs));
  localStorage.setItem('_ji', '0');
  ['_pull', '_furn', '_pets', '_court'].forEach(k => localStorage.setItem(k, '[]'));
  try { window.next.router.push(jobs[0].path); } catch (e) {}
  return { jobs: jobs.length, buyStartsAt: rentJobs.length };
}
// Example (slugs = "<suburb>-<state>-<postcode>"):
//   buildQueue(['mount-claremont-wa-6010','claremont-wa-6010','swanbourne-wa-6010',
//     'cottesloe-wa-6011','floreat-wa-6014','nedlands-wa-6009','dalkeith-wa-6009',
//     'subiaco-wa-6008','wembley-wa-6014','highgate-wa-6003','mount-lawley-wa-6050']);

// ── STEP B — the stepper (run REPEATEDLY, once per job) ──────────────────────
// Self-contained & reload-proof: reads the cursor from localStorage, settles the
// current page, extracts it, advances, and pushes the next page (after a pace
// delay). Returns {ji_done,…} on success or {ji_stuck,…,denied:true} on a block
// (in which case it does NOT advance — wait, then run it again).
async function step() {
  const jobs = JSON.parse(localStorage.getItem('_jobs'));
  let ji = +(localStorage.getItem('_ji') || 0);
  const job = jobs[ji];
  if (!job) return { done: true, ji };
  // settle: wait until the loaded page matches this job (suburb + kind + feature)
  let settled = false;
  for (let i = 0; i < 35; i++) {
    const cp = window.__NEXT_DATA__?.props?.pageProps?.componentProps;
    if (cp?.listingsMap) {
      const seg = location.pathname.split('/');
      const slugOk = seg.includes(job.slug);
      const kindOk = job.kind === 'buy' ? location.pathname.startsWith('/sale/')
                                        : location.pathname.startsWith('/rent/');
      const featOk = job.feat ? location.search.includes('features=' + job.feat)
                              : !location.search.includes('features=');
      if (slugOk && kindOk && featOk) { settled = true; break; }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  await new Promise(r => setTimeout(r, 200));
  const cp = window.__NEXT_DATA__?.props?.pageProps?.componentProps;
  const lm = cp?.listingsMap || {};
  const denied = /access denied/i.test(document.title)
              || /Oops/i.test((document.body?.innerText || '').slice(0, 120));
  if (!settled || denied) return { ji_stuck: ji, slug: job.slug, feat: job.feat || null, settled, denied };

  if (job.store) {
    // feature query: keep only the matching listing ids
    const ids = [];
    for (const e of Object.values(lm)) if (e.listingModel?.address) ids.push(e.id);
    const fs = JSON.parse(localStorage.getItem(job.store) || '[]');
    fs.push(...ids);
    localStorage.setItem(job.store, JSON.stringify(fs));
  } else {
    // base search: extract the full listing rows the website reads
    const num = (t) => {
      if (!t) return null;
      const m = String(t).match(/\$\s*([\d,]+(?:\.\d+)?)\s*([kmKM]?)/); if (!m) return null;
      let v = parseFloat(m[1].replace(/,/g, '')); const s = (m[2] || '').toLowerCase();
      if (s === 'k') v *= 1e3; else if (s === 'm') v *= 1e6; return Math.round(v);
    };
    const out = [];
    for (const e of Object.values(lm)) {
      const m = e.listingModel; if (!m || !m.address) continue;
      const a = m.address, f = m.features || {};
      let url = m.url || ''; if (url.startsWith('/')) url = 'https://www.domain.com.au' + url;
      const tail = [a.suburb, a.state, a.postcode].filter(Boolean).join(' ');
      const addr = [(a.street || '').trim(), tail].filter(Boolean).join(', ') || 'Address withheld';
      let price = m.price || m.displaySearchPriceRange || 'Contact agent';
      let pv = num(price); if (job.kind === 'buy' && pv && pv < 10000) pv = null;
      let tt = '', tc = ''; const tg = m.tags;
      if (Array.isArray(tg)) { tt = tg.map(t => (t && t.tagText) || '').join(' ');
                               tc = tg.map(t => (t && t.tagClassName) || '').join(' '); }
      else if (tg && typeof tg === 'object') { tt = tg.tagText || ''; tc = tg.tagClassName || ''; }
      const underOffer = /under.?offer|under.?contract/i.test(tt + ' ' + tc);
      const ins = m.inspection;
      const inspect = (ins && ins.openTime) ? { open: ins.openTime, close: ins.closeTime || null } : null;
      out.push({ id: e.id, address: addr, suburb: (a.suburb || '').trim(),
        beds: f.beds ?? null, baths: f.baths ?? null, cars: f.parking ?? null, area: f.landSize || null,
        propertyType: f.propertyTypeFormatted || f.propertyType || '',
        price: String(price).trim(), priceValue: pv, isNew: /new/i.test(tt), underOffer, inspect,
        image: (Array.isArray(m.images) && m.images[0]) || null, url: url || null, _kind: job.kind });
    }
    const cur = JSON.parse(localStorage.getItem('_pull') || '[]');
    cur.push(...out);
    localStorage.setItem('_pull', JSON.stringify(cur));
  }
  ji++; localStorage.setItem('_ji', String(ji));
  await new Promise(r => setTimeout(r, 4000)); // pace: stay under Akamai's burst threshold
  const next = jobs[ji];
  if (next) { try { window.next.router.push(next.path); } catch (e) {} }
  return { ji_done: ji - 1, slug: job.slug, kind: job.kind, feat: job.feat || null,
           total: cp?.totalListings, nextIdx: ji, of: jobs.length, hasNext: !!next };
}

// ── STEP C — exfiltrate the bundle to disk (receiver must be running) ────────
// Domain's CSP blocks fetch() to localhost, so we navigate (top-level) to the
// receiver's sink page with the data in the URL hash; it POSTs it back same-origin
// and writes scraper/_pull_final.json. Then run: python scraper/build_listings.py
function exfil() {
  const bundle = {
    pull:  JSON.parse(localStorage.getItem('_pull')  || '[]'),
    furn:  JSON.parse(localStorage.getItem('_furn')  || '[]'),
    pets:  JSON.parse(localStorage.getItem('_pets')  || '[]'),
    court: JSON.parse(localStorage.getItem('_court') || '[]'),
  };
  const data = JSON.stringify(bundle);
  location.href = 'http://127.0.0.1:8799/sink#' + encodeURIComponent(data);
  return { bytes: data.length, listings: bundle.pull.length };
}

// ── METHOD 2 reference extractors ────────────────────────────────────────────
// Run ONE of these per page load (after a top-level `navigate`). Each waits for
// __NEXT_DATA__ to hydrate (the race that makes fresh pages report 0 listings),
// detects Akamai denial, and appends results to localStorage. Stash them once:
//   localStorage.setItem('_extractRent', extractRent.toString()) … etc,
// then per page:  eval(localStorage.getItem('_extractRent')); await extractRent();

// shared: wait for the listing data to hydrate (or detect a block)
async function settle() {
  for (let i = 0; i < 20; i++) {
    if (/access denied/i.test(document.title)) return { denied: true };
    const cp = window.__NEXT_DATA__?.props?.pageProps?.componentProps;
    if (cp?.listingsMap) return { denied: false, cp };
    await new Promise(r => setTimeout(r, 400));
  }
  return { denied: false, cp: null }; // treat as empty page, not a block
}

// row extractor shared by rent + buy (kind = 'rent' | 'buy')
function rowsOf(lm, kind) {
  const num = (t) => {
    if (!t) return null;
    const m = String(t).match(/\$\s*([\d,]+(?:\.\d+)?)\s*([kmKM]?)/); if (!m) return null;
    let v = parseFloat(m[1].replace(/,/g, '')); const s = (m[2] || '').toLowerCase();
    if (s === 'k') v *= 1e3; else if (s === 'm') v *= 1e6; return Math.round(v);
  };
  const out = [];
  for (const e of Object.values(lm)) {
    const m = e.listingModel; if (!m || !m.address) continue;
    const a = m.address, f = m.features || {};
    let url = m.url || ''; if (url.startsWith('/')) url = 'https://www.domain.com.au' + url;
    const tail = [a.suburb, a.state, a.postcode].filter(Boolean).join(' ');
    const addr = [(a.street || '').trim(), tail].filter(Boolean).join(', ') || 'Address withheld';
    let price = m.price || m.displaySearchPriceRange || 'Contact agent';
    let pv = num(price); if (kind === 'buy' && pv && pv < 10000) pv = null;
    let tt = '', tc = ''; const tg = m.tags;
    if (Array.isArray(tg)) { tt = tg.map(t => (t && t.tagText) || '').join(' '); tc = tg.map(t => (t && t.tagClassName) || '').join(' '); }
    else if (tg && typeof tg === 'object') { tt = tg.tagText || ''; tc = tg.tagClassName || ''; }
    const underOffer = /under.?offer|under.?contract/i.test(tt + ' ' + tc);
    const ins = m.inspection;
    const inspect = (ins && ins.openTime) ? { open: ins.openTime, close: ins.closeTime || null } : null;
    out.push({ id: e.id, address: addr, suburb: (a.suburb || '').trim(),
      beds: f.beds ?? null, baths: f.baths ?? null, cars: f.parking ?? null, area: f.landSize || null,
      propertyType: f.propertyTypeFormatted || f.propertyType || '',
      price: String(price).trim(), priceValue: pv, isNew: /new/i.test(tt), underOffer, inspect,
      image: (Array.isArray(m.images) && m.images[0]) || null, url: url || null, _kind: kind });
  }
  return out;
}

async function extractRent() {
  const s = await settle(); if (s.denied) return { denied: true };
  const out = rowsOf(s.cp?.listingsMap || {}, 'rent');
  const cur = JSON.parse(localStorage.getItem('_pull') || '[]');
  cur.push(...out); localStorage.setItem('_pull', JSON.stringify(cur));
  return { denied: false, total: s.cp?.totalListings ?? null, captured: out.length, newPullTotal: cur.length };
}

async function extractBuy() {
  const s = await settle(); if (s.denied) return { denied: true };
  const out = rowsOf(s.cp?.listingsMap || {}, 'buy');
  const cur = JSON.parse(localStorage.getItem('_pull') || '[]');
  cur.push(...out); localStorage.setItem('_pull', JSON.stringify(cur));
  return { denied: false, total: s.cp?.totalListings ?? null, captured: out.length, newPullTotal: cur.length };
}

async function extractFeat(store) { // store = '_furn' | '_pets' | '_court'
  const s = await settle(); if (s.denied) return { denied: true };
  const ids = [];
  for (const e of Object.values(s.cp?.listingsMap || {})) if (e.listingModel?.address) ids.push(e.id);
  const fs = JSON.parse(localStorage.getItem(store) || '[]');
  fs.push(...ids); localStorage.setItem(store, JSON.stringify(fs));
  return { denied: false, total: s.cp?.totalListings ?? null, added: ids.length, storeNow: fs.length };
}
