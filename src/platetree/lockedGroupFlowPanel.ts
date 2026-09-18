import type { PlateTreeData } from '../core/plateTree';
import type { ResolvedTheme } from '../core/theme';
import type { StaticPolygon } from '../core/types';
import { drawSankey, layoutSankey, pickSankeyNode, withTransitionGaps, type SankeyLayout } from '../core/sankey';
import {
  checkpointIndexAt, computeLockedGroupFlow, FULL_SPHERE_SR, OTHER_ID, type LockedGroupFlowResult,
} from './lockedGroupFlow';

/** A Locked Group needs at least this fraction of the CONTINENTAL crust
 *  actually modelled at that age (not of the whole sphere, and not counting
 *  oceanic crust at all -- see lockedGroupFlow.ts's bucketsForFrame() doc
 *  comment: modelled continental coverage itself runs from ~41% of Earth's
 *  surface at 0 Ma down to ~12% by 1800 Ma) to earn its own band; the rest
 *  pool into one grey OTHER band per Checkpoint. This is a fixed AREA
 *  threshold rather than "the N largest by plate count" -- a rank-based
 *  cutoff turns every swap among near-tied small groups into a spurious
 *  Checkpoint, and plate count on its own rewards fragmentation over mass. */
const MIN_AREA_FRACTION = 0.01;

/** Pixel width carved out of every Checkpoint boundary for the merge/split
 *  ribbon -- see core/sankey.ts's withTransitionGaps() for why touching
 *  columns need this at all. */
const TRANSITION_GAP_PX = 4;

const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const DARK_CHROME = {
  bg: 'rgba(12,16,22,0.82)', border: '1px solid rgba(255,255,255,0.10)',
  ink: 'rgba(235,240,250,0.92)', inkDim: 'rgba(235,240,250,0.62)',
};
const LIGHT_CHROME = {
  bg: 'rgba(255,255,255,0.88)', border: '1px solid rgba(20,24,32,0.14)',
  ink: 'rgba(20,24,32,0.92)', inkDim: 'rgba(20,24,32,0.62)',
};

/**
 * v2 of docs/plans/plate-tree-viewer.md (Geode repo): Locked Groups merging
 * and splitting through time, as an alluvial diagram, drawn full-width just
 * above the time bar. Owns its own canvas and DOM chrome (the timebar/status/
 * circuit-panel pattern plateTreeUi.ts already uses); the actual layout and
 * lineage maths live in core/sankey.ts and lockedGroupFlow.ts so this class
 * is just wiring plus draw calls, the same split PlateTreeOverlay keeps
 * between its own canvas plumbing and plateTree.ts's data functions.
 */
export class LockedGroupFlowPanel {
  private anchor: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private status: HTMLDivElement;
  private tooltip: HTMLDivElement;

  private result: LockedGroupFlowResult | null = null;
  private layout: SankeyLayout | null = null;
  private lightness: 'light' | 'dark' = 'dark';
  private currentAge = 0;
  private modelName = '';
  private polygons: StaticPolygon[] = [];

