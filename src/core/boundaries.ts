import type { Camera, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { BoundarySeries, DEFAULT_STYLE } from '../../vendor/petrify/js/index.js';

import { R_SURFACE } from './constants';
import { maskAt } from './mask';
import type { Rect } from './layout';
import { conjugateQuaternion, rotateVector, type Quaternion } from './rotation';
import { FlatProjector } from './flatProjector';
import type { ResolvedTheme } from './theme';
import type { ProjectionMode } from './projection';

/**
 * Plate boundaries, drawn by the vendored petrify library onto a 2D canvas
 * over the WebGL globe.
 *
 * That library talks to its host through exactly one method:
 *
 *     project(vec3) -> [x, y, depth] | null
 *
 * so meeting it costs a projector and nothing else. Everything difficult stays
 * on their side: the subduction-polarity triangles, the pixel-spaced decoration
 * walk, the pen-lift at the horizon. Reimplementing the polarity logic against
 * three.js line geometry would mean re-deriving -- and re-verifying -- the one
 * part their README singles out as invisibly wrong when mirrored.
 *
 * ---- Two frames, and why mixing them is safe ------------------------------
 *
 * petrify works in the geographic frame, (cos.lat cos.lon, cos.lat
 * sin.lon, sin.lat), with Z through the north pole. Geode works in three.js's
 * Y-up frame, where the same point is (cos.lat cos.lon, sin.lat, -cos.lat
 * sin.lon). The map between them, (gx, gy, gz) -> (gx, gz, -gy), is a
 * permutation with determinant +1: a rotation, not a mirror.
 *
 * That matters because the library resolves which side of a trench the
 * triangles go on with a cross product, `a x tangent`, taken on the sphere in
 * ITS frame and only then projected. A rotation preserves cross products, so
 * the polarity survives untouched. (A reflection would not -- and would silently
 * mirror every subduction zone.) The conversion happens here, in one place, and
 * the vendored code is not modified.
 *
 * ---- Reference Plate --------------------------------------------------------
 *
 * The library hands `project()` present-day-rotated geographic-frame vectors
 * (it does its own age reconstruction internally, upstream of this boundary).
 * Reference Plate reanchoring is applied here, to that geographic-frame v,
 * BEFORE the permutation above -- see setReferenceRotation()/rotation.ts's
 * module doc comment on why geographic- and render-frame quaternions are not
 * interchangeable. Everything else that reanchors (coastlines, volume
 * shaders, isosurfaces, cutaway) works in the render frame instead because
 * that's the frame their own geometry already lives in; this overlay is the
 * one exception since petrify only ever gives us geographic vectors.
 */

type Projected = [number, number, number] | null;

export class ThreeProjector {
  private camDir = new Vector3();
  private p = new Vector3();
  private horizon = 0;
  private w = 0;
  private h = 0;

  /** Current cutaway raster, or null when nothing is cut. */
  mask: Uint8Array | null = null;

  /** Reference Plate rotation, in the GEOGRAPHIC frame (this class's v is
   *  geographic, unlike everything else that reanchors in the render frame).
   *  Identity when Reference Plate is 0 or unset. */
  private qRef: Quaternion = [0, 0, 0, 1];

  constructor(private camera: PerspectiveCamera) {}

  /** Retarget this projector at a NEW camera object -- needed by any caller
   *  whose own camera gets reassigned wholesale rather than reconfigured in
   *  place (e.g. ClimateInstance.setProjection() building a fresh camera per
   *  Projection, docs/adr/0003). Tomography (this class's original caller)
   *  never needs this: it has no Projection concept, so its camera reference
   *  never changes after construction. */
  setCamera(camera: PerspectiveCamera): void {
    this.camera = camera;
  }

  setReferenceRotation(q: Quaternion): void {
    this.qRef = q;
  }

  /** Refresh the per-frame camera terms. Call once before drawing. */
  update(cssWidth: number, cssHeight: number): void {
    this.w = cssWidth;
    this.h = cssHeight;
    const d = this.camera.position.length();
    this.camDir.copy(this.camera.position).divideScalar(d || 1);
    // The visible cap of a sphere of radius R seen from distance d is where
    // dot(v, camDir) > R/d -- NOT dot > 0, which is the orthographic answer.
    // At the default d = 2.6 R the two differ by 23 degrees of arc, a band of
    // the far side that would be drawn over the limb.
    //
    // An orthographic camera has no eye point, so the cap IS the hemisphere and
    // the horizon is a great circle. That is the case `axis` below requires.
    this.horizon = this.isOrthographic ? 0 : R_SURFACE / (d || 1);
  }

  private get isOrthographic(): boolean {
    return (this.camera as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
  }

  /**
   * Optional part of petrify's projector contract: the view axis, in ITS
   * geographic frame, used by `PolygonLayer` to clamp a vertex behind the
   * horizon onto the limb so a straddling continent still fills.
   *
   * **Undefined under a perspective camera, deliberately.** The library's
   * `clampToLimb` puts the clamped vertex on the great circle perpendicular to
   * this axis, which is the horizon only when the camera is orthographic. Under
   * perspective the true horizon is a smaller circle at dot = R/d, so a vertex
   * clamped to the great circle is still behind it: `project()` would return
   * null a second time, the vertex would be dropped anyway, and the ring would
   * close across the globe -- the exact artefact the clamping exists to prevent,
   * arrived at more expensively. Returning undefined instead makes PolygonLayer
   * fall back to polyline behaviour, which is honest about what it can do.
   *
   * Frame note: the layer's own vectors are geographic and PRE-Reference-Plate,
   * while `camDir` is a render-frame direction. So this converts back
   * (gx, gy, gz) <- (x, -z, y) and then un-rotates by qRef, because rotations
   * preserve the dot product the layer is about to take: dot(R·v, a) equals
   * dot(v, R⁻¹·a).
   */
  get axis(): number[] | undefined {
    if (!this.isOrthographic) return undefined;
    const g: [number, number, number] = [this.camDir.x, -this.camDir.z, this.camDir.y];
    const [x, y, z] = rotateVector(conjugateQuaternion(this.qRef), g[0], g[1], g[2]);
    return [x, y, z];
  }

  project(v: ArrayLike<number>): Projected {
    if (this.mask) {
      // lon/lat from the GEOGRAPHIC vector, BEFORE Reference Plate rotation
      // -- constants.vec3ToLonLat expects a three.js one and would silently
      // swap two axes if used here. The cutaway polygon was rasterised
      // against this same pre-rotation (TRUE) frame (see cutaway.ts's own
      // doc comment), so the mask lookup must stay here too, not on
      // wherever Reference Plate has since rotated this point to.
      const lon = Math.atan2(v[1], v[0]) * (180 / Math.PI);
      const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * (180 / Math.PI);
      // The overlay has no depth buffer, so where the cutaway has removed the
      // ground the line has to be culled explicitly. Returning null makes
      // tracePolyline lift the pen, exactly as it does at the horizon.
      if (maskAt(this.mask, lon, lat)) return null;
    }

    const [rx, ry, rz] = rotateVector(this.qRef, v[0], v[1], v[2]);

    // Geographic -> three.js. See the note above on why this is orientation-safe.
    const x = rx;
    const y = rz;
    const z = -ry;

    const depth = x * this.camDir.x + y * this.camDir.y + z * this.camDir.z;
    if (depth <= this.horizon) return null;

    this.p.set(x, y, z).project(this.camera);
    return [
      (this.p.x * 0.5 + 0.5) * this.w,
      (-this.p.y * 0.5 + 0.5) * this.h,
      depth,
    ];
  }
}

export interface BoundaryFrameInfo {
  time: number;
  file: string;
  features: number;
  subduction: number;
}

export class BoundaryOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly projector: ThreeProjector;
  /** Built lazily, on the first setCamera() that asks for a flat Projection --
   *  the Globe-only wrappers (tomography, reconstruction, reconstructionGroup)
   *  never call it and pay nothing. */
  private flatProjector: FlatProjector | null = null;
  private mode: ProjectionMode = 'globe';
  /** Kept so a flat projector built later still gets the current rotation. */
  private qRef: Quaternion = [0, 0, 0, 1];
  private series: BoundarySeries | null = null;
  /** The Theme to apply as soon as a series exists -- see applyTheme(). */
  private pendingTheme: ResolvedTheme | null = null;
  /** Time of the frame actually on screen, which need not be the slider's age. */
  frameTime: number | null = null;
  visible = true;
  /** CSS-pixel tile this overlay covers. Defaults to the full window. */
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(camera: PerspectiveCamera) {
    this.projector = new ThreeProjector(camera);

    const c = document.createElement('canvas');
    Object.assign(c.style, {
      position: 'fixed',
      // The overlay must never eat clicks: polygon drawing and OrbitControls
      // both live on the WebGL canvas underneath it.
      pointerEvents: 'none',
    });
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d')!;
    this.applyRect();
  }

  /**
   * Move/resize this overlay to a new tile, in CSS pixels. Called once at
   * boot with the full window and again whenever the globe grid is
   * relaid out -- adding, removing, or resizing changes every tile's rect.
   */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    Object.assign(this.canvas.style, {
      left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
    });
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // Draw in CSS pixels so the library's pixel-spaced decorations keep the
    // size they were tuned at, whatever the display density.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * `styleOverride` replaces per-type entries wholesale, matching the library's
   * own shallow merge (see below) -- a caller wanting only one boundary type
   * visible passes transparent strokes for the others. Omit it for Geode's
   * house style.
   */
  async load(url: string, styleOverride?: Record<string, unknown>): Promise<void> {
    // The library's own default renders subduction zones (and their polarity
    // triangles, which share this colour -- see boundaries.js) in a pale
    // peach; Geode wants them black. Spreading DEFAULT_STYLE.subduction
    // rather than passing just { stroke } because the library's merge is
    // shallow (BoundaryLayer's constructor replaces the whole `subduction`
    // entry, not just the field given), so width/label would otherwise be
    // dropped.
    this.series = await BoundarySeries.load(url, {
      style: styleOverride
        ?? { subduction: { ...DEFAULT_STYLE.subduction, stroke: '#000000' } },
    });
    // A Theme set before the frames arrived still wins -- see applyTheme().
    if (this.pendingTheme) this.applyTheme(this.pendingTheme);
  }

  /**
   * Re-colour and re-weight the boundary lines for a Theme.
   *
   * Held as `pendingTheme` when no series is loaded yet, because load() is
   * async and a wrapper legitimately sets its Theme before its Boundary Frames
   * have arrived -- dropping it there would leave the boundaries on the default
   * palette until the next Theme change, which for a viewer booted into a
   * non-default Theme is "for ever".
   */
  applyTheme(theme: ResolvedTheme): void {
    this.pendingTheme = theme;
    this.series?.restyle({
      style: theme.boundaryStyle,
      ...theme.boundaryDecoration,
    });
  }

  get timeRange(): [number, number] | null {
    return this.series ? (this.series.timeRange as [number, number]) : null;
  }

  /**
   * Point the series at an age. Resolves once the frame is on screen; the
   * previous frame stays up in the meantime rather than flashing an empty globe.
   */
  async setAge(age: number, onFrame?: (f: BoundaryFrameInfo) => void): Promise<void> {
    if (!this.series) return;
    await this.series.setTime(age, (f: BoundaryFrameInfo) => {
      this.frameTime = f.time;
      onFrame?.(f);
    });
  }

  setMask(mask: Uint8Array | null): void {
    this.projector.mask = mask;
  }

  /**
   * Track the caller's Projection and camera, exactly as PointOverlay and
   * AggregateOverlay do -- a new camera object is built per Projection, so a
   * captured reference goes stale on every switch.
   *
   * Boundary Frames were Globe-only until petrify v0.6.0, and the reason
   * was the antimeridian rather than the camera: these are LINES, and a flat
   * map is cut open somewhere, so a feature spanning the cut drew straight back
   * across the whole map. Points and aggregate cells never had that problem,
   * which is why they gained flat support first. The library now takes an
   * optional `seamSplit` from the projector and breaks the line there, and
   * FlatProjector supplies it.
   */
  setCamera(camera: Camera, mode: ProjectionMode): void {
    this.mode = mode;
    this.projector.setCamera(camera as PerspectiveCamera);
    if (mode !== 'globe') {
      this.flatProjector = this.flatProjector ?? new FlatProjector(camera);
      this.flatProjector.setCamera(camera);
      this.flatProjector.setFlatMode(mode);
      this.flatProjector.setReferenceRotation(this.qRef);
    }
  }

  private get activeProjector(): ThreeProjector | FlatProjector {
    return this.mode === 'globe' || !this.flatProjector ? this.projector : this.flatProjector;
  }

  /** Reference Plate rotation, in the GEOGRAPHIC frame -- see
   *  ThreeProjector.setReferenceRotation()'s doc comment. */
  setReferenceRotation(q: Quaternion): void {
    this.qRef = q;
    this.projector.setReferenceRotation(q);
    this.flatProjector?.setReferenceRotation(q);
  }

  /** Detach the overlay canvas. Called when a globe instance is removed. */
  dispose(): void {
    this.canvas.remove();
  }

  draw(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    if (!this.visible || !this.series) return;
    const projector = this.activeProjector;
    projector.update(this.rect.width, this.rect.height);
    this.series.draw(this.ctx, projector);
  }
}
