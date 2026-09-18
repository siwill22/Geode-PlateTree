import type { LonLat } from './constants';
import { fetchVolumeBytes } from './volume';
import { rotationAt, rotateVector, conjugateQuaternion } from './rotation';
import { loadReconstructionManifest, reconstructionAssetPath } from './reconstructions';
import { fetchPlateNames, type PlateNameTable } from './plateNames';
import type { ArchiveIndex, RotationTable, StaticPolygon } from './types';

/** Parse staticpolygons/geometry.bin (see prep_staticpolygons.py for the
 *  layout). Points are present-day unit vectors in the GEOGRAPHIC frame
 *  (X -> 0N/0E, Y -> 0N/90E, Z -> pole) -- the same frame coastlines.ts's
 *  geometry uses and the one RotationTable's quaternions act in. Never mix
 *  this with the viewer's (X, Z, -Y) render frame. */
export function parseStaticPolygons(buf: ArrayBuffer): StaticPolygon[] {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3),
  );
  if (magic !== 'ESSP') throw new Error(`bad static-polygon magic: ${magic}`);
  const version = dv.getUint32(4, true);
  if (version !== 1) {
    throw new Error(
      `static polygons are version ${version}, expected 1 -- re-run prep_staticpolygons.py`,
    );
  }
  const npolys = dv.getUint32(8, true);

  const polygons: StaticPolygon[] = [];
  let o = 12;
  for (let i = 0; i < npolys; i++) {
    const plateId = dv.getInt32(o, true); o += 4;
    const continental = dv.getUint8(o) !== 0; o += 4; // 1 byte + 3 padding
    const beginAge = dv.getFloat32(o, true); o += 4;
    const endAge = dv.getFloat32(o, true); o += 4;
    const npts = dv.getUint32(o, true); o += 4;
    const points = new Float32Array(buf, o, npts * 3);
    o += npts * 3 * 4;
    polygons.push({ plateId, continental, beginAge, endAge, points });
  }
  return polygons;
}

export interface StaticPolygonData {
  polygons: StaticPolygon[];
  table: RotationTable;
  /** Empty for a model whose source data carries no plate names at all
   *  (e.g. Scotese) -- see CONTEXT.md's Reference Plate entry and
   *  prep_plate_names.py. Bundled here (not fetched separately) since it
   *  comes from the same Reconstruction Model manifest as the rest of this
   *  data, fetched in the same step. */
  plateNames: PlateNameTable;
}

/** Fetch and parse static-polygon geometry plus the rotation table it shares
 *  with the same Reconstruction Model's coastlines (see
 *  prep_reconstruction.py -- plate ids from both sources are unioned before
 *  that file is written, so every plate id here has a rotation). Also
 *  fetches the Reference Plate name lookup, if this model has one --
 *  `plateNamesPath` is undefined whenever has_plate_names was false. */
export async function fetchStaticPolygonData(
  base: string, geometryPath: string, rotationsPath: string, plateNamesPath?: string,
): Promise<StaticPolygonData> {
  const [gBytes, rBytes, plateNames] = await Promise.all([
    fetchVolumeBytes(`${base}/${geometryPath}`),
    fetchVolumeBytes(`${base}/${rotationsPath}`),
    fetchPlateNames(base, plateNamesPath),
  ]);
  const polygons = parseStaticPolygons(
    gBytes.buffer.slice(gBytes.byteOffset, gBytes.byteOffset + gBytes.byteLength) as ArrayBuffer,
  );
  const table: RotationTable = JSON.parse(new TextDecoder().decode(rBytes));
  return { polygons, table, plateNames };
}

/**
 * Which Reconstruction Model id a climate-family Manifest's static polygons
 * come from -- docs/adr/0026's accepted debt: unlike e.g.
 * muller2019-deformation (docs/adr/0004), climate-family manifests carry no
 * explicit `reconstruction_model` field of their own, so this mirrors
 * core/coastlines.ts's resolveCoastlineSet() type-based switch instead of a
 * real declared lookup. Tracked as a comment on GitHub issue #5 -- once
 * climate manifests get a real reconstruction_model field, delete this in
 * favour of the same lookup every other Reconstruction-Model-aware consumer
 * already uses.
 */
export function resolveStaticPolygonReconstructionId(
  manifest: { type: string; reconstruction_model?: string },
): string | null {
  if (manifest.reconstruction_model) return manifest.reconstruction_model.toLowerCase();
  switch (manifest.type) {
    case 'climate':
    case 'climate-monthly':
    case 'climate-ocean-depth':
    case 'paleogeography':
      return 'scotese';
    default:
      return null;
  }
}

