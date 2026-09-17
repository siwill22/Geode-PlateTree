import {
  MOUSE, OrthographicCamera, PerspectiveCamera, PlaneGeometry, SphereGeometry,
  type BufferGeometry, type Camera,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  DEG, R_SURFACE, eastNorthAt, lonLatToVec3, vec3ToLonLat,
} from './constants';
import {
  ROBINSON_HALF_HEIGHT, ROBINSON_HALF_WIDTH, robinsonForward,
} from './robinson';
import { rotateVector, type Quaternion } from './rotation';

/**
 * How a volume-draped surface is mapped onto the screen -- see CONTEXT.md's
 * Projection entry and docs/adr/0003-plate-carree-as-first-alternate-projection.md.
 * Mollweide and Spilhaus are still expected later.
 *
 * `plateCarree` and `robinson` are both FLAT: they share a camera type, pan/zoom
 * controls, the antimeridian-seam problem, and the "reproject per vertex/per
 * fragment rather than rotate in 3D" treatment of Reference Plate (ADR-0030).
 * Where code cares about flat-vs-sphere rather than about which flat one, it
 * should ask `isFlat()` instead of testing for one by name -- that test was
 * `mode === 'plateCarree'` in several places, and every one of them was a latent
 * bug the moment a second flat projection existed.
 */
export type ProjectionMode = 'globe' | 'plateCarree' | 'robinson';

/** True for any flat map projection. See ProjectionMode. */
export function isFlat(mode: ProjectionMode): boolean {
  return mode !== 'globe';
}

/** Consumed by core/material.ts's uProjectionMode uniform -- must match the
 *  branch there and in GEOGRAPHIC_GLSL's worldToGeographic/worldToGeographicFlat. */
export const PROJECTION_UNIFORM: Record<ProjectionMode, number> = {
  globe: 0,
  plateCarree: 1,
  robinson: 2,
};

const PLATE_CARREE_MAP_WIDTH = 2 * Math.PI * R_SURFACE;
const PLATE_CARREE_MAP_HEIGHT = Math.PI * R_SURFACE;
const PLATE_CARREE_MARGIN = 1.15;

/**
 * Geometry for a volume-draped surface at `radius` in the given Projection.
 * A sphere needs many segments to read as smoothly curved; a flat plane's
 * fragment shader is exact under linear interpolation regardless of vertex
 * density (see worldToGeographicFlat), so 1x1 is enough -- there is no
 * curvature to approximate.
 *
 * `radius` bigger than R_SURFACE pushes a sphere surface radially outward to
 * avoid z-fighting between coincident layers (see climateInstance.ts's
 * OVERLAY_R). A flat plane has no radial direction, so the same intent is
 * expressed as a Z offset instead, at the map's fixed canonical width/height
 * -- scaling the plane's extent by `radius`, as an earlier version of this
 * did, changes its SIZE, not its depth, and does nothing to separate
 * coincident layers.
 */
export function createSurfaceGeometry(mode: ProjectionMode, radius: number = R_SURFACE): BufferGeometry {
  if (mode === 'globe') return new SphereGeometry(radius, 256, 128);
  // Robinson's outline is a curve, so its plane is the BOUNDING box of the map
  // and the fragment shader discards the corners that fall outside it (see
  // GEOGRAPHIC_GLSL's worldToGeographicRobinson). Still 1x1: the inverse is
  // evaluated per fragment, exactly, so vertex density buys nothing -- the same
  // reason Plate Carrée needs no tessellation.
  const [w, h] = mode === 'robinson'
    ? [2 * ROBINSON_HALF_WIDTH, 2 * ROBINSON_HALF_HEIGHT]
    : [PLATE_CARREE_MAP_WIDTH, PLATE_CARREE_MAP_HEIGHT];
  const geo = new PlaneGeometry(w, h, 1, 1);
  geo.translate(0, 0, radius - R_SURFACE);
  return geo;
}

