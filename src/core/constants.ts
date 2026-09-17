import { Vector3 } from 'three';

/**
 * Coordinate and radius conventions. Fixed here, used everywhere.
 *
 * Right-handed, Y-up (three.js default).
 *   x =  r*cos(lat)*cos(lon)
 *   y =  r*sin(lat)
 *   z = -r*cos(lat)*sin(lon)
 *
 * NOTE THE MINUS SIGN ON Z. It is not optional and it is not cosmetic.
 *
 * The geographic frame is right-handed with X toward (0N, 0E), Y toward
 * (0N, 90E) and Z toward the north pole. Mapping that to three.js as
 * (x, y, z) = (X, Z, Y) -- which is what dropping the minus sign does -- is a
 * transposition of two axes, so its determinant is -1 and the embedding is
 * LEFT-handed. three.js renders in a right-handed world, so the result is a
 * mirror image of the Earth: longitude runs backwards and east and west are
 * swapped. Because every consumer used the same convention the error was
 * self-consistent and invisible in the tomography, which is blobby enough to
 * look plausible mirrored; it only showed up once recognisable coastlines were
 * drawn on top.
 *
 * (x, y, z) = (X, Z, -Y) restores right-handedness: x_hat cross y_hat = z_hat.
 *
 * Anything converting a world position back to longitude must therefore use
 * atan2(-z, x), never atan2(z, x). That includes every fragment shader.
 *
 * No vertical exaggeration. Depth is real.
 */

export const EARTH_RADIUS_KM = 6371;
export const R_SURFACE = 1.0;
export const R_CMB = 3480 / 6371; // 0.54615

export const DEG = Math.PI / 180;

/** Shared key-light direction, so every lit surface (globe, core, coastline
 *  fill) agrees on where the sun is. Lives here rather than in tomography's
 *  globe.ts because coastlines.ts (shared between both viewers) needs it
 *  too, and core/ must not import from an app-specific directory. */
export const LIGHT_DIR = new Vector3(0.6, 0.45, 0.65).normalize();

/** Depth in km -> radius in world units. */
export function depthToRadius(depthKm: number): number {
  return R_SURFACE - depthKm / EARTH_RADIUS_KM;
}

/** Radius in world units -> depth in km. */
export function radiusToDepth(r: number): number {
  return (R_SURFACE - r) * EARTH_RADIUS_KM;
}

export interface LonLat {
  lon: number; // degrees, -180..180
  lat: number; // degrees, -90..90
}

export function lonLatToVec3(
  lon: number,
  lat: number,
  r = R_SURFACE,
): [number, number, number] {
  const cl = Math.cos(lat * DEG);
  return [
    r * cl * Math.cos(lon * DEG),
    r * Math.sin(lat * DEG),
    -r * cl * Math.sin(lon * DEG),
  ];
}

/**
 * The unit east and north tangent vectors of the globe at (lon, lat), in the
 * same 3D frame as lonLatToVec3 -- derived directly from its own
 * parameterisation (d/dlon and d/dlat, each normalised) so the two stay
 * consistent by construction. Needed to turn a meteorological (u, v) pair
 * (already expressed in a local east/north frame) into a 3D direction: which
 * 3D direction is "east" rotates with position on a sphere, so a flat
 * (u, v) -> (x, y) mapping would be wrong everywhere except lon=0.
 *
 * Degenerate at lat = +-90 (every longitude is the same point there, so
 * "east" is meaningless) -- callers must not evaluate this at the poles.
 */
export function eastNorthAt(lon: number, lat: number): {
  east: [number, number, number]; north: [number, number, number];
} {
  const sLon = Math.sin(lon * DEG);
  const cLon = Math.cos(lon * DEG);
  const sLat = Math.sin(lat * DEG);
  const cLat = Math.cos(lat * DEG);
  return {
    east: [-sLon, 0, -cLon],
    north: [-sLat * cLon, cLat, sLat * sLon],
  };
}

export function vec3ToLonLat(x: number, y: number, z: number): LonLat {
  const r = Math.hypot(x, y, z);
  return {
    lat: Math.asin(Math.min(1, Math.max(-1, y / r))) / DEG,
    lon: Math.atan2(-z, x) / DEG,
  };
}

/** Shortest signed difference b - a, wrapped to (-180, 180]. */
export function wrapLonDelta(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Great-circle interpolation between two lon/lat points.
 * Straight chords in lon/lat would cut the wrong path across the sphere.
 */
export function densifyGreatCircle(
  a: LonLat,
  b: LonLat,
  maxSpacingDeg: number,
): LonLat[] {
  const va = lonLatToVec3(a.lon, a.lat, 1);
  const vb = lonLatToVec3(b.lon, b.lat, 1);
  const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const arcDeg = omega / DEG;
  const n = Math.max(1, Math.ceil(arcDeg / maxSpacingDeg));
  const out: LonLat[] = [];
  if (omega < 1e-9) return [a];
  const s = Math.sin(omega);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const w0 = Math.sin((1 - t) * omega) / s;
    const w1 = Math.sin(t * omega) / s;
    out.push(
      vec3ToLonLat(
        w0 * va[0] + w1 * vb[0],
        w0 * va[1] + w1 * vb[1],
        w0 * va[2] + w1 * vb[2],
      ),
    );
  }
  return out;
}

/** Densify a closed polygon, returning the boundary without repeating the first point. */
export function densifyPolygon(verts: LonLat[], maxSpacingDeg = 0.5): LonLat[] {
  if (verts.length < 2) return verts.slice();
  const out: LonLat[] = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    out.push(...densifyGreatCircle(a, b, maxSpacingDeg));
  }
  return out;
}
