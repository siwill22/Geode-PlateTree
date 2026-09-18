/*
 * Latitude against age: where something lived, over the whole record, in one picture.
 *
 * A globe answers "where is this at THIS age". Scrubbing it shows a trend only to someone
 * already watching for one, and never in a screenshot. This panel puts the whole record on
 * two axes -- latitude up, age across -- so a poleward retreat, a tropical collapse, or a
 * range expanding across a newly-formed connection is a shape rather than something you
 * have to remember having seen.
 *
 * Kept out of index.js alongside hover.js and timeseries-panel.js: it is a DOM module, and
 * a consumer drawing headlessly should not have to load it.
 *
 * ---- Two axis conventions, both deliberate ---------------------------------------------
 *
 * **Age bins keep their true widths.** They are stratigraphic intervals, and real ones are
 * wildly uneven -- ICS stages run from under 1 Myr to 21.6 Myr. Drawing them as equal
 * columns would make a long bin look like a short one while it quietly accumulates more
 * taxa, which is the single easiest way to misread a diversity record. So a bin's column is
 * as wide as the time it covers, and the unevenness is visible.
 *
 * **Latitude bands are equal in degrees, not equal in area.** A band at 60 degrees covers
 * half the surface of one at the equator, so polar bands sample less area and will read
 * thinner for that reason alone. The alternative -- equal-area bands, equally spaced in
 * sin(lat) -- removes that bias but puts a nonlinear axis in front of a reader who is
 * trying to read "latitude", and the tropics would occupy most of the height. Degrees win
 * because this panel is read as a map axis, not as a density estimate. The consequence is
 * noted here so a consumer does not mistake band totals for area-normalised ones.
 */

import { fetchMaybeGzippedJSON } from './gzipFetch.js';

const DEFAULTS = {
  // Half of this is the plot inset at each end, so a time cursor lines up with a range
  // input's thumb centre -- same geometry timeseries-panel.js documents at length.
  thumbWidth: 14,

  height: 150,
  seekStep: 1,

  /*
   * 'dominant'  cell painted in its majority category's colour, opacity by count. Shows
   *             composition and abundance together, which is what a turnover story needs.
   * 'density'   one ramp, category ignored. Cleaner when there is only one category, or
   *             when the question is purely "how much, where".
   */
  mode: 'dominant',

  background: 'rgba(10, 16, 26, 0.55)',
  axis: 'rgba(210, 222, 236, 0.30)',
  equator: 'rgba(210, 222, 236, 0.55)',
  label: 'rgba(210, 222, 236, 0.70)',
  cursor: 'rgba(255, 255, 255, 0.9)',
  ghost: 'rgba(255, 255, 255, 0.35)',
  densityColour: [126, 200, 227],
  font: '10px system-ui, sans-serif',

  /* Latitude gridlines, in degrees. The equator is drawn brighter than the rest. */
  gridLatitudes: [-60, -30, 0, 30, 60],

  /*
   * Opacity is scaled by sqrt(count / opacityRef), not linearly: occurrence counts per
   * (bin, band) span orders of magnitude, so a linear ramp leaves everything but the few
   * best-sampled cells indistinguishable from empty.
   */
  opacityRef: 30,
  minOpacity: 0.16,

  /* Which end of the x axis the present sits at -- see TimeSeriesSet.presentLeft.
     Same name, same values, same default, because these two panels are routinely
     stacked on what the reader takes to be ONE shared age axis. */
  timeDirection: 'oldest-left',

  /*
   * Horizontal inset of the plot, in px, at BOTH ends -- deliberately the same
   * quantity timeseries-panel.js insets by (half a range input's thumb width),
   * so that stacking the two puts a given age at the same x in both. Matching
   * the DIRECTION is not sufficient for that: an earlier version reserved 30 px
   * on the left for latitude labels and 7 on the right, which left the two
   * panels' axes differing by up to 23 px -- small enough to look like sloppy
   * rendering rather than a different axis, which is worse than an obvious
   * error.
   *
   * The latitude labels are therefore drawn INSIDE the plot, over the heatmap,
   * with a halo. That costs a few pixels of data at the left edge and buys an
   * axis that agrees with its neighbour by construction.
   */
  inset: 7,
  labelHalo: 'rgba(10, 16, 26, 0.85)',
};

