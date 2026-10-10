#!/usr/bin/env python3
"""Build the third hint ("hint3") of every airport. Build time only: the app never contacts any of these sources.

hint3 is one of (chosen per airport, first that applies):
  airline  the airport's MAIN AIRLINE (the app charges 2 attempts for it), accepted only when confident:
             1. Wikidata (CC0) airline-hub relations (property P113, current hubs of airlines that still exist);
                the only hub airline of the airport is accepted; with several, the one with at least 1.5x the OpenFlights
                routes of the second is accepted, a tie is not
             2. otherwise OpenFlights routes (non-codeshare routes departing the airport): the airline with at least 1.5x the
                routes of the second, if the airport has at least 10 routes and the airline is active in OpenFlights
  region   the state / province / department name (the app shows "<region>, <country>") from OurAirports iso_region + regions.csv
  grid     position in the country (north-west ... south-east, centre), for countries with at least 5 airports in the data
  elev     elevation band ("below 100 m", "100-500 m", "500-1,500 m", "above 1,500 m")
Stored as "type|value" in data/*.json by build_data.py. Output: scripts/.cache/hint3.json and qa/hint3-report.json.
Usage: python scripts/hint_data.py [--refresh]
"""
import csv
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
OUT = os.path.join(CACHE, "hint3.json")
REPORT = os.path.join(ROOT, "qa", "hint3-report.json")
UA = "airport-guesser-build/1.0 (https://github.com/PinkFrosties/airport-guesser)"
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"
OPENFLIGHTS = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/"
MARGIN = 2.0          # the main airline needs this many times the routes of the runner-up (v1.3.6: was 1.5)
MIN_ROUTES = 10       # OpenFlights fallback: the airport needs at least this many routes
MIN_GRID_AIRPORTS = 5
# Top-50 airports whose "main airline" the sources get wrong (OpenFlights routes are from 2014, Wikidata hub links are partial):
# no airline hint is offered there; the region is used instead. Reviewed by hand, reason per airport.
SUPPRESS_AIRLINE = {
    "ICN": "Asiana (Wikidata hub, 2014 routes) is being merged into Korean Air, which is the larger carrier",
    "MCO": "JetBlue is a Wikidata 'focus city' entry; Southwest is larger",
    "LAS": "Allegiant is a Wikidata hub entry; Southwest is larger",
    "BCN": "Ryanair from 2014 routes; Vueling is larger today",
    "DEL": "Air India from 2014 routes; IndiGo is larger today",
    "BOM": "Air India from 2014 routes; IndiGo is larger today",
    "CGK": "Garuda from 2014 routes; the Lion Air group is larger today",
}
refresh = "--refresh" in sys.argv


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if refresh or not os.path.exists(path):
        print("downloading", url)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def sparql(name, query):
    path = os.path.join(CACHE, name)
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(query)
    for i in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
            with urllib.request.urlopen(req, timeout=170) as r:
                rows = json.load(r)["results"]["bindings"]
            with open(path, "w", encoding="utf-8") as f:
                json.dump(rows, f)
            return rows
        except Exception as e:
            print("  wikidata attempt %d failed: %s" % (i + 1, str(e)[:100]))
            time.sleep(10 * (i + 1))
    raise SystemExit("Wikidata query failed")


# ---------- names ----------
LEGAL = re.compile(r"[ ,]+(co\.?(,?\s*ltd\.?)?|ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|s\.a\.?|sa|ag|gmbh|plc|pty\.?( ltd\.?)?|jsc|pjsc|ojsc|b\.v\.|n\.v\.|s\.p\.a\.?|a/s|asa|ab|oy|corp\.?|corporation|company)$", re.I)


COMMON = {"lion mentari airlines": "Lion Air", "aeroflot russian airlines": "Aeroflot", "leeward islands air transport": "LIAT", "spicejet": "SpiceJet", "condor flugdienst": "Condor",
          "sunexpress": "SunExpress", "aerolinea del estado mexicano": "Mexicana", "lineas aereas del estado": "LADE"}


