/*
 * Spherical geometry.
 *
 * Everything here treats the Earth as a sphere and works in 3-D unit vectors. Nothing
 * interpolates lon/lat pairs directly -- that is a flat-plane operation which misbehaves
 * near the poles and across the antimeridian, and plate reconstructions spend a lot of
 * their time in both places.
 */

export const DEG = Math.PI / 180;

/** Unit vector for a lon/lat in degrees. Writes into `out` if given. */
export function lonLatToVec3(lonDeg, latDeg, out) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const cosLat = Math.cos(lat);
  out = out || [0, 0, 0];
  out[0] = cosLat * Math.cos(lon);
  out[1] = cosLat * Math.sin(lon);
  out[2] = Math.sin(lat);
  return out;
}

export function vec3ToLonLat(v) {
  return [
    Math.atan2(v[1], v[0]) / DEG,
    Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG,
  ];
}

/**
 * The local east and north unit vectors at a point, in world coordinates.
 *
 * This is the tangent frame used to turn (east, north) velocity components into a
 * direction on the sphere. It is the same basis an orthographic camera uses for its
 * first two rows, which is not a coincidence -- both are "the plane tangent at this
 * point".
 */
export function tangentFrame(lonDeg, latDeg, east, north) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);

  east[0] = -sinLon;
  east[1] = cosLon;
  east[2] = 0;

  north[0] = -sinLat * cosLon;
  north[1] = -sinLat * sinLon;
  north[2] = cosLat;
}

/** a × b, written into `out`. */
export function cross(a, b, out) {
  out = out || [0, 0, 0];
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Normalise in place. Returns the original length. */
export function normalise(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n > 0) { v[0] /= n; v[1] /= n; v[2] /= n; }
  return n;
}

/**
 * Unit tangent at `a` pointing towards `b`: the component of b perpendicular to a.
 *
 * This is the direction of travel along the great circle from a to b. Returns false if
 * the two points coincide, where the tangent is undefined.
 */
export function tangentTowards(a, b, out) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  out[0] = b[0] - dot * a[0];
  out[1] = b[1] - dot * a[1];
  out[2] = b[2] - dot * a[2];
  return normalise(out) > 1e-12;
}

/**
 * The point an angular distance `theta` from `base` in the direction of unit tangent
 * `dir`:  base·cos θ + dir·sin θ.
 *
 * This is the great circle the point is actually travelling along, which is what makes
 * it correct to use for velocity arrows and for offsetting a decoration off a boundary.
 */
export function travel(base, dir, theta, out) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out[0] = base[0] * c + dir[0] * s;
  out[1] = base[1] * c + dir[1] * s;
  out[2] = base[2] * c + dir[2] * s;
  return out;
}

/**
 * The "left of travel" direction on the sphere at `a`, heading along `tangent`.
 *
 * a × tangent. Sanity check: at a point on the equator heading north, this points west.
 * Defined on the sphere, so it is independent of any projection -- which is the whole
 * point, since the projected left/right depends on the projection's handedness.
 */
export function leftOfTravel(a, tangent, out) {
  return cross(a, tangent, out);
}
