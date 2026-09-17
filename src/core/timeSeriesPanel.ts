import type { Rect } from './layout';
import type { TimeSeriesPoint } from './timeSeries';

export interface TimeSeriesPanelCallbacks {
  /** The panel was just expanded -- see setVariables()'s own doc comment
   *  for why every open fires this rather than TimeSeriesPanel tracking
   *  "already requested" itself; the caller owns the actual cache. */
  onExpand(): void;
}

export interface TimeSeriesPanelRectOptions {
  /** How far below the tile's own top edge to start -- clears whatever
   *  fixed status/legend/query stack the owning UI class already anchors
   *  up there. */
  topOffset: number;
  /** Absolute CSS `bottom` (distance from the viewport's bottom edge, in
   *  px) -- the caller computes this from its own bottom-anchored elements
   *  (e.g. a legend) so the two never overlap, the same reasoning
   *  climate/climateUi.ts's applyRect() applies to its bottom-bar. */
  bottomPx: number;
  /** How much horizontal space the owning UI class's own lil-gui panel
   *  (top-right) currently occupies, so a narrow multi-globe tile's panel
   *  and this box never overlap. */
  panelWidth: number;
}

interface Row {
  row: HTMLDivElement;
  canvas: HTMLCanvasElement;
  statusEl: HTMLDivElement;
  points: TimeSeriesPoint[] | null;
}

/**
 * A collapsible fan-chart panel (median + IQR band + 5-95th pct band) per
 * pickable Variable of whatever model/manifest is currently active --
 * extracted from climate/climateUi.ts's original, climate-only
 * implementation (see docs/adr/0023) so `single-model-globe`/
 * `model-group-globe` can offer the same Field Aggregate Time Series
 * without duplicating the DOM/canvas plumbing a second time. Owns no
 * domain knowledge of its own: the caller decides which variables are
 * pickable, computes each one's points (core/timeSeries.ts's
 * computeTimeSeries()), and feeds them in via setData().
 */
export class TimeSeriesPanel {
  private anchor: HTMLDivElement;
  private toggle: HTMLButtonElement;
  private body: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private expanded = false;
  private rows = new Map<string, Row>();
  /** The Frame age range to plot the X axis over -- the manifest's own full
   *  range, NOT the span of whichever points happen to be computed so far,
   *  so the marker line and axis stay stable as rows populate
   *  progressively at different speeds. */
  private ageMin = 0;
  private ageMax = 540;
  private currentAge = 0;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  private rectOpts: TimeSeriesPanelRectOptions = { topOffset: 0, bottomPx: 0, panelWidth: 0 };

  constructor(private readonly cb: TimeSeriesPanelCallbacks) {
    this.anchor = document.createElement('div');
    this.anchor.className = 'timeseries-anchor';
    this.toggle = document.createElement('button');
    this.toggle.className = 'timeseries-toggle';
    this.toggle.textContent = '▸ time series';
    this.body = document.createElement('div');
    this.body.className = 'timeseries-body';
    this.toggle.addEventListener('click', () => this.toggleExpanded());
    this.anchor.append(this.toggle, this.body);
    document.body.appendChild(this.anchor);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'timeseries-tooltip';
    document.body.appendChild(this.tooltip);

    this.applyRect();
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.body.style.display = this.expanded ? 'flex' : 'none';
    this.toggle.textContent = this.expanded ? '▾ time series' : '▸ time series';
    if (this.expanded) this.cb.onExpand();
  }

  setAgeRange(min: number, max: number): void {
    this.ageMin = min;
    this.ageMax = max;
  }

