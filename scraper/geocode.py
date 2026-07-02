#!/usr/bin/env python3
"""geocode.py — add lat/lng to listing rows via Nominatim (OpenStreetMap).

Results cache in scraper/_geocache.json (address -> [lat, lon] | null), so only
NEW addresses hit the network — throttled to 1 request/second per Nominatim's
usage policy. Unit prefixes ("5/2 Quintilian Rd") and lot letters ("38B") are
retried stripped when the full address misses; the last resort is the suburb
centroid, which still puts the pin in the right neighbourhood.

Run standalone to backfill data/listings.json in place:
    python scraper/geocode.py
build_listings.py also calls geocode_rows() on every build, so refreshed
listings pick up coordinates automatically.
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_FILE = Path(__file__).resolve().parent / "_geocache.json"
LISTINGS = ROOT / "data" / "listings.json"
UA = "mums-property-search/1.0 (personal family site)"
API = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q="


def _load_cache():
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


def _query(q):
    req = urllib.request.Request(API + urllib.parse.quote(q), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        hits = json.load(r)
    time.sleep(1.1)  # Nominatim: max 1 req/sec
    return [round(float(hits[0]["lat"]), 6), round(float(hits[0]["lon"]), 6)] if hits else None


def _variants(addr):
    yield addr
    v = re.sub(r"^\S+/", "", addr).strip()          # drop unit prefix "5/2 X St"
    if v != addr:
        yield v
    v2 = re.sub(r"^(\d+)[A-Za-z]\b", r"\1", v)       # "38B Adderley St" -> "38 ..."
    if v2 != v:
        yield v2
    m = re.search(r"([^,]+ WA \d{4})\s*$", addr)     # suburb centroid fallback
    if m and m.group(1).strip() != addr:
        yield m.group(1).strip()


def geocode_rows(rows, verbose=True):
    """Set row['lat']/row['lng'] on every row whose address can be resolved."""
    cache = _load_cache()
    fetched = 0
    for r in rows:
        addr = (r.get("address") or "").strip()
        if not addr:
            continue
        if addr not in cache:
            pos = None
            for q in _variants(addr):
                try:
                    pos = _query(q)
                except Exception:
                    pos = None
                if pos:
                    break
            cache[addr] = pos
            fetched += 1
            if verbose:
                print(f"  geocoded {addr} -> {pos}", flush=True)
            if fetched % 20 == 0:
                _save_cache(cache)
        pos = cache.get(addr)
        if pos:
            r["lat"], r["lng"] = pos
    if fetched:
        _save_cache(cache)
    return rows


if __name__ == "__main__":
    data = json.loads(LISTINGS.read_text(encoding="utf-8"))
    rows = (data.get("rent") or []) + (data.get("buy") or [])
    print(f"geocoding {len(rows)} listings (cache: {len(_load_cache())} known)...", flush=True)
    geocode_rows(rows)
    LISTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    located = sum(1 for r in rows if r.get("lat") is not None)
    print(f"done: {located}/{len(rows)} listings have coordinates", flush=True)
