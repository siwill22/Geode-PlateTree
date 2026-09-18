/*
 * Time series beside the map, sharing its clock.
 *
 * A globe answers "what did the Earth look like at time t". It cannot answer "and what was
 * happening to CO2 / sea level / boundary length while that changed". This draws one small
 * stacked panel per quantity against the same time axis, with a marker at the current
 * reconstruction time.
 *
 * ---- Which way is forwards? -----------------------------------------------------------
 *
 * The single thing most worth getting right here. Time is in Ma, so it counts DOWN toward
 * the present, and the axis is drawn oldest-left / present-right to match a slider that
 * reads like a timeline. Moving FORWARD in time therefore moves RIGHTWARD, and at a current
 * time T everything that has already happened is OLDER -- t >= T -- and lies to the LEFT of
 * the marker.
 *
 * So 'reveal' mode draws t >= T and hides t < T. Reversing that produces a chart that looks
 * completely plausible and is exactly backwards, which is why it has a test of its own.
 *
 * ---- No DOM here ----------------------------------------------------------------------
 *
 * This module draws into a 2D context and nothing else. Creating the canvas, resizing it,
 * the mode selector and pointer handling live in timeseries-panel.js, which is kept out of
 * the barrel -- the same split hover.js uses.
 */

export const MODES = ['marker', 'shade', 'reveal', 'always'];

export const DEFAULT_OPTIONS = {
  /*
   * How the chart expresses "now":
   *
   *   'marker'  the whole curve, with a rule and a dot at the current time
   *   'shade'   the whole curve, already-happened solid and the rest dimmed
   *   'reveal'  only what has already happened, so the curve draws itself as time advances
   *   'always'  the whole curve, no marker at all -- for comparing shapes, or printing
   */
  mode: 'shade',

  rowHeight: 44,
  rowGap: 6,
  padTop: 4,

  // Left inset for the row label, in px. The plot area starts after it.
  labelWidth: 0,

  stroke: 'rgba(200, 214, 230, 0.9)',
  lineWidth: 1.4,
  // What the not-yet-reached part fades to under 'shade'. Low enough to read as context
  // rather than data, high enough that the shape of what is coming is still legible.
  dimAlpha: 0.22,

  marker: 'rgba(232, 240, 248, 0.85)',
  markerWidth: 1,
  dotRadius: 2.6,

  baseline: 'rgba(143, 212, 240, 0.14)',
  ghost: 'rgba(143, 212, 240, 0.5)',

  // Vertical padding inside a row, so a peak does not touch the row above. The label sits
  // in the top of this padding, over the quietest part of most records.
  yPad: 5,

  labels: true,
  labelFont: '10px ui-sans-serif, system-ui, sans-serif',
  labelColour: 'rgba(232, 240, 248, 0.62)',
  valueColour: 'rgba(232, 240, 248, 0.92)',
  labelTop: 9,
  // Labels sit inside the plot, so a curve can run behind them. A halo in the panel colour
  // keeps them readable without reserving a gutter that would waste most of the width.
  labelHalo: 'rgba(9, 16, 28, 0.85)',
  labelHaloWidth: 3,
};

/**
 * Parse a CSV of numbers with a header row.
 *
 * Deliberately strict about one thing: a blank or unparsable cell becomes `null`, never 0.
 * A gap in a record is not a plunge to zero, and drawing it as one invents data that is not
 * there. `null` lifts the pen instead.
 *
 * Handles a UTF-8 BOM, CRLF, `#` comment lines, blank lines, and quoted fields containing
 * commas or escaped quotes.
 *
 * @returns { columns: string[], rows: (number|string|null)[][] }
 */
