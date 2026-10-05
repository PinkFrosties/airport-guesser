#!/usr/bin/env python3
"""Fetch the world's busiest airports by total passengers and write data/top50.json.

Source: Wikipedia, "List of busiest airports by passenger traffic". The page compiles the annual figures of Airports
Council International (ACI World) and publishes the top 50 for each year. The latest "<year> statistics" table is used.
(Neither Wikipedia nor ACI's free pages publish a top 100.)

Usage:  python scripts/fetch_top_airports.py
"""
import html
import json
import os
import re
import sys
import urllib.request
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "top50.json")
PAGE = "List_of_busiest_airports_by_passenger_traffic"
API = "https://en.wikipedia.org/w/api.php?action=parse&page=%s&prop=text&format=json&formatversion=2" % PAGE
PAGE_URL = "https://en.wikipedia.org/wiki/" + PAGE
ACI_URL = "https://aci.aero/resources/busiest-airports-in-the-world/"


def clean(cell):
    cell = re.sub(r"<sup[\s\S]*?</sup>", "", cell)
    cell = re.sub(r"<style[\s\S]*?</style>", "", cell)
    cell = re.sub(r"<[^>]+>", "", cell)
    return re.sub(r"\s+", " ", html.unescape(cell).replace("\xa0", " ")).strip()


def main():
    req = urllib.request.Request(API, headers={"User-Agent": "airport-guesser-build/1.0 (https://github.com/PinkFrosties/airport-guesser)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = json.load(r)["parse"]["text"]
    sections = [(int(m.group(1)), m.start()) for m in re.finditer(r'id="(\d{4})_statistics"', text)]
    year, pos = max(sections)  # latest year with a table
    table = re.search(r"<table[\s\S]*?</table>", text[pos:]).group(0)
    rows = [[clean(c) for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", tr)] for tr in re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", table)]
    header, body = rows[0], rows[1:]
    assert header[0] == "Rank" and "Airport" in header[1], header
    airports = []
    for r in body:
        rank = int(r[0].rstrip("."))
        iata, icao = r[4].split("/")
        airports.append({
            "rank": rank,
            "iata": iata.strip(),
            "icao": icao.strip(),
            "name": r[1],
            "city": r[2].split(",")[0].strip(),
            "country": r[3],
            "passengers": int(r[5].replace(",", "")),
            "year": year,
            "sourceUrl": PAGE_URL,
        })
    assert [a["rank"] for a in airports] == list(range(1, len(airports) + 1)), "ranks are not 1..N"
    assert len({a["iata"] for a in airports}) == len(airports), "duplicate IATA codes"
    data = {
        "source": "ACI World annual passenger traffic, as compiled on Wikipedia (List of busiest airports by passenger traffic)",
        "sourceUrl": PAGE_URL,
        "aciUrl": ACI_URL,
        "year": year,
        "retrieved": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "note": "The source publishes the top 50 only.",
        "count": len(airports),
        "airports": airports,
    }
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("wrote %s: %d airports, year %d" % (OUT, len(airports), year))


if __name__ == "__main__":
    sys.exit(main())
