#!/usr/bin/env python3
"""
build_listings.py — assemble data/listings.json from a browser-pulled bundle.

The browser pull (see browser_pull.js) accumulates, in localStorage:
  _pull  — raw listing records (each tagged with _kind: 'rent' | 'buy')
  _furn  — listing ids that are FURNISHED       (rentals: excluded)
  _pets  — listing ids that allow PETS           (rentals: flagged pets=true)
  _court — listing ids with a GARDEN / COURTYARD (rentals: flagged courtyard=true)

Those four are exfiltrated together as one JSON bundle to scraper/_pull_final.json
(via receiver.py). This script turns that bundle + config.json into the
data/listings.json the website reads:

  rentals:  drop furnished, drop anything under config.minRent, flag pets/courtyard
  sales:    as-is
  both:     dedupe, sort (price asc; price-on-application last), keep inspect times
"""
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "scraper" / "_pull_final.json"
CONFIG = ROOT / "config.json"
OUT = ROOT / "data" / "listings.json"


def clean(records, kind, *, furn=None, pets=None, court=None, min_rent=0):
    furn = furn or set()
    pets = pets or set()
    court = court or set()
    seen, rows = set(), []
    for r in records:
        if r.get("_kind") != kind or not r.get("url"):
            continue
        key = r.get("id") or r.get("url")
        if key in seen:
            continue
        if kind == "rent":
            if r.get("id") in furn:
                continue
            pv = r.get("priceValue")
            if pv is not None and pv < min_rent:
                continue
        seen.add(key)
        row = {k: v for k, v in r.items() if k != "_kind"}
        if kind == "rent":
            row["pets"] = r.get("id") in pets
            row["courtyard"] = r.get("id") in court
        rows.append(row)
    rows.sort(key=lambda x: (x.get("priceValue") is None, x.get("priceValue") or 0))
    return rows


def main():
    bundle = json.loads(BUNDLE.read_text(encoding="utf-8"))
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    pull = bundle.get("pull", [])
    furn = set(bundle.get("furn", []))
    pets = set(bundle.get("pets", []))
    court = set(bundle.get("court", []))
    min_rent = config.get("minRent", 0)

    # modes: "full" rebuilds both; "rent-only" rebuilds rent and keeps existing buy;
    #        "buy-only" rebuilds buy and keeps existing (freshly-built) rent.
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    existing = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}

    if mode == "buy-only":
        rent = existing.get("rent", [])
    else:
        rent = clean(pull, "rent", furn=furn, pets=pets, court=court, min_rent=min_rent)

    if mode == "rent-only":
        buy = existing.get("buy", [])
    else:
        buy = clean(pull, "buy")

    now = datetime.now(timezone(timedelta(hours=8)))  # AWST
    out = {
        "generatedAt": now.isoformat(),
        "config": config,
        "rent": rent,
        "buy": buy,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    pets_n = sum(1 for r in rent if r.get("pets"))
    court_n = sum(1 for r in rent if r.get("courtyard"))
    insp_n = sum(1 for r in (rent + buy) if r.get("inspect"))
    print(f"rent={len(rent)} buy={len(buy)} furnished_dropped={len(furn)} "
          f"pets={pets_n} courtyard={court_n} with_inspection={insp_n}")


if __name__ == "__main__":
    main()
