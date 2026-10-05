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
| Daily | The 50 busiest airports worldwide by total passengers (ACI World, 2025) | Same airport for everyone each day; every airport once per cycle, then reshuffled; never the same airport twice within 30 days |
| Hard | All other airports: the rest of the international airports plus regional, small and remote airfields (12,770) | Own daily airport and own results |

Hard is a toggle next to the mode switch. Its daily is drawn from a different pool and it keeps its own saved game, streak and statistics. Autocomplete searches the full database (12,820 airports) in every mode. Practice (endless random airports) is also available; with Hard mode on it draws from the Hard pool.

## Features

- Light, Apple-inspired design, responsive on phone and desktop
- Zoom fitted per airport to its runway extent, capped at native tile resolution so images stay sharp
- Retina-sharp imagery: tiles are requested at the screen's pixel density (up to +1 level), never CSS-upscaled beyond that
- Fast loading: only the visible tiles, background preload of the zoom-out view, service-worker tile cache
- Desktop layout: image left, guess panel right
- Distance and direction feedback on every wrong guess
- Optional hints and one-time zoom-out, each costing a guess
- Light and dark themes, follows system setting with manual override
- Installable PWA that works offline (map tiles need a network)

## Changelog

Newest first. The top entry is the current version (`js/version.js`); `tests/changelog.mjs` enforces the order.

### v1.2.4 (daily load) - 2026-10-05
- The Daily's first image appears much sooner: today's airport comes from `data/daily.json` / an entry inlined in the HTML (built at deploy time), so the 180 KB airport list is no longer on the critical path; the first tile requests start from an inline script before any app JavaScript has downloaded (cold, Fast 4G: image at about 1.0 s, was 1.3 s; Slow 4G: about 2.5 s, was 3.7 s; repeat visit: instant)
- Airport lists, Statistics, Help and About load after the first image (or on first use); a query typed before the lists arrive waits and then shows results
- Deploy now builds the site: one minified bundle with hashed names, inlined CSS, minified HTML; rebuilt daily so the schedule stays current
- Service worker: small install-time precache (the big lists are not precached), stale-while-revalidate for pages and data so an update never causes a blank wait, tile cache fed with the first image's tiles
- The Daily now follows the player's local calendar date (midnight rollover switches the tab to the new day without a reload); tiles come 3:1 from the faster Esri host

### v1.2.3 (zoom fit) - 2026-10-05
- The airfield is now fitted on its runway endpoints with a 6% margin on every edge, never under the corner chips or the attribution pill, and a hard maximum fill of 78%; the zoom always rounds down (wider), so long diagonal runways no longer touch or leave the frame
- One zoom per airport for everyone (`z` in the data: the smaller of the phone and desktop fits), so the Daily looks the same on every device; a frame smaller than the reference frames (for example with the keyboard open) only zooms out further
- The airfield is centred in the part of the frame the chips and the pill do not cover
- Pool filter keeps its 45% minimum but now applies only where the imagery cap forces a wider view than the fit (Daily 3,230 to 3,228, Hard file 9,548 to 9,592)

### v1.2.2 (top 50 Daily) - 2026-10-05
- Daily now draws only from the busiest airports worldwide by total passengers (ACI World 2025 ranking, `data/top50.json`); every airport comes up once per cycle, the order is reshuffled each cycle, and no airport repeats within 30 days
- Hard pool is now every airport outside that list (12,728); autocomplete searches the full database in all modes
- Source and ranking year shown in About & credits. The free ranking sources publish only the top 50, so the pool is 50 airports, not 100

### v1.2.1 (credits) - 2026-10-05
- New "About & credits" screen (footer link): imagery, airport data, other data, open-source software, disclaimer, version
- Esri attribution always visible on the image in a translucent pill; the airfield is lifted slightly so the pill never covers it
- Footer on every screen: Created by Kevin Pahud, About & credits, version number, theme switch
- THIRD_PARTY_NOTICES.md and data/credits.json generated from the real dependencies

### v1.2.0 (system theme) - 2026-10-05
- Light and dark themes in the same Apple style; follows the OS setting live, with a System / Light / Dark switch in the footer (stored in localStorage)
- All colours are CSS variables (design tokens); the theme is applied before first paint, so there is no flash of the wrong theme
- `color-scheme: light dark` and a per-theme browser-bar colour; WCAG AA contrast verified in both themes (`tests/theme.mjs`)

