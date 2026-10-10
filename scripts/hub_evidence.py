"""Evidence for data/hub_airlines.json (the curated main airline of each of the 100 Major hubs). Run by hand, never by the app:
    python scripts/hub_evidence.py        -> scripts/.cache/hub_evidence.json
For every Major hub (tier 1 in data/airports.json) it fetches
  - the airport's Wikidata item and its airline-hub relations (P113 "airline hub", with each airline's dissolved date P576),
  - the airport's current English Wikipedia article: the sentences that mention hub / focus city / base / largest, and the airlines in its
    "Airlines and destinations" table ranked by the number of destinations listed (a proxy for scheduled service, current to the article).
The curation (which airline is the MAIN one, dominant or not, confidence) is a human decision recorded in data/hub_airlines.json."""
import json, re, sys, time, urllib.parse, urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "airport-guesser-build/1.4 (https://github.com/PinkFrosties/airport-guesser)"}


def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            time.sleep(2 + 2 * i)
            err = e
    raise err


def main():
    hubs = [a for a in json.load(open(ROOT / "data/airports.json", encoding="utf-8"))["airports"] if a["tier"] == 1]
    out = {}
    titles = {a["iata"]: urllib.parse.unquote(a.get("wp") or a["name"].replace(" ", "_")) for a in hubs}
    # QIDs via Wikipedia page props (redirects followed)
    qid = {}
    for a in hubs:
        t = titles[a["iata"]]
        j = get("https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageprops|info&inprop=url&ppprop=wikibase_item&titles=" + urllib.parse.quote(t))
        page = next(iter(j["query"]["pages"].values()))
        qid[a["iata"]] = (page.get("pageprops") or {}).get("wikibase_item")
        out[a["iata"]] = {"icao": a["icao"], "name": a["name"], "wikipedia": page.get("fullurl"), "qid": qid[a["iata"]], "hubOf": [], "table": [], "sentences": []}
    # Wikidata hub relations
    ids = " ".join("wd:" + q for q in qid.values() if q)
    q = """SELECT ?ap ?al ?alLabel ?end WHERE { VALUES ?ap { %s } ?al wdt:P113 ?ap . OPTIONAL { ?al wdt:P576 ?end } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }""" % ids
    j = get("https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(q))
    by_q = {}
    for b in j["results"]["bindings"]:
        by_q.setdefault(b["ap"]["value"].rsplit("/", 1)[1], []).append({"airline": b["alLabel"]["value"], "wikidata": b["al"]["value"], "dissolved": b.get("end", {}).get("value", "")[:10] or None})
    for iata, e in out.items():
        e["hubOf"] = by_q.get(e["qid"], [])
    # Wikipedia article text
    for iata, e in out.items():
        t = urllib.parse.unquote(e["wikipedia"].rsplit("/wiki/", 1)[1])
        j = get("https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=" + urllib.parse.quote(t))
        wt = j["parse"]["wikitext"]["*"]
        e["wikipedia"] = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(j["parse"]["title"].replace(" ", "_"))
        plain = re.sub(r"<ref[^>]*?/>|<ref[^>]*?>.*?</ref>", "", wt, flags=re.S)
        plain = re.sub(r"\{\{[^{}]*\}\}", "", plain); plain = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", plain)
        for s in re.split(r"(?<=[.!?])\s+", plain):
            if re.search(r"\b(hub|focus city|base for|main base|largest (?:airline|carrier)|primary carrier|home (?:airport|base)|dominant)\b", s, re.I) and len(s) < 420:
                e["sentences"].append(re.sub(r"\s+", " ", s.strip())[:300])
            if len(e["sentences"]) >= 6:
                break
        # the "Airlines and destinations" table: airline link at the start of a row, destinations until the next row
        sec = re.split(r"==\s*Airlines and destinations\s*==", wt, maxsplit=1)
        cnt = Counter()
        if len(sec) > 1:
            body = re.split(r"\n==[^=]", sec[1], maxsplit=1)[0]
            rows = re.split(r"\n\|-|\n\|\s*(?=\[\[)", body)
            for m in re.finditer(r"\n\|\s*\[\[(?:[^|\]]*\|)?([^\]]+)\]\](.*?)(?=\n\|\s*\[\[|\n\|\}|\n\{\{|\Z)", body, flags=re.S):
                cnt[m.group(1).strip()] += len(re.findall(r"\[\[", m.group(2)))
        e["table"] = cnt.most_common(8)
        print(iata, e["qid"], len(e["hubOf"]), e["table"][:3], flush=True)
    (ROOT / "scripts/.cache/hub_evidence.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
