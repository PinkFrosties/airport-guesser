// A locked Leaflet satellite view that loads exactly the tiles of one view and tells you when all of them are in.
//
// Sharp rendering: tiles are requested `n` levels deeper than the map zoom and drawn at 256/2^n CSS px, so each CSS
// pixel is backed by >= devicePixelRatio real pixels. Zoom is a whole number (Leaflet never applies a CSS scale to
// the tile layer) and no stand-in tiles from other zoom levels are ever kept.
//
// Cheap loading: only tiles intersecting the frame are requested (the container is exactly the frame, no buffer),
// tiles are plain cacheable GETs spread over two hosts (more parallel HTTP/1.1 connections), a stalled view is retried
// once after `tileTimeoutMs`, and a failed view reports 'failed' / 'timeout' instead of hanging.

const SharpTiles = L.TileLayer.extend({
  _retainParent() { return false; },
  _retainChildren() { return false; },
});

export function createSatView({ container, imagery, onProgress }) {
  let map = null, layer = null, n = 0;
  let state = { key: null, status: 'idle', promise: null, stats: { ok: 0, err: 0 }, total: 0 };
  const subs = Array.isArray(imagery.subdomains) ? imagery.subdomains : [];

  const emit = () => onProgress && onProgress(Math.min(state.stats.ok, state.total), state.total, state);

  function ensureMap() {
    if (map) return;
    map = L.map(container, {
      zoomControl: false, attributionControl: true, dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, zoomSnap: 1, zoomDelta: 1,
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, inertia: false,
      minZoom: imagery.minZoom, maxZoom: imagery.maxZoom, worldCopyJump: false,
    });
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution(imagery.attribution); // always on the image, even while tiles load
  }

  function makeLayer() {
    const l = new SharpTiles(imagery.url, {
      subdomains: subs.length ? subs : 'abc', crossOrigin: true,
      tileSize: 256 / 2 ** n, zoomOffset: n, minZoom: imagery.minZoom, maxZoom: imagery.maxZoom - n,
      keepBuffer: 0, updateWhenIdle: true, updateWhenZooming: false, detectRetina: false,
    });
    l.on('tileload', () => { state.stats.ok++; emit(); });
    l.on('tileerror', () => { state.stats.err++; emit(); });
    return l;
  }

  /** URL of the tile at grid position (x, y) for map zoom z: same host choice as Leaflet, so prefetches hit the cache. */
  function urlFor(z, x, y) {
    const host = subs.length ? subs[Math.abs(x + y) % subs.length] : '';
    return imagery.url.replace('{s}', host).replace('{z}', z + n).replace('{x}', x).replace('{y}', y);
  }

  /** Exactly the tiles Leaflet will request for this view (those intersecting the frame). */
  function tilesFor(center, z) {
    ensureMap();
    const css = 256 / 2 ** n;
    const size = map.getSize();
    const pc = map.project(L.latLng(center), z).floor();
    const min = { x: pc.x - size.x / 2, y: pc.y - size.y / 2 };
    const max = { x: pc.x + size.x / 2, y: pc.y + size.y / 2 };
    const out = [];
    for (let y = Math.floor(min.y / css); y <= Math.ceil(max.y / css) - 1; y++) {
      for (let x = Math.floor(min.x / css); x <= Math.ceil(max.x / css) - 1; x++) out.push(urlFor(z, x, y));
    }
    return out;
  }

  /** Cancel in-flight tile requests (a stalled request would otherwise be re-used by the retry instead of re-sent). */
  const EMPTY_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const abortPending = () => {
    for (const img of container.querySelectorAll('img.leaflet-tile')) {
      if (!img.classList.contains('leaflet-tile-loaded')) { img.onload = img.onerror = null; img.src = EMPTY_GIF; }
    }
  };

  const allLoaded = () => {
    const t = container.querySelectorAll('img.leaflet-tile');
    return t.length > 0 && [...t].every((i) => i.classList.contains('leaflet-tile-loaded'));
  };

  const api = {
    get map() { return map; },
    get container() { return container; },
    get status() { return state.status; },
    get retinaLevels() { return n; },
    get stats() { return { ...state.stats, total: state.total }; },
    size() { ensureMap(); map.invalidateSize(); const s = map.getSize(); return { W: Math.max(s.x, 200), H: Math.max(s.y, 150) }; },
    tilesFor,

    /** The centre of the view moved so the airfield appears `dy` CSS px higher in the frame (room for the attribution pill). */
    shifted(center, z, dy) {
      ensureMap();
      const ll = map.unproject(map.project(L.latLng(center), z).add([0, dy]), z);
      return [ll.lat, ll.lng];
    },

    /** Change tile density (devicePixelRatio changed). Forces the next load() to rebuild. */
    setRetina(level) {
      if (level === n && layer) return false;
      n = level;
      ensureMap();
      if (layer) { map.removeLayer(layer); layer = null; }
      if (state.status === 'loading' && state.cancel) state.cancel();
      state = { key: null, status: 'idle', promise: null, stats: { ok: 0, err: 0 }, total: 0 };
      return true;
    },

    /** True when the view is already fully loaded (so showing it needs no waiting). */
    isReady(center, z) {
      return !!map && state.status === 'ready' && !!state.key && state.key.startsWith(`${center[0]},${center[1]},${z},${n}|`) && map.getZoom() === z && allLoaded();
    },

    /** Load a view; resolves 'ok' once every tile is in, 'failed' if tiles still fail after one retry, 'timeout' if stalled. */
    load(center, z) {
      ensureMap();
      map.invalidateSize();
      const key = `${center[0]},${center[1]},${z},${n}|${map.getSize().x}x${map.getSize().y}`;
      if (state.key === key && state.status === 'loading') return state.promise;
      if (state.key === key && state.status === 'ready' && allLoaded()) return Promise.resolve('ok');
      if (state.status === 'loading' && state.cancel) state.cancel(); // superseded by a different view
      state = { key, status: 'loading', promise: null, cancel: null, stats: { ok: 0, err: 0 }, total: tilesFor(center, z).length };
      const mine = state;
      emit();
      mine.promise = new Promise((resolve) => {
        let attempt = 1, timer = null;
        const onLoad = () => {
          if (state !== mine) return;
          if (mine.stats.err === 0) return settle('ok');
          if (attempt === 1) retry(); else settle('failed');
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { if (state !== mine) return; if (attempt === 1) retry(); else settle('timeout'); }, imagery.tileTimeoutMs);
        };
        const retry = () => { attempt = 2; mine.stats = { ok: 0, err: 0 }; emit(); abortPending(); layer.redraw(); arm(); };
        const settle = (res) => {
          clearTimeout(timer);
          layer && layer.off('load', onLoad);
          if (res !== 'ok') abortPending();
          mine.status = res === 'ok' ? 'ready' : res;
          emit();
          resolve(res);
        };
        mine.cancel = () => { clearTimeout(timer); layer && layer.off('load', onLoad); resolve('superseded'); };
        if (!layer) { map.setView(center, z, { animate: false }); layer = makeLayer(); layer.on('load', onLoad); layer.addTo(map); }
        else { layer.on('load', onLoad); map.setView(center, z, { animate: false }); }
        arm();
        // nothing new to fetch (view unchanged / fully cached)? 'load' will not fire
        queueMicrotask(() => { if (state === mine && !layer.isLoading() && allLoaded()) settle('ok'); });
      });
      return mine.promise;
    },

    /** Fire-and-forget: warm the HTTP/service-worker cache with the tiles of a view (same URLs Leaflet will request). */
    prefetch(center, z) {
      const kept = (api._kept ||= []);
      for (const url of tilesFor(center, z)) {
        const img = new Image();
        img.crossOrigin = '';
        img.src = url;
        kept.push(img);
      }
      if (kept.length > 200) kept.splice(0, kept.length - 200);
    },
  };
  return api;
}