### v1.1.2 (load speed) - 2026-10-05
- Image appears in about 0.6 s on Fast 4G (was 1.8-2.4 s), cold page load to image in about 1.2 s (was 4.3 s)
- Extra tile levels capped at +1 (16 tiles per view instead of 42-49); +2 gave slightly finer detail at 3x but tripled the load
- Only the frame is loaded; tiles are plain cacheable GETs spread over two Esri hosts; preconnect and preloaded data
- The zoom-out view loads in the background, so Zoom out is an instant swap
- Loading skeleton with spinner and tiles-loaded progress; fade-in only when every tile is in
- Service worker caches map tiles (Cache API); a reload is instant and works offline for seen airports
- 10 s stall timeout, one automatic retry, then a tap-to-retry state

### v1.1.1 (image quality) - 2026-10-04
- Fixed blurry images on phones: tiles are now requested 1-2 levels deeper (by devicePixelRatio) and drawn at 256/2^n CSS px, so every device pixel is backed by a real pixel
- Whole-number zooms only (no CSS scaling of the tile layer); no stand-in tiles from other zoom levels; the image is revealed only after every tile of the view has loaded
- Per-airport native imagery level (`nz`) precomputed at build time; zoom never exceeds it
- Airports whose real imagery cannot show the airfield at 45% or more of the frame (on a reference phone at 3x) are removed from both pools

### v1.1.0 (v1.1 features) - 2026-10-04
- Light theme and Apple-style UI
- Tighter, per-airport locked zoom; removed all image interaction
- Zoom-out button (costs 1 guess) and hint system
- Daily restricted to international airports
- New Hard mode with a separate airport pool
- Desktop layout with guess panel on the right
- Credit footer

### v1.0 (initial release) - 2026-10-04
- Initial release

## Build and deploy

```bash
npm install
node scripts/build_site.mjs      # writes dist/: bundled + minified JS, inlined CSS, data/daily.json, sw.js
AG_ROOT=dist node scripts/serve.mjs 8080   # serve the built site (the tests accept AG_ROOT=dist too)
```

`.github/workflows/deploy.yml` runs the build on every push to `main` **and every day at 00:07 UTC** and publishes `dist/`. The daily rebuild keeps `data/daily.json` (the next 14 days of Daily and Hard airports) and the entry inlined in `index.html` current. If scheduled runs stop (GitHub pauses them after 60 days without repository activity) the app still works: for a date missing from the schedule it computes the airport from the full lists, just more slowly.

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
node tests/waterfall.mjs [label]    # cold/warm Daily load waterfall on throttled Fast/Slow 4G (qa/perf/)
node tests/unit.game.mjs         # pools, zoom fitting, hints/attempts, share text, stats, data integrity
node tests/credits.mjs           # footer, attribution never covering the airfield, About & credits
node tests/theme.mjs             # light/dark, live OS switching, no-flash, WCAG AA contrast, QA screenshots
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

