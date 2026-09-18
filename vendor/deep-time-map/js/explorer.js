/*
 * The Explorer host: a whole interactive reconstruction page, built from a recipe.
 *
 * An *Explorer* is a globe, some standard layers, a time slider, a legend, hover
 * popups and no authored narrative. That shape recurs -- across seven hand-written
 * pages in one sibling repo, `setTime` and `prefetchAll` appeared in 7/7,
 * `scheduleRender` in 5/7, `parseHash` and `attachCollapse` in 4/7. Measured on one
 * of them, roughly 8 lines of plumbing per line of genuine decision. This module is
 * that plumbing, written once.
 *
 *     import { mountExplorer } from 'deep-time-map/js/explorer.js';
 *     mountExplorer(await (await fetch('view.json')).json(),
 *                   document.getElementById('app'));
 *
 * What stays the page's business, and is therefore in the recipe rather than here:
 * which layers, which colours, which hover fields, which Display Rule, which Theme.
 * What is NOT expressible here is a *Narrative* -- scroll choreography, authored
 * camera moves, prose interleaved with the map. Those pages stay hand-written; see
 * Geode's docs/adr/0046.
 *
 * The recipe is data, not code: it round-trips through JSON, which is what lets a
 * Python API emit it (deep_time_map's sibling `geode` package) and what makes the
 * provenance drawer able to show the exact calls that produced the page.
 */

import { RasterGlobe } from './raster-globe.js';
import {
  BoundarySeries, VelocityField, PointLayer, PolygonLayer,
} from './index.js';
import {
  themeById, outlineColour, boundaryStyle, boundaryDecoration, velocityStyle,
} from './themes.js';
import { hexToRgb } from './colour.js';
import { attachHover } from './hover.js';
import { attachTimeSeries } from './timeseries-panel.js';

