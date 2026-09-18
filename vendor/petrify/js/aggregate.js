/*
 * Aggregated point summaries: one glyph per occupied cell, not one per point.
 *
 * PointLayer answers "where is each thing?". This answers "what is here, and how much of
 * it?" -- the question a dataset of tens of thousands of occurrences cannot answer as
 * individual symbols, because at ~3.4 px they overlap into a density cloud in which no
 * category is legible.
 *
 * ---- What this module does NOT know ----------------------------------------------------
 *
 * It does not know the grid. Cell centres arrive in the payload as plain lon/lat, so the
 * binning scheme is entirely the exporter's business -- an equal-area ring grid today, a
 * HEALPix one tomorrow, with no change here. That seam exists because the alternative is
 * the same tessellation implemented twice in two languages, drifting apart silently; the
 * consequence is the renderer cannot draw cell BOUNDARIES, only marks at cell centres,
 * which is a deliberate trade and not an oversight.
 *
 * It also does not know what the categories mean. Same rule as PointLayer: nothing in js/
 * has ever needed to know what a "deposit" or a "species" is.
 *
 * ---- Why frames are not interpolated ---------------------------------------------------
 *
 * PointLayer slerps between samples because a point is a rigid body with correspondence
 * across time -- the same deposit, somewhere else. A CELL has no such correspondence: as
 * plates move, occurrences cross cell boundaries, so a cell's contents change by
 * membership rather than by motion. Interpolating a count would invent fractional
 * occurrences in a cell that may not be the same cell's neighbour at all. So frames cut
 * hard, at the nearest sample, for the same reason BoundarySeries does.
 */

import { lonLatToVec3 } from './sphere.js';
import { fetchMaybeGzippedJSON } from './gzipFetch.js';

export const DEFAULT_OPTIONS = {
  /*
   * 'pie'       proportional wedges per category. Reads composition directly, which is
   *             what "which taxon dominates here" asks for.
   * 'dominant'  a single filled disc in the majority category's colour. Less information,
   *             far more legible when cells are small or numerous.
   */
  mode: 'pie',

  /*
   * Glyph radius, in px, for a cell holding `sizeRef` items. Area is made proportional to
   * the count (radius ~ sqrt), which is the only scaling that does not mislead: a cell
   * with four times the occurrences should look four times as big, and radius-proportional
   * sizing would make it sixteen.
   */
  minRadius: 3,
  maxRadius: 14,
  sizeRef: 40,

  /* What drives glyph size. 'total' is occurrence count; 'richness' is distinct taxa in
   * the cell -- a different question, and the honest one when the curve alongside is a
   * richness curve. 'none' draws every cell the same size. */
  sizeBy: 'total',

  keyline: 'rgba(6, 11, 20, 0.85)',
  keylineWidth: 0.9,

  /* Fallback for a category the palette does not name. Deliberately drab: an unnamed
   * category is a data problem and should look like one rather than like a real class. */
  fill: 'rgba(150, 160, 172, 0.85)',

  hitRadius: 12,

  highlight: 'rgba(255, 255, 255, 0.95)',
  highlightWidth: 1.6,
};

export class AggregateLayer {
  /**
   * @param data     an `aggregates.json` payload -- see SCHEMA.md
   * @param options  see DEFAULT_OPTIONS; `grouping` selects which declared Grouping is
   *                 active, defaulting to the payload's own `default_grouping`
   */
  constructor(data, options = {}) {
    this.data = data;
    this.meta = data.meta || {};
    this.times = data.times;
    this.grid = data.grid || {};
    this.centres = data.cell_centres;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.visible = true;

    if (!Array.isArray(this.centres)) {
      throw new Error('aggregates.json: cell_centres missing -- the renderer does not '
                      + 'implement the grid, so centres must be shipped');
    }

    // Present-day-frame unit vector per cell centre. Cells do NOT move: a cell is a region
    // of the reconstructed globe, and the exporter has already decided which occurrences
    // fall in it at each time. Nothing here rotates.
    this._xyz = new Float64Array(this.centres.length * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < this.centres.length; i++) {
      lonLatToVec3(this.centres[i][0], this.centres[i][1], tmp);
      this._xyz[i * 3] = tmp[0];
      this._xyz[i * 3 + 1] = tmp[1];
      this._xyz[i * 3 + 2] = tmp[2];
    }

    this.groupingNames = Object.keys(data.groupings || {});
    if (!this.groupingNames.length) throw new Error('aggregates.json: no groupings declared');
    this.grouping = null;
    this.setGrouping(options.grouping || data.default_grouping || this.groupingNames[0]);

    this.currentTime = null;
    this.hovered = -1;
    this._frame = null;      // the active grouping's frame at the current time
    this._screen = [];       // parallel to _frame.cells; null where not drawn
    this._v = [0, 0, 0];
  }

