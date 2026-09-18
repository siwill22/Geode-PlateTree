/*
 * Camera maths for the raster globe: view matrices, Spilhaus, and the pannable
 * Robinson forward.
 *
 * Everything here treats the Earth as a sphere and works in 3-D unit vectors.
 * Nothing interpolates lon/lat pairs directly -- that is a flat-plane operation
 * which misbehaves near the poles and across the antimeridian, precisely where
 * deep-time reconstructions spend most of their time.
 *
 * The split against ./sphere.js and ./robinson.js is: those two own the geometry
 * that any consumer needs (unit vectors, the published Robinson table, seam
 * arithmetic); this file owns what only a *camera* needs. It imports rather than
 * redefines, so there is one copy of each constant.
 */

import { DEG, lonLatToVec3, vec3ToLonLat } from './sphere.js';
import {
  ROBINSON_KX, ROBINSON_KY, ROBINSON_STEP, ROBINSON_X, ROBINSON_Y,
  robinsonForward as robinsonUnits,
} from './robinson.js';

export { DEG, lonLatToVec3, vec3ToLonLat };

/** Great-circle angular distance in degrees between two unit vectors. */
export function angularDistance(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) / DEG;
}

/* ---- orthographic camera ------------------------------------------------- */

/**
 * Build the view matrix for an orthographic globe centred on (lon, lat).
 *
 * Rows are the east, north and outward unit vectors at the centre point, so
 * multiplying a point's unit vector by this matrix yields
 *   [ screen x, screen y, depth ]
 * with depth > 0 meaning the point is on the visible hemisphere. Handling the
 * horizon this way is exact -- there is no planar approximation anywhere.
 */
export function viewMatrix(centreLonDeg, centreLatDeg, out) {
  out = out || new Float64Array(9);
  const lon = centreLonDeg * DEG;
  const lat = centreLatDeg * DEG;
  const sinLon = Math.sin(lon); const cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat); const cosLat = Math.cos(lat);

  // east
  out[0] = -sinLon; out[1] = cosLon; out[2] = 0;
  // north
  out[3] = -sinLat * cosLon; out[4] = -sinLat * sinLon; out[5] = cosLat;
  // outward (the centre direction itself)
  out[6] = cosLat * cosLon; out[7] = cosLat * sinLon; out[8] = sinLat;
  return out;
}

/**
 * The camera basis for a Spilhaus view centred on (lon, lat). Identical
 * construction to viewMatrix() -- kept as its own name because the Spilhaus
 * branch means something different by it (the projection's own centre, not a
 * pannable camera) and callers read better for saying which they want.
 */
export function spilhausViewMatrix(centreLonDeg, centreLatDeg, out) {
  return viewMatrix(centreLonDeg, centreLatDeg, out);
}

/**
 * Interpolate between two camera positions along a great circle.
 *
 * Independently lerping the centre longitude and latitude would swing the camera
 * along a path that is not a great circle, and would spin wildly when passing
 * near a pole.
 */
export function cameraInterpolate(a, b, t) {
  const va = lonLatToVec3(a.lon, a.lat);
  const vb = lonLatToVec3(b.lon, b.lat);

  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);

  let v;
  if (omega < 1e-6) {
    v = va;
  } else {
    const sinOmega = Math.sin(omega);
    const s0 = Math.sin((1 - t) * omega) / sinOmega;
    const s1 = Math.sin(t * omega) / sinOmega;
    v = [
      s0 * va[0] + s1 * vb[0],
      s0 * va[1] + s1 * vb[1],
      s0 * va[2] + s1 * vb[2],
    ];
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    v = [v[0] / n, v[1] / n, v[2] / n];
  }

  const [lon, lat] = vec3ToLonLat(v);
  return {
    lon,
    lat,
    zoom: (a.zoom ?? 1) + ((b.zoom ?? 1) - (a.zoom ?? 1)) * t,
  };
}

/** Points along the great circle from a to b, for drawing flow paths. */
export function greatCirclePoints(lon1, lat1, lon2, lat2, n = 48) {
  const va = lonLatToVec3(lon1, lat1);
  const vb = lonLatToVec3(lon2, lat2);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const out = [];
  if (omega < 1e-9) return [[lon1, lat1]];
  const sinOmega = Math.sin(omega);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s0 = Math.sin((1 - t) * omega) / sinOmega;
    const s1 = Math.sin(t * omega) / sinOmega;
    out.push(vec3ToLonLat([
      s0 * va[0] + s1 * vb[0],
      s0 * va[1] + s1 * vb[1],
      s0 * va[2] + s1 * vb[2],
    ]));
  }
  return out;
}

/** A small circle of given angular radius about a centre. */
export function smallCirclePoints(centreLonDeg, centreLatDeg, radiusDeg, n = 180) {
  const c = lonLatToVec3(centreLonDeg, centreLatDeg);
  // Any vector perpendicular to c works as the starting radius.
  const ref = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u = [
    ref[1] * c[2] - ref[2] * c[1],
    ref[2] * c[0] - ref[0] * c[2],
    ref[0] * c[1] - ref[1] * c[0],
  ];
  const un = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / un, u[1] / un, u[2] / un];
  const v = [
    c[1] * u[2] - c[2] * u[1],
    c[2] * u[0] - c[0] * u[2],
    c[0] * u[1] - c[1] * u[0],
  ];

  const r = radiusDeg * DEG;
  const cosR = Math.cos(r); const sinR = Math.sin(r);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const ca = Math.cos(a); const sa = Math.sin(a);
    out.push(vec3ToLonLat([
      cosR * c[0] + sinR * (ca * u[0] + sa * v[0]),
      cosR * c[1] + sinR * (ca * u[1] + sa * v[1]),
      cosR * c[2] + sinR * (ca * u[2] + sa * v[2]),
    ]));
  }
  return out;
}