/* ---- small helpers -------------------------------------------------------- */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Numbers for a popup: enough precision to be useful, not so much it reads as noise. */
function fmt(v) {
  if (v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * A CSS `rgba()` from a hex colour and an alpha.
 *
 * `hexToRgb` returns NORMALISED 0-1 components, because everything else in
 * colour.js works in that space. CSS wants 0-255, and it does not error on
 * `rgba(0.2, 0.33, 0.43, 0.62)` -- it clamps each channel to 0 and renders black.
 * That failure is completely silent: the page looked plausible, and every derived
 * colour in it (continents, panel text, borders, faint symbols) was black.
 */
function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  const byte = (v) => Math.round(v * 255);
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${alpha})`;
}

/* ---- theme tokens --------------------------------------------------------- */

/*
 * A recipe may name a Theme colour instead of writing a hex literal:
 *
 *     "colour": "@accentCool"              a Theme role
 *     "colour": "@boundary.subduction"     whatever ink this Theme gives that type
 *
 * That is what keeps a chart row the same colour as the map line it annotates when
 * the Theme changes -- the alternative is a hex literal in the recipe that silently
 * stops matching.
 */
function makeResolver(theme) {
  const bs = boundaryStyle(theme);
  const pen = outlineColour(theme);
  return function resolve(value) {
    if (typeof value !== 'string' || !value.startsWith('@')) return value;
    const token = value.slice(1);
    if (token.startsWith('boundary.')) {
      const entry = bs[token.slice('boundary.'.length)];
      if (!entry) throw new Error(`unknown boundary type in '${value}'`);
      return entry.stroke;
    }
    if (token === 'outline') return pen ?? theme.roles.land;
    const role = theme.roles[token];
    if (role == null) throw new Error(`unknown theme token '${value}'`);
    return role;
  };
}

/* ---- Display Rules -------------------------------------------------------- */

/*
 * Exactly two, and both derived from pages that exist rather than imagined:
 *
 *   constant    a point's colour depends only on which group it is in.
 *   age_window  bright within `window` Myr of the point's own age, faint outside.
 *
 * The second is a function of (point, current time) and is re-evaluated on every
 * scrub, which is exactly why it cannot be a Python callback -- it has to run in
 * the browser. Anything else goes through `styleJs` (see below), which is a
 * supported path, not a failure.
 *
 * A third rule ships when a real page needs one. Growing this list speculatively is
 * how an API becomes a DSL with bad syntax.
 */
function makeStyleFn(spec, inks, getTime) {
  const rule = spec ?? { type: 'constant' };

  switch (rule.type) {
    case 'constant':
      return (point) => ({ fill: inks.for(point.type).bright });

    case 'age_window': {
      const w = rule.window ?? 5;
      return (point) => {
        const ink = inks.for(point.type);
        const dist = point.age == null ? Infinity : Math.abs(getTime() - point.age);
        return { fill: dist <= w ? ink.bright : ink.faint };
      };
    }

    default:
      throw new Error(`unknown display rule '${rule.type}'`);
  }
}

/* ---- hover ---------------------------------------------------------------- */

/**
 * Build the popup formatter from a recipe's `hover` block.
 *
 * Wording is the page's business, not the renderer's, so every label comes from the
 * recipe. The one piece of real formatting logic here is `error`: a measurement and
 * its uncertainty belong on one line ("512 Ma +- 3 Myr"), and splitting them into
 * two rows was the thing every hand-written version did by hand.
 */
function makeFormatter(spec) {
  if (!spec) return (p) => `<h3>${escapeHtml(p.sample_id ?? p.type ?? 'Point')}</h3>`;
  const rows = spec.rows ?? [];
  const titleKeys = Array.isArray(spec.title) ? spec.title
    : (spec.title ? [spec.title] : []);

  return function format(point) {
    const out = [];
    for (const row of rows) {
      const value = point[row.key];
      if (value == null || value === '') continue;

      let text = row.numeric === false ? String(value) : fmt(value);
      if (row.unit) text += ` ${row.unit}`;
      if (row.error) {
        const err = point[row.error];
        if (err != null && err !== '') {
          text += ` ± ${fmt(err)}${row.errorUnit ? ` ${row.errorUnit}` : ''}`;
        }
      }
      out.push(`<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(text)}</dd>`);
    }

    const title = titleKeys.map((k) => point[k]).find((v) => v != null && v !== '')
      ?? spec.titleFallback ?? '';
    const eyebrow = spec.eyebrow ? point[spec.eyebrow] : null;
    const footer = spec.footer ? point[spec.footer] : null;

    return (eyebrow ? `<span class="dtm-pp-eyebrow">${escapeHtml(eyebrow)}</span>` : '')
      + (title ? `<h3>${escapeHtml(title)}</h3>` : '')
      + (out.length ? `<dl>${out.join('')}</dl>` : '')
      + (footer ? `<p class="dtm-pp-footer">${escapeHtml(footer)}</p>` : '');
  };
}

/* ---- the page shell ------------------------------------------------------- */

function buildShell(root, recipe) {
  root.classList.add('dtm-explorer');
  root.innerHTML = '';

  const stage = el('div', 'dtm-stage');
  const globeEl = el('div', 'dtm-globe');
  const popup = el('div', 'dtm-popup');
  const loading = el('div', 'dtm-loading', '<span></span>Loading reconstruction…');
  stage.append(globeEl, popup, loading);

  const header = el('header', 'dtm-header');
  header.append(el('h1', null, escapeHtml(recipe.title ?? 'Reconstruction')));
  if (recipe.subtitle) header.append(el('p', 'dtm-subtitle', escapeHtml(recipe.subtitle)));

  const legend = el('aside', 'dtm-panel dtm-legend');
  const timebar = el('div', 'dtm-panel dtm-timebar');

  root.append(stage, header, legend, timebar);
  return { stage, globeEl, popup, loading, header, legend, timebar };
}

/** A panel's collapse control. Both panels sit over the globe, so both need to be
 *  gettable out of the way entirely rather than only resizable by the window. */
function panelSection(panel, titleText) {
  const head = el('div', 'dtm-panel-head');
  head.append(el('h2', null, escapeHtml(titleText)));
  const toggle = el('button', 'dtm-panel-toggle', '−');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', `Collapse ${titleText}`);
  head.append(toggle);
  const body = el('div', 'dtm-panel-body');
  panel.append(head, body);

  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '+' : '−';
  });
  return body;
}

/* ---- deep links ----------------------------------------------------------- */

function parseHash(hash) {
  const parts = hash.replace('#', '').split(',').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return {};
  return { lon: parts[0], lat: parts[1], zoom: parts[2], time: parts[3] };
}

/* ---- mount ---------------------------------------------------------------- */

/**
 * Build a whole Explorer page into `root` from `recipe`.
 *
 * @param recipe  the view record (see SCHEMA.md, "Explorer recipe")
 * @param root    an element to fill; it is emptied first
 * @returns       { globe, layers, setTime, render, recipe } for anything a page
 *                wants to do on top -- the escape hatch that is not `styleJs`
 */
export async function mountExplorer(recipe, root) {
  if (recipe.explorer !== 1) {
    throw new Error(`unsupported explorer recipe version ${recipe.explorer}`);
  }

  const theme = themeById(recipe.theme);
  const resolve = makeResolver(theme);
  const pen = outlineColour(theme);
  const dom = buildShell(root, recipe);

  applyThemeVars(root, theme, pen);

  /* ---- camera and clock ---------------------------------------------------- */

  const cam = recipe.camera ?? {};
  const clock = recipe.time ?? {};
  const linked = parseHash(location.hash);

  const view = {
    lon: linked.lon ?? cam.lon ?? 0,
    lat: linked.lat ?? cam.lat ?? 0,
    zoom: linked.zoom ?? cam.zoom ?? 1,
  };
  const zoomLimits = cam.zoomLimits ?? [0.6, 4.0];

  // Declared before the layers load: a points layer's `style` hook closes over this
  // and is invoked synchronously during construction, before the await returns here.
  // Reading it in the temporal dead zone would throw.
  let time = linked.time ?? clock.initial ?? clock.start ?? 0;
  const getTime = () => time;

  const globe = new RasterGlobe(dom.globeEl,
    { projection: recipe.projection ?? 'orthographic' });

  /* ---- layers -------------------------------------------------------------- */

  const specs = recipe.layers ?? [];
  // One ink book per points layer, built before the load so the `style` hook (invoked
  // synchronously during construction) and the legend rows read the same object.
  const inkBooks = new Map();
  for (const spec of specs) {
    if (spec.kind === 'points') inkBooks.set(spec, makeInkBook(spec, theme, resolve));
  }
  const loaded = await Promise.all(specs.map((spec) => loadLayer(spec, {
    theme, resolve, pen, getTime, inks: inkBooks.get(spec),
  })));

  const layers = {};
  specs.forEach((spec, i) => { layers[spec.id ?? spec.kind] = loaded[i]; });

  // Draw order is the recipe's order, so "what sits on top of what" is a decision the
  // recipe states rather than one buried here. The ocean disc replaces the raster for
  // pages that do not ship paleogeography textures; without it the globe has no body
  // and the vectors float on the page background.
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const layer = loaded[i];
    if (spec.kind === 'ocean') {
      const fill = resolve(spec.fill ?? '@water');
      const edge = spec.edge === null ? null : resolve(spec.edge ?? '@outline');
      globe.addOverlay((ctx, g) => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (edge) {
          ctx.strokeStyle = rgba(edge, spec.edgeAlpha ?? 0.28);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      });
    } else if (layer) {
      globe.addOverlay((ctx, g) => layer.draw(ctx, g.projector));
    }
  }

  const boundarySpec = specs.find((s) => s.kind === 'boundaries');
  const series = boundarySpec ? layers[boundarySpec.id ?? 'boundaries'] : null;
  const velocitySpec = specs.find((s) => s.kind === 'velocities');
  const velocities = velocitySpec ? layers[velocitySpec.id ?? 'velocities'] : null;
  const pointSpecs = specs.filter((s) => s.kind === 'points');

  /* ---- time range ---------------------------------------------------------- */

  // Preferring the boundary series' own range over the recipe's keeps the slider
  // honest about what was actually exported: a recipe claiming 0-1000 Ma against
  // frames that stop at 410 would otherwise scrub into empty space.
  const [minTime, maxTime] = series ? series.timeRange
    : [clock.start ?? 0, clock.end ?? 100];
  time = Math.max(minTime, Math.min(maxTime, time));

  /* ---- render loop --------------------------------------------------------- */

  let timeseries = null;
  const timecodeEl = el('span', 'dtm-timecode');
  let updateCounts = () => {};
  let updateScale = () => {};

  function render() {
    globe.set({ age: time, lon: view.lon, lat: view.lat, zoom: view.zoom });
    globe.render();
    timecodeEl.textContent = `${Math.round(time)} Ma`;
    updateScale();
    // The chart repaints on the same frame as the globe rather than running its own
    // loop, so one scrub event is still one render.
    timeseries?.draw();
  }

  // Coalesce every redraw request into one frame. A scrub fires far faster than the
  // display refreshes, and each raw event would otherwise cost a full repaint.
  let frame = null;
  function scheduleRender() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; render(); });
  }

  function setTime(next, { updateSlider = true } = {}) {
    time = Math.max(minTime, Math.min(maxTime, next));
    if (updateSlider) scrub.value = String(maxTime - (time - minTime));

    for (let i = 0; i < specs.length; i++) {
      const layer = loaded[i];
      if (!layer || specs[i].kind === 'boundaries') continue;
      // restyle() re-reads the display rule for every point, so each fill is
      // recomputed against the NEW time before positions update. Order against
      // setTime() does not matter: restyle() only touches cached colour, setTime()
      // only touches position and live flags.
      layer.restyle?.();
      layer.setTime?.(time);
    }
    timeseries?.setTime(time);
    updateCounts();
    // A boundary frame may not be in cache. Warm frames swap synchronously and are
    // picked up by the render scheduled below; a cold one calls back when it lands.
    series?.setTime(time, scheduleRender);
    scheduleRender();
  }

  /* ---- legend -------------------------------------------------------------- */

  const legendBody = panelSection(dom.legend, recipe.legendTitle ?? 'Legend');

  if (series && boundarySpec.legend !== false) {
    legendBody.append(buildBoundaryLegend(series, theme, scheduleRender));
  }

  const counters = [];
  for (const spec of pointSpecs) {
    const layer = layers[spec.id ?? 'points'];
    if (spec.legend === false) continue;
    const { node, update } = buildPointLegend(layer, spec, inkBooks.get(spec),
      scheduleRender);
    legendBody.append(node);
    counters.push(update);
  }
  updateCounts = () => { for (const fn of counters) fn(); };

  if (velocities) {
    const { node, update } = buildVelocityRow(velocities, velocitySpec, globe, theme,
      scheduleRender);
    legendBody.append(node);
    updateScale = update;
  }

  const creditBits = [];
  if (recipe.credit?.modelLabel) {
    creditBits.push(`Reconstruction: ${escapeHtml(recipe.credit.modelLabel)}`);
  }
  for (const spec of pointSpecs) {
    const caption = layers[spec.id ?? 'points']?.meta?.caption;
    if (caption) creditBits.push(escapeHtml(caption));
  }
  if (recipe.caption) creditBits.push(escapeHtml(recipe.caption));
  if (creditBits.length) {
    legendBody.append(el('p', 'dtm-credit', creditBits.join('<br>')));
  }

  if (recipe.provenance) legendBody.append(buildProvenance(recipe.provenance, root));

  /* ---- time bar ------------------------------------------------------------ */

  const timeBody = panelSection(dom.timebar, 'Time');

  const chartEl = el('div', 'dtm-chart');
  const controls = el('div', 'dtm-controls');
  const play = el('button', 'dtm-play', '▶');
  play.setAttribute('aria-label', 'Play through time');
  const scrub = el('input', 'dtm-scrub');
  scrub.type = 'range';
  scrub.min = String(minTime);
  scrub.max = String(maxTime);
  scrub.step = String(clock.step ?? 1);
  // The slider runs backwards -- present at the right, deep time at the left, the way
  // a timeline reads. Done by inverting the VALUE rather than flipping the element in
  // CSS, so the native keyboard behaviour stays sensible: right arrow still means
  // "later", which a scaleX(-1) would have reversed.
  const sliderToTime = (v) => maxTime - (Number(v) - minTime);

  controls.append(play, scrub, timecodeEl);
  timeBody.append(chartEl, controls);

  scrub.addEventListener('input', () => {
    stopPlaying();
    setTime(sliderToTime(scrub.value), { updateSlider: false });
  });

  /* ---- hover --------------------------------------------------------------- */

  for (const spec of pointSpecs) {
    if (!spec.hover) continue;
    attachHover({
      element: dom.stage,
      popup: dom.popup,
      layer: layers[spec.id ?? 'points'],
      render,
      format: makeFormatter(spec.hover),
    });
  }

  /* ---- charts -------------------------------------------------------------- */

  if (recipe.charts?.sources?.length) {
    // Failing to load the chart must not take the globe down with it: it is context
    // for the map, not the map.
    try {
      const sources = recipe.charts.sources.map((src) => ({
        url: src.url,
        series: Object.fromEntries(Object.entries(src.series).map(([k, s]) => [
          k, { ...s, colour: resolve(s.colour) },
        ])),
      }));
      timeseries = await attachTimeSeries({
        element: chartEl,
        sources,
        range: [minTime, maxTime],
        thumbWidth: recipe.charts.thumbWidth ?? 14,
        mode: recipe.charts.mode ?? 'shade',
        onSeek: (t) => { stopPlaying(); setTime(t); },
        onRender: scheduleRender,
      });
      if (timeseries.clipping()) {
        chartEl.append(el('p', 'dtm-chart-note', 'record extends beyond this range'));
      }
    } catch (err) {
      console.warn('time series unavailable:', err.message);
    }
  }

  /* ---- pointer controls ---------------------------------------------------- */

  attachControls(dom.stage, globe, view, zoomLimits, scheduleRender);
  window.addEventListener('resize', scheduleRender);

  /* ---- playback ------------------------------------------------------------ */

  const rate = clock.playRate ?? 25;         // Myr per second of wall clock
  let playing = null;

  function stopPlaying() {
    if (playing === null) return;
    cancelAnimationFrame(playing);
    playing = null;
    play.textContent = '▶';
  }

  function startPlaying() {
    play.textContent = '❚❚';
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      let next = time + dt * rate;
      if (next > maxTime) next = minTime;    // loop back round to the present
      setTime(next);
      playing = requestAnimationFrame(step);
    };
    playing = requestAnimationFrame(step);
  }

  play.addEventListener('click', () => {
    if (playing === null) startPlaying(); else stopPlaying();
  });

  /* ---- go ------------------------------------------------------------------ */

  setTime(time);
  dom.loading.classList.add('is-done');
  setTimeout(() => { dom.loading.style.display = 'none'; }, 900);

  // Far too much to pull eagerly on load -- a 1 Ma series over a billion years is
  // ~1000 files -- but once the page is up and idle it is worth warming so scrubbing
  // stops hitting the network.
  if (series && recipe.prefetch !== false) {
    setTimeout(() => series.prefetchAll(), recipe.prefetchDelay ?? 4000);
  }

  return { globe, layers, series, velocities, setTime, render: scheduleRender, recipe };
}

/* ---- theme -> CSS --------------------------------------------------------- */

function applyThemeVars(root, theme, pen) {
  const r = theme.roles;
  const vars = {
    '--dtm-page': r.page,
    '--dtm-water': r.water,
    '--dtm-land': r.land,
    '--dtm-ink': r.outline,
    '--dtm-pen': pen ?? r.land,
    '--dtm-hot': r.accentHot,
    '--dtm-warm': r.accentWarm,
    '--dtm-bright': r.accentBright,
    '--dtm-muted': r.accentMuted,
    '--dtm-cool': r.accentCool,
    // Panels float over the globe, so they need a wash of the page colour rather
    // than the page colour itself -- opaque panels on a dark globe read as holes.
    '--dtm-panel': rgba(r.page, 0.82),
    '--dtm-ink-dim': rgba(r.outline, 0.62),
    '--dtm-rule': rgba(r.outline, 0.18),
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.lightness = theme.lightness;
  root.dataset.theme = theme.id;
}

/* ---- layer loading -------------------------------------------------------- */

async function loadLayer(spec, ctx) {
  const { theme, resolve, pen, getTime } = ctx;

  switch (spec.kind) {
    case 'ocean':
      return null;                      // drawn inline; nothing to load

    case 'continents':
    case 'polygons':
      return PolygonLayer.load(spec.url, {
        fill: rgba(resolve(spec.fill ?? '@land'), spec.fillAlpha ?? 0.62),
        stroke: pen ? rgba(resolve(spec.stroke ?? '@outline'), spec.strokeAlpha ?? 0.45)
          : 'rgba(0,0,0,0)',
        lineWidth: (spec.lineWidth ?? 0.7) * theme.weight,
      });

    case 'boundaries':
      return BoundarySeries.load(spec.url, {
        style: boundaryStyle(theme),
        ...boundaryDecoration(theme),
      });

    case 'velocities':
      return VelocityField.load(spec.url, velocityStyle(theme));

    case 'points': {
      const inks = ctx.inks;
      const style = spec.styleJs
        // The escape hatch, and a supported path rather than a failure: a module
        // exporting `default (point, category, api) => ({ fill, symbol, size })`.
        // Pages whose symbols are genuinely bespoke -- pie glyphs, say -- belong
        // here rather than in a third Display Rule nobody else can use.
        ? (await import(/* @vite-ignore */ new URL(spec.styleJs, location.href).href))
          .default
        : makeStyleFn(spec.rule, inks, getTime);

      return PointLayer.load(spec.url, {
        size: spec.size ?? 3.4,
        keyline: spec.keyline === null ? null
          : rgba(resolve(spec.keyline ?? '@page'), spec.keylineAlpha ?? 0.55),
        keylineWidth: spec.keylineWidth ?? 0.6,
        lifespan: spec.lifespan ?? 'since',
        ageWindow: spec.ageWindow ?? 5,
        style: (point, cat) => style(point, cat, { time: getTime(), inks }),
      });
    }

    default:
      throw new Error(`unknown layer kind '${spec.kind}'`);
  }
}

/**
 * Per-group inks, each as a bright/faint pair.
 *
 * Faint is the same hue at low alpha rather than a separately chosen colour: the two
 * have to read as the same category seen in two states, and two independently picked
 * colours do not. The alpha is dropped hard (0.07 by default) because on a dense
 * mostly-faint globe the contrast between "just formed" and "formed long ago" has to
 * survive thousands of overlapping symbols.
 *
 * Groups the recipe did not colour are assigned Theme accents on first sight, in a
 * fixed order -- so `v.points(df, group=...)` with no palette still produces a
 * legible map, and produces the SAME map on every load, since the assignment order
 * follows the exported point order rather than object-key iteration.
 */
function makeInkBook(spec, theme, resolve) {
  const fade = spec.rule?.fade ?? 0.07;
  const ACCENTS = ['accentHot', 'accentCool', 'accentBright', 'accentWarm', 'accentMuted'];
  const pair = (hex) => ({ bright: hex, faint: rgba(hex, fade) });

  const book = {};
  for (const [group, colour] of Object.entries(spec.colours ?? {})) {
    book[group] = pair(resolve(colour));
  }

  let next = 0;
  return {
    for(group) {
      if (group == null) return book.__default ?? pair(theme.roles.accentMuted);
      if (!book[group]) book[group] = pair(theme.roles[ACCENTS[next++ % ACCENTS.length]]);
      return book[group];
    },
  };
}

/* ---- legends -------------------------------------------------------------- */

/** Boundary rows double as per-type visibility toggles. */
function buildBoundaryLegend(series, theme, render) {
  const list = el('ul', 'dtm-legend-list');
  for (const [type, style] of Object.entries(boundaryStyle(theme))) {
    const li = el('li');
    // The subduction swatch carries a triangle: the decoration is the whole point of
    // the symbol, and a plain line makes it indistinguishable from the others.
    const swatch = type === 'subduction'
      ? `<span class="dtm-swatch dtm-swatch-sz" style="background:${style.stroke}">`
        + `<i style="border-bottom-color:${style.stroke}"></i></span>`
      : `<span class="dtm-swatch" style="background:${style.stroke}"></span>`;
    li.innerHTML = `${swatch}<span>${escapeHtml(style.label)}</span>`;
    li.addEventListener('click', () => {
      // The visibility object is shared with every loaded frame, so a toggle applies
      // across the whole series rather than only the frame on screen.
      series.visible[type] = !series.visible[type];
      li.classList.toggle('is-off', !series.visible[type]);
      render();
    });
    list.append(li);
  }
  return list;
}

/** One toggle row per group, each showing the symbol used on the map. */
function buildPointLegend(layer, spec, inks, render) {
  const wrap = el('div', 'dtm-legend-group');
  const head = el('div', 'dtm-legend-grouphead');
  if (spec.legend?.title) head.append(el('h3', null, escapeHtml(spec.legend.title)));
  const allBtn = el('button', 'dtm-legend-all', 'none');
  head.append(allBtn);
  wrap.append(head);

  const list = el('ul', 'dtm-legend-list');
  wrap.append(list);

  // Totals are of the whole dataset; the live count beside each row is of what is
  // showing NOW, which under lifespan:'since' means "how many had already formed by
  // this time" -- cumulative, not a moving-window count.
  const totals = {};
  for (const p of layer.points) totals[p.type] = (totals[p.type] || 0) + 1;

  const rows = [];
  const countEls = {};
  const showCounts = spec.legend?.counts !== false;

  for (const [type, cat] of Object.entries(layer.categories ?? {})) {
    const li = el('li');
    // The BRIGHT ink, always -- a legend row showing the faint variant would be
    // reporting what the map looks like at the current time rather than what the
    // category is, and under a fade of 0.07 it would be invisible.
    const ink = inks.for(type).bright;
    li.innerHTML = `<span class="dtm-swatch dtm-swatch-sym">`
      + `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">`
      + `<circle cx="7" cy="7" r="4.4" fill="${escapeHtml(ink)}"/></svg></span>`
      + `<span>${escapeHtml(cat.label || type)}`
      + (showCounts ? `<span class="dtm-legend-count"> · 0</span>` : '')
      + `</span>`;
    li.title = `${totals[type] || 0} in the dataset`;
    if (showCounts) countEls[type] = li.querySelector('.dtm-legend-count');

    li.addEventListener('click', () => {
      layer.types[type] = !layer.types[type];
      li.classList.toggle('is-off', !layer.types[type]);
      render();
      syncAll();
    });
    list.append(li);
    rows.push([type, li]);
  }

  function syncAll() {
    allBtn.textContent = rows.some(([t]) => layer.types[t]) ? 'none' : 'all';
  }

  allBtn.addEventListener('click', () => {
    const anyOn = rows.some(([t]) => layer.types[t]);
    for (const [type, li] of rows) {
      layer.types[type] = !anyOn;
      li.classList.toggle('is-off', anyOn);
    }
    render();
    syncAll();
  });
  syncAll();

  return {
    node: wrap,
    update() {
      for (const [type, node] of Object.entries(countEls)) {
        node.textContent = ` · ${layer.liveCount(type)}`;
      }
    },
  };
}