- `data/top50.json`: the Daily ranking. `python scripts/fetch_top_airports.py` fetches the latest "<year> statistics" table of Wikipedia's [List of busiest airports by passenger traffic](https://en.wikipedia.org/wiki/List_of_busiest_airports_by_passenger_traffic) (ACI World annual figures; the top 50 only) with rank, IATA, ICAO, name, city, country, passengers, year and source URL. `build_data.py` matches every entry to the dataset by IATA and ICAO, requires it to pass the image-quality filter (the build stops instead of dropping anything), and flags it with `top` (the rank).
- `data/airports.json` (3,228 international airports, 50 of them flagged `top` = the **Daily pool**; the other 3,178 join the Hard pool): [OurAirports](https://davidmegginson.github.io/ourairports-data/) large and medium airports with an IATA code and scheduled service, not closed.
- `data/airports-hard.json` (9,592 airports, the rest of the **Hard pool** with the 3,178 above): every other open large, medium or small airport that has runway data and an IATA code, ICAO code or Wikipedia page. In Hard mode autocomplete searches both files.
- **Per-airport view box and zoom.** `view` is `[lat, lon, width m, height m]`: the bounding box of the runway endpoints, which is exactly the condition for "every endpoint inside the frame" whatever the runway angle. `z` is the airport's whole-number zoom for everyone: the largest zoom at which that box stays inside the frame minus a 6% margin, below the top corner chips and above the attribution pill, and fills at most 78% of the frame, rounded down; it is the smaller of the phone (358x371) and desktop (604x585) fits. `rw` is the number of open runways (for the hint).
- **Native resolution (`nz`).** At build time the Esri `tilemap` service is probed for each airport: `nz` is the deepest tile level at which a 7x7 block of tiles around the airfield is real imagery (not the grey "map data not yet available" placeholder). Results are cached in `scripts/.cache/native_zoom.json`; `--refresh-zoom` re-probes and `--verify` spot-checks the tilemap against real tile downloads.
- **Sharp rendering.** Tiles are requested `n` levels deeper than the map zoom (n = 0 for devicePixelRatio 1, otherwise 1; +2 was dropped in v1.1.2 for load speed) and drawn at 256/2^n CSS px. The map zoom is a whole number, and the zoom used is `min(fit-to-airfield zoom, nz - n)`: a smaller airport in the frame beats a blurry upscale.
- **Quality filter.** Both pools drop airports where the imagery cap (native resolution minus the worst-case retina levels) forces a view wider than the airport's fitted zoom and the airfield would then fill less than 45% of the reference 358x371 phone frame (Daily 3,244 to 3,228, Hard 9,765 to 9,592). Airports whose fitted zoom is not capped are never dropped for being small in the frame. The filter is device-independent so everyone gets the same Daily.
- **Practice sets.** OurAirports has no passenger numbers, so "Top 100" is ranked by a connectivity proxy: route counts in [OpenFlights](https://github.com/jpatokal/openflights) `routes.dat` (ODbL). "Large" is all large airports, "Mid-size" is medium airports.

## Performance

```bash
node tests/perf.mjs [label]        # 390px, DPR 3, Fast 4G (9 Mbit/s, 170 ms RTT): requests, KB and time-to-reveal
node tests/quality-compare.mjs     # +1 vs +2 tile levels at DPR 3: requests, KB, sharpness score, side-by-side shots
```

Results are written to `qa/`. Esri serves tiles over HTTP/1.1, so tiles alternate between `server.` and `services.arcgisonline.com` to double the parallel connections.

## Imagery provider

All provider settings live in one object, `IMAGERY` in `js/config.js` (tile URL template, attribution, zoom limits, optional tilemap URL). Default is Esri World Imagery, which has no labels. Esri's terms require visible attribution (included in the map) and may require an account or key for heavy or commercial use; check them before promoting the site widely.

## Credits & data sources

Mirrors **About & credits** in the app (footer link). Only what the code actually uses is listed.

- **Created by** Kevin Pahud.
- **Imagery:** [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9), used under Esri's terms ([Master Agreement](https://www.esri.com/en-us/legal/terms/full-master-agreement)). Attribution shown on every image: "Tiles © Esri, Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community" (Vantor was formerly Maxar; this is the wording Esri's service currently publishes).
- **Airport data:** [OurAirports](https://ourairports.com/data/), public domain, no warranty. Fields used: name, IATA and ICAO codes, latitude and longitude, country, municipality, continent, airport type, runway count and end coordinates. The retrieval date is stored in `data/*.json` (`meta.ourairports_retrieved`) and shown in the app.
- **Ranking:** the Daily list is the world's 50 busiest airports by total passengers, ACI World annual figures for 2025 as compiled on [Wikipedia](https://en.wikipedia.org/wiki/List_of_busiest_airports_by_passenger_traffic) (retrieved 2026-10-05; see `data/top50.json`). [ACI World](https://aci.aero/resources/busiest-airports-in-the-world/) publishes the original figures. The source lists the top 50 only.
- **Other data:** country names (OurAirports countries table) and continent codes (OurAirports airport records). The Practice "Top 100" set is ordered by route counts from [OpenFlights](https://github.com/jpatokal/openflights) (ODbL), used only at build time.
- **Open-source software:** [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2-Clause), vendored in `vendor/leaflet`. No framework, no build step. Full list and licence text: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), generated by `node scripts/gen_notices.mjs`.
- **Fonts and icons:** no fonts are bundled (system font stack); the app icon is original artwork generated by `scripts/make_icons.mjs`.
- **Disclaimer:** not affiliated with or endorsed by any airport, airline, or data and imagery provider. Imagery may be outdated.

This repository has no `LICENSE` file yet; add one if you want to state the terms for the app's own code.