/**
 * Resolve AND fetch a Manifest's static-polygon data in one step -- null if
 * this Reconstruction Model isn't cataloged, has no static polygons, or
 * doesn't apply to `manifest` at all (resolveStaticPolygonReconstructionId()
 * returned null). A real fetch, not just a path lookup (unlike
 * resolveCoastlineSet()): static-polygon paths live inside the Reconstruction
 * Model's OWN manifest.json (ReconstructionManifest.static_polygons), not
 * directly on ArchiveIndex the way CoastlineSet is -- see docs/adr/0021.
 */
export async function loadStaticPolygonDataFor(
  base: string, archive: ArchiveIndex, manifest: { type: string; reconstruction_model?: string },
): Promise<StaticPolygonData | null> {
  const id = resolveStaticPolygonReconstructionId(manifest);
  if (!id) return null;
  const entry = archive.reconstruction_models?.find((r) => r.id === id);
  if (!entry?.has_static_polygons) return null;
  const rm = await loadReconstructionManifest(base, entry.path);
  if (!rm.static_polygons) return null;
  return fetchStaticPolygonData(
    base,
    reconstructionAssetPath(rm, rm.static_polygons.geometry),
    reconstructionAssetPath(rm, rm.static_polygons.rotations),
    rm.static_polygons.plate_names
      ? reconstructionAssetPath(rm, rm.static_polygons.plate_names)
      : undefined,
  );
}

function lonLatToGeographicXYZ(lon: number, lat: number): [number, number, number] {
  const lonR = lon * (Math.PI / 180);
  const latR = lat * (Math.PI / 180);
  const cl = Math.cos(latR);
  return [cl * Math.cos(lonR), cl * Math.sin(lonR), Math.sin(latR)];
}

function geographicXYZToLonLat(x: number, y: number, z: number): LonLat {
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, z / r))) * (180 / Math.PI),
    lon: Math.atan2(y, x) * (180 / Math.PI),
  };
}

/** Signed area (steradians) of the spherical triangle (a, b, c), via the Van
 *  Oosterom-Strackee formula -- used both for polygon area (fan-triangulated
 *  from vertex 0) and, with the query point as apex, for the point-in-polygon
 *  test below. Sign follows the vertex winding, which is what lets both uses
 *  work on a concave (but still simple, non-self-intersecting) polygon. */
function sphericalTriangleSignedArea(
  a: [number, number, number], b: [number, number, number], c: [number, number, number],
): number {
  const triple = a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const bc = b[0] * c[0] + b[1] * c[1] + b[2] * c[2];
  const ca = c[0] * a[0] + c[1] * a[1] + c[2] * a[2];
  return 2 * Math.atan2(triple, 1 + ab + bc + ca);
}

/** Area of a present-day static polygon, in steradians. Rotation-invariant
 *  (a rigid rotation doesn't change area), so this is computed once from the
 *  stored present-day ring -- no need to rotate to any particular age first.
 *  Used to break ties among overlapping candidates in assignPlate() (see
 *  docs/adr/0025: the larger polygon wins), and as the weight behind
 *  platetree/lockedGroupFlow.ts's Sankey -- a Locked Group's mass, not how
 *  many fragments its id happens to be split across. */
export function polygonArea(points: Float32Array): number {
  const n = points.length / 3;
  if (n < 3) return 0;
  const ax = points[0], ay = points[1], az = points[2];
  let area = 0;
  for (let i = 1; i < n - 1; i++) {
    const bx = points[i * 3], by = points[i * 3 + 1], bz = points[i * 3 + 2];
    const j = i + 1;
    const cx = points[j * 3], cy = points[j * 3 + 1], cz = points[j * 3 + 2];
    area += sphericalTriangleSignedArea([ax, ay, az], [bx, by, bz], [cx, cy, cz]);
  }
  return Math.abs(area);
}

/** Every polygon's own area (steradians), in the same order as `polygons` --
 *  computed once and reused at every age, since polygonArea() is
 *  rotation-invariant and does not depend on `age` at all. */
export function computePolygonAreas(polygons: StaticPolygon[]): Float64Array {
  return Float64Array.from(polygons, (p) => polygonArea(p.points));
}

/**
 * Total area (steradians) of each plate id's geometry AT `age` -- summed
 * over whichever of that plate's static-polygon fragments are valid then
 * (the same beginAge/endAge window test assignPlate() uses). A plate id with
 * several disjoint fragments under it (a continent plus its skirt of
 * surrounding oceanic crust, both carrying the same reconstruction plate id)
 * gets their combined area, which is the point: plate COUNT treats such a
 * plate the same as a single microplate fragment, area does not.
 *
 * `areas` is computePolygonAreas(polygons)'s own output, passed in rather
 * than recomputed here so a caller building this per Frame (e.g.
 * lockedGroupFlow.ts, once per sampled age) pays the O(vertices) area cost
 * once for the whole model, not once per age.
 */
