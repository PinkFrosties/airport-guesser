#!/usr/bin/env python3
"""Find and validate the Wikipedia article of every airport in data/*.json (build time only; the app never contacts Wikipedia).

Sources, in order:
  1. OurAirports `wikipedia_link` (airports.csv): used when it passes validation.
  2. Wikidata (CC0): the English Wikipedia sitelink of the airport item found by its ICAO / FAA / IATA code.
  3. Neither: the app builds a Wikipedia *search* link from the airport's name (never a guessed article URL).

Validation of every candidate link:
  - https, host *.wikipedia.org, a /wiki/<Title> path (or an index.php?title=<Title> permalink); anything else is rejected
  - the page exists, is not a disambiguation page, and, if it is a redirect, the target is checked instead
  - the page's Wikidata item is an airport / aerodrome / air base / heliport (so a link to a city or a person is rejected)

Output: scripts/.cache/wp_links.json  {id: {"wp": "Title" | "lang|Title", "src": "ourairports"|"wikidata"}} plus
        qa/wikipedia-report.json (counts and every rejected link with the reason). build_data.py reads the cache.
Usage:  python scripts/wikipedia_links.py [--refresh]
"""
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
OUT = os.path.join(CACHE, "wp_links.json")
REPORT = os.path.join(ROOT, "qa", "wikipedia-report.json")
UA = "airport-guesser-build/1.0 (https://github.com/PinkFrosties/airport-guesser)"
AIRPORT_CLASSES = ["Q62447", "Q695850", "Q502074", "Q1248784"]  # aerodrome, airbase, heliport, airport


def get_json(url, retries=8, data=None):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:  # be polite: honour Retry-After on 429/503
            if i == retries - 1:
                raise
            wait = float(e.headers.get("Retry-After") or 0) or min(90, 5 * (2 ** i))
            print("  HTTP %d, waiting %.0fs" % (e.code, wait))
            time.sleep(wait)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def sparql(query):
    url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(query)
    return get_json(url)["results"]["bindings"]


def parse_link(link):
    """-> (lang, title) or (None, reason). Pure string handling, nothing is guessed."""
    link = link.strip()
    m = re.match(r"^(https?)://([a-z\-]+)(?:\.m)?\.wikipedia\.org(/.*)?$", link)
    if not m:
        return None, "not a wikipedia.org link"
    lang, rest = m.group(2), m.group(3) or ""
    parsed = urllib.parse.urlparse(link)
    if rest.startswith("/wiki/"):
        title = rest[len("/wiki/"):].split("#")[0]
    elif rest.startswith("/w/index.php"):
        q = urllib.parse.parse_qs(parsed.query)
        if "title" not in q:
            return None, "index.php link without a title"
        title = q["title"][0]
    else:
        return None, "not an article path"
    title = urllib.parse.unquote(title).replace(" ", "_").strip("_")
    if not title or ":" in title.split("_")[0] and title.split(":")[0].lower() in ("special", "file", "category", "template", "help", "wikipedia", "talk"):
        return None, "not an article title"
    return (lang, title), None