/**
 * The velocity toggle, and a scale reference beside it.
 *
 * The label is pinned to a round speed and the drawn bar sized to match, rather than
 * the other way round: "5 cm/yr" is a reference a reader can use, "20.7 cm/yr" is
 * just the arbitrary length of a box in the legend.
 */
function buildVelocityRow(velocities, spec, globe, theme, render) {
  const wrap = el('div', 'dtm-legend-group');
  const row = el('div', 'dtm-velocity-row');
  const toggle = el('button', 'dtm-velocity-toggle', spec.label ?? 'Plate velocity');
  row.append(toggle);
  wrap.append(row);

  toggle.addEventListener('click', () => {
    velocities.visible = !velocities.visible;
    toggle.classList.toggle('is-off', !velocities.visible);
    render();
  });

  if (spec.scaleBar === false) return { node: wrap, update: () => {} };

  const SPEEDS = spec.scaleSpeeds ?? [200, 100, 50, 20, 10];   // km/Myr = 20..1 cm/yr
  const scale = el('div', 'dtm-scale');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('height', '10');
  svg.innerHTML = '<line x1="0" y1="5" x2="40" y2="5" stroke="currentColor" '
    + 'stroke-width="1.3"/><polygon points="49,5 39,9 39,1" fill="currentColor"/>';
  const label = el('span', 'dtm-scale-label');
  scale.append(svg, label);
  wrap.append(scale);

  // The bar depends only on the globe radius, so it changes on zoom and resize and
  // never on time. Rewriting its attributes every frame invalidated style on frames
  // where nothing about the legend had moved.
  let lastRadius = null;

  return {
    node: wrap,
    update() {
      if (globe.radius === lastRadius) return;
      lastRadius = globe.radius;
      // Arrow length for a speed comes from the library, so it cannot drift out of
      // step with what draw() actually renders.
      const pxFor = (kmPerMyr) => velocities.lengthFor(kmPerMyr, globe.radius);
      const speed = SPEEDS.find((s) => pxFor(s) <= 56) ?? SPEEDS.at(-1);
      const len = Math.max(12, pxFor(speed));
      svg.setAttribute('width', String(len + 10));
      svg.querySelector('line').setAttribute('x2', String(len));
      svg.querySelector('polygon')
        .setAttribute('points', `${len + 9},5 ${len - 1},9 ${len - 1},1`);
      label.textContent = `${speed / 10} cm/yr`;
    },
  };
}