export function plateAreasAt(
  polygons: StaticPolygon[], areas: Float64Array, age: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < polygons.length; i++) {
    const poly = polygons[i];
    // Ages increase into the past, so beginAge is the LARGER value -- see
    // assignPlate()'s identical test above.
    if (age > poly.beginAge || age < poly.endAge) continue;
    out.set(poly.plateId, (out.get(poly.plateId) ?? 0) + areas[i]);
  }
  return out;
}

/** Spherical point-in-polygon test: project every polygon vertex onto the
 *  tangent plane at `p` (the component perpendicular to `p`), then sum the
 *  signed turning angle between consecutive projected directions around the
 *  loop -- the spherical generalisation of the planar "sum of signed angles"
 *  winding test. Totals +-2pi if `p` is enclosed, ~0 otherwise (verified
 *  numerically: exactly 2pi inside, ~1e-16 outside, for a simple test
 *  polygon). Works in pure 3D vectors, so it needs no antimeridian or pole
 *  special-casing the way a planar lon/lat ray cast would (the same reason
 *  the boundary-frame exporter works in vectors, not degrees -- see its own
 *  "antimeridian" note in boundaries.json). `points` is the present-day
 *  ring, treated as implicitly closed (last vertex connects back to the
 *  first), matching how prep_staticpolygons.py stores it.
 *
 *  NOT the same computation as polygonArea() above: fan-triangulating from
 *  an apex and summing signed AREA is apex-invariant (it always recovers
 *  the polygon's own area, whether the apex is inside or outside -- the
 *  spherical shoelace formula), so it cannot answer "is `p` inside" at all.
 *  This sums ANGLES at `p` itself instead, which is what actually
 *  distinguishes inside from outside.
 *
 *  BROKEN for a `p`/polygon pair more than roughly a hemisphere apart:
 *  projecting onto the tangent plane AT `p` (a gnomonic-style projection) has
 *  no way to represent a vertex on the far side of the sphere from `p` --
 *  each `dirs[i]` still comes out as SOME finite direction, so the winding
 *  sum can still land near +-2pi purely by coincidence of how the far-side
 *  vertices happen to project, a false "inside". Confirmed directly: a
 *  compact North America polygon (33 degree radius from its own centroid)
 *  reporting `true` for a Southern Ocean point 173 degrees from that same
 *  centroid. assignPlate() below guards every call here with a cheap
 *  centroid+radius pre-filter for exactly this reason -- never call this
 *  directly without one unless the caller already knows `p` is plausibly
 *  close. */
function isPointInPolygon(p: [number, number, number], points: Float32Array): boolean {
  const n = points.length / 3;
  const pDotP = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];

  const dirs: [number, number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const vx = points[i * 3], vy = points[i * 3 + 1], vz = points[i * 3 + 2];
    const d = (vx * p[0] + vy * p[1] + vz * p[2]) / pDotP;
    const tx = vx - d * p[0], ty = vy - d * p[1], tz = vz - d * p[2];
    const n_ = Math.hypot(tx, ty, tz) || 1;
    dirs[i] = [tx / n_, ty / n_, tz / n_];
  }

  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay, az] = dirs[i];
    const [bx, by, bz] = dirs[j];
    const crossX = ay * bz - az * by, crossY = az * bx - ax * bz, crossZ = ax * by - ay * bx;
    const sinPart = crossX * p[0] + crossY * p[1] + crossZ * p[2];
    const cosPart = ax * bx + ay * by + az * bz;
    total += Math.atan2(sinPart, cosPart);
  }
  return Math.abs(total) > Math.PI;
}

function angularDistance(a: [number, number, number], b: [number, number, number]): number {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot);
}

function polygonCentroid(points: Float32Array): [number, number, number] {
  const n = points.length / 3;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) { x += points[i * 3]; y += points[i * 3 + 1]; z += points[i * 3 + 2]; }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Arc-length-weighted centroid of the polygon's BOUNDARY -- each edge's
 * midpoint weighted by that edge's arc length, summed around the closed ring
 * and renormalised onto the sphere.
 *
 * Distinct from `polygonCentroid()` above, which is the unweighted mean of the
 * vertices, and the difference is not negligible on a real static polygon: a
 * ring digitised with dense vertices along one margin and sparse ones along
 * another has its vertex mean pulled toward the dense side, while its boundary
 * centroid does not care how the ring was sampled.
 *
 * This one exists because it is what pygplates' `get_boundary_centroid()`
 * computes, and therefore what `gprm.utils.platetree`'s
 * `get_polygon_centroids()` -- the reference this viewer's Tree Node positions
 * are checked against -- actually returns. `polygonCentroid()` keeps its own
 * callers and meaning; neither is a replacement for the other.
 */