/**
 * (lon, lat) degrees -> world position on the flat Plate Carrée plane, the
 * exact inverse of GEOGRAPHIC_GLSL's worldToGeographicFlat -- the CPU-side
 * counterpart for anything positioned per-vertex/per-instance rather than
 * per-fragment (wind glyphs/streaks; see core/windGlyphs.ts,
 * core/windStreaks.ts). `z` is the Plate Carrée equivalent of lonLatToVec3's
 * radius: a small constant offset, not a scale, keeps coincident layers
 * apart the same way createSurfaceGeometry's does.
 */
export function lonLatToFlatVec3(lon: number, lat: number, z = 0): [number, number, number] {
  return [lon * DEG * R_SURFACE, lat * DEG * R_SURFACE, z];
}

/** (lon, lat) -> world position in whichever flat Projection is active. The
 *  one place callers should go, so adding Mollweide later touches this and not
 *  every call site. Returns the sphere-radius vector for 'globe'. */
export function lonLatToProjected(
  mode: ProjectionMode, lon: number, lat: number, z = 0,
): [number, number, number] {
  if (mode === 'robinson') return robinsonForward(lon, lat, z);
  if (mode === 'plateCarree') return lonLatToFlatVec3(lon, lat, z);
  return lonLatToVec3(lon, lat, R_SURFACE);
}

/** Half the drawn width of a flat map, in world units -- what an
 *  antimeridian-seam test compares against. Plate Carrée's is pi*R; Robinson's
 *  is narrower, and using the wrong one leaves seam-spanning segments undrawn
 *  (or drawn) across a band of the map. */
export function flatHalfWidth(mode: ProjectionMode): number {
  return mode === 'robinson' ? ROBINSON_HALF_WIDTH : Math.PI * R_SURFACE;
}

/**
 * Every Projection, in the order a control should offer them: Globe first (the
 * default in every wrapper), then the flat pair with the less distorted one
 * first.
 *
 * One order for both control idioms in use -- paleobio's lil-gui dropdown lists
 * it, climate's and Valdes' single button cycles it -- so the two can never
 * disagree about what follows what. Adding Mollweide means adding it here, and
 * every viewer's control grows an entry without being touched.
 */
export const PROJECTION_ORDER: readonly ProjectionMode[] = ['globe', 'robinson', 'plateCarree'];

/** Display name, for a dropdown entry, tooltip or aria-label. */
export const PROJECTION_LABEL: Record<ProjectionMode, string> = {
  globe: 'Globe',
  robinson: 'Robinson',
  plateCarree: 'Plate Carrée',
};

/** The next Projection in `PROJECTION_ORDER`, wrapping at the end -- for a
 *  viewer whose control is one cycling button rather than a dropdown. */
export function nextProjection(mode: ProjectionMode): ProjectionMode {
  const i = PROJECTION_ORDER.indexOf(mode);
  return PROJECTION_ORDER[(i + 1) % PROJECTION_ORDER.length];
}

function isIdentity(q: Quaternion): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/**
 * Reanchor a TRUE (lon, lat) into a Reference Plate rotation's frame, then
 * reproject the result onto the flat Plate Carrée plane -- the Plate
 * Carrée counterpart of rotating a Globe sphere point by the SAME 3D
 * quaternion directly (see core/rotation.ts's docs/adr/0030 comments). A
 * flat plane's own Cartesian position isn't a 3D direction, so rotating IT
 * directly warps the map instead of reanchoring content (see
 * docs/plans/reference-plate.md's "Known issue" postmortem) -- this
 * instead rotates the TRUE point on the sphere, then reprojects the
 * ROTATED result back onto the flat map, exactly like redrawing a map
 * after the globe underneath it turned. Identity `qRef` (Reference Plate
 * 0, the overwhelmingly common case) short-circuits to the exact
 * bit-identical lonLatToFlatVec3(lon, lat, z) rather than round-tripping
 * through trig for no reason. Used by windStreaks.ts's respawn()/advect().
 */
