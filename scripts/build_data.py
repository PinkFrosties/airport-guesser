#!/usr/bin/env python3
"""Build data/airports.json for Airport Guesser.

Sources (downloaded and cached in scripts/.cache/):
  * OurAirports airports.csv, countries.csv, runways.csv  (public domain)
      https://davidmegginson.github.io/ourairports-data/
  * OpenFlights routes.dat  (ODbL) - used ONLY as a traffic proxy for the Easy tier

Filter: IATA code present, scheduled_service == yes, type large_airport or
medium_airport, not closed.

Tier (difficulty):
  1 = "top"  : the 100 large airports with the most routes in OpenFlights
               (routes departing from + arriving at the airport). Route count is
               a connectivity-based proxy for traffic: no free dataset has
               current passenger numbers with global coverage, but the busiest
               hubs are also the best connected. -> Easy
  2 = remaining large airports (tier 1 + 2 together = Medium)
  3 = medium airports with scheduled service -> Hard

Per-airport view box: "view": [centre lat, centre lon, width m, height m] is the bounding box of the
runway endpoints (falls back to runway length around the reference point, then to a size by type).
The client picks the zoom that fits it to ~75% of the viewport. "rw" is the number of open runways.

Two files are written:
  data/airports.json       Daily pool: the airports above (tiers 1-3).
  data/airports-hard.json  Hard pool: every other open large/medium/small airport that has runway data and
                           an IATA code, ICAO code or Wikipedia page (tier 4). Also searchable in Hard mode.

Usage:  python scripts/build_data.py [--refresh]
"""
import csv
import io
import json
import math
import os
import sys
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
OUT = os.path.join(ROOT, "data", "airports.json")
OUT_HARD = os.path.join(ROOT, "data", "airports-hard.json")
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"
ROUTES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat"
TOP_N = 100


def fetch(url, name, refresh):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if refresh or not os.path.exists(path):
        print("downloading", url)
        req = urllib.request.Request(url, headers={"User-Agent": "airport-guesser-build"})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fit_zoom(extent_m, lat, px):
    """Largest integer zoom at which extent_m spans <= px pixels."""
    if extent_m <= 0:
        return 99
    mpp0 = 156543.03392 * math.cos(math.radians(lat))
    return math.floor(math.log2(px * mpp0 / extent_m))


