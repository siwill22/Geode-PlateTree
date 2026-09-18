import type { Camera, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { PointLayer } from '../../vendor/petrify/js/index.js';

import { ThreeProjector } from './boundaries';
// FlatProjector lived here until BoundaryOverlay needed it too, which would
// have made boundaries.ts <-> pointOverlay.ts circular -- see flatProjector.ts.
import { FlatProjector } from './flatProjector';
import { referencePlateProjectedPosition } from './projection';
import { loadReconstructionManifest, reconstructionAssetUrl } from './reconstructions';
import { resolveStaticPolygonReconstructionId } from './staticPolygons';
import type { ProjectionMode } from './projection';
import type { ArchiveIndex } from './types';
import type { Quaternion } from './rotation';
import type { Rect } from './layout';

/**
 * A symbolised point dataset (petrify's `PointLayer`), drawn by the same
 * "2D canvas over the WebGL globe" technique `core/boundaries.ts`'s
 * `BoundaryOverlay` already established for Boundary Frames -- see that
 * module's own doc comment for the geographic-frame/render-frame conversion
 * `ThreeProjector` (reused here for Globe) performs. Generic on purpose (per
 * CONTEXT.md's Plate-Frame Point entry: "loading an arbitrary point dataset
 * ... is the same per-point assignment-and-rotation" as any other) -- any
 * future point dataset (VGP, ADR-0029) can reuse this unchanged; only the
 * `points.json` URL and PointLayer options are caller-specific.
 *
 * Supports BOTH Projections, unlike Anchored Point/Plate-Frame Point/Tracked
 * Particle (which stay Globe-only -- they need a raycast against a clicked
 * screen position, a harder problem this doesn't have): `draw()`/`pick()`
 * switch between `ThreeProjector` (Globe) and `FlatProjector` (Plate Carrée)
 * by `mode`, both fed the exact same petrify geographic vector.
 */
export class PointOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly globeProjector: ThreeProjector;
  private readonly flatProjector: FlatProjector;
  private mode: ProjectionMode = 'globe';
  private layer: PointLayer | null = null;
  visible = true;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(camera: Camera) {
    this.globeProjector = new ThreeProjector(camera as PerspectiveCamera);
    this.flatProjector = new FlatProjector(camera);

    const c = document.createElement('canvas');
    c.className = 'point-overlay';
    Object.assign(c.style, {
      position: 'fixed',
      // Never eats clicks -- OrbitControls and the query-gesture raycast
      // both live on the WebGL canvas underneath it, same reasoning as
      // BoundaryOverlay's own canvas.
      pointerEvents: 'none',
    });
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d')!;
    this.applyRect();
  }

  private get activeProjector(): ThreeProjector | FlatProjector {
    return this.mode === 'globe' ? this.globeProjector : this.flatProjector;
  }

  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const {
      x, y, width, height,
    } = this.rect;
    Object.assign(this.canvas.style, {
      left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
    });
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** `options` is passed straight through to `new PointLayer(data, options)`
   *  -- category fill colours come from the fetched JSON's own `categories`
   *  field (baked in at prep time, see prep_boucot.py), so the caller
   *  typically only needs a `keyline` (edge colour), `size`, and `lifespan`
   *  mode here, not a `style()` hook. */
  async load(url: string, options?: ConstructorParameters<typeof PointLayer>[1]): Promise<void> {
    this.layer = await PointLayer.load(url, options);
  }

  setTime(age: number): void {
    this.layer?.setTime(age);
  }

  /** Track the caller's own camera swaps (Globe <-> Plate Carrée, docs/adr/
   *  0003) -- ClimateInstance.setProjection() builds a brand NEW camera
   *  object per Projection rather than reconfiguring one in place, so a
   *  captured reference would otherwise go stale the moment a switch
   *  happened. Retargets BOTH projectors unconditionally (cheap -- a field
   *  write each) rather than only the active one, so whichever becomes
   *  active next is never left pointing at a disposed camera. */
  setCamera(camera: Camera, mode: ProjectionMode): void {
    this.mode = mode;
    this.globeProjector.setCamera(camera as PerspectiveCamera);
    this.flatProjector.setCamera(camera);
    if (mode !== 'globe') this.flatProjector.setFlatMode(mode);
  }

  setReferenceRotation(q: Quaternion): void {
    this.globeProjector.setReferenceRotation(q);
    this.flatProjector.setReferenceRotation(q);
  }

  /** What's at this canvas position, in the SAME tile-local pixel space
   *  `setRect()`'s `rect` uses -- a caller doing its own hit-testing across
   *  several tiled instances (see climate/main.ts's own `hitTest()`) must
   *  subtract `rect.x`/`rect.y` from its client coordinates first, same as
   *  `ndcFor()` already does for the WebGL raycast. Reads positions cached by
   *  the last draw() (see PointLayer.pick()'s own doc comment) -- null before
   *  the first draw(), while hidden, or with nothing loaded yet. */
  pick(x: number, y: number): { index: number; point: unknown; x: number; y: number } | null {
    if (!this.visible || !this.layer) return null;
    return this.layer.pick(x, y);
  }

  /** Ring-highlight one point (or none, for `null`) -- purely visual, drawn
   *  by the next draw(). Mirrors `pick()`'s tile-local coordinate space
   *  implicitly (it's an index into the same `points` array pick() reads). */
  highlight(index: number | null): void {
    this.layer?.highlight(index);
  }

  /**
   * How many drawn points are piled within a hit radius of this position --
   * see PointLayer's own class doc comment: on a dense dataset (measured
   * there at 71% of drawn points sharing a hit radius with a neighbour),
   * pick() alone returns *a* point from the pile and the rest are visually
   * indistinguishable AND unreachable -- what looks like "the wrong colour"
   * for a category is usually a same-position NEIGHBOUR of a different one
   * painted on top of it, not a styling bug. Callers should `spiderfy()`
   * before trusting a single pick()/colour at a position where this is >= 2.
   */
  clusterSizeAt(x: number, y: number): number {
    if (!this.visible || !this.layer) return 0;
    return this.layer.clusterSizeAt(x, y);
  }

  /** Fan apart the cluster nearest (x, y) so each member becomes individually
   *  visible/pickable -- see clusterSizeAt()'s own doc comment for why this
   *  matters. Returns the member count fanned, or 0 if there was no pile
   *  worth opening. Safe to call every hover move: a no-op if the same
   *  cluster is already open (PointLayer.spiderfy()'s own dedup). */
  spiderfy(x: number, y: number): number {
    if (!this.visible || !this.layer) return 0;
    return this.layer.spiderfy(x, y);
  }

  /** Collapse an open fan, if any. Returns whether one was actually open
   *  (i.e. whether the caller needs to redraw). */
  unspiderfy(): boolean {
    return this.layer?.unspiderfy() ?? false;
  }

  /** Indices of the currently-fanned members, or null if no fan is open --
   *  lets a caller tell "pointer is still over one of THIS fan's members"
   *  apart from "pointer moved onto something else", the same distinction
   *  petrify's own hover.js reference implementation makes. */
  get spiderfied(): number[] | null {
    return this.layer?.spiderfied ?? null;
  }

  /** How far the open fan reaches from its anchor, in px -- 0 if none is
   *  open. Lets a caller size a keep-alive/hysteresis radius to the fan
   *  actually open (a 2-member pair vs. a 20-member spiral), same as
   *  petrify's own hover.js reference implementation does. */
  spiderExtent(): number {
    return this.layer?.spiderExtent() ?? 0;
  }

  dispose(): void {
    this.canvas.remove();
  }

  draw(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    if (!this.visible || !this.layer) return;
    const projector = this.activeProjector;
    projector.update(this.rect.width, this.rect.height);
    this.layer.draw(this.ctx, projector);
  }
}