export function referencePlateFlatPosition(
  lon: number, lat: number, qRef: Quaternion, z = 0,
): [number, number, number] {
  if (isIdentity(qRef)) return lonLatToFlatVec3(lon, lat, z);
  const [x0, y0, z0] = lonLatToVec3(lon, lat, 1);
  const [x1, y1, z1] = rotateVector(qRef, x0, y0, z0);
  const rotated = vec3ToLonLat(x1, y1, z1);
  return lonLatToFlatVec3(rotated.lon, rotated.lat, z);
}

/**
 * referencePlateFlatPosition() generalised to any Projection.
 *
 * Same order in every case, and the order is the whole point: reanchor on the
 * SPHERE, then lay the rotated result down in the target projection. Rotating
 * the projected position instead warps the map rather than moving content
 * across it (see docs/plans/reference-plate.md's postmortem, and ADR-0030).
 */
export function referencePlateProjectedPosition(
  mode: ProjectionMode, lon: number, lat: number, qRef: Quaternion, z = 0,
): [number, number, number] {
  if (isIdentity(qRef)) return lonLatToProjected(mode, lon, lat, z);
  const [x0, y0, z0] = lonLatToVec3(lon, lat, 1);
  const [x1, y1, z1] = rotateVector(qRef, x0, y0, z0);
  const rotated = vec3ToLonLat(x1, y1, z1);
  return lonLatToProjected(mode, rotated.lon, rotated.lat, z);
}

/**
 * Angular step used to read a projection's local orientation by finite
 * difference. Small enough that the map is linear over it at any plausible
 * zoom, large enough to stay well clear of float noise in the table lookups
 * Robinson's forward transform does.
 */
const DIRECTION_PROBE_DEG = 0.05;

/**
 * Which way a physical (east, north) tangent vector -- wind components, say --
 * points ON THE MAP, in the given flat Projection. Unnormalised; callers that
 * want a pure orientation normalise it themselves (windGlyphs.ts does).
 *
 * This exists because "the flat map's screen axes are the same everywhere" is
 * true of Plate Carrée and **false of flat maps in general**. Robinson's
 * parallels are straight and horizontal, so east really is +x -- but its
 * meridians curve, so north is not +y anywhere off the central meridian, and
 * both scale factors vary with latitude. Treating (u, v) as (x, y) there points
 * arrows visibly wrong away from the centre of the map.
 *
 * Rather than hand-differentiate each projection, this steps a short
 * great-circle distance along the vector's own bearing and differences the two
 * projected positions. That is exact for any projection -- including Robinson,
 * whose forward transform is a table interpolation with no closed-form
 * derivative -- and costs one extra forward projection per sample. A future
 * Mollweide needs nothing here.
 */
export function flatDirection(
  mode: ProjectionMode, lon: number, lat: number, u: number, v: number,
): [number, number, number] {
  const speed = Math.hypot(u, v);
  if (speed < 1e-12) return [0, 0, 0];

  // Unit tangent at (lon, lat) pointing along (u, v), as a 3D vector.
  const { east, north } = eastNorthAt(lon, lat);
  const tx = (u * east[0] + v * north[0]) / speed;
  const ty = (u * east[1] + v * north[1]) / speed;
  const tz = (u * east[2] + v * north[2]) / speed;

  // Walk that far along the great circle through (lon, lat) in direction t.
  // Rotating in the {p, t} plane keeps the result exactly on the sphere, so
  // no renormalisation is needed and the poles are not special.
  const [px, py, pz] = lonLatToVec3(lon, lat, 1);
  const d = DIRECTION_PROBE_DEG * DEG;
  const c = Math.cos(d);
  const s = Math.sin(d);
  const probe = vec3ToLonLat(px * c + tx * s, py * c + ty * s, pz * c + tz * s);

  const [x0, y0] = lonLatToProjected(mode, lon, lat, 0);
  const [x1, y1] = lonLatToProjected(mode, probe.lon, probe.lat, 0);

  // A probe that happens to cross the antimeridian projects to the far side of
  // the map and the difference comes out reversed and map-wide. Stepping
  // backwards instead and negating gives the same direction without the jump --
  // the sample is a few hundredths of a degree from the seam, not on it.
  let dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.abs(dx) > flatHalfWidth(mode)) {
    const back = vec3ToLonLat(px * c - tx * s, py * c - ty * s, pz * c - tz * s);
    const [xb, yb] = lonLatToProjected(mode, back.lon, back.lat, 0);
    dx = x0 - xb;
    return [dx, y0 - yb, 0];
  }
  return [dx, dy, 0];
}

