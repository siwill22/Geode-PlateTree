import type { RotationTable } from './types';

export type Quaternion = [number, number, number, number];

/**
 * Slerp a plate's rotation between the bracketing 1 Ma samples. Shared by
 * coastlines.ts and staticPolygons.ts (docs/adr/0025) -- both rotate
 * present-day geometry into an age's position via the same RotationTable
 * (ADR-0001); Plate-Frame Point needs no new rotation mechanism of its own.
 */
export function rotationAt(table: RotationTable, plateId: number, age: number): Quaternion {
  const quats = table.plates[String(plateId)];
  if (!quats) return [0, 0, 0, 1];

  const ages = table.ages;
  const lo = Math.max(0, Math.min(ages.length - 2,
    Math.floor((age - ages[0]) / (ages[1] - ages[0]))));
  const t = Math.max(0, Math.min(1, (age - ages[lo]) / (ages[lo + 1] - ages[lo])));

  let [ax, ay, az, aw] = quats[lo];
  const [bx, by, bz, bw] = quats[lo + 1];

  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; d = -d; }

  if (d > 0.9995) {
    const x = ax + t * (bx - ax), y = ay + t * (by - ay);
    const z = az + t * (bz - az), w = aw + t * (bw - aw);
    const n = Math.hypot(x, y, z, w) || 1;
    return [x / n, y / n, z / n, w / n];
  }
  const theta = Math.acos(Math.min(1, d));
  const s = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / s;
  const w1 = Math.sin(t * theta) / s;
  return [
    w0 * ax + w1 * bx, w0 * ay + w1 * by,
    w0 * az + w1 * bz, w0 * aw + w1 * bw,
  ];
}

/** Rotate a vector by a unit quaternion: v' = q*v*q^-1, expanded. Operates in
 *  whatever frame the quaternion and vector were both defined in -- callers
 *  are responsible for using the geographic frame consistently (see
 *  coastlines.ts's module doc comment), never mixing it with the viewer's
 *  (X, Z, -Y) render frame. */
export function rotateVector(
  q: Quaternion, x: number, y: number, z: number,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Inverse of a unit quaternion (its conjugate). Used to reconstruct a point
 *  back to present-day coordinates from wherever it was picked -- see
 *  staticPolygons.ts's createPlateFramePoint(). */
export function conjugateQuaternion(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Compose two rotations: the result of applying `a` THEN `b` (v' =
 *  b*(a*v*a^-1)*b^-1) is rotateVector(composeQuaternions(b, a), v). Order
 *  matters -- the rotation applied SECOND is the first argument, standard
 *  Hamilton-product convention. */
export function composeQuaternions(b: Quaternion, a: Quaternion): Quaternion {
  const [bx, by, bz, bw] = b;
  const [ax, ay, az, aw] = a;
  return [
    bw * ax + bx * aw + by * az - bz * ay,
    bw * ay - bx * az + by * aw + bz * ax,
    bw * az + bx * ay - by * ax + bz * aw,
    bw * aw - bx * ax - by * ay - bz * az,
  ];
}

/**
 * See CONTEXT.md's Reference Plate entry and docs/adr/0030.
 *
 * Reanchoring the view into `referencePlateId`'s own frame is a single
 * rotation: the inverse of that plate's own rotationAt() at the same age,
 * composed ON TOP of whatever rotation a layer already applies to its own
 * present-day geometry. Identity at age 0 by construction (rotationAt is
 * identity for every plate there), so choosing a Reference Plate never moves
 * anything at the present day -- only deeper time is affected.
 */
export function referenceRotationAt(
  table: RotationTable, referencePlateId: number, age: number,
): Quaternion {
  if (referencePlateId === 0) return [0, 0, 0, 1]; // common case, skip the lookup+conjugate
  return conjugateQuaternion(rotationAt(table, referencePlateId, age));
}

/**
 * Fixed change-of-basis from the geographic frame (X to 0N/0E, Y to 0N/90E,
 * Z to the pole -- what RotationTable's quaternions and rotateVector() act
 * in) to the viewer's render frame (X, Z, -Y of geographic -- see
 * constants.ts). A rotation of -90 degrees about the geographic X axis:
 * render = (geoX, geoZ, -geoY) is exactly what that rotation produces.
 *
 * Exists so a rotation computed in the geographic frame (referenceRotationAt,
 * sourced from a RotationTable) can be applied directly to vectors that are
 * ALREADY in render-frame coordinates -- lonLatToVec3()'s output, used
 * throughout core/windGlyphs.ts, core/windStreaks.ts, core/trackedParticles.ts
 * and the volume/raster shaders -- without converting each vector to the
 * geographic frame and back. See toRenderFrameRotation().
 */
const GEOGRAPHIC_TO_RENDER_FRAME: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/**
 * Re-express a geographic-frame rotation (e.g. from referenceRotationAt) as
 * the equivalent rotation in render-frame coordinates, via similarity
 * transform: renderQ = F * geoQ * F^-1, where F is
 * GEOGRAPHIC_TO_RENDER_FRAME. rotateVector(toRenderFrameRotation(q), v) on a
 * render-frame v then gives the same physical rotation rotateVector(q, ...)
 * would give on the equivalent geographic-frame vector -- computed once per
 * age/Reference-Plate change, not per vertex.
 */
export function toRenderFrameRotation(q: Quaternion): Quaternion {
  return composeQuaternions(
    composeQuaternions(GEOGRAPHIC_TO_RENDER_FRAME, q),
    conjugateQuaternion(GEOGRAPHIC_TO_RENDER_FRAME),
  );
}