/**
 * @param element    container to fill
 * @param data       a `latitude.json` payload (see SCHEMA.md), or pass `url` instead
 * @param url        fetched if `data` is absent
 * @param range      [minAge, maxAge] in Ma -- the drawn x extent
 * @param grouping   which declared Grouping to colour by; defaults to the payload's own
 * @param onSeek     (age) => void when the reader clicks or drags
 * @param onRender   called when the panel needs repainting; wire to the page's own
 *                   frame-coalescing render rather than letting this drive a loop
 */
export async function attachLatitudePanel({
  element, data = null, url = null, range, grouping = null,
  onSeek = null, onRender = null, ...rest
}) {
  const opts = { ...DEFAULTS, ...rest };
  const payload = data || await fetchMaybeGzippedJSON(url);

  const bands = payload.bands;
  const bins = payload.bins;
  const groupingNames = Object.keys(payload.groupings || {});
  if (!groupingNames.length) throw new Error('latitude.json: no groupings declared');

  let active = null;
  let categories = [];
  let fills = [];
  let current = null;
  let ghost = null;

  const canvas = document.createElement('canvas');
  canvas.className = 'lat-canvas';
  element.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;
  let plot = null;

  function setGrouping(name) {
    const g = payload.groupings[name];
    if (!g) throw new Error(`latitude.json: no grouping "${name}"`);
    active = g;
    // Fixed by the payload, never by per-cell counts -- see AggregateLayer for why.
    categories = g.category_order || Object.keys(g.categories || {});
    fills = categories.map((c) => rgbOf(g.categories?.[c]?.fill));
    request();
    return api;
  }

  function request() {
    if (onRender) onRender(); else draw();
  }

  function layout() {
    const pad = opts.inset;
    const padT = 4;
    const padB = 14;   // age labels
    plot = {
      x: pad,
      y: padT,
      w: Math.max(1, cssWidth - 2 * pad),
      h: Math.max(1, cssHeight - padT - padB),
    };
  }

  function resize() {
    const width = element.clientWidth;
    if (!width) return false;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = width;
    cssHeight = opts.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${cssHeight}px`;
    layout();
    return true;
  }

  const [lo, hi] = range;
  // Direction is the caller's, not this panel's. An earlier version hardcoded
  // present-on-the-left and justified it with "every host's slider runs 0 on the
  // left" -- which was never checked, is not true of this library's other panel,
  // and produced two stacked charts running opposite ways.
  const presentLeft = () => opts.timeDirection === 'present-left';
  const frac = (age) => (presentLeft() ? (age - lo) : (hi - age)) / (hi - lo);
  const xOf = (age) => plot.x + frac(age) * plot.w;
  const ageAt = (px) => {
    const f = (px - plot.x) / plot.w;
    return presentLeft() ? lo + f * (hi - lo) : hi - f * (hi - lo);
  };
  const yOf = (lat) => plot.y + ((90 - lat) / 180) * plot.h;

  function draw() {
    if (!cssWidth || !plot) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.fillStyle = opts.background;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    drawCells();
    drawGrid();
    drawCursor();
  }

  function drawCells() {
    const counts = active.counts;
    for (let b = 0; b < bins.length; b++) {
      const bin = bins[b];
      // A bin's column is as wide as the interval it covers. from >= to, ages in Ma.
      const x0 = xOf(Math.min(bin.from, hi));
      const x1 = xOf(Math.max(bin.to, lo));
      const left = Math.min(x0, x1);
      const width = Math.abs(x1 - x0);
      // Clip in SCREEN order, not in the order the ages happened to project --
      // which of x0/x1 is leftmost depends on timeDirection.
      if (left + width < plot.x || left > plot.x + plot.w) continue;

      for (let a = 0; a < bands.length; a++) {
        const row = counts[b]?.[a];
        if (!row) continue;
        const total = row.reduce((s, n) => s + (n || 0), 0);
        if (!total) continue;

        const yTop = yOf(bands[a].to);
        const yBot = yOf(bands[a].from);
        const alpha = Math.max(
          opts.minOpacity,
          Math.min(1, Math.sqrt(total / opts.opacityRef)),
        );

        let rgb = opts.densityColour;
        if (opts.mode === 'dominant') {
          let best = 0;
          for (let c = 1; c < row.length; c++) if ((row[c] || 0) > (row[best] || 0)) best = c;
          rgb = fills[best] || opts.densityColour;
        }
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
        // +0.5 px so adjacent bins/bands butt together instead of leaving hairlines that
        // read as gaps in the record.
        ctx.fillRect(left, Math.min(yTop, yBot),
                     Math.max(1, width) + 0.5, Math.abs(yBot - yTop) + 0.5);
      }
    }
  }

  function drawGrid() {
    ctx.font = opts.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const lat of opts.gridLatitudes) {
      const y = yOf(lat);
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.strokeStyle = lat === 0 ? opts.equator : opts.axis;
      ctx.lineWidth = lat === 0 ? 1 : 0.5;
      ctx.stroke();
      // Inside the plot, haloed -- see `inset` for why the label gutter went
      // away. Drawn after the cells so it stays readable over dense data.
      const text = `${lat}°`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = opts.labelHalo;
      ctx.strokeText(text, plot.x + 3, y);
      ctx.fillStyle = opts.label;
      ctx.fillText(text, plot.x + 3, y);
    }

    // Age ticks: round numbers inside the range, enough to orient without clutter.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const span = hi - lo;
    const step = niceStep(span / 6);
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, plot.y + plot.h);
      ctx.lineTo(x, plot.y + plot.h + 3);
      ctx.strokeStyle = opts.axis;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = opts.label;
      ctx.fillText(String(Math.round(t)), x, plot.y + plot.h + 4);
    }
  }

  function drawCursor() {
    for (const [age, colour, width] of [[ghost, opts.ghost, 1], [current, opts.cursor, 1.4]]) {
      if (age == null) continue;
      const x = xOf(age);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }

  /* ---- pointer -------------------------------------------------------------- */

  let dragging = false;

  const ageAtEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = ageAt(e.clientX - rect.left);
    const snapped = Math.round(t / opts.seekStep) * opts.seekStep;
    return Math.max(lo, Math.min(hi, snapped));
  };

  function onMove(e) {
    ghost = ageAtEvent(e);
    if (dragging && onSeek) onSeek(ghost);
    request();
  }
  function onDown(e) {
    if (!onSeek) return;
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    onSeek(ageAtEvent(e));
    request();
  }
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  }
  function onLeave() { ghost = null; request(); }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', onLeave);

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (resize()) request(); })
    : null;
  observer?.observe(element);
  if (!observer) window.addEventListener('resize', () => { if (resize()) request(); });

  // Declared BEFORE the bootstrap setGrouping()/resize() below. setGrouping()
  // returns `api` so calls can chain, and the bootstrap call would otherwise
  // touch the binding inside its temporal dead zone -- a ReferenceError on
  // first load, every time, which is how this was found.
  const api = {
    element,
    canvas,
    payload,
    get grouping() { return active; },
    groupingNames,
    setGrouping,
    setMode(mode) { opts.mode = mode; request(); return api; },
    setTimeDirection(d) { opts.timeDirection = d; request(); return api; },
    setTime(age) { current = age; return api; },
    resize,
    draw,
    destroy() {
      observer?.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onLeave);
      element.removeChild(canvas);
    },
  };

  setGrouping(grouping || payload.default_grouping || groupingNames[0]);
  resize();
  return api;
}

/** 'rgb(r,g,b)' or '#rrggbb' -> [r, g, b]. Cells are painted at a count-derived alpha, so
 *  a fill's own alpha would compound with it; components are taken and opacity is this
 *  panel's to set. */
function rgbOf(fill) {
  if (!fill) return null;
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(fill);
  if (m) return [+m[1], +m[2], +m[3]];
  const h = /^#([0-9a-f]{6})$/i.exec(fill.trim());
  if (h) {
    const v = parseInt(h[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return null;
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