/* ---- provenance ----------------------------------------------------------- */

/**
 * The drawer that connects the picture back to the science.
 *
 * Two clearly separated things, because conflating them would imply an audit trail
 * the page does not have:
 *
 *   the View Script -- generated, canonical, provably what produced this view;
 *   the author's own notebook -- optional, carrying the wrangling and their prose.
 *
 * And a third thing stated rather than shown: the analysis libraries. A panel
 * claiming to show "the code" while silently omitting the package that did the
 * science would be worse than one that names and pins it.
 */
function buildProvenance(prov, root) {
  const btn = el('button', 'dtm-prov-open', prov.label ?? 'How this was made');
  const drawer = el('div', 'dtm-prov');
  const close = el('button', 'dtm-prov-close', '×');
  close.setAttribute('aria-label', 'Close');
  const body = el('div', 'dtm-prov-body', '<p class="dtm-prov-loading">Loading…</p>');
  drawer.append(close, body);
  root.append(drawer);

  let loaded = false;
  btn.addEventListener('click', async () => {
    drawer.classList.add('is-open');
    if (loaded) return;
    loaded = true;
    const parts = [];

    for (const file of prov.files ?? []) {
      try {
        const text = await (await fetch(file.url)).text();
        parts.push(`<section><h3>${escapeHtml(file.title)}</h3>`
          + (file.note ? `<p>${escapeHtml(file.note)}</p>` : '')
          + `<pre><code>${escapeHtml(text)}</code></pre></section>`);
      } catch (err) {
        parts.push(`<section><h3>${escapeHtml(file.title)}</h3>`
          + `<p class="dtm-prov-missing">not bundled (${escapeHtml(err.message)})</p>`
          + `</section>`);
      }
    }

    if (prov.libraries?.length) {
      const rows = prov.libraries.map((lib) => `<li><code>${escapeHtml(lib.call)}</code>`
        + `<span> — ${escapeHtml(lib.package)}`
        + (lib.version ? ` ${escapeHtml(lib.version)}` : '') + `</span>`
        + (lib.citation ? `<p>${escapeHtml(lib.citation)}</p>` : '') + `</li>`).join('');
      parts.push(`<section><h3>Analysis libraries</h3>`
        + `<p>Not reproduced here: these run outside the browser. The record names `
        + `and pins the call instead.</p><ul class="dtm-prov-libs">${rows}</ul></section>`);
    }

    body.innerHTML = parts.join('') || '<p>No provenance bundled.</p>';
  });

  close.addEventListener('click', () => drawer.classList.remove('is-open'));
  return btn;
}

