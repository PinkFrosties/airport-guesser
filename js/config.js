// App version shown in the footer (keep in sync with package.json; tests check it).
export const APP_VERSION = '1.2.0';

// Everything provider-specific lives here. To switch imagery, change only this object.
export const IMAGERY = {
  // {z}/{y}/{x} as served by Esri's REST tile endpoint. {s} is supported for subdomain templates.
  // Two hosts serve identical tiles; alternating them doubles the parallel HTTP/1.1 connections (a tile always maps to the same host, so caching still works).
  url: 'https://{s}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution:
    'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  minZoom: 2,
  maxZoom: 19,
  subdomains: ['server', 'services'],
  tileTimeoutMs: Number(globalThis.__AG_TILE_TIMEOUT_MS) || 10000, // a view that has not finished loading after this is retried once, then reported as stalled
};

export const GAME = {
  /** How many candidate airports to try (imagery probe) before giving up on starting a round. */
  maxProbeAttempts: 10,
};
