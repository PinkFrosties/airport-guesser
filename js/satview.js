// A locked Leaflet satellite view that loads exactly the tiles of one view and tells you when all of them are in.
//
// Interaction (v1.3.4): after the first reveal the player can zoom IN from the start view (pinch, wheel, double tap / click,
// keys) and pan while zoomed, never wider than the start view and never beyond the real imagery. Zoom levels are whole
// numbers, tiles are always requested at the sharp level (zoom + retina offset, never past the native level); scaled
// stand-in tiles exist only while a zoom is in progress, never for the first reveal.
//
// Sharp rendering: tiles are requested `n` levels deeper than the map zoom and drawn at 256/2^n CSS px, so each CSS
// pixel is backed by >= devicePixelRatio real pixels. Zoom is a whole number (Leaflet never applies a CSS scale to
// the tile layer) and no stand-in tiles from other zoom levels are ever kept.
//
// Cheap loading: only tiles intersecting the frame are requested (the container is exactly the frame, no buffer),
// tiles are plain cacheable GETs spread over two hosts (more parallel HTTP/1.1 connections), a stalled view is retried
// once after `tileTimeoutMs`, and a failed view reports 'failed' / 'timeout' instead of hanging.

const SharpTiles = L.TileLayer.extend({
  // no stand-in tiles for a reveal; while the player zooms, Leaflet keeps the old level scaled until the new one is in
  _retainParent(x, y, z, minZoom) { return this._standIns ? L.TileLayer.prototype._retainParent.call(this, x, y, z, minZoom) : false; },
  _retainChildren(x, y, z, maxZoom) { return this._standIns ? L.TileLayer.prototype._retainChildren.call(this, x, y, z, maxZoom) : false; },
});
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createSatView({ container, imagery, onProgress }) {
  let map = null, layer = null, n = 0;
  let ia = null; // interaction: { center, z, zmax, size, onChange } while the player may zoom in
  let state = { key: null, status: 'idle', promise: null, stats: { ok: 0, err: 0 }, total: 0 };
  const subs = Array.isArray(imagery.subdomains) ? imagery.subdomains : [];

  const emit = () => onProgress && onProgress(Math.min(state.stats.ok, state.total), state.total, state);

  function ensureMap() {
    if (map) return;
    map = L.map(container, {
      zoomControl: false, attributionControl: true, dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, zoomSnap: 1, zoomDelta: 1,
      zoomAnimation: !reducedMotion(), fadeAnimation: false, markerZoomAnimation: false, inertia: false,
      maxBoundsViscosity: 1, wheelPxPerZoomLevel: 120, bounceAtZoomLimits: false,
      minZoom: imagery.minZoom, maxZoom: imagery.maxZoom, worldCopyJump: false,
    });
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution(imagery.attribution); // always on the image, even while tiles load
    map.on('zoomend', onZoomEnd);
  }

  const levelNow = () => (ia && map ? map.getZoom() - ia.z : 0);
  function onZoomEnd() {
    if (!ia) return;
    // with updateWhenZooming off (a reveal never loads intermediate levels) the tile layer must be told the zoom ended, or a pinch would keep the old level scaled
    if (layer && layer._tileZoom !== Math.round(map.getZoom())) layer._setView(map.getCenter(), map.getZoom(), false, false);
    const zoomed = levelNow() > 0;
    if (zoomed) map.dragging.enable(); else {
      map.dragging.disable();
      // back at the start zoom: exactly the start centre (the clamped centre can be a pixel off after a zoom around a point)
      const off = map.project(map.getCenter(), ia.z).distanceTo(map.project(L.latLng(ia.center), ia.z));
      if (off > 0.5) map.setView(ia.center, ia.z, { animate: false });
    }
    container.classList.toggle('zoomed', zoomed);
    if (ia.onChange) ia.onChange({ level: levelNow(), zoomed, atMax: map.getZoom() >= ia.zmax });
  }

  function makeLayer() {
    const l = new SharpTiles(imagery.url, {
      subdomains: subs.length ? subs : 'abc', crossOrigin: true,
      tileSize: 256 / 2 ** n, zoomOffset: n, minZoom: imagery.minZoom, maxZoom: imagery.maxZoom - n,
      keepBuffer: 0, updateWhenIdle: true, updateWhenZooming: false, detectRetina: false,
    });
    l._standIns = !!ia; // stand-ins only while the player can zoom
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
    /** The size Leaflet currently believes in (no DOM measuring): the keyboard layout freezes the frame to exactly this, so no resize can shift the view by a pixel. */
    cachedSize() { return map && map._size ? { W: map._size.x, H: map._size.y } : null; },
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
      if (!map || state.status !== 'ready' || !state.key || !state.key.startsWith(`${center[0]},${center[1]},${z},${n}|`)) return false;
      return ia ? true : map.getZoom() === z && allLoaded(); // zoomed in by the player: the view is valid, whatever level it is at
    },

    // ---- interaction (zooming in from the start view)
    get interactive() { return !!ia; },
    get level() { return levelNow(); },
    get maxLevel() { return ia ? ia.zmax - ia.z : 0; },

    /** Let the player zoom in from this view: start zoom `z` is the minimum, `zmax` the maximum, the pan range is the start frame. Keeps the player's zoom if nothing changed. */
    enableInteraction({ center, z, zmax, onChange }) {
      ensureMap();
      const size = map.getSize();
      if (ia && ia.z === z && ia.center[0] === center[0] && ia.center[1] === center[1] && ia.size.x === size.x && ia.size.y === size.y) { ia.zmax = zmax; ia.onChange = onChange; return; }
      api.disableInteraction();
      if (zmax <= z || map.getZoom() !== z) return; // no real imagery deeper than this view: nothing to zoom into
      const half = size.divideBy(2), pc = map.project(map.getCenter(), z);
      map.setMaxBounds(L.latLngBounds(map.unproject(pc.add([-half.x, half.y]), z), map.unproject(pc.add([half.x, -half.y]), z))); // the start frame
      map.setMinZoom(z); map.setMaxZoom(zmax);
      ia = { center, z, zmax, size, onChange };
      map.touchZoom.enable(); map.scrollWheelZoom.enable(); map.dragging.disable();
      if (layer) { layer._standIns = true; layer.options.updateWhenIdle = false; layer.options.keepBuffer = 1; }
      if (onChange) onChange({ level: 0, zoomed: false, atMax: false });
    },

    /** Back to a plain locked view (new view loading, or another view took over). */
    disableInteraction() {
      if (!map) return;
      const was = ia; ia = null;
      map.touchZoom.disable(); map.scrollWheelZoom.disable(); map.dragging.disable();
      map.setMaxBounds(null); map.setMinZoom(imagery.minZoom); map.setMaxZoom(imagery.maxZoom - n);
      container.classList.remove('zoomed');
      if (layer) { layer._standIns = false; layer.options.updateWhenIdle = true; layer.options.keepBuffer = 0; }
      if (was && was.onChange) was.onChange({ level: 0, zoomed: false, atMax: false });
    },

    /** One level in (about a container point, or the centre) or out. Returns false when already at the limit. */
    zoomBy(delta, containerPoint) {
      if (!ia) return false;
      const target = Math.max(ia.z, Math.min(ia.zmax, map.getZoom() + delta));
      if (target === map.getZoom()) return false;
      if (containerPoint) map.setZoomAround(L.point(containerPoint), target, { animate: !reducedMotion() }); else map.setZoom(target, { animate: !reducedMotion() });
      return true;
    },

    /** Back to exactly the start view (centre and zoom). Animated unless the player prefers reduced motion. */
    resetView(animate = true) {
      if (!ia) return;
      if (levelNow() === 0 && map.project(map.getCenter(), ia.z).distanceTo(map.project(L.latLng(ia.center), ia.z)) <= 0.5) return; // already exactly there
      const anim = animate && !reducedMotion();
      map.setView(ia.center, ia.z, { animate: anim });
      if (!anim) onZoomEnd();
    },

    /** Load a view; resolves 'ok' once every tile is in, 'failed' if tiles still fail after one retry, 'timeout' if stalled. */
    load(center, z) {
      ensureMap();
      map.invalidateSize();
      const key = `${center[0]},${center[1]},${z},${n}|${map.getSize().x}x${map.getSize().y}`;
      if (state.key === key && state.status === 'loading') return state.promise;
      if (state.key === key && state.status === 'ready' && allLoaded()) return Promise.resolve('ok');
      if (state.status === 'loading' && state.cancel) state.cancel(); // superseded by a different view
      api.disableInteraction(); // a (re)load is a reveal: plain locked view, no stand-in tiles
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