/* ---- pointer ------------------------------------------------------------- */

// A drag across one globe radius turns the Earth by this much. Fixed in screen terms
// rather than degrees per pixel, so the globe tracks the pointer at the same rate
// whatever the window size or zoom.
const DEGREES_PER_RADIUS = 90;

function attachControls(stageEl, globe, view, zoomLimits, render) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  stageEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    stageEl.classList.add('is-dragging');
    stageEl.setPointerCapture(e.pointerId);
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const scale = DEGREES_PER_RADIUS / (globe.radius || 1);
    view.lon -= (e.clientX - lastX) * scale;
    view.lat += (e.clientY - lastY) * scale;

    // Clamping short of the pole avoids the degenerate view matrix exactly at 90,
    // where east and north are undefined.
    view.lat = Math.max(-89.9, Math.min(89.9, view.lat));
    if (view.lon > 180) view.lon -= 360;
    if (view.lon < -180) view.lon += 360;

    lastX = e.clientX;
    lastY = e.clientY;
    render();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    stageEl.classList.remove('is-dragging');
    stageEl.releasePointerCapture?.(e.pointerId);
  };
  stageEl.addEventListener('pointerup', endDrag);
  stageEl.addEventListener('pointercancel', endDrag);

  stageEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    view.zoom = Math.max(zoomLimits[0], Math.min(zoomLimits[1], view.zoom * factor));
    render();
  }, { passive: false });
}
