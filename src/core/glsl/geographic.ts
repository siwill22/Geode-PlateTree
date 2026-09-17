import { EARTH_RADIUS_KM, R_SURFACE } from '../constants';
import {
  ROBINSON_KX, ROBINSON_KY, ROBINSON_STEP, ROBINSON_X, ROBINSON_Y, robinsonGlslTable,
} from '../robinson';

/**
 * The world -> geographic -> texture mapping, in GLSL, written exactly once.
 *
 * Every shader that reads a raster or the volume needs this, and it used to be
 * copy-pasted into each of them: the cutaway/floor material, the globe surface,
 * the coastline lines and the land fill. The isosurface would have made a sixth
 * copy -- and that is the copy that matters, because an isosurface and the wall
 * it crosses have to agree. Half a texel of disagreement puts a blob visibly
 * beside the colour contour it is supposed to trace, which looks like a
 * rendering nuance rather than a bug.
 *
 * Interpolate GEOGRAPHIC_GLSL into a fragment shader's preamble. The functions
 * take everything as arguments and reference no uniforms, so a shader can use
 * only the parts it needs.
 */
export const GEOGRAPHIC_GLSL = /* glsl */ `
#ifndef GEODE_GEOGRAPHIC
#define GEODE_GEOGRAPHIC

const float PI = 3.141592653589793;
const float R_SURFACE = ${R_SURFACE.toFixed(1)};
const float EARTH_RADIUS_KM = ${EARTH_RADIUS_KM.toFixed(1)};

/**
 * World position -> (lon, lat) in radians.
 *
 * NOTE atan(-p.z, p.x), NOT atan(p.z, p.x). The viewer frame is (X, Z, -Y) of
 * the geographic frame -- see constants.ts. Dropping the minus sign mirrors the
 * Earth and is self-consistent enough to be invisible in blobby data.
 */
vec2 worldToGeographic(vec3 p) {
  float r = length(p);
  return vec2(atan(-p.z, p.x), asin(clamp(p.y / r, -1.0, 1.0)));
}

/** (lon, lat) radians -> equirectangular uv: the layout of every 2D raster here. */
vec2 geographicToUV(vec2 ll) {
  return vec2((ll.x + PI) / (2.0 * PI), (ll.y + PI * 0.5) / PI);
}

/**
 * World position -> (lon, lat) in radians, for the flat Plate Carrée plane
 * (see core/projection.ts) rather than the sphere. The plane's x/y ARE the
 * equirectangular layout, scaled linearly by R_SURFACE -- no trig, and exact
 * under interpolation everywhere on the plane, unlike worldToGeographic's
 * sphere inverse. West is negative x (left edge, lon -180) and north is
 * positive y (top edge, lat +90), the reading direction any flat map is
 * expected to have -- a convention specific to this plane, independent of
 * worldToGeographic's sphere-embedding handedness above.
 */
vec2 worldToGeographicFlat(vec3 p) {
  return vec2(p.x / R_SURFACE, p.y / R_SURFACE);
}

${robinsonGlslTable('ROBINSON_X', ROBINSON_X)}
${robinsonGlslTable('ROBINSON_Y', ROBINSON_Y)}
const float ROBINSON_KX = ${ROBINSON_KX};
const float ROBINSON_KY = ${ROBINSON_KY};
const float ROBINSON_STEP = ${ROBINSON_STEP.toFixed(1)};

/**
 * World position -> (lon, lat) in radians on the Robinson map plane, or a
 * sentinel outside it.
 *
 * The GLSL twin of core/robinson.ts's robinsonInverse(); the table literals
 * above are generated FROM that module's own arrays, so there is one set of
 * numbers rather than two transcriptions that can drift.
 *
 * Robinson is tabulated and has no closed form, but Y(lat) is strictly
 * increasing, so latitude comes from an exact table bracket and longitude from
 * evaluating X at the recovered latitude -- no iteration, which is what makes it
 * affordable per fragment.
 *
 * Returns lon outside [-PI, PI] to signal "off the map". The caller MUST
 * discard there and must not clamp: Robinson's boundary is a curve, so a
 * rectangular plane large enough to hold the map has corners that are not on
 * the Earth at all, and clamping grows rectangular ears of smeared polar data
 * where the map should simply end.
 */
vec2 worldToGeographicRobinson(vec3 p) {
  float ay = abs(p.y) / (ROBINSON_KY * R_SURFACE);
  if (ay > ROBINSON_Y[18]) return vec2(10.0, 0.0);

  int i = 17;
  for (int k = 0; k < 18; k++) {
    if (ay <= ROBINSON_Y[k + 1]) { i = k; break; }
  }
  float span = ROBINSON_Y[i + 1] - ROBINSON_Y[i];
  float f = span == 0.0 ? 0.0 : (ay - ROBINSON_Y[i]) / span;

  float latDeg = (float(i) + f) * ROBINSON_STEP * (p.y < 0.0 ? -1.0 : 1.0);
  float xf = ROBINSON_X[i] + (ROBINSON_X[i + 1] - ROBINSON_X[i]) * f;
  float lon = p.x / (ROBINSON_KX * R_SURFACE * xf);
  if (abs(lon) > PI) return vec2(10.0, 0.0);
  return vec2(lon, latDeg * PI / 180.0);
}

/** True where worldToGeographicRobinson returned its off-the-map sentinel. */
bool robinsonOffMap(vec2 ll) {
  return abs(ll.x) > PI + 1.0;
}

/** World position -> depth below the surface, in km. No vertical exaggeration. */
float worldDepthKm(vec3 p) {
  return (R_SURFACE - length(p)) * EARTH_RADIUS_KM;
}

/**
 * (lon, lat, depth) -> volume texture coordinates.
 *
 * Half-texel offsets. Longitude wraps and has no duplicate column, so it needs a
 * +0.5/nlon shift; latitude and depth include both endpoints, so they map to
 * (p*(N-1)+0.5)/N. Sampling at raw p puts every value half a cell off.
 */
vec3 volumeUVW(vec2 ll, float depthKm, float depthMin, float depthMax, vec3 grid) {
  float pLon = (ll.x + PI) / (2.0 * PI);
  float pLat = (ll.y + PI * 0.5) / PI;
  float pDep = clamp((depthKm - depthMin) / (depthMax - depthMin), 0.0, 1.0);
  return vec3(
    pLon + 0.5 / grid.x,
    (pLat * (grid.y - 1.0) + 0.5) / grid.y,
    (pDep * (grid.z - 1.0) + 0.5) / grid.z
  );
}

/**
 * Rotate a vector by a unit quaternion -- v' = q*v*q^-1, expanded. The GLSL
 * twin of core/rotation.ts's rotateVector(), for the Reference Plate
 * rotation applied per-vertex (see core/material.ts's VERT shader and
 * docs/adr/0030). q must already be in whatever frame v is in -- see
 * toRenderFrameRotation() on the JS side, which is what every uRefQuat
 * uniform is set from.
 */
vec3 rotateByQuat(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

/** Conjugate of a unit quaternion -- its inverse rotation. */
vec4 conjugateQuat(vec4 q) {
  return vec4(-q.xyz, q.w);
}

/**
 * (lon, lat) radians -> unit-length RENDER-frame direction -- the inverse of
 * worldToGeographic at radius 1. Only needed for the Plate Carrée Reference
 * Plate round-trip (see core/material.ts's FRAG shader): the flat plane
 * can't rotate in 3D the way the Globe sphere does (docs/adr/0030), so
 * instead each fragment's DISPLAY (lon, lat) is converted to a direction,
 * unrotated by uRefQuat's conjugate, and converted back -- recovering which
 * TRUE (lon, lat) belongs at that fixed display position.
 */
vec3 lonLatToUnit(vec2 ll) {
  float cl = cos(ll.y);
  return vec3(cl * cos(ll.x), sin(ll.y), -cl * sin(ll.x));
}

#endif
`;
