# Airport Guesser

A static, backend-free guessing game for phone and desktop: you get a locked satellite image of one airport and five attempts to name it. Every miss shows the distance to the answer, a compass arrow pointing from your guess toward it, and a proximity percentage. There is one shared Daily airport per UTC date, a separate Hard mode, and endless Practice. It is vanilla JS + Leaflet, installable as a PWA, and keeps stats in `localStorage`.

## How to play

You get a locked satellite view of an airport. Name it in 5 guesses or fewer.

- Type the airport name; autocomplete suggests matches.
- Each wrong guess shows the distance and direction to the answer.
- The image is fixed: no panning or zooming.
- **Zoom out** (once per game): reveals a wider view, costs 1 guess.
- **Hints**: continent, country, first letter, number of runways. Each costs 1 guess.
- Zoom-outs and hints share the same 5 attempts as guesses.

## Game modes

| Mode | Airport pool | Notes |
|---|---|---|
| Daily | International airports only | Same airport for everyone each day |
| Hard | Other airports: regional, small, remote airfields | Own daily airport and own results |

Hard is a toggle next to the mode switch. Its daily is drawn from a different pool, autocomplete searches the full database, and it keeps its own saved game, streak and statistics. Practice (endless random airports) is also available; with Hard mode on it draws from the Hard pool.

## Features

- Light, Apple-inspired design, responsive on phone and desktop
- Zoom fitted per airport to its runway extent, capped at native tile resolution so images stay sharp
- Desktop layout: image left, guess panel right
- Distance and direction feedback on every wrong guess
- Optional hints and one-time zoom-out, each costing a guess
- Installable PWA that works offline (map tiles need a network)

## Changelog

### v1.1
- Light theme and Apple-style UI
- Tighter, per-airport locked zoom; removed all image interaction
- Zoom-out button (costs 1 guess) and hint system
- Daily restricted to international airports
- New Hard mode with a separate airport pool
- Desktop layout with guess panel on the right
- Credit footer

### v1.0
- Initial release

## Run locally

```bash
node scripts/serve.mjs 8080      # then open http://localhost:8080/
# or: python -m http.server 8080
```

Any static server works. A service worker only registers on `localhost` or HTTPS.

## Tests

```bash
npm install                      # dev-only: Playwright + the vendored Leaflet source
node tests/unit.mjs              # haversine, bearing, accent-insensitive search
node tests/unit.game.mjs         # pools, zoom fitting, hints/attempts, share text, stats, data integrity
node tests/e2e.mjs               # headless Playwright: phone 390x844 and desktop 1280x800 (needs network for Esri tiles)
```

The e2e script uses an installed Edge or Chrome if present, otherwise Playwright's Chromium (`npx playwright install chromium`). Screenshots land in `test-output/`.

## Deploy to GitHub Pages

1. Create a GitHub repository and add it as a remote: `git remote add origin <url>`.
2. `git push -u origin main`.
3. In the repository go to **Settings > Pages** and set **Source** to **GitHub Actions**.
4. `.github/workflows/deploy.yml` publishes the repository root on every push to `main`. All paths are relative, so it works under `https://<user>.github.io/<repo>/`. `.nojekyll` is included.

When you ship changes to cached files, bump `VERSION` in `sw.js` so installed copies refresh.

## Data

Both data files are generated and committed; the app never fetches OurAirports at runtime.

```bash
python scripts/build_data.py     # add --refresh to re-download sources
```

- `data/airports.json`, the **Daily pool** (3,244 airports): [OurAirports](https://davidmegginson.github.io/ourairports-data/) large and medium airports with an IATA code and scheduled service, not closed.
- `data/airports-hard.json`, the **Hard pool** (9,765 airports): every other open large, medium or small airport that has runway data and an IATA code, ICAO code or Wikipedia page. In Hard mode autocomplete searches both files.
- **Per-airport view box.** `view` is `[lat, lon, width m, height m]`: the bounding box of the runway endpoints (falling back to runway length around the reference point). The client picks the zoom at which that box fills about 75% of the actual image area, in half-level steps so tiles are never upscaled, and `rw` is the number of open runways (for the hint).
- **Native resolution cap.** Before a round starts, the Esri `tilemap` service is asked which tiles exist for the view. If tiles are missing at the fitted level (remote areas with lower-resolution imagery) the view steps down one tile level at a time, so the "map data not yet available" placeholder and blurry upscales never appear. A candidate whose sharp view would show the airfield under 20% of the frame is skipped; for the Daily this uses a deterministic fallback order.
- **Practice sets.** OurAirports has no passenger numbers, so "Top 100" is ranked by a connectivity proxy: route counts in [OpenFlights](https://github.com/jpatokal/openflights) `routes.dat` (ODbL). "Large" is all large airports, "Mid-size" is medium airports.

## Imagery provider

All provider settings live in one object, `IMAGERY` in `js/config.js` (tile URL template, attribution, zoom limits, optional tilemap URL). Default is Esri World Imagery, which has no labels. Esri's terms require visible attribution (included in the map) and may require an account or key for heavy or commercial use; check them before promoting the site widely.

## Credits

Satellite imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community.
Airport data: [OurAirports](https://ourairports.com/) (public domain). Route counts for the Top 100 set: OpenFlights. Map engine: [Leaflet](https://leafletjs.com/) (BSD-2, vendored).
Created by Kevin Pahud.
