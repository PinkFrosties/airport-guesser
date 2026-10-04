// Everything provider-specific lives here. To switch imagery, change only this object.
export const IMAGERY = {
  // {z}/{y}/{x} as served by Esri's REST tile endpoint. {s} is supported for subdomain templates.
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution:
    'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  minZoom: 2,
  maxZoom: 19,
  subdomains: '',
  probeTimeoutMs: 8000,
};

export const GAME = {
  /** How many candidate airports to try (imagery probe) before giving up on starting a round. */
  maxProbeAttempts: 10,
};