  static async load(url, options) {
    return new AggregateLayer(await fetchMaybeGzippedJSON(url), options);
  }

  /** Switch active Grouping. Several are declared, exactly one is shown -- never overlaid,
   *  since two pie charts on one cell is not a readable mark. */
  setGrouping(name) {
    const g = this.data.groupings[name];
    if (!g) throw new Error(`aggregates.json: no grouping "${name}"`);
    this.grouping = name;
    this.active = g;
    // Category order is fixed by the payload, not by per-cell counts -- otherwise a cell's
    // wedges would reshuffle between frames as the majority changed, which reads as motion
    // that is not in the data.
    this.categories = g.category_order || Object.keys(g.categories || {});
    this._fills = this.categories.map(
      (c) => (g.categories?.[c]?.fill) || this.options.fill,
    );
    if (this.currentTime != null) this.setTime(this.currentTime);
    return this;
  }

  /** Label for a category key, falling back to the key itself. */
  labelFor(category) {
    return this.active.categories?.[category]?.label || category;
  }

  /** Fill for a category key. */
  fillFor(category) {
    const i = this.categories.indexOf(category);
    return i < 0 ? this.options.fill : this._fills[i];
  }

  /** Nearest sample index to a time in Ma. Nearest, not bracketing -- see the module
   *  comment for why cell counts are never interpolated. */
  _nearest(time) {
    const times = this.times;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - time);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  setTime(time) {
    this.currentTime = time;
    const key = String(this.times[this._nearest(time)]);
    this._frame = this.active.frames[key] || null;
    this._screen.length = this._frame ? this._frame.cells.length : 0;
    this._screen.fill(null);
    return this;
  }

  /** Occupied cells at the current time. */
  get cellCount() {
    return this._frame ? this._frame.cells.length : 0;
  }

  /** Totals per category across every occupied cell at the current time -- what a legend
   *  showing "how much of each is on screen right now" needs. */
  totals() {
    const out = this.categories.map(() => 0);
    if (!this._frame) return out;
    for (const row of this._frame.counts) {
      for (let c = 0; c < out.length; c++) out[c] += row[c] || 0;
    }
    return out;
  }

  /** Everything known about one occupied-cell slot, for a popup. */
  cellAt(slot) {
    if (!this._frame || slot < 0 || slot >= this._frame.cells.length) return null;
    const counts = this._frame.counts[slot];
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    return {
      cell: this._frame.cells[slot],
      centre: this.centres[this._frame.cells[slot]],
      counts,
      total,
      richness: this._frame.richness ? this._frame.richness[slot] : null,
      categories: this.categories,
      byCategory: Object.fromEntries(
        this.categories.map((c, i) => [c, counts[i] || 0]).filter(([, n]) => n > 0),
      ),
    };
  }

  _radius(slot) {
    const { sizeBy, minRadius, maxRadius, sizeRef } = this.options;
    if (sizeBy === 'none') return (minRadius + maxRadius) / 2;
    const counts = this._frame.counts[slot];
    const n = sizeBy === 'richness' && this._frame.richness
      ? this._frame.richness[slot]
      : counts.reduce((a, b) => a + (b || 0), 0);
    if (!n) return 0;
    // Area proportional to n: r = maxR * sqrt(n / sizeRef), clamped.
    const r = maxRadius * Math.sqrt(n / sizeRef);
    return Math.max(minRadius, Math.min(maxRadius, r));
  }