def main():
    refresh = "--refresh" in sys.argv
    airports = {}
    for f in ("airports.json", "airports-hard.json"):
        for a in json.load(open(os.path.join(ROOT, "data", f), encoding="utf-8"))["airports"]:
            airports[a["id"]] = a
    csv_rows = {}
    with open(os.path.join(CACHE, "airports.csv"), encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            if int(r["id"]) in airports:
                csv_rows[int(r["id"])] = r
    print("airports:", len(airports))

    result, rejected = {}, []
    # ---- 1. OurAirports links
    cand = {}
    stats = Counter()
    for i, r in csv_rows.items():
        link = r["wikipedia_link"].strip()
        if not link:
            stats["no_link"] += 1
            continue
        stats["has_link"] += 1
        if link.startswith("http://"):
            stats["http_upgraded"] += 1
        parsed, why = parse_link(link)
        if not parsed:
            rejected.append({"id": i, "name": airports[i]["name"], "link": link, "reason": why})
            continue
        cand[i] = parsed
    print("candidates from OurAirports:", len(cand), "of", stats["has_link"], "links;", len(rejected), "rejected by form")

    # ---- resolve titles through the MediaWiki API (redirects, missing pages, disambiguation) and get the Wikidata item
    by_lang = defaultdict(set)
    for lang, title in cand.values():
        by_lang[lang].add(title)
    resolved = {}  # (lang, original title) -> {"title":..., "item":..., "missing":bool, "disambig":bool, "redirected":bool}

    def resolve_batch(args):
        lang, titles = args
        q = urllib.parse.urlencode({"action": "query", "format": "json", "formatversion": "2", "redirects": "1", "prop": "pageprops",
                                    "ppprop": "wikibase_item|disambiguation", "titles": "|".join(t.replace("_", " ") for t in titles)})
        j = get_json("https://%s.wikipedia.org/w/api.php?%s" % (lang, q))["query"]
        norm = {n["from"]: n["to"] for n in j.get("normalized", [])}
        redir = {r["from"]: r["to"] for r in j.get("redirects", [])}
        pages = {p["title"]: p for p in j.get("pages", [])}
        out = {}
        for t in titles:
            t1 = t.replace("_", " ")
            t2 = norm.get(t1, t1)
            t3 = redir.get(t2, t2)
            p = pages.get(t3, {})
            pp = p.get("pageprops", {})
            out[(lang, t)] = {"title": t3.replace(" ", "_"), "item": pp.get("wikibase_item"), "missing": bool(p.get("missing") or p.get("invalid") or not p),
                              "disambig": "disambiguation" in pp, "redirected": t3 != t2}
        return out

    RES_CACHE = os.path.join(CACHE, "wp_resolved.json")
    cache = {}
    if os.path.exists(RES_CACHE) and not refresh:
        cache = {tuple(k.split("\t")): v for k, v in json.load(open(RES_CACHE, encoding="utf-8")).items()}
    jobs = []
    for lang, ts in by_lang.items():
        todo = sorted(t for t in ts if (lang, t) not in cache)
        jobs += [(lang, todo[k:k + 50]) for k in range(0, len(todo), 50)]
    resolved.update({k: v for k, v in cache.items() if k in {(l, t) for l, t in cand.values()}})
    t0 = time.time()
    for n_done, job in enumerate(jobs, 1):  # sequential on purpose: Wikimedia asks bots to keep the request rate low
        out = resolve_batch(job)
        resolved.update(out)
        cache.update(out)
        if n_done % 20 == 0 or n_done == len(jobs):
            with open(RES_CACHE, "w", encoding="utf-8") as f:
                json.dump({"\t".join(k): v for k, v in cache.items()}, f, ensure_ascii=False)
            print("  resolved batches %d/%d" % (n_done, len(jobs)))
        time.sleep(0.4)
    print("resolved %d titles, %d requests this run (%.0fs)" % (len(resolved), len(jobs), time.time() - t0))

    # ---- is the Wikidata item an airport?
    items = sorted({v["item"] for v in resolved.values() if v["item"]})
    airportish = set()
    cls = " ".join("wd:" + c for c in AIRPORT_CLASSES)
    for k in range(0, len(items), 150):
        batch = items[k:k + 150]
        rows = sparql("SELECT DISTINCT ?item WHERE { VALUES ?item { %s } ?item wdt:P31/wdt:P279* ?c . VALUES ?c { %s } }" % (" ".join("wd:" + q for q in batch), cls))
        airportish.update(r["item"]["value"].rsplit("/", 1)[1] for r in rows)
        time.sleep(0.5)
    print("airport-type items:", len(airportish), "of", len(items))

    for i, (lang, title) in cand.items():
        info = resolved[(lang, title)]
        reason = None
        if info["missing"]:
            reason = "page does not exist"
        elif info["disambig"]:
            reason = "disambiguation page"
        elif not info["item"]:
            reason = "page has no Wikidata item (cannot confirm it is an airport)"
        elif info["item"] not in airportish:
            reason = "article is not about an airport (Wikidata type check)"
        if reason:
            rejected.append({"id": i, "name": airports[i]["name"], "link": "https://%s.wikipedia.org/wiki/%s" % (lang, title), "reason": reason})
            continue
        final = info["title"]
        stats["redirect_followed"] += 1 if info["redirected"] else 0
        result[i] = {"wp": final if lang == "en" else "%s|%s" % (lang, final), "src": "ourairports"}

    # ---- 2. Wikidata fallback for airports without an accepted link: find the item by its codes, take its English article
    missing = [i for i in airports if i not in result]
    print("direct links accepted: %d | need fallback: %d" % (len(result), len(missing)))
    keys = {"P239": defaultdict(list), "P240": defaultdict(list), "P238": defaultdict(list)}
    for i in missing:
        a, r = airports[i], csv_rows.get(i, {})
        if len(a["icao"]) == 4 and re.match(r"^[A-Z]{4}$", a["icao"]):
            keys["P239"][a["icao"]].append(i)
        for code in {r.get("ident", ""), r.get("local_code", "")}:
            if code and re.match(r"^[A-Z0-9]{3,5}$", code):
                keys["P240"][code].append(i)
        if a["iata"]:
            keys["P238"][a["iata"]].append(i)
    found = defaultdict(dict)  # airport id -> {item: (title, set of matching props)}
    for prop, table in keys.items():
        codes = sorted(table)
        for k in range(0, len(codes), 120):
            batch = codes[k:k + 120]
            q = ("SELECT DISTINCT ?code ?item ?title WHERE { VALUES ?code { %s } ?item wdt:%s ?code . ?item wdt:P31/wdt:P279* ?c . VALUES ?c { %s } "
                 "?art schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title . }") % (" ".join('"%s"' % c for c in batch), prop, cls)
            for row in sparql(q):
                code, item, title = row["code"]["value"], row["item"]["value"].rsplit("/", 1)[1], row["title"]["value"]
                for i in table[code]:
                    found[i].setdefault(item, [title, set()])[1].add(prop)
            time.sleep(0.5)
    via_wikidata = 0
    ambiguous = []
    for i in missing:
        c = found.get(i)
        if not c:
            continue
        # prefer an item matched by the most identifiers; skip when two different items tie (never guess)
        ranked = sorted(c.items(), key=lambda kv: -len(kv[1][1]))
        if len(ranked) > 1 and len(ranked[0][1][1]) == len(ranked[1][1][1]):
            ambiguous.append({"id": i, "name": airports[i]["name"], "candidates": [kv[1][0] for kv in ranked[:3]]})
            continue
        result[i] = {"wp": ranked[0][1][0].replace(" ", "_"), "src": "wikidata"}
        via_wikidata += 1

    os.makedirs(CACHE, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    n = len(airports)
    direct = sum(1 for v in result.values() if v["src"] == "ourairports")
    report = {
        "airports": n,
        "ourairports_link_present": stats["has_link"], "ourairports_link_missing": stats["no_link"],
        "direct_accepted": direct, "redirects_followed_to_airport_article": stats["redirect_followed"], "http_links_upgraded_to_https": stats["http_upgraded"],
        "rejected_direct_links": len(rejected), "wikidata_fallback": via_wikidata, "wikidata_ambiguous_skipped": len(ambiguous),
        "search_fallback": n - len(result), "no_link_at_all": 0,
        "rejected_by_reason": dict(Counter(r["reason"] for r in rejected)),
        "rejected": rejected, "ambiguous": ambiguous,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k not in ("rejected", "ambiguous")}, indent=1))


if __name__ == "__main__":
    main()