/**
 * Like referencePlateProjectedPosition(), but also reanchors a local tangent
 * direction -- `(u, v)` in the physical east/north sense (constants.ts's
 * eastNorthAt), e.g. wind components -- for a caller that needs an on-map
 * direction as well as a position (windGlyphs.ts's arrows). The rotated
 * tangent is decomposed back onto the ROTATED location's own east/north
 * basis, then laid onto the map by flatDirection(): which physical (u, v) is
 * displayed changes with the Reference Plate, and how that (u, v) lies on the
 * page changes with the Projection, and those are two separate steps.
 */
export function referencePlateProjectedSample(
  mode: ProjectionMode, lon: number, lat: number, u: number, v: number,
  qRef: Quaternion, z = 0,
): { position: [number, number, number]; direction: [number, number, number] } {
  if (isIdentity(qRef)) {
    return {
      position: lonLatToProjected(mode, lon, lat, z),
      direction: flatDirection(mode, lon, lat, u, v),
    };
  }
  const { east, north } = eastNorthAt(lon, lat);
  const dx0 = u * east[0] + v * north[0];
  const dy0 = u * east[1] + v * north[1];
  const dz0 = u * east[2] + v * north[2];
  const [px0, py0, pz0] = lonLatToVec3(lon, lat, 1);
  const [px1, py1, pz1] = rotateVector(qRef, px0, py0, pz0);
  const [dx1, dy1, dz1] = rotateVector(qRef, dx0, dy0, dz0);
  const rotated = vec3ToLonLat(px1, py1, pz1);
  const { east: east2, north: north2 } = eastNorthAt(rotated.lon, rotated.lat);
  const u2 = dx1 * east2[0] + dy1 * east2[1] + dz1 * east2[2];
  const v2 = dx1 * north2[0] + dy1 * north2[1] + dz1 * north2[2];
  return {
    position: lonLatToProjected(mode, rotated.lon, rotated.lat, z),
    direction: flatDirection(mode, rotated.lon, rotated.lat, u2, v2),
  };
}

/**
 * Plate Carrée's east/north tangent directions, which are the same everywhere
 * on that projection -- no meridian convergence, no pole degeneracy.
 *
 * Deliberately named for Plate Carrée rather than for flat maps in general:
 * an earlier version of this comment claimed the constancy as a property of
 * flat projections, which is false the moment a second one exists. Robinson's
 * meridians converge like the sphere's do. Anything needing a tangent
 * direction on an arbitrary flat map wants flatDirection(), not these; these
 * remain only for a caller that has already established it is on Plate Carrée
 * and wants the degenerate case without a function call.
 */
export const PLATE_CARREE_EAST: readonly [number, number, number] = [1, 0, 0];
export const PLATE_CARREE_NORTH: readonly [number, number, number] = [0, 1, 0];

/** World-unit height of the orthographic frustum that contains the whole
 *  2:1 Plate Carrée map at `aspect`, plus a little headroom -- a "fit by
 *  height" alone would crop the map's width on any tile squarer than 2:1
 *  (every climate tile is roughly square), so this fits by whichever
 *  dimension is the binding constraint, the same idea as CSS
 *  `object-fit: contain`. */
