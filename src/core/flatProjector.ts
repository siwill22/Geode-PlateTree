import type { Camera } from 'three';
import { Vector3 } from 'three';
import { meridianCrossing } from '../../vendor/deep-time-map/js/index.js';

import { lonLatToVec3, vec3ToLonLat } from './constants';
import { conjugateQuaternion, rotateVector, type Quaternion } from './rotation';
import { referencePlateProjectedPosition, type ProjectionMode } from './projection';

type Projected = [number, number, number] | null;

/** Passed where a reanchor must NOT happen -- see mapHalfWidth. */
const IDENTITY_QUAT: Quaternion = [0, 0, 0, 1];

/** Reference Plate 0, the overwhelmingly common case -- worth short-circuiting
 *  the rotate/unrotate round trips it would otherwise make no difference to. */
function isIdentityQuat(q: Quaternion): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/**
 * Plate Carrée counterpart of `core/boundaries.ts`'s `ThreeProjector` --
 * turns a deep-time-map GEOGRAPHIC-frame unit vector into a screen position
 * on a flat map instead of the globe -- Plate Carrée or Robinson, via
 * setFlatMode(). `projection.ts`'s
 * `referencePlateFlatPosition()` already does the reanchor-then-reproject
 * work (see its own doc comment); this only adds the geographic xyz -> lon/
 * lat step deep-time-map's vector needs before that call, and the final
 * camera projection to screen pixels. No horizon/occlusion test -- a flat
 * map has no far side, unlike ThreeProjector's sphere.
 *
 * Exported so `core/aggregateOverlay.ts` can reuse it rather than keep a second
 * copy: both overlays face the identical problem (a deep-time-map geographic
 * vector -> a screen position on the flat map), and two copies of the
 * reanchor-then-reproject step would drift the moment one is fixed.
 */
export class FlatProjector {
  private p = new Vector3();
  private w = 0;
  private h = 0;
  private qRef: Quaternion = [0, 0, 0, 1];
  /** Which flat Projection to lay the reanchored point onto. Plate Carrée by
   *  default, so every existing caller is unchanged. */
  private flatMode: ProjectionMode = 'plateCarree';

  // Vector3.project() only needs a generic three.js Camera (it reads
  // .matrixWorldInverse/.projectionMatrix, present on any camera type) --
  // no OrthographicCamera-specific member is ever touched, so this stays
  // untyped-narrower than that on purpose.
  constructor(private camera: Camera) {}

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  setReferenceRotation(q: Quaternion): void {
    this.qRef = q;
  }

  setFlatMode(mode: ProjectionMode): void {
    this.flatMode = mode;
  }

  update(cssWidth: number, cssHeight: number): void {
    this.w = cssWidth;
    this.h = cssHeight;
  }

  project(v: ArrayLike<number>): Projected {
    const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * (180 / Math.PI);
    const lon = Math.atan2(v[1], v[0]) * (180 / Math.PI);
    // Reanchor on the SPHERE, then lay the result down in the active flat
    // Projection -- the same order the raster shader and the coastline rebuild
    // use, and the reverse of it warps the map (ADR-0030).
    const [x, y, z] = referencePlateProjectedPosition(this.flatMode, lon, lat, this.qRef);
    this.p.set(x, y, z).project(this.camera);
    return [
      (this.p.x * 0.5 + 0.5) * this.w,
      (-this.p.y * 0.5 + 0.5) * this.h,
      1, // no occlusion on a flat map -- always "in front"
    ];
  }

  /**
   * Two frames meet in this method, and they do NOT share an up-axis. Mixing
   * them produces a plausible-looking but wrong map, so they are converted
   * explicitly rather than passed around as bare triples:
   *
   * - **geographic** (deep-time-map's): z is the pole. `geoVec`/`geoLonLat`.
   * - **render** (Geode's `constants.ts`): y is the pole, and the frame
   *   `Quaternion`s from `core/rotation.ts` are expressed in. `lonLatToVec3`.
   */
  private static geoVec(lon: number, lat: number): number[] {
    const la = lat * (Math.PI / 180);
    const lo = lon * (Math.PI / 180);
    const c = Math.cos(la);
    return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
  }