/* ---- Spilhaus projection ------------------------------------------------- */

/** The standard Spilhaus centre: 71S, 142E. */
export const SPILHAUS_CENTER = { lon: 142, lat: -71 };
const SPILHAUS_SCALE = 0.917;

/**
 * Forward Spilhaus: a polar azimuthal equal-area projection about SPILHAUS_CENTER,
 * scaled to zoom in on the Southern Ocean. Returns null for a point on the far side.
 */
export function spilhausForward(lonDeg, latDeg) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const clat = SPILHAUS_CENTER.lat * DEG;
  const clon = SPILHAUS_CENTER.lon * DEG;

  const cosDelta = Math.sin(lat) * Math.sin(clat)
    + Math.cos(lat) * Math.cos(clat) * Math.cos(lon - clon);

  if (cosDelta < -0.1) return null;

  const k = SPILHAUS_SCALE * (1 + cosDelta)
    / Math.sqrt((1 - cosDelta) * (1 + cosDelta));

  return [
    k * Math.cos(lat) * Math.sin(lon - clon),
    k * (Math.cos(clat) * Math.sin(lat)
      - Math.sin(clat) * Math.cos(lat) * Math.cos(lon - clon)),
  ];
}

/** Inverse Spilhaus: projected coordinates back to [lon, lat] in degrees. */
export function spilhausInverse(x, y) {
  const clat = SPILHAUS_CENTER.lat * DEG;
  const clon = SPILHAUS_CENTER.lon * DEG;

  const rho = Math.hypot(x, y);
  if (rho < 1e-10) return [SPILHAUS_CENTER.lon, SPILHAUS_CENTER.lat];

  const c = 2 * Math.atan(rho / (2 * SPILHAUS_SCALE));
  const sinc = Math.sin(c);

  const lat = Math.asin(Math.cos(c) * Math.sin(clat)
    + (y * sinc * Math.cos(clat)) / rho);
  const lon = clon + Math.atan2(x * sinc,
    rho * Math.cos(clat) * Math.cos(c) - y * Math.sin(clat) * sinc);

  return [lon / DEG, lat / DEG];
}

/** Meridians and parallels for a Spilhaus graticule. */
export function spilhausGrid(lonStep = 30, latStep = 15) {
  const meridians = [];
  const parallels = [];

  for (let lon = -180; lon <= 180; lon += lonStep) {
    const points = [];
    for (let lat = -90; lat <= 90; lat += latStep) {
      const p = spilhausForward(lon, lat);
      if (p) points.push(p);
    }
    if (points.length > 1) meridians.push(points);
  }

  for (let lat = -90; lat <= 90; lat += latStep) {
    const points = [];
    for (let lon = -180; lon <= 180; lon += lonStep) {
      const p = spilhausForward(lon, lat);
      if (p) points.push(p);
    }
    if (points.length > 1) parallels.push(points);
  }

  return { meridians, parallels };
}

/* ---- Robinson, with a pannable central meridian --------------------------- */

/**
 * The published table as `[lat, x, y]` triples, derived from ./robinson.js's two
 * parallel arrays rather than retyped. RasterGlobe interpolates its GLSL from
 * this, so the shader's inverse and the JS forward used by vector overlays cannot
 * drift apart.
 */
export const ROBINSON_TABLE = ROBINSON_X.map(
  (x, i) => [i * ROBINSON_STEP, x, ROBINSON_Y[i]],
);

export const ROBINSON_XSCALE = ROBINSON_KX;
export const ROBINSON_YSCALE = ROBINSON_KY;

/**
 * Forward Robinson centred on `centreLonDeg` -- the pannable central meridian.
 * Robinson has no camera tilt, so latitude plays no part in centring the view the
 * way it does for an orthographic globe. Returns [x, y] in the projection's own
 * units (x up to +-ROBINSON_XSCALE*PI, y up to +-ROBINSON_YSCALE).
 */
export function robinsonForward(lonDeg, latDeg, centreLonDeg = 0) {
  let dLon = lonDeg - centreLonDeg;
  dLon = ((dLon + 180) % 360 + 360) % 360 - 180;
  return robinsonForwardDelta(dLon, latDeg);
}

/**
 * Same as robinsonForward(), but takes a longitude DELTA already known to be safe
 * (already within the map's own -180..180 span relative to whatever centre it was
 * measured from) instead of an absolute longitude to be wrapped. The wrap in
 * robinsonForward() resolves the seam itself to a single canonical representative
 * (-180) -- fine for an ordinary point, wrong for geometry already split at the
 * seam that approaches it from the +180 side, which would be flipped back and
 * reintroduce the jump the split removed.
 */
export function robinsonForwardDelta(dLonDeg, latDeg) {
  return robinsonUnits(dLonDeg, latDeg);
}
