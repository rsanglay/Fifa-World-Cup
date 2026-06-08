"""Fetch player headshot URL + real birth year for every squad player.

Writes data/players_meta.json:
  { "<player name>": { "photo": "<url|>", "age": <int|null> } }

Both come from one Wikipedia REST summary call per player (the `extract` text
usually starts "... (born 29 June 2003) is ..."). Players without a page get
{"photo": "", "age": null} recorded so the app falls back to an initials avatar
+ modelled age, and we don't re-query them. Safe to re-run; --force re-queries.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"
SQUADS = DATA / "squads.json"
OUT = DATA / "players_meta.json"
UA = "wc2026-predictor/1.0 (educational project)"
REST = "https://en.wikipedia.org/api/rest_v1/page/summary/"
SEASON_YEAR = 2026  # tournament year, for age

_BORN = re.compile(r"born\s+(?:\d{1,2}\s+\w+\s+)?(\d{4})")
_DESC_YEAR = re.compile(r"\(born\s+(\d{4})\)")


def _fetch(title: str) -> dict | None:
    url = REST + urllib.parse.quote(title.replace(" ", "_"), safe="")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.load(resp)
    except Exception:
        return None


def _parse(data: dict) -> tuple[str, int | None]:
    if not data or data.get("type") == "disambiguation":
        return "", None
    photo = (data.get("thumbnail") or {}).get("source") or ""
    if photo:
        photo = photo.replace("/330px-", "/500px-")
    age = None
    # The cleaned summary strips the birth date from `extract`, but the short
    # `description` ("English footballer (born 2003)") usually keeps it.
    m = (_DESC_YEAR.search(data.get("description", "") or "")
         or _BORN.search(data.get("extract", "") or ""))
    if m:
        year = int(m.group(1))
        if 1975 <= year <= 2012:
            age = SEASON_YEAR - year
    return photo, age


def resolve(name: str) -> dict:
    for variant in (name, f"{name} (footballer)", f"{name} (soccer)"):
        data = _fetch(variant)
        if data:
            photo, age = _parse(data)
            if photo or age is not None:
                return {"photo": photo, "age": age}
        time.sleep(0.05)
    return {"photo": "", "age": None}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    squads = json.loads(SQUADS.read_text())
    names, seen = [], set()
    for players in squads.values():
        for p in players:
            if p["name"] not in seen:
                seen.add(p["name"])
                names.append(p["name"])
    if args.limit:
        names = names[: args.limit]

    out: dict = {}
    if OUT.exists():
        out = json.loads(OUT.read_text())

    total = len(names)
    for i, name in enumerate(names, 1):
        if not args.force and name in out:
            continue
        out[name] = resolve(name)
        if i % 25 == 0 or i == total:
            OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
            photos = sum(1 for v in out.values() if v.get("photo"))
            ages = sum(1 for v in out.values() if v.get("age"))
            print(f"[{i}/{total}] {photos} photos, {ages} ages", flush=True)

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    photos = sum(1 for n in names if out.get(n, {}).get("photo"))
    ages = sum(1 for n in names if out.get(n, {}).get("age"))
    print(f"DONE: {photos}/{total} photos ({100*photos//max(1,total)}%), "
          f"{ages}/{total} real ages.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