  private static geoLonLat(v: ArrayLike<number>): { lon: number; lat: number } {
    return {
      lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) * (180 / Math.PI),
      lon: Math.atan2(v[1], v[0]) * (180 / Math.PI),
    };
  }

  /** Reanchor a (lon, lat) by `q`, via the render frame the quaternion lives
   *  in -- the same round trip `referencePlateProjectedPosition` performs. */
  private static reanchor(lon: number, lat: number, q: Quaternion): { lon: number; lat: number } {
    const [x0, y0, z0] = lonLatToVec3(lon, lat, 1);
    const [x1, y1, z1] = rotateVector(q, x0, y0, z0);
    return vec3ToLonLat(x1, y1, z1);
  }

  /** Where a point sits in the DISPLAY frame -- after the Reference Plate
   *  rotation, which is the frame the map's own edges are fixed in. */
  private displayLonLat(v: ArrayLike<number>): { lon: number; lat: number } {
    const { lon, lat } = FlatProjector.geoLonLat(v);
    if (isIdentityQuat(this.qRef)) return { lon, lat };
    return FlatProjector.reanchor(lon, lat, this.qRef);
  }

  /**
   * Optional part of deep-time-map's projector contract: how wide half the map
   * is, in screen pixels, used by `PolygonLayer` to spot a ring whose projected
   * vertices jump from one edge to the other.
   *
   * Without it that layer's `halfWidth` defaults to 0, the jump is never
   * detected, and a ring straddling the seam is FILLED across the whole map
   * rather than diverted to an outline -- `seamSplit()` alone does not save it,
   * because a fill never consults the seam hook. The two belong together.
   *
   * Measured through the live camera rather than derived from the world-unit map
   * width, so it tracks pan and zoom: this is the screen distance between
   * display longitudes -90 and +90 on the equator, which is exactly half the map
   * in both flat Projections (their parallels are straight and evenly divided in
   * longitude). Returns 0 before the first `update()`, which reads as "unknown"
   * and simply disables the test.
   *
   * DISPLAY longitudes, so it deliberately does NOT go through `project()`: that
   * reanchors by the Reference Plate first, and true ±90 is not display ±90
   * whenever a rotation is active. The map's edges are fixed in the display
   * frame, so its width has to be measured there.
   */
  get mapHalfWidth(): number {
    if (!this.w) return 0;
    return Math.abs(this.screenXOfDisplayLon(90) - this.screenXOfDisplayLon(-90));
  }

  /** Screen x of a point on the equator at DISPLAY longitude `lon`. */
  private screenXOfDisplayLon(lon: number): number {
    return this.screenOfDisplayLonLat(lon, 0)[0];
  }

  /** Screen position of a DISPLAY (lon, lat) -- i.e. with no Reference Plate
   *  reanchor, for things fixed to the map rather than to the Earth. */
  private screenOfDisplayLonLat(lon: number, lat: number): [number, number] {
    const [x, y, z] = referencePlateProjectedPosition(
      this.flatMode, lon, lat, IDENTITY_QUAT,
    );
    this.p.set(x, y, z).project(this.camera);
    return [(this.p.x * 0.5 + 0.5) * this.w, (-this.p.y * 0.5 + 0.5) * this.h];
  }

  /**
   * The map's own boundary, in screen pixels, walked once anticlockwise.
   *
   * This is the edge of the EARTH on this projection, which is not the edge of
   * the canvas: Robinson's boundary is a curve, so a rectangle covering the map
   * necessarily includes corners that are not on the planet. A consumer painting
   * anything derived from "everywhere that is not land" -- an ocean tint, a
   * distance field, a graticule fill -- needs this to stop at, or it paints the
   * corners too.
   *
   * In the DISPLAY frame, like the seam and for the same reason: the map's edges
   * do not move when a Reference Plate rotation moves the Earth beneath them.
   *
   * `steps` samples per side. Plate Carrée is exact at any value (its boundary
   * is four straight lines); Robinson's meridians are curved, so this is a
   * polyline approximation of them, which is why the default is generous.
   */
  mapOutline(steps = 96): [number, number][] {
    const pts: [number, number][] = [];
    const lerp = (a: number, b: number, i: number): number => a + ((b - a) * i) / steps;
    for (let i = 0; i < steps; i++) pts.push(this.screenOfDisplayLonLat(180, lerp(-90, 90, i)));
    for (let i = 0; i < steps; i++) pts.push(this.screenOfDisplayLonLat(lerp(180, -180, i), 90));
    for (let i = 0; i < steps; i++) pts.push(this.screenOfDisplayLonLat(-180, lerp(90, -90, i)));
    for (let i = 0; i < steps; i++) pts.push(this.screenOfDisplayLonLat(lerp(-180, 180, i), -90));
    return pts;
  }

  /**
   * Optional part of deep-time-map's projector contract (see its
   * `js/robinson.js`): where a segment crosses this map's edge, so a line layer
   * can break there instead of drawing straight back across the map.
   *
   * Both flat Projections here have their seam at ±180 in the DISPLAY frame,
   * which is not ±180 in the true frame once a Reference Plate rotation is
   * active (docs/plans/reference-plate.md). So the crossing is found in display
   * coordinates and the two edge points are rotated BACK before being handed
   * over -- `project()` rotates them forward again, and returning display-frame
   * vectors would apply that rotation twice.
   */
  seamSplit(a: ArrayLike<number>, b: ArrayLike<number>): [number[], number[]] | null {
    const da = this.displayLonLat(a);
    const db = this.displayLonLat(b);
    if (Math.abs(da.lon - db.lon) <= 180) return null;

    const hit = meridianCrossing(
      FlatProjector.geoVec(da.lon, da.lat), FlatProjector.geoVec(db.lon, db.lat), 180,
    ) as number[] | null;
    if (!hit) return null;
    const seamLat = FlatProjector.geoLonLat(hit).lat;

    const EPS = 1e-4;
    const atEdge = (displayLon: number): number[] => {
      if (isIdentityQuat(this.qRef)) return FlatProjector.geoVec(displayLon, seamLat);
      const t = FlatProjector.reanchor(displayLon, seamLat, conjugateQuaternion(this.qRef));
      return FlatProjector.geoVec(t.lon, t.lat);
    };
    // Leave by the edge the segment was already heading for.
    return da.lon > 0
      ? [atEdge(180 - EPS), atEdge(-180 + EPS)]
      : [atEdge(-180 + EPS), atEdge(180 - EPS)];
  }
}
