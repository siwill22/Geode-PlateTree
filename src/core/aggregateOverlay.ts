import type { Camera, PerspectiveCamera } from 'three';
import { AggregateLayer } from '../../vendor/petrify/js/index.js';

import { ThreeProjector } from './boundaries';
import { FlatProjector } from './flatProjector';
import type { ProjectionMode } from './projection';
import type { Quaternion } from './rotation';
import type { Rect } from './layout';

/**
 * A summarised point dataset (petrify's `AggregateLayer`) drawn by the same
 * "2D canvas over the WebGL globe" technique `core/boundaries.ts` established
 * for Boundary Frames and `core/pointOverlay.ts` reuses for `PointLayer` -- see
 * either for the geographic-frame/render-frame conversion `ThreeProjector`
 * performs.
 *
 * Deliberately a sibling of `PointOverlay` rather than a mode inside it. The two
 * answer different questions of the same data ("where is each thing" vs "what is
 * here, and how much"), they are switched between rather than composed, and
 * fusing them would mean one class holding two layer types and two sets of
 * hit-testing semantics. What they DO share -- the canvas, the rect/DPR
 * bookkeeping, and both projectors -- is shared by importing, not by copying.
 *
 * Generic, the same way PointOverlay is: nothing here knows what a category
 * means. Any future aggregated dataset reuses it unchanged; only the
 * `aggregates.json` URL and the layer options are caller-specific.
 */
export class AggregateOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly globeProjector: ThreeProjector;
  private readonly flatProjector: FlatProjector;
  private mode: ProjectionMode = 'globe';
  private layer: InstanceType<typeof AggregateLayer> | null = null;
  visible = true;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(camera: Camera) {
    this.globeProjector = new ThreeProjector(camera as PerspectiveCamera);
    this.flatProjector = new FlatProjector(camera);

    const c = document.createElement('canvas');
    c.className = 'aggregate-overlay';
    Object.assign(c.style, {
      position: 'fixed',
      // Never eats clicks -- OrbitControls lives on the WebGL canvas underneath,
      // same reasoning as BoundaryOverlay's and PointOverlay's own canvases.
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

  async load(url: string, options?: Record<string, unknown>): Promise<void> {
    this.layer = await AggregateLayer.load(url, options);
  }

  get loaded(): boolean { return this.layer !== null; }

  setTime(age: number): void {
    this.layer?.setTime(age);
  }

  /** Switch which declared Grouping is shown. Several are declared, exactly one
   *  is drawn -- two pie charts on one cell is not a readable mark. */
  setGrouping(name: string): void {
    this.layer?.setGrouping(name);
  }

  /** 'pie' (composition per cell) or 'dominant' (majority category only). */
  setMode(mode: 'pie' | 'dominant'): void {
    if (this.layer) this.layer.options.mode = mode;
  }

  /** What drives glyph size: occurrence count, distinct-taxon richness, or nothing. */
  setSizeBy(sizeBy: 'total' | 'richness' | 'none'): void {
    if (this.layer) this.layer.options.sizeBy = sizeBy;
  }

  /** The active Grouping's category keys, in the payload's own fixed order --
   *  what a legend iterates. */
  get categories(): string[] {
    return this.layer?.categories ?? [];
  }

  labelFor(category: string): string {
    return this.layer?.labelFor(category) ?? category;
  }

  fillFor(category: string): string {
    return this.layer?.fillFor(category) ?? 'rgb(150,160,172)';
  }

  /** Per-category totals across every occupied cell at the current age -- lets a
   *  legend show what is actually on screen rather than what exists in the file. */
  totals(): number[] {
    return this.layer?.totals() ?? [];
  }

  get cellCount(): number { return this.layer?.cellCount ?? 0; }

  /** Track the caller's own camera swaps (Globe <-> Plate Carrée, ADR-0003) --
   *  a new camera object is built per Projection, so a captured reference would
   *  go stale. Retargets both projectors, same as PointOverlay. */
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

  /** What's at this canvas position, in the same tile-local pixel space
   *  `setRect()`'s rect uses. Reads positions cached by the last draw(), so a
   *  popup always describes the glyph actually under the cursor. */
  pick(x: number, y: number): Record<string, unknown> | null {
    if (!this.visible || !this.layer) return null;
    return this.layer.pick(x, y) as Record<string, unknown> | null;
  }

  highlight(slot: number | null): void {
    this.layer?.highlight(slot);
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
