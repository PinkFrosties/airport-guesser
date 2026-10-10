# Airport Guesser

**Play it: https://pinkfrosties.github.io/airport-guesser/**

A static, backend-free guessing game for phone and desktop: you get a satellite image of one airport (zoom in as much as the real imagery allows, never wider than the start view) and five attempts to name it. Every miss shows the distance to the answer, a compass arrow pointing from your guess toward it, and a proximity percentage. There is one shared Daily airport per UTC date, a separate Hard mode, and endless Practice. It is vanilla JS + Leaflet, installable as a PWA, and keeps stats in `localStorage`.

## How to play

You get a satellite view of an airport. Name it in 5 guesses or fewer. Zooming in is free (pinch, mouse wheel, double-tap / double-click, + and -; drag while zoomed; 0, Esc or Reset view go back); you can never zoom out past the start view.

- Type the airport name; autocomplete suggests matches.
- Each wrong guess shows the distance and direction to the answer.
- The image is fixed: no panning or zooming.
- **Zoom out** (once per game): reveals a wider view, costs 1 guess.
- **Hints**: the country, the first letter of the name, or a third clue chosen per airport (the main airline, which costs **2 guesses**, where it is known with confidence; otherwise its region). The other hints cost 1 guess.
- Zoom-outs and hints share the same 5 attempts as guesses.

## Game modes

| Mode | Airport pool | Notes |
|---|---|---|
| Daily | The 50 busiest airports worldwide by total passengers (ACI World, 2025) | Same airport for everyone each day; every airport once per cycle, then reshuffled; never the same airport twice within 30 days |
| Hard | All other airports: the rest of the international airports plus regional, small and remote airfields (12,675) | Own daily airport and own results |

Hard is a toggle next to the mode switch. Its daily is drawn from a different pool and it keeps its own saved game, streak and statistics. Autocomplete searches the full database (12,820 airports) in every mode. Practice (endless random airports) is also available; with Hard mode on it draws from the Hard pool.

## Features

- Light, Apple-inspired design, responsive on phone and desktop
- Zoom fitted per airport to its runway extent, capped at native tile resolution so images stay sharp
- Retina-sharp imagery: tiles are requested at the screen's pixel density (up to +1 level), never CSS-upscaled beyond that
- Fast loading: only the visible tiles, background preload of the zoom-out view, service-worker tile cache
- Desktop layout: image left, guess panel right
- Interactive zoom-in from the start view: pinch, wheel / trackpad pinch, double tap, + - 0 Esc, drag to pan while zoomed (clamped to the start frame), never beyond the native imagery; retina-sharp tiles at every level
- Distance and direction feedback on every wrong guess
- Optional hints and one-time zoom-out, each costing a guess
- Light and dark themes, follows system setting with manual override
- Installable PWA that works offline (map tiles need a network)

## Changelog

Newest first. The top entry is the current version (`js/version.js`); `tests/changelog.mjs` enforces the order.

### v1.3.5 (version history, airline hint penalty) - 2026-10-10
- The page now ends with a **Version history**: every version from this changelog (newest open and marked current, older ones collapsed), generated from the README into `data/changelog.json`
- The main-airline hint (offered wherever the sources are confident, as before) now costs **2 attempts** (two pips, "Solved in 3 of 5" when it was bought and the airport guessed next, two bulbs in the share text); it is only offered while at least 3 attempts are left, so a guess is always left. Counts as in v1.3.3 (Top 50: 31 airline / 19 region)
- Hints bought in earlier versions keep the cost they had
- Tests: `tests/changelog.mjs` (history section, JSON in sync with the README), `tests/hints.mjs` and the unit tests (cost, affordability, share text)

