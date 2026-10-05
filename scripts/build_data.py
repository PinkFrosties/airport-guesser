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
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

# Records that the source itself marks as closed, disused, duplicated or superseded: never offered as an answer.
JUNK_NAME = re.compile(r"\[(in-?active|closed|duplicate)\]|\((old|disused|former[^)]*)\)|^\(\*\)", re.I)

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
MARGIN, MAX_FILL, MIN_FILL = 0.06, 0.78, 0.45   # edge margin (share of the frame), hard max fill, pool-filter minimum fill
CHIPS_BOTTOM, GAP = 41, 6       # px: the top corner chips end 41 px below the frame top; clearance kept around chips and pill
REF_PHONE = (358, 371, 27)      # reference frames (CSS px) + attribution pill height: phone (390 px wide) ...
REF_DESKTOP = (604, 585, 18)    # ... and desktop (1280x800). One zoom per airport = the smaller (wider) of the two fits.
REF_W, REF_H = REF_PHONE[0], REF_PHONE[1]
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


def fill_at(a, w_px, h_px, z):
    clat, _, w, h = a["view"]
    k = 2 ** z / (MPP0 * math.cos(math.radians(clat)))
    return max(max(w, MIN_BOX_M) * k / w_px, max(h, MIN_BOX_M) * k / h_px)


def safe_rect(w_px, h_px, pill):
    """Part of the frame the airfield must stay inside: edge margin, below the top corner chips, above the pill."""
    return (MARGIN * w_px, max(MARGIN * h_px, CHIPS_BOTTOM + GAP), w_px - MARGIN * w_px, h_px - max(MARGIN * h_px, pill + GAP))


def fit_zoom(a, w_px, h_px, pill, min_zoom=8, max_zoom=19):
    """Largest WHOLE zoom at which every runway endpoint (the airfield box) lies inside the safe rect and the box fills at most
    MAX_FILL of the frame in each dimension. Always rounds down (wider)."""
    l, t, r, b = safe_rect(w_px, h_px, pill)
    clat, _, w, h = a["view"]
    ex, ey = max(w, MIN_BOX_M), max(h, MIN_BOX_M)
    ppm = min(min(MAX_FILL * w_px, r - l) / ex, min(MAX_FILL * h_px, b - t) / ey)
    z = math.floor(math.log2(ppm * MPP0 * math.cos(math.radians(clat))))
    return max(min_zoom, min(max_zoom, z))


def base_zoom(a):
    """The airport's zoom for everyone: the smaller of the phone and desktop fits (so the Daily looks the same on every device)."""
    return min(fit_zoom(a, *REF_PHONE), fit_zoom(a, *REF_DESKTOP))


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


def passes_quality(a):
    """Imagery must be able to show the airfield. The airport's zoom z is chosen by fit (rounded down, max 78% fill). Only when the
    native-resolution cap (nz minus the worst-case retina levels) forces a WIDER view than z does the airfield have to still
    fill MIN_FILL of the reference phone frame; otherwise the airport passes."""
    cap = a["nz"] - REF_RETINA_LEVELS
    if cap < 8:
        return False, "no usable imagery (nz %d)" % a["nz"]
    if a["z"] <= cap:
        return True, "fits at its zoom (%d <= %d)" % (a["z"], cap)
    fill = fill_at(a, REF_PHONE[0], REF_PHONE[1], cap)
    return (fill >= MIN_FILL), "capped by imagery (nz %d): airfield would fill %d%% of the frame" % (a["nz"], round(fill * 100))


