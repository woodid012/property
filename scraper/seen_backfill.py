#!/usr/bin/env python3
"""seen_backfill.py — reconstruct a first-seen date per listing from git history.

Walks every past commit of data/listings.json (oldest -> newest) and records, for
each listing id, the date of the FIRST commit it appeared in. Writes the result to
scraper/_seen.json ({ "<id>": "YYYY-MM-DD" }). build_listings.py then keeps this map
up to date (new ids get today's date) and stamps each row with `dateAdded`.

Run once to seed history; safe to re-run (only fills gaps, never moves a date later).
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEEN = ROOT / "scraper" / "_seen.json"
REL = "data/listings.json"


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args],
                          capture_output=True, text=True, encoding="utf-8").stdout


def ids_at(commit):
    raw = git("show", f"{commit}:{REL}")
    if not raw.strip():
        return []
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        return []
    out = []
    for kind in ("rent", "buy"):
        for r in d.get(kind, []):
            k = r.get("id") or r.get("url")
            if k is not None:
                out.append(str(k))
    return out


def main():
    # oldest -> newest: "%H %cI" then reverse
    lines = git("log", "--format=%H %cI", "--", REL).strip().splitlines()
    commits = [ln.split(" ", 1) for ln in lines][::-1]  # reverse to oldest-first

    seen = {}
    if SEEN.exists():
        seen = json.loads(SEEN.read_text(encoding="utf-8"))

    added = 0
    for h, iso in commits:
        day = iso[:10]  # YYYY-MM-DD
        for k in ids_at(h):
            if k not in seen:
                seen[k] = day
                added += 1

    SEEN.write_text(json.dumps(seen, ensure_ascii=False, indent=0, sort_keys=True),
                    encoding="utf-8")
    by_day = {}
    for day in seen.values():
        by_day[day] = by_day.get(day, 0) + 1
    print(f"_seen.json now has {len(seen)} ids ({added} new). By first-seen day:")
    for day in sorted(by_day):
        print(f"  {day}: {by_day[day]}")


if __name__ == "__main__":
    main()