export function polygonBoundaryCentroid(points: Float32Array): [number, number, number] {
  const n = points.length / 3;
  if (n < 2) return polygonCentroid(points);
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // closed ring: last vertex joins the first
    const ax = points[i * 3], ay = points[i * 3 + 1], az = points[i * 3 + 2];
    const bx = points[j * 3], by = points[j * 3 + 1], bz = points[j * 3 + 2];
    // Arc length from the CHORD, not from acos(dot). acos loses catastrophic
    // precision for nearly-parallel unit vectors, which is every edge of a
    // densely digitised ring: at float32 storage precision the dot product
    // carries ~1e-7 of error, and acos turns that into ~4e-4 rad -- comparable
    // to the ~1e-3 rad edges themselves. Measured: it put Cao 2024's plate 8011
    // node 1.68 degrees from where pygplates puts it, worst on exactly the
    // rings with the most vertices (3137, 3978). 2*asin(chord/2) is exact for
    // the same geometry and stable as the chord goes to zero.
    const cx = ax - bx, cy = ay - by, cz = az - bz;
    const chord = Math.hypot(cx, cy, cz);
    const arc = 2 * Math.asin(Math.min(1, chord / 2));
    if (arc === 0) continue;
    let mx = ax + bx, my = ay + by, mz = az + bz;
    const ml = Math.hypot(mx, my, mz);
    // Antipodal endpoints have no well-defined midpoint; such an edge cannot
    // occur in a real ring, and skipping it is safer than emitting NaN.
    if (ml === 0) continue;
    mx /= ml; my /= ml; mz /= ml;
    x += mx * arc; y += my * arc; z += mz * arc;
  }
  const len = Math.hypot(x, y, z);
  if (len === 0) return polygonCentroid(points);
  return [x / len, y / len, z / len];
}

/** Largest angle from `centroid` to any of the polygon's own vertices -- a
 *  spherical cap of this radius, centred at `centroid`, is GUARANTEED to
 *  contain the whole polygon whenever the radius is under 90 degrees (a cap
 *  that size is geodesically convex, so the geodesic edge between any two
 *  vertices inside it stays inside it too). Every real static polygon is
 *  well under this -- a continent-scale block spanning a full hemisphere
 *  from its own centroid would be extraordinary. */
function polygonRadius(points: Float32Array, centroid: [number, number, number]): number {
  const n = points.length / 3;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const d = angularDistance(centroid, [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]);
    if (d > best) best = d;
  }
  return best;
}

/** Cached per polygon object (not per call -- assignPlate() runs this
 *  pre-filter against all ~250 candidates on every single click, and a
 *  polygon's own centroid/radius never change). A WeakMap rather than a
 *  field on StaticPolygon itself: that type is also the plain wire shape
 *  test fixtures construct directly (see check_static_polygons.mjs), and
 *  keeping these derived-only values out of it means no fixture needs to
 *  know they exist. */
const polygonBounds = new WeakMap<StaticPolygon, { centroid: [number, number, number]; radius: number }>();

function boundsFor(poly: StaticPolygon): { centroid: [number, number, number]; radius: number } {
  let b = polygonBounds.get(poly);
  if (!b) {
    const centroid = polygonCentroid(poly.points);
    b = { centroid, radius: polygonRadius(poly.points, centroid) };
    polygonBounds.set(poly, b);
  }
  return b;
}

const HALF_PI = Math.PI / 2;

export interface PlateAssignment {
  plateId: number;
  continental: boolean;
  /** Larger Ma value: when this crust appeared. See docs/adr/0025 -- every
   *  age older than this reports "no plate here yet", uniformly, with no
   *  further per-age polygon testing needed. */
  beginAge: number;
}

