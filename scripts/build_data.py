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

Per-airport zoom hints:
  z  = Leaflet zoom at which the whole airfield (farthest runway end from the
       reference point, plus margin) fits in ~300 px. Clamped 12..15; falls back
       to 13 (large) / 14 (medium) when runway coordinates are missing.
  cz = zoom at which the country (spread of its other kept airports around this
       one) roughly fits in ~320 px. Clamped 4..8.

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

    # ---- airfield zoom from runway end coordinates
    points = defaultdict(list)
    for r in csv.DictReader(io.StringIO(runways_csv)):
        if r["closed"] == "1":
            continue
        for la, lo in (("le_latitude_deg", "le_longitude_deg"), ("he_latitude_deg", "he_longitude_deg")):
            try:
                points[int(r["airport_ref"])].append((float(r[la]), float(r[lo])))
            except ValueError:
                pass
    for a in kept:
        pts = points.get(a["id"])
        if pts:
            radius = max(haversine_m(a["lat"], a["lon"], p[0], p[1]) for p in pts)
            z = fit_zoom(2 * radius * 1.3, a["lat"], 300)
            a["z"] = max(12, min(15, z))
        else:
            a["z"] = 13 if a["type"] == "large" else 14

    # ---- country zoom from spread of the country's other airports (ignore overseas outliers)
    by_cc = defaultdict(list)
    for a in kept:
        by_cc[a["countryCode"]].append(a)
    for a in kept:
        radius = 0
        for b in by_cc[a["countryCode"]]:
            d = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
            if d <= 2_500_000:
                radius = max(radius, d)
        z = fit_zoom(max(2 * radius * 1.15, 60_000), a["lat"], 320)
        a["cz"] = max(4, min(8, z))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump({
            "source": "OurAirports (public domain); tier proxy: OpenFlights route counts",
            "airports": kept,
        }, f, ensure_ascii=False, separators=(",", ":"))
    n = Counter(a["tier"] for a in kept)
    print("wrote %s: %d airports (tier1=%d tier2=%d tier3=%d), %d bytes" % (
        OUT, len(kept), n[1], n[2], n[3], os.path.getsize(OUT)))
    print("top 10 by routes:", [a["iata"] for a in ranked[:10]])


if __name__ == "__main__":
    main()
