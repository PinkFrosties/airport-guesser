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
import datetime
import io
import json
import math
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
OUT = os.path.join(ROOT, "data", "airports.json")
OUT_HARD = os.path.join(ROOT, "data", "airports-hard.json")
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"
ROUTES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat"
TOP_N = 100

# ---- image-quality model (keep in sync with js/core.js: fitZoom / fillAt / MIN_FILL / MAX_FILL)
TILEMAP_URL = "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/{z}/{y}/{x}/{w}/{h}?f=json"
TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
PLACEHOLDER_BYTES = 2521        # size of Esri's grey "Map data not yet available" tile
MPP0 = 156543.03392             # metres per pixel at zoom 0 on the equator
MIN_BOX_M = 150
FILL_TARGET, MAX_FILL, MIN_FILL = 0.75, 0.9, 0.45
REF_W, REF_H = 358, 371         # reference phone frame (CSS px)
REF_RETINA_LEVELS = 2           # worst case: devicePixelRatio 3-4 renders tiles two levels deeper than the map zoom
BLOCK = 7                       # tiles (7x7 around the view centre) that must all be real imagery at a level


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


def fill_at(a, w_px, h_px, z):
    clat, _, w, h = a["view"]
    k = 2 ** z / (MPP0 * math.cos(math.radians(clat)))
    return max(max(w, MIN_BOX_M) * k / w_px, max(h, MIN_BOX_M) * k / h_px)


def fit_zoom(a, w_px, h_px, min_zoom=8, max_zoom=19):
    """Integer zoom whose airfield box fills ~75% of the frame (rounded up when that stays <= 90%)."""
    clat, _, w, h = a["view"]
    ppm = min(FILL_TARGET * w_px / max(w, MIN_BOX_M), FILL_TARGET * h_px / max(h, MIN_BOX_M))
    zl = math.floor(math.log2(ppm * MPP0 * math.cos(math.radians(clat))))
    z = zl + 1 if fill_at(a, w_px, h_px, zl + 1) <= MAX_FILL else zl
    return max(min_zoom, min(max_zoom, z))


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    r = math.radians(lat)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    return min(n - 1, max(0, x)), min(n - 1, max(0, y))