def mark_top_airports(kept):
    """Read data/top50.json (scripts/fetch_top_airports.py) and flag those airports with `top` = passenger rank.
    Every listed airport must match the dataset by IATA + ICAO and pass the imagery quality filter; otherwise the
    build stops (nothing is dropped silently)."""
    path = os.path.join(ROOT, "data", "top50.json")
    with open(path, encoding="utf-8") as f:
        top = json.load(f)["airports"]
    by_iata = {a["iata"]: a for a in kept}
    missing, bad_icao, failing = [], [], []
    for t in top:
        a = by_iata.get(t["iata"])
        if not a:
            missing.append("%d %s/%s %s" % (t["rank"], t["iata"], t["icao"], t["name"]))
            continue
        if a["icao"] != t["icao"]:
            bad_icao.append("%d %s: ranking says %s, dataset has %s" % (t["rank"], t["iata"], t["icao"], a["icao"]))
        ok, why = passes_quality(a)
        if not ok:
            failing.append("%d %s %s: %s" % (t["rank"], t["iata"], a["name"], why))
        a["top"] = t["rank"]
    problems = [("not in the dataset", missing), ("ICAO mismatch", bad_icao), ("fails the image-quality filter", failing)]
    if any(v for _, v in problems):
        for label, v in problems:
            for line in v:
                print("TOP AIRPORT %s: %s" % (label, line))
        raise SystemExit("top-airport check failed: resolve the entries above (nothing was dropped silently)")
    print("top airports: %d matched by IATA+ICAO, all pass the quality filter" % len(top))


# Image visibility: scripts/image_contrast.mjs scores how visible the runway is in the imagery (median brightness difference
# between the runway line and its sides, 0..255; cache in scripts/.cache/contrast.json). Airports below CONTRAST_MIN show
# nothing a player could identify (bare fields, blank ice, haze) and are dropped. The Daily top 50 are never dropped.
CONTRAST_MIN = 3.0
try:
    with open(os.path.join(CACHE, "contrast.json"), encoding="utf-8") as _f:
        CONTRAST = {int(k): v for k, v in json.load(_f).items()}
except OSError:
    CONTRAST = {}
    print("WARNING: scripts/.cache/contrast.json missing (run node scripts/image_contrast.mjs); no visibility filter applied")


def quality_filter(items, label):
    """Drop airports whose real imagery cannot show the airfield (see passes_quality)."""
    kept_items, dropped = [], Counter()
    for a in items:
        ok, why = passes_quality(a)
        c = CONTRAST.get(a["id"])
        if ok and not a.get("top") and c is not None and 0 <= c < CONTRAST_MIN:
            dropped["runway not visible in the imagery (contrast < %g)" % CONTRAST_MIN] += 1
            continue
        if ok:
            kept_items.append(a)
        else:
            dropped["no usable imagery" if a["nz"] - REF_RETINA_LEVELS < 8 else "imagery too coarse: capped airfield would fill < %d%% of the frame" % int(MIN_FILL * 100)] += 1
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
        if JUNK_NAME.search(r["name"]):
            continue
        if r["scheduled_service"] != "yes" or not r["iata_code"].strip():
            continue
        try:
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        except ValueError:
            continue
        kept.append({
            "id": int(r["id"]),
            "name": " ".join(r["name"].split()),
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
        if JUNK_NAME.search(r["name"]):
            continue
        if not (r["iata_code"].strip() or r["icao_code"].strip() or r["wikipedia_link"].strip()):
            continue
        try:
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        except ValueError:
            continue
        a = {
            "id": aid,
            "name": " ".join(r["name"].split()),
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
        a["z"] = base_zoom(a)
    if "--verify" in sys.argv:
        verify_tilemap(kept + hard)
    # ---- Wikipedia article titles (scripts/wikipedia_links.py: validated at build time; the app builds the URL itself)
    wp_path = os.path.join(CACHE, "wp_links.json")
    if os.path.exists(wp_path):
        with open(wp_path, encoding="utf-8") as f:
            links = json.load(f)
        n_wp = Counter()
        for a in kept + hard:
            link = links.get(str(a["id"]))
            if link:
                a["wp"] = link["wp"]
                n_wp[link["src"]] += 1
        print("wikipedia titles attached: %s of %d airports (the rest use a Wikipedia search link in the app)" % (dict(n_wp), len(kept) + len(hard)))
    else:
        print("WARNING: scripts/.cache/wp_links.json missing (run scripts/wikipedia_links.py); no Wikipedia titles written")
    mark_top_airports(kept)
    missing_wp = [a["iata"] for a in kept if a.get("top") and not a.get("wp")]
    if missing_wp:
        raise SystemExit("top airports without a verified Wikipedia article: %s" % missing_wp)
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