function flatFrustumHeight(mode: ProjectionMode, aspect: number): number {
  const [w, h] = mode === 'robinson'
    ? [2 * ROBINSON_HALF_WIDTH, 2 * ROBINSON_HALF_HEIGHT]
    : [PLATE_CARREE_MAP_WIDTH, PLATE_CARREE_MAP_HEIGHT];
  return Math.max(h, w / aspect) * PLATE_CARREE_MARGIN;
}

/**
 * Which flat Projection an orthographic camera was framed for.
 *
 * Stashed on the camera because `updateProjectionCameraAspect()` is called from
 * every wrapper's resize handler with just (camera, aspect) and has no way to
 * ask. Robinson's map is a different shape from Plate Carrée's 2:1, so resizing
 * a Robinson view through Plate Carrée's frustum silently reframes it -- the
 * kind of thing that only shows up as "the map jumps a bit when I resize".
 */
function modeOf(camera: Camera): ProjectionMode {
  return (camera.userData.projectionMode as ProjectionMode) ?? 'plateCarree';
}

/** A fresh camera for `mode`, framed at a sensible starting view. Globe and
 *  Plate Carrée need genuinely different camera types (perspective/orbit vs.
 *  orthographic/pan -- see ADR-0003), so switching Projection always means
 *  building a new camera object, never reconfiguring the old one in place. */
export function createProjectionCamera(mode: ProjectionMode, aspect: number): Camera {
  if (mode === 'globe') {
    const camera = new PerspectiveCamera(45, aspect, 0.01, 50);
    camera.position.set(2.6, 1.4, 2.2);
    return camera;
  }
  const h = flatFrustumHeight(mode, aspect);
  const camera = new OrthographicCamera(-(h * aspect) / 2, (h * aspect) / 2, h / 2, -h / 2, 0.01, 50);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.userData.projectionMode = mode;
  return camera;
}

/** Keep a Projection camera's frustum matched to the current aspect ratio,
 *  at whatever zoom/distance the user has already dialled in -- the
 *  Plate-Carrée equivalent of a perspective camera's `camera.aspect = ...`.
 *  A no-op for a PerspectiveCamera passed the same aspect it already has;
 *  three.js only needs updateProjectionMatrix() after left/right/top/bottom
 *  or aspect actually change. */
export function updateProjectionCameraAspect(camera: Camera, aspect: number): void {
  if (camera instanceof PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  } else if (camera instanceof OrthographicCamera) {
    const h = flatFrustumHeight(modeOf(camera), aspect);
    camera.left = -(h * aspect) / 2;
    camera.right = (h * aspect) / 2;
    camera.top = h / 2;
    camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
  }
}

/** OrbitControls configured for `mode`: free orbit + dolly-zoom for Globe,
 *  or pan + zoom with no rotation for Plate Carrée -- an undistorted flat
 *  map has no "orbit" to speak of. OrbitControls dollies a PerspectiveCamera
 *  but drives an OrthographicCamera's .zoom on scroll instead, which is
 *  exactly the zoom-without-perspective-change a flat map needs, so no
 *  separate zoom implementation is required. Always a new instance, never a
 *  reconfigured old one -- see createProjectionCamera's own doc comment. */
export function createProjectionControls(
  mode: ProjectionMode, camera: Camera, domElement: HTMLElement,
): OrbitControls {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  if (mode === 'globe') {
    controls.enableRotate = true;
    controls.enablePan = false;
    controls.minDistance = R_SURFACE + 0.1;
    controls.maxDistance = 12;
  } else {
    controls.enableRotate = false;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.minZoom = 0.4;
    controls.maxZoom = 8;
    // OrbitControls' default LEFT-button action is ROTATE, with a built-in
    // Ctrl/Meta/Shift modifier swap to PAN -- with enableRotate false, plain
    // left-drag hit the disabled ROTATE branch and did nothing, so panning
    // only worked while holding a modifier. Remapping LEFT to PAN directly
    // makes plain drag pan, matching a flat map's expected interaction.
    controls.mouseButtons.LEFT = MOUSE.PAN;
  }
  return controls;
}