  /** Rebuild rows for the given pickable variables -- called whenever the
   *  variable SET changes (a different model/manifest becoming active),
   *  since a stale row for a variable that no longer applies would be
   *  worse than an empty panel. Builds empty placeholder rows regardless of
   *  whether the panel is expanded (cheap: no fetch happens until onExpand()
   *  actually fires), so opening it later needs no separate "first paint"
   *  case. Hides the whole panel when there's nothing pickable, rather than
   *  offering an expand button for a permanently-empty box. */
  setVariables(variables: { id: string; name: string }[]): void {
    this.body.replaceChildren();
    this.rows.clear();
    for (const v of variables) {
      const row = document.createElement('div');
      row.className = 'timeseries-row';
      const label = document.createElement('div');
      label.className = 'timeseries-label';
      label.textContent = v.name;
      const canvas = document.createElement('canvas');
      canvas.className = 'timeseries-canvas';
      canvas.width = 260;
      canvas.height = 110;
      canvas.addEventListener('mousemove', (e) => this.onHover(e, v.id, canvas));
      canvas.addEventListener('mouseleave', () => this.hideTooltip());
      const statusEl = document.createElement('div');
      statusEl.className = 'timeseries-status';
      row.append(label, canvas, statusEl);
      this.body.appendChild(row);
      this.rows.set(v.id, { row, canvas, statusEl, points: null });
    }
    const hasAny = variables.length > 0;
    this.anchor.style.display = hasAny ? 'flex' : 'none';
    if (!hasAny) {
      this.expanded = false;
      this.body.style.display = 'none';
      this.toggle.textContent = '▸ time series';
    }
    if (hasAny && this.expanded) this.cb.onExpand();
  }

  setLoading(variableId: string): void {
    const entry = this.rows.get(variableId);
    if (!entry) return;
    entry.statusEl.textContent = 'computing…';
  }

  setData(variableId: string, points: TimeSeriesPoint[]): void {
    const entry = this.rows.get(variableId);
    if (!entry) return; // a stale response landing after setVariables() rebuilt the rows
    entry.points = points;
    entry.statusEl.textContent = '';
    this.drawRow(entry.canvas, points);
  }

  /** Redraw every row's marker (and, incidentally, the whole chart -- cheap
   *  enough at a few hundred points on a small canvas not to bother
   *  splitting out) at the CURRENT age. Safe to call regardless of whether
   *  the panel is expanded or any row has data yet -- drawRow() on a
   *  null-points row is a no-op. */
  setAge(age: number): void {
    this.currentAge = age;
    for (const entry of this.rows.values()) {
      if (entry.points) this.drawRow(entry.canvas, entry.points);
    }
  }

  /** Nearest-point lookup by X position, not exact pixel hit-testing --
   *  Frame ages aren't evenly spaced, so "nearest age to the cursor" is the
   *  only sensible notion of hover target. */
  private onHover(e: MouseEvent, variableId: string, canvas: HTMLCanvasElement): void {
    const entry = this.rows.get(variableId);
    if (!entry?.points?.length) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const hoverAge = this.ageMin + frac * (this.ageMax - this.ageMin);
    let nearest = entry.points[0];
    let bestDist = Math.abs(nearest.age - hoverAge);
    for (const p of entry.points) {
      const d = Math.abs(p.age - hoverAge);
      if (d < bestDist) { bestDist = d; nearest = p; }
    }
    this.showTooltip(e.clientX, e.clientY, nearest);
  }

  private formatTick(v: number): string {
    return Number(v.toPrecision(3)).toString();
  }