  constructor() {
    this.anchor = document.createElement('div');
    Object.assign(this.anchor.style, {
      position: 'fixed', left: '1.5rem', right: '1.5rem', bottom: '5.3rem', zIndex: '10',
      padding: '0.6rem 0.9rem 0.4rem', borderRadius: '10px',
      background: DARK_CHROME.bg, border: DARK_CHROME.border,
      font: `12px/1.4 ${UI_FONT}`, color: DARK_CHROME.ink,
      display: 'none',
    });

    this.status = document.createElement('div');
    Object.assign(this.status.style, { marginBottom: '4px', color: DARK_CHROME.inkDim });
    this.anchor.appendChild(this.status);

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '150px' });
    this.anchor.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    document.body.appendChild(this.anchor);

    this.tooltip = document.createElement('div');
    Object.assign(this.tooltip.style, {
      position: 'fixed', zIndex: '11', display: 'none', pointerEvents: 'none',
      padding: '6px 9px', borderRadius: '6px',
      background: DARK_CHROME.bg, border: DARK_CHROME.border,
      font: `11px/1.5 ${UI_FONT}`, color: DARK_CHROME.ink, whiteSpace: 'pre',
    });
    document.body.appendChild(this.tooltip);

    this.canvas.addEventListener('mousemove', (e) => this.onHover(e));
    this.canvas.addEventListener('mouseleave', () => { this.tooltip.style.display = 'none'; });
    // recompute(), not just applySize(): the pixel x0/x1 baked into every
    // Checkpoint column are only valid for the width they were computed at.
    addEventListener('resize', () => { if (this.data) this.recompute(); });
  }

  applyLightness(lightness: 'light' | 'dark'): void {
    this.lightness = lightness;
    const chrome = lightness === 'light' ? LIGHT_CHROME : DARK_CHROME;
    Object.assign(this.anchor.style, { background: chrome.bg, border: chrome.border, color: chrome.ink });
    Object.assign(this.status.style, { color: chrome.inkDim });
    Object.assign(this.tooltip.style, { background: chrome.bg, border: chrome.border, color: chrome.ink });
    if (this.result) this.recompute();
  }

  /** Re-themes with the resolved Theme -- only its lightness matters here,
   *  same rule plateTreeUi.ts's chrome follows (never a Theme's data roles). */
  applyTheme(theme: ResolvedTheme): void { this.applyLightness(theme.lightness); }

  setVisible(v: boolean): void {
    this.anchor.style.display = v ? 'block' : 'none';
    // recompute(), not just draw(): while hidden, getBoundingClientRect()
    // reads a zero-width box, so any layout computed during that time baked
    // in degenerate (zero-width) column positions.
    if (v && this.data) this.recompute();
  }

  setData(data: PlateTreeData, modelName: string, polygons: StaticPolygon[]): void {
    this.modelName = modelName;
    this.data = data;
    this.polygons = polygons;
    this.recompute();
  }

  private data: PlateTreeData | null = null;

  private recompute(): void {
    if (!this.data) return;
    this.applySize();
    const width = this.canvas.getBoundingClientRect().width || innerWidth;
    const ageMin = this.data.ages[0];
    const ageMax = this.data.ages[this.data.ages.length - 1];
    const span = ageMax - ageMin || 1;
    const ageToX = (age: number) => ((age - ageMin) / span) * width;
    this.result = computeLockedGroupFlow(this.data, {
      minAreaFraction: MIN_AREA_FRACTION, polygons: this.polygons, lightness: this.lightness, ageToX,
    });
    this.draw();
  }

  setAge(age: number): void {
    this.currentAge = age;
    if (this.result) this.draw();
  }

  /** For PlateTreeOverlay.lineageColorOf: the current Checkpoint set this
   *  panel is showing, so the globe can look up the same band colour for
   *  the plate under a node. Null before any data has been computed. */
  get currentResult(): LockedGroupFlowResult | null { return this.result; }

  private applySize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || this.anchor.getBoundingClientRect().width || innerWidth;
    const height = 150;
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(): void {
    if (!this.result) return;
    const width = this.canvas.width / Math.min(devicePixelRatio, 2);
    const height = this.canvas.height / Math.min(devicePixelRatio, 2);
    this.ctx.clearRect(0, 0, width, height);

    const gapped = withTransitionGaps(this.result.columns, TRANSITION_GAP_PX);
    // Absolute scale, not per-column: a Checkpoint with less modelled area
    // than the diagram's richest one should draw shorter, not be stretched
    // to fill the same height and imply a parity the data doesn't have.
    const referenceTotal = Math.max(...this.result.coverageFraction) * FULL_SPHERE_SR;
    this.layout = layoutSankey(gapped, { x: 0, y: 0, width, height }, { padY: 4, referenceTotal });
    drawSankey(this.ctx, this.layout, this.result.flows);

    const ageMin = this.result.ageMin;
    const ageMax = this.result.ageMax;
    const span = ageMax - ageMin || 1;
    const markerX = ((this.currentAge - ageMin) / span) * width;
    this.ctx.strokeStyle = this.lightness === 'light' ? 'rgba(20,24,32,0.6)' : 'rgba(255,255,255,0.55)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(markerX, 0);
    this.ctx.lineTo(markerX, height);
    this.ctx.stroke();

    const chrome = this.lightness === 'light' ? LIGHT_CHROME : DARK_CHROME;
    const ci = checkpointIndexAt(this.result.ageRanges, this.currentAge);
    const coverage = (this.result.coverageFraction[ci] * 100).toFixed(0);
    this.status.textContent = `${this.modelName} — continental crust only  ·  Locked Groups covering `
      + `${(MIN_AREA_FRACTION * 100).toFixed(0)}%+ of the continental crust modelled at that age, `
      + `the rest pooled (grey)  ·  ${this.result.checkpointCount} reorganisation events, `
      + `${ageMin.toFixed(0)}–${ageMax.toFixed(0)} Ma  ·  `
      + `${coverage}% of Earth's surface is modelled continental crust at ${this.currentAge.toFixed(0)} Ma`;
    Object.assign(this.status.style, { color: chrome.inkDim });
  }

  private onHover(e: MouseEvent): void {
    if (!this.layout || !this.result) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = pickSankeyNode(this.layout, x, y);
    if (!hit) { this.tooltip.style.display = 'none'; return; }

    const [ageStart, ageEnd] = this.result.ageRanges[hit.columnIndex];
    const isOther = hit.node.id === OTHER_ID;
    const members = this.result.bucketMembers.get(`${hit.columnIndex}:${hit.node.id}`) ?? [];
    // The Locked Group id itself is an arbitrary per-Checkpoint number (see
    // PlateTreeFrame's own doc comment) -- not worth showing. The plates it
    // actually contains are.
    const shown = members.slice(0, 8).join(', ') + (members.length > 8 ? ', …' : '');
    const label = isOther ? 'other Locked Groups, pooled' : `Locked Group: ${shown}`;
    const pct = (hit.node.value / FULL_SPHERE_SR) * 100;
    this.tooltip.textContent = `${label}\n${pct.toFixed(1)}% of Earth's surface (continental crust), `
      + `${members.length} plate${members.length === 1 ? '' : 's'}\n`
      + `${ageStart.toFixed(0)}–${ageEnd.toFixed(0)} Ma`;
    this.tooltip.style.display = 'block';
    const { width: tw, height: th } = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(e.clientX + 12, innerWidth - tw - 8)}px`;
    this.tooltip.style.top = `${Math.max(8, rect.top - th - 8)}px`;
  }

  dispose(): void {
    this.anchor.remove();
    this.tooltip.remove();
  }
}
