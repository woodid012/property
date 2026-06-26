/*
 * browser_pull.js — how the listings are refreshed (NO Firecrawl).
 * ============================================================================
 *
 * Domain.com.au sits behind Akamai bot protection. Every server-side approach
 * is blocked: plain urllib/requests -> 403, headless Playwright -> "Access
 * Denied", and Firecrawl was unreliable (HTTP 408 timeouts). The ONLY thing
 * that gets through is a real, logged-in browser — so the listings are pulled
 * through the user's actual Chrome (driven by Claude via the Chrome extension).
 *
 * This file holds the two snippets that do it. To refresh, just ask Claude to
 * "pull the latest listings", and it will drive Chrome through these steps.
 *
 * FLOW
 * ----
 * 1. In the browser, run STEP A once to define the extractor + clear the buffer.
 * 2. For every suburb × {rent, sale} search page, navigate there and run
 *    `await run('rent')` (or `await run('buy')`). Results accumulate in
 *    localStorage._pull (survives navigation because it's same-origin).
 *      URLs: https://www.domain.com.au/rent/<suburb>-wa-<postcode>/?bedrooms=2-any
 *            https://www.domain.com.au/sale/<suburb>-wa-<postcode>/?bedrooms=2-any
 * 3. Run STEP B to dedupe, filter to 2+ beds, split rent/buy, sort, and stash
 *    the cleaned {rent, buy} object in localStorage._final.
 * 4. Exfiltrate _final to disk (CSP blocks fetch from domain.com.au, so a tiny
 *    local receiver + a sink page reached via top-level navigation is used —
 *    see scraper/receiver.py), then merge with config.json + a timestamp into
 *    data/listings.json (same shape the website expects).
 *
 * The extractor mirrors the fields the website reads: id, address, suburb,
 * beds, baths, cars, area, propertyType, price, priceValue, isNew, image, url.
 */

// ── STEP A — define the per-page extractor and reset the buffer ──────────────
async function run(KIND) {
  // wait for Next.js data to be present
  for (let i = 0; i < 20; i++) {
    const cp = window.__NEXT_DATA__?.props?.pageProps?.componentProps;
    if (cp && cp.listingsMap) break;
    await new Promise(r => setTimeout(r, 400));
  }
  const lm = window.__NEXT_DATA__?.props?.pageProps?.componentProps?.listingsMap;
  if (!lm) {
    return { ok: false, denied: !!document.body?.innerText.includes('Access Denied'),
             title: document.title, url: location.href };
  }
  const num = (t) => {
    if (!t) return null;
    const m = String(t).match(/\$\s*([\d,]+(?:\.\d+)?)\s*([kmKM]?)/);
    if (!m) return null;
    let v = parseFloat(m[1].replace(/,/g, ''));
    const s = (m[2] || '').toLowerCase();
    if (s === 'k') v *= 1e3; else if (s === 'm') v *= 1e6;
    return Math.round(v);
  };
  const out = [];
  for (const e of Object.values(lm)) {
    const m = e.listingModel; if (!m || !m.address) continue;
    const a = m.address, f = m.features || {};
    let url = m.url || ''; if (url.startsWith('/')) url = 'https://www.domain.com.au' + url;
    const tail = [a.suburb, a.state, a.postcode].filter(Boolean).join(' ');
    const addr = [(a.street || '').trim(), tail].filter(Boolean).join(', ') || 'Address withheld';
    let price = m.price || m.displaySearchPriceRange || 'Contact agent';
    let pv = num(price); if (KIND === 'buy' && pv && pv < 10000) pv = null;
    let tt = ''; const tg = m.tags;
    if (Array.isArray(tg)) tt = tg.map(t => (t && t.tagText) || '').join(' ');
    else if (tg && typeof tg === 'object') tt = tg.tagText || '';
    out.push({
      id: e.id, address: addr, suburb: (a.suburb || '').trim(),
      beds: f.beds ?? null, baths: f.baths ?? null, cars: f.parking ?? null,
      area: f.landSize || null,
      propertyType: f.propertyTypeFormatted || f.propertyType || '',
      price: String(price).trim(), priceValue: pv, isNew: /new/i.test(tt),
      image: (Array.isArray(m.images) && m.images[0]) || null,
      url: url || null, _kind: KIND,
    });
  }
  const cur = JSON.parse(localStorage.getItem('_pull') || '[]');
  cur.push(...out);
  localStorage.setItem('_pull', JSON.stringify(cur));
  localStorage.setItem('_fn', run.toString()); // so later pages can re-eval cheaply
  return { ok: true, count: out.length, total: cur.length, title: document.title };
}
// reset before a fresh pull:  localStorage.setItem('_pull', '[]'); await run('rent');

// ── STEP B — dedupe / filter / sort into localStorage._final ─────────────────
function assemble(minBeds = 2) {
  const raw = JSON.parse(localStorage.getItem('_pull') || '[]');
  const clean = (kind) => {
    const seen = new Set(), rows = [];
    for (const r of raw) {
      if (r._kind !== kind || !r.url) continue;
      const key = r.id || r.url;
      if (seen.has(key)) continue;
      if (r.beds != null && r.beds < minBeds) continue;
      seen.add(key);
      const { _kind, ...rest } = r;
      rows.push(rest);
    }
    rows.sort((a, b) => {
      const an = a.priceValue == null, bn = b.priceValue == null;
      if (an !== bn) return an ? 1 : -1;          // price-on-application last
      return (a.priceValue || 0) - (b.priceValue || 0);
    });
    return rows;
  };
  const final = JSON.stringify({ rent: clean('rent'), buy: clean('buy') });
  localStorage.setItem('_final', final);
  return { rent: JSON.parse(final).rent.length, buy: JSON.parse(final).buy.length, bytes: final.length };
}