export function parseCsv(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  let started = false;

  const endField = () => { record.push(field); field = ''; started = false; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];

    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }   // "" is a literal quote
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"' && !started) { quoted = true; started = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;                              // CRLF
    if (c === '\n') { endRecord(); continue; }
    field += c;
    started = true;
  }
  if (field !== '' || record.length) endRecord();

  // Drop blank lines and comments only now, so a `#` inside a quoted field survives.
  const useful = records.filter(
    (r) => !(r.length === 1 && r[0].trim() === '') && !r[0].trimStart().startsWith('#'));

  if (!useful.length) return { columns: [], rows: [] };

  const columns = useful[0].map((h) => h.trim());
  const rows = useful.slice(1).map((r) => columns.map((_, i) => {
    const raw = (r[i] ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }));

  return { columns, rows };
}

/** Which column holds time? A named one if there is one, else the first. */
export function timeColumn(columns) {
  const i = columns.findIndex((c) => /^(time|age|ma|t)(_|\b)/i.test(c.trim()));
  return i >= 0 ? i : 0;
}

/**
 * A set of quantities sharing one time axis.
 *
 * @param series  [{ key, label, unit, colour, times: number[], values: (number|null)[] }]
 *                times ascending in Ma
 */
export class TimeSeriesSet {
  constructor(series, options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.series = series.map((s) => ({ ...s, visible: s.visible !== false }));
    this.currentTime = null;
    this.ghostTime = null;          // where the pointer is, if anywhere
    this.range = options.range || this._dataRange();
    this._layout = null;
  }