def main():
    refresh = "--refresh" in sys.argv
    airports_csv = fetch(OURAIRPORTS + "airports.csv", "airports.csv", refresh)
    countries_csv = fetch(OURAIRPORTS + "countries.csv", "countries.csv", refresh)
    runways_csv = fetch(OURAIRPORTS + "runways.csv", "runways.csv", refresh)
    try:
        routes_dat = fetch(ROUTES_URL, "routes.dat", refresh)
    except Exception as e:  # proxy unavailable -> degrade, don't fail
        print("WARNING: routes.dat unavailable (%s); Easy tier will use large-airport order" % e)
        routes_dat = ""

    countries = {r["code"]: r["name"] for r in csv.DictReader(io.StringIO(countries_csv))}

    kept = []
    for r in csv.DictReader(io.StringIO(airports_csv)):
        if r["type"] not in ("large_airport", "medium_airport"):
            continue
        if r["scheduled_service"] != "yes" or not r["iata_code"].strip():
            continue
        try:
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        except ValueError:
            continue
        kept.append({
            "id": int(r["id"]),
            "name": r["name"].strip(),
            "iata": r["iata_code"].strip().upper(),
            "icao": (r["icao_code"] or r["ident"]).strip().upper(),
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "country": countries.get(r["iso_country"], r["iso_country"]),
            "countryCode": r["iso_country"],
            "continent": r["continent"],
            "city": (r["municipality"] or "").strip(),
            "type": "large" if r["type"] == "large_airport" else "medium",
        })

    # unique IATA (prefer large, then lowest id)
    by_iata = {}
    for a in sorted(kept, key=lambda a: (a["type"] != "large", a["id"])):
        by_iata.setdefault(a["iata"], a)
    kept = sorted(by_iata.values(), key=lambda a: a["id"])

    # ---- tier via route-count proxy
    routes = Counter()
    for line in routes_dat.splitlines():
        f = next(csv.reader([line]), [])
        if len(f) >= 5:
            routes[f[2]] += 1
            routes[f[4]] += 1
    large = [a for a in kept if a["type"] == "large"]
    ranked = sorted(large, key=lambda a: (-routes[a["iata"]], a["id"]))
    top_ids = {a["id"] for a in ranked[:TOP_N]}
    for a in kept:
        a["tier"] = 1 if a["id"] in top_ids else (2 if a["type"] == "large" else 3)

    # ---- runway data: count, and the airfield's bounding box
    runways = defaultdict(list)
    for r in csv.DictReader(io.StringIO(runways_csv)):
        if r["closed"] == "1":
            continue
        runways[int(r["airport_ref"])].append(r)

    def airfield(a):
        """(runway_count, [clat, clon, width_m, height_m]) or None when there is no usable runway data."""
        rws = runways.get(a["id"])
        if not rws:
            return None
        pts = []
        for r in rws:
            ends = []
            for la, lo in (("le_latitude_deg", "le_longitude_deg"), ("he_latitude_deg", "he_longitude_deg")):
                try:
                    ends.append((float(r[la]), float(r[lo])))
                except ValueError:
                    pass
            pts.extend(ends)
            if not ends:  # no coordinates: assume the runway is centred on the reference point
                try:
                    half = float(r["length_ft"]) * 0.3048 / 2
                except ValueError:
                    continue
                dlat = half / 110574
                dlon = half / (111320 * max(0.2, math.cos(math.radians(a["lat"]))))
                pts.extend([(a["lat"] + dlat, a["lon"]), (a["lat"] - dlat, a["lon"]),
                            (a["lat"], a["lon"] + dlon), (a["lat"], a["lon"] - dlon)])
        # drop obviously wrong coordinates (swapped, 0/0, ...): nothing real is >12 km from the reference point
        pts = [p for p in pts if haversine_m(a["lat"], a["lon"], p[0], p[1]) <= 12000]
        if not pts:
            return None
        pts.append((a["lat"], a["lon"]))
        lat_min, lat_max = min(p[0] for p in pts), max(p[0] for p in pts)
        lon_min, lon_max = min(p[1] for p in pts), max(p[1] for p in pts)
        clat, clon = (lat_min + lat_max) / 2, (lon_min + lon_max) / 2
        w = (lon_max - lon_min) * 111320 * math.cos(math.radians(clat))
        h = (lat_max - lat_min) * 110574
        return len(rws), [round(clat, 5), round(clon, 5), int(round(w)), int(round(h))]

    FALLBACK_M = {"large": 4000, "medium": 2000, "small": 1000}
    for a in kept:
        info = airfield(a)
        if info:
            a["rw"], a["view"] = info
        else:
            a["rw"] = 0
            m = FALLBACK_M[a["type"]]
            a["view"] = [a["lat"], a["lon"], m, m]

    # ---- hard pool: everything else that is a real airfield with runway data and is identifiable
    kept_ids = {a["id"] for a in kept}
    hard = []
    for r in csv.DictReader(io.StringIO(airports_csv)):
        if r["type"] not in ("large_airport", "medium_airport", "small_airport"):
            continue
        aid = int(r["id"])
        if aid in kept_ids:
            continue
        if not (r["iata_code"].strip() or r["icao_code"].strip() or r["wikipedia_link"].strip()):
            continue
        try:
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        except ValueError:
            continue
        a = {
            "id": aid,
            "name": r["name"].strip(),
            "iata": r["iata_code"].strip().upper(),
            "icao": (r["icao_code"] or r["ident"]).strip().upper(),
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "country": countries.get(r["iso_country"], r["iso_country"]),
            "countryCode": r["iso_country"],
            "continent": r["continent"],
            "city": (r["municipality"] or "").strip(),
            "type": r["type"].replace("_airport", ""),
            "tier": 4,
        }
        info = airfield(a)
        if not info:
            continue
        a["rw"], a["view"] = info
        hard.append(a)
    hard.sort(key=lambda a: a["id"])

    def dump(path, items, source):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"source": source, "airports": items}, f, ensure_ascii=False, separators=(",", ":"))
        print("wrote %s: %d airports, %d bytes" % (path, len(items), os.path.getsize(path)))

    dump(OUT, kept, "OurAirports (public domain); tier proxy: OpenFlights route counts")
    dump(OUT_HARD, hard, "OurAirports (public domain)")
    n = Counter(a["tier"] for a in kept)
    print("daily tiers: tier1=%d tier2=%d tier3=%d" % (n[1], n[2], n[3]))
    print("top 10 by routes:", [a["iata"] for a in ranked[:10]])


if __name__ == "__main__":
    main()
