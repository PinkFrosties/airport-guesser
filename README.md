# Airport Guesser

**Play it: https://pinkfrosties.github.io/airport-guesser/**

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
- Retina-sharp imagery: tiles are requested at the screen's pixel density (up to +1 level), never CSS-upscaled beyond that
- Fast loading: only the visible tiles, background preload of the zoom-out view, service-worker tile cache
- Desktop layout: image left, guess panel right
- Distance and direction feedback on every wrong guess
- Optional hints and one-time zoom-out, each costing a guess
- Installable PWA that works offline (map tiles need a network)

## Changelog

### v1.1.2 (load speed)
- Image appears in about 0.6 s on Fast 4G (was 1.8-2.4 s), cold page load to image in about 1.2 s (was 4.3 s)
- Extra tile levels capped at +1 (16 tiles per view instead of 42-49); +2 gave slightly finer detail at 3x but tripled the load
- Only the frame is loaded; tiles are plain cacheable GETs spread over two Esri hosts; preconnect and preloaded data
- The zoom-out view loads in the background, so Zoom out is an instant swap
- Loading skeleton with spinner and tiles-loaded progress; fade-in only when every tile is in
- Service worker caches map tiles (Cache API); a reload is instant and works offline for seen airports
- 10 s stall timeout, one automatic retry, then a tap-to-retry state

### v1.1.1 (image quality)
- Fixed blurry images on phones: tiles are now requested 1-2 levels deeper (by devicePixelRatio) and drawn at 256/2^n CSS px, so every device pixel is backed by a real pixel
- Whole-number zooms only (no CSS scaling of the tile layer); no stand-in tiles from other zoom levels; the image is revealed only after every tile of the view has loaded
- Per-airport native imagery level (`nz`) precomputed at build time; zoom never exceeds it
- Airports whose real imagery cannot show the airfield at 45% or more of the frame (on a reference phone at 3x) are removed from both pools

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

- `data/airports.json`, the **Daily pool** (3,230 airports): [OurAirports](https://davidmegginson.github.io/ourairports-data/) large and medium airports with an IATA code and scheduled service, not closed.
- `data/airports-hard.json`, the **Hard pool** (9,548 airports): every other open large, medium or small airport that has runway data and an IATA code, ICAO code or Wikipedia page. In Hard mode autocomplete searches both files.
- **Per-airport view box.** `view` is `[lat, lon, width m, height m]`: the bounding box of the runway endpoints (falling back to runway length around the reference point). The client picks the zoom at which that box fills about 75% of the actual image area, in half-level steps so tiles are never upscaled, and `rw` is the number of open runways (for the hint).
- **Native resolution (`nz`).** At build time the Esri `tilemap` service is probed for each airport: `nz` is the deepest tile level at which a 7x7 block of tiles around the airfield is real imagery (not the grey "map data not yet available" placeholder). Results are cached in `scripts/.cache/native_zoom.json`; `--refresh-zoom` re-probes and `--verify` spot-checks the tilemap against real tile downloads.
- **Sharp rendering.** Tiles are requested `n` levels deeper than the map zoom (n = 0 for devicePixelRatio 1, otherwise 1; +2 was dropped in v1.1.2 for load speed) and drawn at 256/2^n CSS px. The map zoom is a whole number, and the zoom used is `min(fit-to-airfield zoom, nz - n)`: a smaller airport in the frame beats a blurry upscale.
- **Quality filter.** Both pools drop airports where, on a reference 358x371 phone at devicePixelRatio 3, real imagery cannot show the airfield at 45% or more of the frame (Daily 3,244 to 3,230, Hard 9,765 to 9,548). The filter is device-independent so everyone gets the same Daily.
- **Practice sets.** OurAirports has no passenger numbers, so "Top 100" is ranked by a connectivity proxy: route counts in [OpenFlights](https://github.com/jpatokal/openflights) `routes.dat` (ODbL). "Large" is all large airports, "Mid-size" is medium airports.

## Performance

```bash
node tests/perf.mjs [label]        # 390px, DPR 3, Fast 4G (9 Mbit/s, 170 ms RTT): requests, KB and time-to-reveal
node tests/quality-compare.mjs     # +1 vs +2 tile levels at DPR 3: requests, KB, sharpness score, side-by-side shots
```

Results are written to `qa/`. Esri serves tiles over HTTP/1.1, so tiles alternate between `server.` and `services.arcgisonline.com` to double the parallel connections.

## Imagery provider

All provider settings live in one object, `IMAGERY` in `js/config.js` (tile URL template, attribution, zoom limits, optional tilemap URL). Default is Esri World Imagery, which has no labels. Esri's terms require visible attribution (included in the map) and may require an account or key for heavy or commercial use; check them before promoting the site widely.

## Credits

Satellite imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community.
Airport data: [OurAirports](https://ourairports.com/) (public domain). Route counts for the Top 100 set: OpenFlights. Map engine: [Leaflet](https://leafletjs.com/) (BSD-2, vendored).
Created by Kevin Pahud.