  _dataRange() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.series) {
      if (!s.times.length) continue;
      lo = Math.min(lo, s.times[0]);
      hi = Math.max(hi, s.times[s.times.length - 1]);
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 1];
  }

  get mode() { return this.options.mode; }
  set mode(m) { if (MODES.includes(m)) this.options.mode = m; }

  get visibleSeries() { return this.series.filter((s) => s.visible); }

  /** Height the panel wants for the current number of visible rows. */
  heightFor(count = this.visibleSeries.length) {
    const { rowHeight, rowGap, padTop } = this.options;
    return count ? padTop + count * rowHeight + (count - 1) * rowGap : 0;
  }

  /** Does any series carry data outside the drawn range? Worth telling the reader. */
  clipping() {
    const [lo, hi] = this.range;
    return this.series.some((s) => s.times.length
      && (s.times[0] < lo - 1e-9 || s.times[s.times.length - 1] > hi + 1e-9));
  }

  setTime(time) { this.currentTime = time; return this; }
  setGhost(time) { this.ghostTime = time; return this; }

  /**
   * Which end of the x axis the present sits at.
   *
   * 'oldest-left' (the default, and this library's original and only behaviour)
   * puts hi at x0, so time runs left-to-right in reading order. 'present-left'
   * puts lo at x0, which is what a host whose age slider runs 0 on the left needs
   * if its chart is to line up with the slider rather than mirror it.
   *
   * Explicit because this library now ships TWO time-axis panels -- this one and
   * latitude-panel.js -- and they disagreed silently when the second was added.
   * Two charts stacked on what the reader takes to be one shared axis, running
   * opposite ways, is not a misconfiguration anyone spots: it just looks like the
   * data is wrong.
   */
  get presentLeft() {
    return this.options.timeDirection === 'present-left';
  }

  /** Time at a canvas x, inverse of the layout's x mapping. */
  timeAt(x) {
    const L = this._layout;
    if (!L) return null;
    const f = (x - L.x0) / (L.x1 - L.x0);
    const [lo, hi] = this.range;
    return this.presentLeft ? lo + f * (hi - lo) : hi - f * (hi - lo);
  }

  xFor(time) {
    const L = this._layout;
    if (!L) return null;
    const [lo, hi] = this.range;
    if (hi === lo) return L.x0;
    const f = this.presentLeft ? (time - lo) / (hi - lo) : (hi - time) / (hi - lo);
    return L.x0 + f * (L.x1 - L.x0);
  }

  /**
   * Value of each visible series at a time, by linear interpolation between samples.
   * Returns [{ key, label, unit, colour, value }], value null inside a gap.
   */
  valuesAt(time) {
    return this.visibleSeries.map((s) => ({
      key: s.key, label: s.label, unit: s.unit, colour: s.colour,
      value: interpolate(s.times, s.values, time),
    }));
  }

  /**
   * Precompute pixel coordinates. Called on resize and on data change, NOT per frame:
   * when only the time changes, the geometry is identical and only the split moves.
   *
   * @param inset  px to reserve at each end of the plot, so x can be made to line up with
   *               something else -- a range input's thumb travel, for instance.
   */
  layout({ width, height, inset = 0 }) {
    const o = this.options;
    const rows = this.visibleSeries;

    const x0 = o.labelWidth + inset;
    const x1 = width - inset;
    const [lo, hi] = this.range;
    const span = hi === lo ? 1 : hi - lo;

    const L = { width, height, inset, x0, x1, rows: [] };

    for (let r = 0; r < rows.length; r++) {
      const s = rows[r];
      const top = o.padTop + r * (o.rowHeight + o.rowGap);
      const bottom = top + o.rowHeight;

      // y scale from the data actually inside the drawn time range: a record that runs to
      // 500 Ma should not squash the visible 0-250 Ma part against the baseline.
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < s.times.length; i++) {
        const t = s.times[i];
        const v = s.values[i];
        if (v == null || t < lo || t > hi) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!Number.isFinite(min)) { min = 0; max = 1; }
      if (min === max) { min -= 0.5; max += 0.5; }

      const yTop = top + o.yPad;
      const yBottom = bottom - o.yPad;
      const toY = (v) => yBottom - ((v - min) / (max - min)) * (yBottom - yTop);
      const toX = (t) => x0 + ((hi - t) / span) * (x1 - x0);

      // Decimate to at most two points per pixel column, keeping the min and max in each so
      // a one-sample spike survives. Without this a 100k-row record costs 100k lineTo calls
      // a frame; with it the cost is set by the panel width, whatever the file holds.
      const pts = decimate(s.times, s.values, toX, toY, lo, hi, x0, x1);

      L.rows.push({ series: s, top, bottom, min, max, yTop, yBottom, ...pts });
    }

    this._layout = L;
    return this;
  }

  /**
   * Index of the first point at or beyond the split, by binary search on x.
   * Points are stored left to right, i.e. oldest first.
   */
  _splitIndex(row, time) {
    const x = this.xFor(time);
    const xs = row.xs;
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  draw(ctx) {
    const L = this._layout;
    if (!L) return;
    const o = this.options;
    const mode = o.mode;
    const time = this.currentTime;
    const markerX = time == null ? null : this.xFor(time);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const row of L.rows) {
      const s = row.series;
      const colour = s.colour || o.stroke;

      // Baseline, so an empty row still reads as a row.
      ctx.strokeStyle = o.baseline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.x0, row.yBottom + 0.5);
      ctx.lineTo(L.x1, row.yBottom + 0.5);
      ctx.stroke();

      const split = markerX == null ? row.xs.length : this._splitIndex(row, time);

      ctx.lineWidth = o.lineWidth;
      ctx.strokeStyle = colour;

      if (mode === 'reveal') {
        strokeRun(ctx, row, 0, split);
      } else if (mode === 'shade') {
        // The part not yet reached first and dimmed, so the solid part sits over it.
        ctx.globalAlpha = o.dimAlpha;
        strokeRun(ctx, row, Math.max(0, split - 1), row.xs.length);
        ctx.globalAlpha = 1;
        strokeRun(ctx, row, 0, split);
      } else {
        strokeRun(ctx, row, 0, row.xs.length);
      }
      ctx.globalAlpha = 1;
    }

    // One rule across every row, drawn last so nothing covers it.
    if (markerX != null && mode !== 'always') {
      const top = o.padTop;
      const bottom = L.rows.length
        ? L.rows[L.rows.length - 1].bottom : L.height;

      /*
       * fillRect on integer bounds rather than a 1 px stroke.
       *
       * A stroke centred on a fractional x smears across two columns at half strength, so
       * the rule looks soft at some times and crisp at others. Snapping the stroke to a
       * half-pixel fixes the smear but moves it by up to a whole pixel. A filled rect on
       * integer bounds is crisp AND lands within half a pixel of the true position, which
       * matters here because the marker is meant to sit on the slider thumb.
       */
      const mx = Math.round(markerX - o.markerWidth / 2);
      ctx.fillStyle = o.marker;
      ctx.fillRect(mx, top, Math.max(1, Math.round(o.markerWidth)), bottom - top);

      for (const row of L.rows) {
        const v = interpolate(row.series.times, row.series.values, time);
        if (v == null) continue;
        const y = row.yBottom
          - ((v - row.min) / (row.max - row.min)) * (row.yBottom - row.yTop);
        ctx.fillStyle = row.series.colour || o.stroke;
        ctx.beginPath();
        ctx.arc(markerX, y, o.dotRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(7, 12, 22, 0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Labels last, so a busy curve never runs over the text that names it. The value shown
    // is the one under the POINTER when there is one, so the panel can be interrogated
    // without moving the globe; otherwise it is the value at the reconstruction time.
    if (o.labels) {
      const readAt = this.ghostTime != null ? this.ghostTime : time;
      ctx.font = o.labelFont;
      ctx.textBaseline = 'alphabetic';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      const haloed = (text, x, y, fill) => {
        if (o.labelHalo) {
          ctx.strokeStyle = o.labelHalo;
          ctx.lineWidth = o.labelHaloWidth;
          ctx.strokeText(text, x, y);
        }
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
      };

      for (const row of L.rows) {
        const s = row.series;
        const y = row.top + o.labelTop;

        ctx.textAlign = 'left';
        haloed(s.label, L.x0 + 1, y, o.labelColour);

        const v = interpolate(s.times, s.values, readAt);
        ctx.textAlign = 'right';
        haloed(v == null ? '—' : formatValue(v) + (s.unit ? ' ' + s.unit : ''),
               L.x1 - 1, y, this.ghostTime != null ? o.ghost : o.valueColour);
      }
    }

    // Where the pointer is, if it is over the panel and not on the marker.
    if (this.ghostTime != null) {
      const gx = this.xFor(this.ghostTime);
      if (markerX == null || Math.abs(gx - markerX) > 1) {
        ctx.strokeStyle = o.ghost;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(crisp(gx), o.padTop);
        ctx.lineTo(crisp(gx), L.rows.length ? L.rows[L.rows.length - 1].bottom : L.height);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }
}

/**
 * Stroke points [from, to) as one path, lifting the pen across gaps.
 *
 * Note there is no closePath here, and there must not be: it is not O(1) in Blink while
 * subpaths accumulate, and it is what made the continent fill quadratic.
 */
function strokeRun(ctx, row, from, to) {
  const { xs, ys } = row;
  ctx.beginPath();
  let pen = false;
  for (let i = from; i < to; i++) {
    if (Number.isNaN(ys[i])) { pen = false; continue; }   // gap in the record
    if (pen) ctx.lineTo(xs[i], ys[i]);
    else { ctx.moveTo(xs[i], ys[i]); pen = true; }
  }
  ctx.stroke();
}

/**
 * Project a record to pixels, at most two points per column.
 *
 * Within a column the min and max are emitted in the order they occur, so the vertical
 * extent is preserved and the line still runs the right way through it. Gaps are kept as
 * NaN so the pen lifts in the right place.
 */
function decimate(times, values, toX, toY, lo, hi, x0, x1) {
  const columns = Math.max(1, Math.round(x1 - x0));
  const xs = [];
  const ys = [];

  let i = 0;
  const n = times.length;
  // Skip anything left of the drawn range; times ascend, x descends with time.
  while (i < n && times[i] < lo) i++;

  let col = -1;
  let bucket = null;

  const flush = () => {
    if (!bucket) return;
    if (bucket.gap && !bucket.count) { xs.push(bucket.x); ys.push(NaN); bucket = null; return; }
    if (bucket.count === 1) { xs.push(bucket.xFirst); ys.push(bucket.yFirst); }
    else {
      // min and max, in the order they appeared
      const a = bucket.iMin < bucket.iMax
        ? [bucket.xMin, bucket.yMin, bucket.xMax, bucket.yMax]
        : [bucket.xMax, bucket.yMax, bucket.xMin, bucket.yMin];
      xs.push(a[0], a[2]); ys.push(a[1], a[3]);
    }
    if (bucket.gap) { xs.push(bucket.x); ys.push(NaN); }
    bucket = null;
  };

  for (; i < n && times[i] <= hi; i++) {
    const t = times[i];
    const v = values[i];
    const x = toX(t);
    const c = Math.floor(((x - x0) / (x1 - x0)) * columns);

    if (c !== col) { flush(); col = c; bucket = { x, count: 0, gap: false }; }

    if (v == null) { bucket.gap = true; continue; }

    const y = toY(v);
    if (bucket.count === 0) {
      bucket.xFirst = x; bucket.yFirst = y;
      bucket.xMin = bucket.xMax = x;
      bucket.yMin = bucket.yMax = y;
      bucket.iMin = bucket.iMax = i;
    } else {
      if (y < bucket.yMin) { bucket.yMin = y; bucket.xMin = x; bucket.iMin = i; }
      if (y > bucket.yMax) { bucket.yMax = y; bucket.xMax = x; bucket.iMax = i; }
    }
    bucket.count++;
  }
  flush();

  // xs must ascend for the binary search in _splitIndex. Time descends with x, and the
  // input is time-ascending, so the arrays come out right-to-left; reverse them.
  xs.reverse();
  ys.reverse();
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

/** Half-pixel grid, so a 1 px line lands on one column rather than smearing across two. */
function crisp(x) {
  return Math.round(x) + 0.5;
}

/** Enough significant figures to be useful, few enough to read at a glance. */
function formatValue(v) {
  const a = Math.abs(v);
  if (a >= 10000) return Math.round(v).toLocaleString();
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

/** Linear interpolation between bracketing samples; null inside a gap or outside the record. */
function interpolate(times, values, t) {
  const n = times.length;
  if (!n || t == null) return null;
  if (t < times[0] || t > times[n - 1]) return null;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  if (t === times[lo]) return values[lo];
  if (t === times[hi]) return values[hi];

  const a = values[lo];
  const b = values[hi];
  if (a == null || b == null) return null;     // do not interpolate across a gap
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return a + (b - a) * f;
}

/**
 * Build a TimeSeriesSet from CSV text.
 *
 * @param spec  { [column]: { label, unit, colour } } -- which columns to plot and how.
 *              Omit to take every numeric column other than the time one.
 */
export function seriesFromCsv(text, spec = null, options = {}) {
  const { columns, rows } = parseCsv(text);
  if (!columns.length) return new TimeSeriesSet([], options);

  const ti = timeColumn(columns);

  // Ascending time, whatever order the file was written in.
  const sorted = rows
    .filter((r) => typeof r[ti] === 'number')
    .sort((a, b) => a[ti] - b[ti]);
  const times = sorted.map((r) => r[ti]);

  const wanted = spec
    ? Object.keys(spec).filter((c) => columns.includes(c))
    : columns.filter((c, i) => i !== ti
        && sorted.some((r) => typeof r[i] === 'number'));

  const series = wanted.map((name) => {
    const i = columns.indexOf(name);
    const cfg = (spec && spec[name]) || {};
    return {
      key: name,
      label: cfg.label || name,
      unit: cfg.unit || '',
      colour: cfg.colour,
      visible: cfg.visible !== false,
      times,
      values: sorted.map((r) => (typeof r[i] === 'number' ? r[i] : null)),
    };
  });

  return new TimeSeriesSet(series, options);
}