def common_name(name):
    n = re.sub(r"\s*\([^)]*\)", "", name).strip()   # drop "(Priv)", "(7I/INC)" ...
    if norm(n) in {norm(k) for k in COMMON}:
        return {norm(k): v for k, v in COMMON.items()}[norm(n)]
    for _ in range(4):
        m = LEGAL.search(n)
        if not m:
            break
        n = n[:m.start()].strip(" ,")
    return n


SPECIAL = str.maketrans({"ı": "i", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss", "æ": "ae", "œ": "oe", "ħ": "h"})


def fold(s):
    return unicodedata.normalize("NFKD", s.translate(SPECIAL)).encode("ascii", "ignore").decode()


def norm(s):
    s = fold(s)
    return re.sub(r"[^a-z0-9]", "", s.lower())


# words that say nothing about WHICH place a name is (a region "Taoyuan City" and a city "Taoyuan" share "taoyuan")
GENERIC = {"city", "province", "state", "region", "prefecture", "county", "district", "municipality", "metropolitan", "governorate", "autonomous", "capital",
           "territory", "department", "community", "of", "the", "de", "new", "san", "santa", "saint", "st", "north", "south", "east", "west", "port", "fort", "lake", "mount", "great", "greater"}


def words(s):
    s = fold(s).lower()
    return {w for w in re.findall(r"[a-z0-9]+", s) if w not in GENERIC and len(w) > 2}


# regions that ARE one city (city-states, capital municipalities): the name of the region names the airport's city
CITY_REGIONS = {norm(x) for x in (
    "Berlin", "Hamburg", "Bremen", "Wien", "Vienna", "Madrid", "Brussels", "Bruxelles", "Hong Kong", "Macau", "Macao", "Singapore", "Monaco", "Vatican City",
    "Gibraltar", "Delhi", "Shanghai", "Beijing", "Tianjin", "Chongqing", "Moscow", "Saint Petersburg", "Sevastopol", "Seoul", "Busan", "Daegu", "Incheon", "Daejeon", "Gwangju",
    "Ulsan", "Sejong", "Tokyo", "Osaka", "Kyoto", "Taipei", "Kuala Lumpur", "Putrajaya", "Labuan", "Bangkok", "Jakarta", "Istanbul", "Ankara", "Paris", "Cairo", "Tehran", "Baghdad",
    "Kabul", "Kinshasa", "Brazzaville", "Lagos", "Abuja", "Nairobi", "Addis Ababa", "Dubai", "Abu Dhabi", "Kuwait", "Doha", "Manama", "Muscat", "Riyadh", "Mexico City", "Lima", "Santiago",
    "Buenos Aires", "Bogota", "Caracas", "Quito", "La Paz", "Montevideo", "Havana", "Panama City", "Guatemala City", "San Jose")}

def main():
    data = {}
    for fn in ("airports.json", "airports-hard.json"):
        with open(os.path.join(ROOT, "data", fn), encoding="utf-8") as f:
            for a in json.load(f)["airports"]:
                data[a["id"]] = a
    print("%d airports in data" % len(data))

    airports_csv = {int(r["id"]): r for r in csv.DictReader(io.StringIO(fetch(OURAIRPORTS + "airports.csv", "airports.csv")))}
    regions = {r["code"]: r["name"] for r in csv.DictReader(io.StringIO(fetch(OURAIRPORTS + "regions.csv", "regions.csv")))}
    countries = {r["code"]: r["name"] for r in csv.DictReader(io.StringIO(fetch(OURAIRPORTS + "countries.csv", "countries.csv")))}

    # ---------- OpenFlights: airlines (active flag) and routes ----------
    airlines = {}  # id -> dict
    by_iata, by_icao = {}, {}
    for row in csv.reader(io.StringIO(fetch(OPENFLIGHTS + "airlines.dat", "airlines.dat"))):
        if len(row) < 8:
            continue
        aid = row[0]
        a = {"id": aid, "name": row[1], "iata": row[3] if row[3] not in ("", "\\N", "-", "N/A") else "", "icao": row[4] if row[4] not in ("", "\\N", "N/A") else "", "active": row[7] == "Y"}
        airlines[aid] = a
        if a["iata"] and (a["iata"] not in by_iata or a["active"]):
            by_iata[a["iata"]] = a
        if a["icao"] and (a["icao"] not in by_icao or a["active"]):
            by_icao[a["icao"]] = a
    routes = defaultdict(Counter)  # airport IATA -> airline id -> routes departing (non-codeshare)
    for row in csv.reader(io.StringIO(fetch(OPENFLIGHTS + "routes.dat", "routes.dat"))):
        if len(row) < 8 or row[6] == "Y":
            continue
        aid = row[1] if row[1] not in ("", "\\N") else None
        if not aid:
            al = by_iata.get(row[0]) or by_icao.get(row[0])
            aid = al["id"] if al else None
        if aid and row[2] and row[2] != "\\N":
            routes[row[2]][aid] += 1

    # ---------- Wikidata: current airline hubs ----------
    q = """
SELECT ?airline ?airlineLabel ?aiata ?aicao ?apt ?ficao ?fiata WHERE {
  ?airline p:P113 ?st . ?st ps:P113 ?apt .
  FILTER NOT EXISTS { ?st pq:P582 ?end }
  ?airline wdt:P31 wd:Q46970 .
  FILTER NOT EXISTS { ?airline wdt:P576 ?dissolved }
  OPTIONAL { ?airline wdt:P229 ?aiata } OPTIONAL { ?airline wdt:P230 ?aicao }
  OPTIONAL { ?apt wdt:P239 ?ficao } OPTIONAL { ?apt wdt:P238 ?fiata }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}"""
    rows = sparql("wd_airline_hubs.json", q)
    hubs_by_icao, hubs_by_iata = defaultdict(dict), defaultdict(dict)
    for r in rows:
        v = lambda k: r.get(k, {}).get("value", "")
        qid = v("airline").rsplit("/", 1)[-1]
        item = {"qid": qid, "name": v("airlineLabel"), "iata": v("aiata"), "icao": v("aicao")}
        if re.fullmatch(r"Q\d+", item["name"] or ""):
            continue  # no English label
        if v("ficao"):
            hubs_by_icao[v("ficao")][qid] = item
        if v("fiata"):
            hubs_by_iata[v("fiata")][qid] = item
    print("wikidata: %d hub statements, %d airports by ICAO, %d by IATA" % (len(rows), len(hubs_by_icao), len(hubs_by_iata)))

    # airlines Wikidata knows to be dissolved (merged, bankrupt): OpenFlights (2014) still lists many as active
    qd = """
SELECT ?airlineLabel ?aiata WHERE {
  ?airline wdt:P31 wd:Q46970 ; wdt:P576 ?d .
  FILTER (?d < NOW())
  OPTIONAL { ?airline wdt:P229 ?aiata }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}"""
    dissolved_names = set()
    for r in sparql("wd_airlines_dissolved.json", qd):
        nm = r.get("airlineLabel", {}).get("value", "")
        if nm and not re.fullmatch(r"Qd+", nm):
            dissolved_names.add(norm(nm))
    print("wikidata: %d dissolved airlines" % len(dissolved_names))
    still_flying = lambda al: al["active"] and norm(al["name"]) not in dissolved_names

    def of_airline(item):  # the OpenFlights record of a Wikidata airline (by IATA, then ICAO, then name)
        for key, idx in ((item["iata"], by_iata), (item["icao"], by_icao)):
            if key and key in idx:
                return idx[key]
        return None

    # ---------- region / grid / elevation helpers ----------
    cc_points = defaultdict(list)
    for a in data.values():
        cc_points[a["countryCode"]].append(a)

    def spans(cc):
        pts = cc_points[cc]
        lons = [p["lon"] for p in pts]
        wrap = min(lons) < -150 and max(lons) > 150  # a country across the antimeridian (US, Russia, Fiji, NZ ...)
        xs = sorted((p["lon"] % 360) if wrap else p["lon"] for p in pts)
        ys = sorted(p["lat"] for p in pts)
        lo, hi = int(len(pts) * 0.08), int(len(pts) * 0.92) - 1
        return wrap, (xs[lo], xs[max(lo, hi)]), (ys[lo], ys[max(lo, hi)])
    span_cache = {}

    def grid(a):
        cc = a["countryCode"]
        if len(cc_points[cc]) < MIN_GRID_AIRPORTS:
            return None
        if cc not in span_cache:
            span_cache[cc] = spans(cc)
        wrap, (x0, x1), (y0, y1) = span_cache[cc]
        if x1 - x0 < 0.5 and y1 - y0 < 0.5:
            return None
        x = (a["lon"] % 360) if wrap else a["lon"]
        fx = 0.5 if x1 == x0 else (x - x0) / (x1 - x0)
        fy = 0.5 if y1 == y0 else (a["lat"] - y0) / (y1 - y0)
        col = "west" if fx < 1 / 3 else ("east" if fx > 2 / 3 else "")
        row = "south" if fy < 1 / 3 else ("north" if fy > 2 / 3 else "")
        return "-".join(p for p in (row, col) if p) or "centre"

    def band(ft):
        try:
            m = float(ft) * 0.3048
        except ValueError:
            return None
        return "below 100 m" if m < 100 else "100-500 m" if m < 500 else "500-1,500 m" if m < 1500 else "above 1,500 m"

    def region(a, src):
        code = src["iso_region"]
        name = regions.get(code, "")
        country = a["country"]
        m = re.match(r"^(.*?)\s*\((.*)\)$", name)  # "Delhi (National Capital Territory)" -> "Delhi"; Korean "X-Gwangyeoksi (Y City)" -> "Y City"
        if m:
            name = m.group(2) if re.search(r"gwangyeoksi|teukbyeolsi|teukbyeoljachisi", m.group(1), re.I) else m.group(1)
        full = regions.get(code, "")
        if not name or re.search(r"unassigned|unknown|not applicable|\(?no region\)?", name, re.I):
            return None
        if norm(name) == norm(country) or norm(name) in norm(country) or norm(country) in norm(name):
            return None
        # the region must not give the airport away: no municipality / city-state / capital territory ...
        if re.search(r"municipality|metropolitan|capital|federal district|special administrative|autonomous city|city of|district of columbia|\bcity$", full, re.I):
            return None
        if norm(name) in CITY_REGIONS:
            return None
        # ... and nothing that contains the airport's own city (Madrid, New York, Beijing Municipality, ...)
        city = (a.get("city") or "")
        if city and (words(name) & words(city) or norm(name) == norm(city)):
            return None
        return name  # the app shows "<region>, <country>"

    # ---------- decide ----------
    out, why, report_rows = {}, Counter(), []
    for aid, a in data.items():
        src = airports_csv.get(aid)
        icao = (a.get("icao") or "").strip()
        iata = (a.get("iata") or "").strip()
        cand = {}
        for k, idx in ((icao, hubs_by_icao), (iata, hubs_by_iata)):
            for qid, item in idx.get(k, {}).items():
                cand[qid] = item
        rc = routes.get(iata, Counter()) if iata else Counter()
        total = sum(rc.values())
        choice, source = None, None
        if iata and iata in os.environ.get('HINT_DEBUG', '').split(','):
            print('DEBUG', iata, [(i['name'], i['iata'], (of_airline(i) or {}).get('id'), rc.get((of_airline(i) or {}).get('id'), 0)) for i in cand.values()], 'top routes:', [(airlines[i]['name'], airlines[i]['active'], n) for i, n in rc.most_common(5) if i in airlines])
        # the leading airline by OpenFlights routes (still flying only)
        flying = [(n, airlines[i]) for i, n in rc.most_common() if i in airlines and still_flying(airlines[i])]
        leader = flying[0] if flying else None
        runner = flying[1][0] if len(flying) > 1 else 0
        # MAIN AIRLINE: only where ONE carrier is clearly dominant. With route data (10+ routes) the carrier with at least MARGIN x the
        # routes of the runner-up; the Wikidata hub link only decides where there is too little route data to say.
        hub_by_id = defaultdict(list)  # Wikidata names of the carriers that are the same OpenFlights airline
        for item in cand.values():
            of = of_airline(item)
            if of:
                hub_by_id[of["id"]].append(item["name"])
        raw_top = [(n, airlines[i]) for i, n in rc.most_common(3) if i in airlines]
        # the biggest carrier in the (2014) routes may be gone (Alitalia, US Airways, Air Berlin): then nobody can be called dominant
        gone = [n for n, al in raw_top if not still_flying(al)]
        if total >= MIN_ROUTES and leader and leader[0] >= 3:
            if gone and gone[0] * 2 >= leader[0]:
                why["airline: the biggest carrier in the route data no longer exists"] += 1
            elif not runner or leader[0] >= MARGIN * runner:
                names = hub_by_id.get(leader[1]["id"], [])
                exact = [x for x in names if norm(x) == norm(leader[1]["name"])]
                choice, source = {"name": (exact[0] if exact else min(names, key=len) if names else leader[1]["name"])}, "openflights routes (clear leader)"
            else:
                why["airline: no dominant carrier (close race)"] += 1
        elif cand:
            names = {norm(i["name"]) for i in cand.values()}
            groups = {(of_airline(i) or {}).get("id") or "n:" + norm(i["name"]) for i in cand.values()}
            if len(groups) == 1:
                choice, source = {"name": min((i["name"] for i in cand.values()), key=len)}, "wikidata (only hub airline, little route data)"
            else:
                why["airline: several hub airlines, little route data"] += 1
        if choice and iata in SUPPRESS_AIRLINE and a.get("top"):
            why["airline suppressed by review (top 50)"] += 1
            choice = None
        if choice:
            name = common_name(choice["name"])
            if name and len(name) <= 40:
                out[aid] = "airline|" + name
                why["airline: " + source] += 1
                continue
        reg = region(a, src) if src else None
        if reg:
            out[aid] = "region|" + reg
            why["region"] += 1
            continue
        g = grid(a)
        if g:
            out[aid] = "grid|" + g
            why["grid"] += 1
            continue
        e = band(src["elevation_ft"]) if src else None
        if e:
            out[aid] = "elev|" + e
            why["elev"] += 1
            continue
        why["none"] += 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({str(k): v for k, v in out.items()}, f, ensure_ascii=False)

    # ---------- report: counts per pool, Top 50 list ----------
    def tally(items):
        c = Counter((out.get(a["id"], "none|").split("|")[0]) for a in items)
        return dict(c)
    allv = list(data.values())
    top = sorted([a for a in allv if a.get("top")], key=lambda a: a["top"])
    rep = {
        "airports": len(allv), "why": dict(why),
        "top50": tally(top), "hard_pool": tally([a for a in allv if not a.get("top")]),
        "practice": {"major_hubs": tally([a for a in allv if a.get("tier") == 1]), "large": tally([a for a in allv if a["type"] == "large"]), "mid_size": tally([a for a in allv if a["type"] == "medium"])},
        "top50_list": [{"rank": a["top"], "code": a["iata"], "name": a["name"], "country": a["country"], "hint3": out.get(a["id"])} for a in top],
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=1, ensure_ascii=False)
    print(json.dumps({k: rep[k] for k in ("airports", "why", "top50", "hard_pool", "practice")}, indent=1))
    for r in rep["top50_list"]:
        print(("%2d %-4s %-45s %-16s %s" % (r["rank"], r["code"], r["name"][:45], r["country"][:16], r["hint3"])).encode('ascii', 'replace').decode())


if __name__ == "__main__":
    main()