/**
 * Assign a reference-age click to a static polygon -- ADR-0025's whole
 * "cannot answer" design rests on this being a SINGLE point-in-polygon test,
 * never repeated per age. Returns null if no static polygon covers `at` at
 * `referenceAge`: a real, expected outcome (crust that hadn't formed yet, or
 * simply outside this Reconstruction Model's static-polygon coverage), not
 * an error -- there is no retry and no fallback (dynamic-polygon assignment
 * is deferred, see ADR-0025's "Deferred" section).
 *
 * When more than one polygon covers the point (real and age-dependent: 0 of
 * 3000 sampled points overlapped at 0 Ma for Muller 2019, growing to 64/3000
 * by 150 Ma, confirmed directly -- see ADR-0025), the LARGEST overlapping
 * polygon wins: better geological constraint on a larger block's
 * reconstructed position, not polygon size for its own sake.
 *
 * Implementation note: rather than rotating every candidate polygon's ring
 * forward to `referenceAge` (O(ring points) per candidate), the query point
 * is rotated backward by each candidate's OWN inverse rotation instead and
 * tested against that polygon's present-day ring directly -- O(1) per
 * candidate, and exactly equivalent since rotating both sides of a
 * containment test by the same rotation preserves it.
 *
 * Every candidate is gated by a cheap centroid+radius pre-filter
 * (boundsFor()) before the real (but hemisphere-limited, see its own doc
 * comment) isPointInPolygon() ever runs -- discovered directly from a real
 * click: a Southern Ocean point at 107 Ma was assigned to North America's
 * polygon, 173 degrees from that polygon's own 33-degree radius, because
 * isPointInPolygon()'s tangent-plane projection produces false positives for
 * a point/polygon pair that far apart. The pre-filter makes that regime
 * unreachable: only polygons the point could plausibly be inside (within
 * their own bounding cap) ever reach the real test.
 */
export function assignPlate(
  polygons: StaticPolygon[], table: RotationTable, at: LonLat, referenceAge: number,
): PlateAssignment | null {
  const p = lonLatToGeographicXYZ(at.lon, at.lat);

  let best: { area: number; poly: StaticPolygon } | null = null;
  for (const poly of polygons) {
    // Ages increase into the past, so beginAge is the LARGER value -- see
    // coastlines.ts's identical appearAge/disappearAge convention.
    if (referenceAge > poly.beginAge || referenceAge < poly.endAge) continue;

    const qInv = conjugateQuaternion(rotationAt(table, poly.plateId, referenceAge));
    const pAtPresent = rotateVector(qInv, p[0], p[1], p[2]);

    const { centroid, radius } = boundsFor(poly);
    if (radius < HALF_PI && angularDistance(pAtPresent, centroid) > radius) continue;
    if (!isPointInPolygon(pAtPresent, poly.points)) continue;

    const area = polygonArea(poly.points);
    if (!best || area > best.area) best = { area, poly };
  }
  if (!best) return null;
  return {
    plateId: best.poly.plateId,
    continental: best.poly.continental,
    beginAge: best.poly.beginAge,
  };
}

/** A Query Point pinned to a material point on a Plate rather than a fixed
 *  grid cell -- see CONTEXT.md's Plate-Frame Point entry and docs/adr/0025.
 *  `presentDayXYZ` is the assigned material point's own present-day
 *  position (geographic frame): the reference-age click rotated back by the
 *  SAME plate rotation it was assigned under, so its position at any other
 *  age is one forward rotation away -- see positionAt(). */
export interface PlateFramePoint {
  plateId: number;
  continental: boolean;
  beginAge: number;
  presentDayXYZ: [number, number, number];
}

/** Build a Plate-Frame Point from a successful assignPlate() result. Kept
 *  separate from assignPlate() itself so a caller can inspect the
 *  assignment (e.g. show the plate id) before committing to it. */
export function createPlateFramePoint(
  assignment: PlateAssignment, table: RotationTable, at: LonLat, referenceAge: number,
): PlateFramePoint {
  const p = lonLatToGeographicXYZ(at.lon, at.lat);
  const qInv = conjugateQuaternion(rotationAt(table, assignment.plateId, referenceAge));
  const presentDayXYZ = rotateVector(qInv, p[0], p[1], p[2]);
  return {
    plateId: assignment.plateId,
    continental: assignment.continental,
    beginAge: assignment.beginAge,
    presentDayXYZ,
  };
}

/**
 * This Plate-Frame Point's position at `age` -- null if `age` is older than
 * the assigned polygon's own begin age (docs/adr/0025: "no plate here yet",
 * not an error; never too young, since every static polygon persists to
 * present by construction). No per-age polygon re-testing: point-in-polygon
 * containment is invariant under a shared rigid rotation, so the single
 * assignment made at click time bounds every age at once.
 */
export function positionAt(point: PlateFramePoint, table: RotationTable, age: number): LonLat | null {
  if (age > point.beginAge) return null;
  const q = rotationAt(table, point.plateId, age);
  const [x, y, z] = rotateVector(q, ...point.presentDayXYZ);
  return geographicXYZToLonLat(x, y, z);
}