  draw(ctx, projector) {
    const screen = this._screen;
    screen.fill(null);
    if (!this.visible || !this._frame) return;

    const cells = this._frame.cells;
    const v = this._v;
    for (let s = 0; s < cells.length; s++) {
      const i3 = cells[s] * 3;
      v[0] = this._xyz[i3];
      v[1] = this._xyz[i3 + 1];
      v[2] = this._xyz[i3 + 2];
      // null behind the horizon, which makes the cell unpickable as well as invisible.
      screen[s] = projector.project(v);
    }

    // Painter's algorithm, far first, so a near glyph overlaps a far one rather than the
    // cell index deciding. Small glyphs last within the same depth so they are not buried.
    const order = [];
    for (let s = 0; s < cells.length; s++) if (screen[s]) order.push(s);
    order.sort((a, b) => (screen[b][2] - screen[a][2]) || (this._radius(b) - this._radius(a)));

    for (const s of order) this._drawCell(ctx, s, screen[s]);

    if (this.hovered >= 0 && screen[this.hovered]) {
      const [x, y] = screen[this.hovered];
      ctx.beginPath();
      ctx.arc(x, y, this._radius(this.hovered) + 3, 0, Math.PI * 2);
      ctx.strokeStyle = this.options.highlight;
      ctx.lineWidth = this.options.highlightWidth;
      ctx.stroke();
    }
  }

  _drawCell(ctx, slot, p) {
    const r = this._radius(slot);
    if (r <= 0) return;
    const [x, y] = p;
    const counts = this._frame.counts[slot];
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    if (!total) return;

    if (this.options.mode === 'dominant') {
      let best = 0;
      for (let c = 1; c < counts.length; c++) if ((counts[c] || 0) > (counts[best] || 0)) best = c;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = this._fills[best];
      ctx.fill();
    } else {
      // Start at 12 o'clock and go clockwise, which is how a pie is read. Category order
      // is the payload's, so a wedge keeps its angular position between frames.
      let a0 = -Math.PI / 2;
      for (let c = 0; c < counts.length; c++) {
        const n = counts[c] || 0;
        if (!n) continue;
        const a1 = a0 + (n / total) * Math.PI * 2;
        ctx.beginPath();
        // A single-category cell is a full disc: moveTo(centre) on a 2pi arc leaves a
        // visible radius line where the path closes.
        if (n === total) {
          ctx.arc(x, y, r, 0, Math.PI * 2);
        } else {
          ctx.moveTo(x, y);
          ctx.arc(x, y, r, a0, a1);
          ctx.closePath();
        }
        ctx.fillStyle = this._fills[c];
        ctx.fill();
        a0 = a1;
      }
    }

    if (this.options.keylineWidth > 0) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = this.options.keyline;
      ctx.lineWidth = this.options.keylineWidth;
      ctx.stroke();
    }
  }

  /**
   * Which occupied cell is at this canvas position, or null.
   *
   * Reads the positions the last draw() computed, for the same reason PointLayer.pick()
   * does: if picking recomputed them, the popup could describe a glyph other than the one
   * under the cursor, and that is invisible in a screenshot.
   *
   * Hit radius is the glyph's own radius where that exceeds `hitRadius`, so a large pie is
   * hittable across its whole face rather than only near its centre.
   */
  pick(x, y) {
    if (!this.visible || !this._frame) return null;
    let best = -1;
    let bestD = Infinity;
    for (let s = 0; s < this._screen.length; s++) {
      const p = this._screen[s];
      if (!p) continue;
      const d = Math.hypot(p[0] - x, p[1] - y);
      const reach = Math.max(this.options.hitRadius, this._radius(s));
      if (d <= reach && d < bestD) { bestD = d; best = s; }
    }
    if (best < 0) return null;
    return { slot: best, x: this._screen[best][0], y: this._screen[best][1], ...this.cellAt(best) };
  }

  /** Ring-highlight one occupied-cell slot (or none, for null). Purely visual. */
  highlight(slot) {
    this.hovered = slot == null ? -1 : slot;
    return this;
  }
}