def http_get(url, binary=False, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "airport-guesser-build"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            return data if binary else json.loads(data)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(0.5 * (i + 1))


def block_available(a, level):
    """True when every tile in a BLOCK x BLOCK window around the view centre exists at this level (not a placeholder)."""
    n = 2 ** level
    x, y = tile_xy(a["view"][0], a["view"][1], level)
    half = BLOCK // 2
    x0, x1, y0, y1 = max(0, x - half), min(n - 1, x + half), max(0, y - half), min(n - 1, y + half)
    url = TILEMAP_URL.format(z=level, y=y0, x=x0, w=x1 - x0 + 1, h=y1 - y0 + 1)
    return all(v == 1 for v in http_get(url)["data"])


def native_max_level(a):
    """Deepest tile level (<= 19) with real imagery around the airfield. Availability is monotonic in level."""
    lo, hi = 10, 19
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if block_available(a, mid):
            lo = mid
        else:
            hi = mid - 1
    return lo


def compute_native_levels(items, refresh):
    """id -> native max level, cached in scripts/.cache/native_zoom.json (keyed by id + view centre)."""
    path = os.path.join(CACHE, "native_zoom.json")
    cache = {}
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
    key = lambda a: "%d:%.4f,%.4f" % (a["id"], a["view"][0], a["view"][1])
    todo = [a for a in items if key(a) not in cache]
    if todo:
        print("probing Esri imagery for %d airports (cached: %d)..." % (len(todo), len(items) - len(todo)))
        t0 = time.time()
        with ThreadPoolExecutor(24) as ex:
            for a, nz in zip(todo, ex.map(native_max_level, todo)):
                cache[key(a)] = nz
        os.makedirs(CACHE, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        print("  done in %.0fs" % (time.time() - t0))
    return {a["id"]: cache[key(a)] for a in items}


def block_tiles(a, level):
    n = 2 ** level
    x, y = tile_xy(a["view"][0], a["view"][1], level)
    half = BLOCK // 2
    return [(xx, yy) for yy in range(max(0, y - half), min(n - 1, y + half) + 1) for xx in range(max(0, x - half), min(n - 1, x + half) + 1)]


def verify_tilemap(items, n=40):
    """Spot check against real tiles: at the native level every tile in the block is real imagery (not the 2521-byte
    grey placeholder); one level deeper (when tilemap says 'not available') at least one tile is the placeholder."""
    import random
    rnd = random.Random(1)
    sample = rnd.sample(items, min(n, len(items)))
    is_placeholder = lambda lvl, xy: len(http_get(TILE_URL.format(z=lvl, y=xy[1], x=xy[0]), binary=True)) == PLACEHOLDER_BYTES
    bad_native = bad_next = checked_next = 0
    for a in sample:
        if any(is_placeholder(a["nz"], xy) for xy in block_tiles(a, a["nz"])):
            bad_native += 1
        if a["nz"] < 19:
            checked_next += 1
            if not any(is_placeholder(a["nz"] + 1, xy) for xy in block_tiles(a, a["nz"] + 1)):
                bad_next += 1
    print("tilemap vs real tiles (%d airports): %d with a placeholder inside the 'available' block; %d of %d 'unavailable' blocks had no placeholder"
          % (len(sample), bad_native, bad_next, checked_next))


def quality_filter(items, label):
    """Drop airports whose real imagery cannot reach a frame fill of MIN_FILL on a reference phone at devicePixelRatio 3."""
    kept_items, dropped = [], Counter()
    for a in items:
        z_max = a["nz"] - REF_RETINA_LEVELS
        if z_max < 8:
            dropped["no usable imagery (tiles missing / placeholder)"] += 1
            continue
        z = min(fit_zoom(a, REF_W, REF_H), z_max)
        if fill_at(a, REF_W, REF_H, z) < MIN_FILL:
            dropped["imagery too coarse: airfield would fill < %d%% of the frame" % int(MIN_FILL * 100)] += 1
            continue
        kept_items.append(a)
    print("%s pool: %d -> %d airports (dropped %d)" % (label, len(items), len(kept_items), len(items) - len(kept_items)))
    for why, c in dropped.most_common():
        print("    %5d  %s" % (c, why))
    return kept_items, len(items), dict(dropped)


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

    def source_date(name):
        """UTC date the cached source file was downloaded (shown in About & credits)."""
        ts = os.path.getmtime(os.path.join(CACHE, name))
        return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")

    meta = {"ourairports_retrieved": source_date("airports.csv"), "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")}

    def dump(path, items, source):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"source": source, "meta": meta, "airports": items}, f, ensure_ascii=False, separators=(",", ":"))
        print("wrote %s: %d airports, %d bytes" % (path, len(items), os.path.getsize(path)))

    # ---- imagery quality: native max level per airport, then filter both pools
    refresh_zoom = "--refresh-zoom" in sys.argv
    nzs = compute_native_levels(kept + hard, refresh_zoom)
    for a in kept + hard:
        a["nz"] = nzs[a["id"]]
    if "--verify" in sys.argv:
        verify_tilemap(kept + hard)
    kept, n_daily_before, daily_dropped = quality_filter(kept, "Daily")
    hard, n_hard_before, hard_dropped = quality_filter(hard, "Hard")
    top_ids &= {a["id"] for a in kept}

    dump(OUT, kept, "OurAirports (public domain); tier proxy: OpenFlights route counts; nz = native Esri imagery level")
    dump(OUT_HARD, hard, "OurAirports (public domain); nz = native Esri imagery level")
    n = Counter(a["tier"] for a in kept)
    print("daily tiers: tier1=%d tier2=%d tier3=%d" % (n[1], n[2], n[3]))
    print("top 10 by routes:", [a["iata"] for a in ranked[:10]])


if __name__ == "__main__":
    main()