/**
 * Resolve AND fetch a `paleolithology.points` URL for a climate-family
 * Manifest, if this archive has one exported -- null if the model isn't
 * cataloged or has no paleolithology export
 * (`ArchiveIndex.reconstruction_models[].has_paleolithology`). Mirrors
 * `staticPolygons.ts`'s `loadStaticPolygonDataFor()` shape exactly (same
 * `resolveStaticPolygonReconstructionId()` lookup -- one source of truth for
 * "which Reconstruction Model backs climate.html" -- then fetch that model's
 * own manifest.json for the real path), kept as a separate function rather
 * than folded into that one: `StaticPolygonData` is Plate-Frame Point's own
 * shape, and this is an unrelated dataset that just happens to share the same
 * Reconstruction Model.
 */
export async function loadPaleolithologyUrlFor(
  base: string, archive: ArchiveIndex, manifest: { type: string; reconstruction_model?: string },
): Promise<string | null> {
  const id = resolveStaticPolygonReconstructionId(manifest);
  if (!id) return null;
  const entry = archive.reconstruction_models?.find((r) => r.id === id);
  if (!entry?.has_paleolithology) return null;
  const rm = await loadReconstructionManifest(base, entry.path);
  if (!rm.paleolithology) return null;
  return reconstructionAssetUrl(base, rm, rm.paleolithology.points);
}
