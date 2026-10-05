// Pure tile math, shared by the app (satview.js), the inline preloader and the tests. No DOM, no Leaflet.
// Mirrors what Leaflet requests for a locked integer-zoom view whose tiles are drawn at 256/2^n CSS px (see satview.js).

const RAD = Math.PI / 180;

/** Web Mercator pixel position of (lat, lon) at map zoom z (256-px world tiles), like Leaflet's EPSG:3857 project(). */
export function project(lat, lon, z) {
  const scale = 256 * 2 ** z;
  const s = Math.sin(lat * RAD);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

/** Inverse of project(). */
export function unproject(x, y, z) {
  const scale = 256 * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: (x / scale) * 360 - 180 };
}

/** The view centre moved so the airfield appears `dy` CSS px higher in the frame. */
export function shiftedCenter(lat, lon, z, dy) {
  const p = project(lat, lon, z);
  const ll = unproject(p.x, p.y + dy, z);
  return [ll.lat, ll.lon];
}

/** Tile URL for grid position (x, y) at map zoom z (tile level z + n). Hosts alternate by (x + y), so a tile always uses the same host. */
export function tileUrl(imagery, n, z, x, y) {
  const subs = imagery.subdomains || [];
  const host = subs.length ? subs[Math.abs(x + y) % subs.length] : '';
  return imagery.url.replace('{s}', host).replace('{z}', z + n).replace('{x}', x).replace('{y}', y);
}

/** Exactly the tiles that intersect a W x H frame centred on `center` at zoom z. */
export function tilesForView(imagery, n, center, z, W, H) {
  const css = 256 / 2 ** n;
  const p = project(center[0], center[1], z);
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  const minX = cx - W / 2, maxX = cx + W / 2, minY = cy - H / 2, maxY = cy + H / 2;
  const out = [];
  for (let y = Math.floor(minY / css); y <= Math.ceil(maxY / css) - 1; y++) {
    for (let x = Math.floor(minX / css); x <= Math.ceil(maxX / css) - 1; x++) out.push(tileUrl(imagery, n, z, x, y));
  }
  return out;
}