  private showTooltip(clientX: number, clientY: number, p: TimeSeriesPoint): void {
    const fmt = (v: number) => (Number.isNaN(v) ? '—' : this.formatTick(v));
    this.tooltip.replaceChildren();
    const lines = [
      `${p.age.toFixed(0)} Ma`,
      `median ${fmt(p.p50)}`,
      `IQR ${fmt(p.p25)} – ${fmt(p.p75)}`,
      `5–95th pct ${fmt(p.p5)} – ${fmt(p.p95)}`,
      `mean ${fmt(p.mean)}`,
    ];
    for (const line of lines) {
      const row = document.createElement('div');
      row.textContent = line;
      this.tooltip.appendChild(row);
    }
    this.tooltip.style.display = 'block';
    const { width: tw, height: th } = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(clientX + 14, innerWidth - tw - 8)}px`;
    this.tooltip.style.top = `${Math.min(clientY + 14, innerHeight - th - 8)}px`;
  }

  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }

  /** A fan chart: a shaded p5-p95 band (outer, light), a shaded p25-p75 IQR
   *  band (inner, darker) on top of it, a p50 median line on top of that,
   *  plus a vertical marker at the CURRENT age -- see
   *  core/timeSeries.ts's weightedPercentile() doc comment for why p5/p95
   *  rather than literal min/max. A run of points breaks wherever p50 is
   *  NaN (mask covered every texel that Frame), rather than bridging across
   *  missing data. Redrawn from scratch on every call. */
  private drawRow(canvas: HTMLCanvasElement, points: TimeSeriesPoint[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const outer = points.flatMap((p) => [p.p5, p.p95]).filter((v) => !Number.isNaN(v));
    if (outer.length === 0) return;
    let vMin = Math.min(...outer);
    let vMax = Math.max(...outer);
    if (vMin === vMax) { vMin -= 1; vMax += 1; } // a perfectly flat series would otherwise divide by zero below

    const padX = 2;
    const padY = 3;
    const ageSpan = this.ageMax - this.ageMin || 1;
    const toX = (age: number) => padX + ((age - this.ageMin) / ageSpan) * (w - 2 * padX);
    const toY = (v: number) => h - padY - ((v - vMin) / (vMax - vMin)) * (h - 2 * padY);

    const runs: TimeSeriesPoint[][] = [];
    let current: TimeSeriesPoint[] = [];
    for (const p of points) {
      if (Number.isNaN(p.p50)) { if (current.length) runs.push(current); current = []; continue; }
      current.push(p);
    }
    if (current.length) runs.push(current);

    const fillBand = (run: TimeSeriesPoint[], top: 'p5' | 'p25', bottom: 'p95' | 'p75', style: string) => {
      ctx.fillStyle = style;
      ctx.beginPath();
      run.forEach((p, i) => {
        const x = toX(p.age);
        const y = toY(p[top]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(toX(run[i].age), toY(run[i][bottom]));
      ctx.closePath();
      ctx.fill();
    };

    for (const run of runs) {
      fillBand(run, 'p5', 'p95', 'rgba(127, 208, 255, 0.15)');
      fillBand(run, 'p25', 'p75', 'rgba(127, 208, 255, 0.35)');
      ctx.strokeStyle = '#7fd0ff';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      run.forEach((p, i) => {
        const x = toX(p.age);
        const y = toY(p.p50);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const markerX = toX(this.currentAge);
    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(markerX, 0);
    ctx.lineTo(markerX, h);
    ctx.stroke();
  }

  /** Move this panel onto a new tile, in CSS pixels -- called once at boot
   *  with the full window and again whenever the globe grid is relaid out
   *  (see core/multiInstanceHost.ts, docs/adr/0022). */
  setRect(rect: Rect, opts: TimeSeriesPanelRectOptions): void {
    this.rect = rect;
    this.rectOpts = opts;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width } = this.rect;
    const { topOffset, bottomPx, panelWidth } = this.rectOpts;
    this.anchor.style.top = `${y + topOffset}px`;
    this.anchor.style.left = `${x + 12}px`;
    this.anchor.style.bottom = `${bottomPx}px`;
    // Capped to whatever's actually left of the tile after the owning UI
    // class's own lil-gui panel width -- on a narrow multi-globe grid, a
    // fixed 260px here would run this tile's OWN panel over, since both are
    // independently edge-anchored with no shared awareness of each other.
    // Floor of 140px keeps a collapsed row still legible rather than
    // vanishing to nothing on an extreme grid.
    const available = width - 12 - panelWidth - 20;
    this.anchor.style.width = `${Math.max(140, Math.min(260, available))}px`;
  }

  dispose(): void {
    this.anchor.remove();
    this.tooltip.remove();
  }
}
