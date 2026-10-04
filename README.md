# Airport Guesser

A static, backend-free guessing game for phone and desktop: you get a satellite image of one airport and five guesses to name it. Every miss shows the distance to the answer, a compass arrow pointing from your guess toward it, and a proximity percentage, while the image zooms out (airfield, wider view, region, continent, country) as free hints. There is one shared Daily airport per UTC date, plus endless Practice at three difficulties. It is vanilla JS + Leaflet, installable as a PWA, and keeps stats in `localStorage`.

## Run locally

```bash
node scripts/serve.mjs 8080      # then open http://localhost:8080/
# or: python -m http.server 8080
```

Any static server works. A service worker only registers on `localhost` or HTTPS.

## Tests

```bash
npm install                      # dev-only: Playwright + vendored-asset sources
node tests/unit.mjs              # haversine, bearing, search, daily seed, share text, stats
node tests/e2e.mjs               # headless Playwright: full games on 390x844 and 1280x800 (needs network for Esri tiles)
```

The e2e script uses an installed Edge or Chrome if present, otherwise Playwright's Chromium (`npx playwright install chromium`). Screenshots land in `test-output/`.

## Deploy to GitHub Pages

1. Create a GitHub repository and add it as a remote: `git remote add origin <url>`.
2. `git push -u origin main`.
3. In the repository go to **Settings > Pages** and set **Source** to **GitHub Actions**.
4. `.github/workflows/deploy.yml` publishes the repository root on every push to `main`. All paths are relative, so it works under `https://<user>.github.io/<repo>/`. `.nojekyll` is included.

When you ship changes to cached files, bump `VERSION` in `sw.js` so installed copies refresh.

## Data

`data/airports.json` is generated and committed; the app never fetches OurAirports at runtime.

```bash
python scripts/build_data.py     # add --refresh to re-download sources
```

- Source: [OurAirports](https://davidmegginson.github.io/ourairports-data/) (public domain). Kept: IATA code present, `scheduled_service = yes`, type `large_airport` or `medium_airport`, not closed.
- **Difficulty tiers.** OurAirports has no passenger numbers, so the Easy set (tier 1, 100 airports) is ranked by a connectivity proxy: the number of routes departing from or arriving at each large airport in the [OpenFlights](https://github.com/jpatokal/openflights) `routes.dat` (ODbL). Hubs with many routes are, in practice, the busiest airports. Medium = all large airports (tiers 1 + 2). Hard = medium airports with scheduled service (tier 3). The Daily airport is drawn from all large airports.
- Per-airport zoom hints are computed at build time: `z` fits the whole airfield (from runway end coordinates, 12 to 15) and `cz` is a country-level zoom.

## Imagery provider

All provider settings live in one object, `IMAGERY` in `js/config.js` (URL template, attribution, zoom limits). Default is Esri World Imagery, which has no labels. Esri's terms require visible attribution (included) and may require an account or key for heavy or commercial use; check them before promoting the site widely.

## Credits

Airport data: OurAirports. Route counts: OpenFlights. Imagery: Esri, Maxar, Earthstar Geographics and the GIS User Community. Map engine: [Leaflet](https://leafletjs.com/) (BSD-2, vendored). Fonts (vendored, OFL): Instrument Serif, Hanken Grotesk, JetBrains Mono.
