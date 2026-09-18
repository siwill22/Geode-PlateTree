/*
 * DOM wiring for a TimeSeriesSet: canvas, resizing, the mode selector and pointer handling.
 *
 * Kept out of index.js for the same reason hover.js is -- these two are the only modules
 * that touch the DOM, and a consumer drawing headlessly or in a worker should never have to
 * load them. The chart itself is in timeseries.js and knows nothing about any of this.
 *
 * ---- Lining the chart up with a range input -------------------------------------------
 *
 * The point of the panel is that the marker sits directly over the slider thumb, so the
 * reader sees one time axis rather than two. A range input puts its thumb CENTRE at
 *
 *     x = left + W/2 + fraction * (width - W)
 *
 * where W is the thumb width -- the thumb has to stay inside the track at both ends.
 * Measured in Chrome on a 600 px input with a 14 px thumb: 66.5 / 359.5 / 652.5 px at
 * 0 / 125 / 250, against 67 / 360 / 653 predicted. So the chart insets its plot by W/2 at
 * each end and the two agree.
 *
 * That only holds if W is KNOWN, which means the thumb must be styled rather than left
 * native -- native thumb widths differ between browsers and platforms.
 */

import { seriesFromCsv, TimeSeriesSet, MODES } from './timeseries.js';

const DEFAULTS = {
  // Half of this is the plot inset at each end. Must match the CSS thumb width.
  thumbWidth: 14,
  mode: 'shade',

  // Snap seeks to whole Myr, matching the slider's step.
  seekStep: 1,

  modeLabels: {
    marker: 'Marker',
    shade: 'Shade',
    reveal: 'Reveal',
    always: 'Full',
  },
  modeTitles: {
    marker: 'The whole record, with a marker at the current time',
    shade: 'The whole record, with what is still to come dimmed',
    reveal: 'Only what has already happened, so the curve grows as time advances',
    always: 'The whole record, with no marker',
  },
};

/**
 * @param element   container to fill with the canvas and controls
 * @param sources   [{ url, series: { column: { label, unit, colour } } }]
 * @param range     [minTime, maxTime] in Ma; also the drawn x extent
 * @param onSeek    (time) => void, called when the reader clicks or drags the chart
 * @param onRender  called when the panel needs repainting; wire it to the page's own
 *                  frame-coalescing render rather than letting this module drive a loop
 * @returns { set, setTime, draw, destroy, element }
 */
export async function attachTimeSeries({
  element, sources, range, onSeek = null, onRender = null, ...rest
}) {
  const opts = { ...DEFAULTS, ...rest };

  const loaded = await Promise.all(sources.map(async (src) => {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error(`${src.url}: ${res.status}`);
    return { text: await res.text(), spec: src.series || null };
  }));

  // Several files become one set sharing one axis. Each file may have its own sample times;
  // nothing here requires them to agree.
  const series = [];
  for (const { text, spec } of loaded) {
    series.push(...seriesFromCsv(text, spec, { range }).series);
  }

  const set = new TimeSeriesSet(series, { ...rest, range, mode: opts.mode });

  /* ---- DOM ------------------------------------------------------------------ */

  const canvas = document.createElement('canvas');
  canvas.className = 'ts-canvas';
  element.appendChild(canvas);

  const controls = document.createElement('div');
  controls.className = 'ts-modes';
  const buttons = new Map();
  for (const mode of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.modeLabels[mode];
    b.title = opts.modeTitles[mode];
    b.addEventListener('click', () => setMode(mode));
    controls.appendChild(b);
    buttons.set(mode, b);
  }
  element.appendChild(controls);

  const ctx = canvas.getContext('2d');
  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;

  function syncButtons() {
    for (const [mode, b] of buttons) b.classList.toggle('is-on', set.mode === mode);
  }

  function setMode(mode) {
    set.mode = mode;
    syncButtons();
    request();
  }

  function request() {
    if (onRender) onRender(); else draw();
  }

  function resize() {
    const width = element.clientWidth;
    const height = set.heightFor();
    if (!width) return false;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = width;
    cssHeight = height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Pixel geometry is recomputed here and NOT per frame: when only the time changes the
    // curve is in exactly the same place and only the split moves.
    set.layout({ width, height, inset: opts.thumbWidth / 2 });
    return true;
  }

  function draw() {
    if (!cssWidth) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    set.draw(ctx);
  }

  /* ---- pointer -------------------------------------------------------------- */

  let dragging = false;

  const timeAtEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = set.timeAt(e.clientX - rect.left);
    if (t == null) return null;
    const [lo, hi] = range;
    const snapped = Math.round(t / opts.seekStep) * opts.seekStep;
    return Math.max(lo, Math.min(hi, snapped));
  };

  function onMove(e) {
    const t = timeAtEvent(e);
    if (t == null) return;
    set.setGhost(t);
    if (dragging && onSeek) onSeek(t);
    request();
  }

  function onDown(e) {
    if (!onSeek) return;
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    const t = timeAtEvent(e);
    if (t != null) onSeek(t);
    request();
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  }

  function onLeave() {
    set.setGhost(null);
    request();
  }

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

  syncButtons();
  resize();

  return {
    set,
    element,
    canvas,
    get mode() { return set.mode; },
    setMode,
    setTime(time) { set.setTime(time); return this; },
    resize,
    draw,
    /** True if any source carries data outside the drawn range. */
    clipping: () => set.clipping(),
    destroy() {
      observer?.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onLeave);
      element.removeChild(canvas);
      element.removeChild(controls);
    },
  };
}