### v1.3.4 (interactive zoom) - 2026-10-10
- The locked view is replaced by a view you can zoom IN from: pinch on touch, mouse wheel and trackpad pinch on desktop, double-tap / double-click for one step (again to reset), + and - on the keyboard, 0 or Esc to reset. Zooming is free and has no effect on guesses, hints or the Daily answer; the start view is identical for everyone
- Limits: never wider than the start view (or the wider Zoom out view once bought, which becomes the new start view), never deeper than the real imagery (at most 3 levels in, and never past the airport's native level); pan only while zoomed in, clamped so the view never leaves the start frame; one-finger swipes scroll the page normally at the start view and the wheel over the image never scrolls the page on desktop
- Reset: a "Reset view" chip appears only while zoomed in; resetting returns to exactly the start centre (checked to within 1 px) with a smooth animation (none with reduced motion); a screen-reader note says "Zoomed in. Press 0 to reset."
- Image quality: tiles are requested at the sharp level at every zoom (zoom + retina offset, never past native); scaled stand-in tiles exist only while a zoom is in progress, never for the first reveal; extra tiles stay within about one screen and go through the service-worker tile cache
- Typing a guess still never changes the view (also while zoomed in); the attribution pill, Reset chip and result card stay correct at every zoom level
- New `tests/zoominteract.mjs`; the old "locked view" end-to-end check now asserts that nothing pans the start view

### v1.3.3 (hints rework) - 2026-10-10
- Exactly three hints, each still costing 1 of the 5 attempts: **Country**, **Name starts with** (the first character of the name exactly as the suggestions show it, so it is not mistaken for the city), and a **third clue** chosen per airport at build time: the airport's **main airline** (name only, no logos), else its **region** ("Washington, United States"), else its part of the country ("North-west of Brazil"), else an elevation band. The menu names the kind of clue; the clue appears only after it is bought
- Continent and number of runways are gone (UI, saved state, data, tests, Help). A game saved by the previous version keeps the attempts it already spent on them
- The country hint is marked "Already shown" once a region or part-of-country clue is bought (it contains the country), so no clue is ever sold twice; an airline clue does not reveal the country
- Main airline comes from Wikidata (CC0) hub relations and OpenFlights (ODbL) routes, only when confident (one hub airline, or a leader with at least 1.5x the routes of the runner-up; at least 10 routes without a hub link; the airline must still exist); 7 Top-50 airports whose sources are out of date use the region instead. All fetched at build time, nothing at runtime; About, README and THIRD_PARTY_NOTICES updated
- Counts: Top 50: 31 airline, 19 region; Hard pool: 719 airline, 11,547 region, 373 part of country, 35 elevation, 1 none; the Hard pool is 12,675 airports
- New `tests/hints.mjs`

### v1.3.2 (direction arrow audit) - 2026-10-10
- Audited distance and direction end to end against an independent implementation (Turf, dev-only): over 5,025 random airport pairs the largest difference is 3e-11 km in distance and 2e-12 degrees in bearing; antimeridian, poles, antipodes and due N/S/E/W cases have expected-value tests. The maths was correct; the display had four faults, now fixed:
- Arrows no longer swing the long way round: a bearing of 350 degrees now turns 10 degrees anticlockwise instead of 350 clockwise
- Only the newest guess row animates its arrow; the older rows are simply drawn at their angle on every redraw (hint, zoom-out, extra guess, theme switch)
- Each row has a proper accessible name, for example "About 6,310 km to the north-west" (the old label sat on an element screen readers ignore)
- Airports less than 10 km apart (airports of one city, or two records at the same coordinates) now show a ring and "NEAR" ("Very close, about 4 km away") instead of an arrow pointing in a noisy direction
- New `tests/direction.mjs`

### v1.3.1 (typing zoom fix) - 2026-10-10
- Fixed: the satellite view zoomed out while typing a guess. Cause: opening the keyboard switched to the compact layout, which shrank the image frame, and the shrunk frame re-ran the zoom fit (zoom 13 became 11 in the Android test, and back when the keyboard closed). The map now keeps the exact size its view was fitted to and is only scaled down into the compact frame, so zoom and framing are identical before, during and after typing
- A re-fit now happens only when the width changes (rotation, window resize); height-only changes (keyboard, browser bar, window height) never refit, and the compact layout is used with touch only
- Viewport meta has `interactive-widget=resizes-visual` (Chrome on Android no longer resizes the page for the keyboard)
- New `tests/typing.mjs` and `tests/all.mjs` (runs every test script, one line each)

### v1.3.0 (text size, cleaner pools, hardening) - 2026-10-05
- Text follows the browser's text size: all type is in `rem`, so a larger default font size or zoom scales the whole app. The header, mode bar, dialogs and statistics reflow instead of overflowing (tested at 100/150/200% on 390 and 320 px wide screens). The chips and attribution on the satellite image keep fixed sizes because the airfield fit is measured against them
- Hard pool cleaned: records the source marks closed, disused, duplicated or superseded are never offered, and so are airports whose runway cannot be seen in the imagery (visibility filter, `scripts/image_contrast.mjs`; the Daily top 50 are never filtered). Pools: Daily 3,222, Hard 12,675. The Hard Daily is drawn from the new pool, so today's and tomorrow's Hard airport may differ from what the previous version showed; a game already started keeps its airport
- Practice "Top 100" is now called "Major hubs" (it is ranked by route counts, not passengers)
- Content-Security-Policy is on in the built site (inline scripts allowed by hash only, images and tiles only from Esri); `AG_CSP=0` builds without it
- The `window.__ag` test hook exists on localhost only, and `data/daily.json` now holds yesterday, today and tomorrow (it listed two weeks)
- The deploy workflow re-enables itself on every run so GitHub does not pause the daily rebuild after 60 days without repository activity
- Tests run on WebKit too (`AG_BROWSER=webkit`); new tests for text scaling and hardening

### v1.2.6 (audit fixes) - 2026-10-05
- Full audit: game logic, schedule, data, layout, failures, performance, accessibility, security
- Touch targets: the mode and theme switches and the About link now have a 44 px hit area (same look)
- A wrong guess can no longer show "0 km / 100%" when two airports share coordinates
- Airport names with doubled spaces cleaned up
- About states that map tile requests send the player's IP address to Esri (no accounts, analytics or cookies)
- Opt-in Content-Security-Policy build (`AG_CSP=1 node scripts/build_site.mjs`), tested with 0 violations, not enabled by default
- New tests: touch targets, wrong-guess floor, 5-year Daily schedule, local-date/DST handling (run in four time zones), hostile search input

### v1.2.5 (wikipedia link) - 2026-10-05
- The result card (win or lose; Daily, Hard and Practice) has a "Read about <airport> on Wikipedia" row with an external-link icon: new tab, `rel="noopener noreferrer"`, 48 px tall, both themes, long names wrap
- Nothing about the article exists before the round ends: no link, title or Wikipedia text in the DOM, alt text or hint area, and no prefetch; the previous round's result card is emptied when a new round starts
- Article titles are verified at build time (OurAirports link, then Wikidata, else a Wikipedia search link; never guessed); only the title is stored and the URL is built in code; the app makes no runtime request to Wikipedia
- About and README credit Wikipedia/Wikidata and state that the link leaves the app; THIRD_PARTY_NOTICES updated; new tests (`tests/wikipedia.mjs`, link rules in the unit tests)

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

`.github/workflows/deploy.yml` runs the build on every push to `main` **and every day at 00:07 UTC** and publishes `dist/`. A first step re-enables the workflow through the API so GitHub's 60-day inactivity pause cannot stop the schedule. The daily rebuild keeps `data/daily.json` (yesterday, today and tomorrow) and the entry inlined in `index.html` current. If scheduled runs stop (GitHub pauses them after 60 days without repository activity) the app still works: for a date missing from the schedule it computes the airport from the full lists, just more slowly.

The built site carries a Content-Security-Policy `<meta>` (scripts by hash, `img-src`/`connect-src` limited to the app and Esri's two tile hosts; `AG_CSP=0 node scripts/build_site.mjs` leaves it out). If the imagery provider changes, update the hosts in `scripts/build_site.mjs`.

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
node tests/direction.mjs         # distance and bearing vs Turf, edge cases, the rendered arrow, label and spoken text
node tests/zoominteract.mjs       # pinch, wheel, double tap, keys, pan clamp, reset exactness, native cap, typing while zoomed
node tests/hints.mjs             # three hints: spend, no double spend, last attempt, reload, nothing leaks before purchase
node tests/typing.mjs            # typing, keyboard open/close and rotation never change zoom or framing
node tests/all.mjs               # every script, one line each (--dist, --webkit)
node tests/textscale.mjs         # text follows the browser font size, no overflow at 150/200% on narrow screens
node tests/hardening.mjs         # debug hook only on localhost; CSP blocks injected scripts (AG_ROOT=dist for the CSP checks)
node tests/targets.mjs           # every control has a 44 px touch target
node tests/wikipedia.mjs         # Wikipedia link: never before the game ends, correct and safe after it
node tests/credits.mjs           # footer, attribution never covering the airfield, About & credits
node tests/theme.mjs             # light/dark, live OS switching, no-flash, WCAG AA contrast, QA screenshots
node tests/e2e.mjs               # headless Playwright: phone 390x844 and desktop 1280x800 (needs network for Esri tiles)
```

The tests use an installed Edge or Chrome if present, otherwise Playwright's Chromium (`npx playwright install chromium`). `AG_BROWSER=webkit` runs them on Playwright's WebKit (`npx playwright install webkit`; the few checks that need Chromium-only tooling are skipped and say so). Playwright's WebKit is not Safari: check iOS on a real device. Screenshots land in `test-output/`.

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
- `data/airports.json` (3,222 international airports, 50 of them flagged `top` = the **Daily pool**; the other 3,172 join the Hard pool): [OurAirports](https://davidmegginson.github.io/ourairports-data/) large and medium airports with an IATA code and scheduled service, not closed.
- `data/airports-hard.json` (9,503 airports, the rest of the **Hard pool** with the 3,172 above): every other open large, medium or small airport that has runway data and an IATA code, ICAO code or Wikipedia page. In Hard mode autocomplete searches both files.
- **Per-airport view box and zoom.** `view` is `[lat, lon, width m, height m]`: the bounding box of the runway endpoints, which is exactly the condition for "every endpoint inside the frame" whatever the runway angle. `z` is the airport's whole-number zoom for everyone: the largest zoom at which that box stays inside the frame minus a 6% margin, below the top corner chips and above the attribution pill, and fills at most 78% of the frame, rounded down; it is the smaller of the phone (358x371) and desktop (604x585) fits. `rw` is the number of open runways (for the hint).
- **Native resolution (`nz`).** At build time the Esri `tilemap` service is probed for each airport: `nz` is the deepest tile level at which a 7x7 block of tiles around the airfield is real imagery (not the grey "map data not yet available" placeholder). Results are cached in `scripts/.cache/native_zoom.json`; `--refresh-zoom` re-probes and `--verify` spot-checks the tilemap against real tile downloads.
- **Sharp rendering.** Tiles are requested `n` levels deeper than the map zoom (n = 0 for devicePixelRatio 1, otherwise 1; +2 was dropped in v1.1.2 for load speed) and drawn at 256/2^n CSS px. The map zoom is a whole number, and the zoom used is `min(fit-to-airfield zoom, nz - n)`: a smaller airport in the frame beats a blurry upscale.
- **Quality filter.** Both pools drop airports where the imagery cap (native resolution minus the worst-case retina levels) forces a view wider than the airport's fitted zoom and the airfield would then fill less than 45% of the reference 358x371 phone frame (Daily 3,244 to 3,228, Hard 9,765 to 9,592). Airports whose fitted zoom is not capped are never dropped for being small in the frame. The filter is device-independent so everyone gets the same Daily.
- **Source clean-up.** Records the source itself marks as closed, disused, duplicated or superseded ("[CLOSED]", "[Duplicate]", "(Old)", "(former ...)", "(*)") are never offered (8 airports; `JUNK_NAME` in `scripts/build_data.py`).
- **Visibility filter.** `node scripts/image_contrast.mjs` downloads the few Esri tiles covering each airport's runways (at its display zoom, 8 at a time), samples the pixels along every open runway and beside it, and stores a score in `scripts/.cache/contrast.json` (median brightness difference, 0 to 255; runways without coordinates are searched around the reference point at their known heading). `build_data.py` drops airports scoring under `CONTRAST_MIN = 3.0` (87: bare fields, haze, blank ice) and never the Daily top 50. The score is a crude single measure: a few visible-but-low-contrast strips are dropped with the invisible ones.
- **Third hint (`hint3`).** `python scripts/hint_data.py` chooses, per airport, the first that applies, and the build stores it as `"type|value"`: **airline** (main airline, costing 2 attempts: Wikidata current hub relations, P113, for airlines that still exist; one hub airline is accepted, several only if the leader has at least 1.5x the OpenFlights routes of the runner-up, a tie gives nothing; when OpenFlights clearly shows another still-flying airline leading, e.g. 1.5x, that one wins over a minor Wikidata hub; without Wikidata, the OpenFlights airline with at least 1.5x the non-codeshare routes of the runner-up if the airport has 10 or more routes and the airline is still active, also checked against Wikidata's dissolved airlines; legal suffixes dropped, common names only), **region** (OurAirports `iso_region` + `regions.csv`, shown as "<region>, <country>"; skipped when missing or the same as the country), **grid** (north-west ... south-east of the country, from thirds of the 8th to 92nd percentile of the country's airports, countries with at least 5 airports) and **elev** (below 100 m, 100-500 m, 500-1,500 m, above 1,500 m). Seven Top-50 airports whose airline the sources get wrong (`SUPPRESS_AIRLINE` in the script, with the reason) fall back to the region. The route data is from 2014. Counts are written to `qa/hint3-report.json`. The app makes no request for any of this.
- **Wikipedia link (`wp`).** `python scripts/wikipedia_links.py` validates each airport's OurAirports `wikipedia_link` (HTTPS upgrade, host wikipedia.org, redirects followed through the MediaWiki API, must not be missing or a disambiguation page, must be an airport/airbase/heliport on Wikidata), falls back to a Wikidata lookup by ICAO/FAA/IATA code, and writes `qa/wikipedia-report.json`. `build_data.py` stores only the article title (`Title`, or `lang|Title` for other-language wikis) as `wp`; the app builds the URL in code (`wikipediaLink` in `js/core.js`) and uses a Wikipedia search link when there is no verified article; it never guesses. Result for 12,820 airports: 10,933 verified direct links, 346 via Wikidata, 1,541 search links (1,009 OurAirports links rejected: 875 not an airport article, 85 missing page, 34 disambiguation, 14 not wikipedia.org, 1 no Wikidata item). All top 50 have a verified article.
- **Practice sets.** OurAirports has no passenger numbers, so "Major hubs" is ranked by a connectivity proxy: route counts in [OpenFlights](https://github.com/jpatokal/openflights) `routes.dat` (ODbL). "Large" is all large airports, "Mid-size" is medium airports.

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
- **Wikipedia / Wikidata:** Wikipedia is a link target only (result card, after the round ends); the link leaves the app. Article titles are resolved at build time from the OurAirports `wikipedia_link` field, falling back to [Wikidata](https://www.wikidata.org/) (CC0); no Wikipedia text is copied and the app makes no runtime request to Wikipedia or Wikidata.
- **Other data:** country and region names (OurAirports countries and regions tables), elevation (OurAirports), airline-hub relations (Wikidata, CC0) and airline names and routes (OpenFlights, ODbL) for the third hint. The Practice "Major hubs" set is ordered by route counts from [OpenFlights](https://github.com/jpatokal/openflights) (ODbL), used only at build time.
- **Open-source software:** [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2-Clause), vendored in `vendor/leaflet`. No framework, no build step. Full list and licence text: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), generated by `node scripts/gen_notices.mjs`.
- **Fonts and icons:** no fonts are bundled (system font stack); the app icon is original artwork generated by `scripts/make_icons.mjs`.
- **Disclaimer:** not affiliated with or endorsed by any airport, airline, or data and imagery provider. Imagery may be outdated.

This repository has no `LICENSE` file yet; add one if you want to state the terms for the app's own code.
