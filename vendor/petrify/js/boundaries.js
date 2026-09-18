/*
 * Plate boundary layers: lines by type, with subduction-polarity triangles.
 *
 * Input is the GeoJSON written by the Python exporter, which is ALREADY reconstructed to
 * its snapshot time. Unlike coastlines, resolved topological boundaries are not rigid
 * bodies that persist through time -- segments appear, vanish and split at triple
 * junctions -- so there is nothing to rotate in the browser. Every vertex is converted
 * to a unit vector once at load, so drawing a frame costs one projection per point.
 *
 * ---- Which side the triangles go on -------------------------------------------------
 *
 * gpml:subductionPolarity is 'Left' or 'Right', naming the side of the line -- in vertex
 * order -- on which the OVERRIDING plate lies. Triangles go on that side and point away
 * from the trench, down-dip. This matches what GMT's -Sf...+r+t draws via gprm, and was
 * checked against resolved plate polygons on two independent models: for every subduction
 * segment with both plates attributed, a point stepped to the polarity side falls inside
 * the overriding plate, never the subducting one.
 *
 * The side is resolved ON THE SPHERE, not in screen space. "Left of travel" is
 * a × tangent, a cross product of unit vectors; that direction is then projected and the
 * screen-space normal read off the result. The tempting shortcut -- taking the projected
 * segment direction (dx, dy) and using (dy, -dx) -- is only correct for a projection that
 * preserves orientation on the visible hemisphere, combined with the canvas y-flip. That
 * happens to hold for orthographic, Spilhaus and Mercator, but it is an assumption about
 * the host's projection that this library has no business making: getting it wrong would
 * silently mirror every subduction polarity on the map, which looks entirely plausible.
 */

import {
  lonLatToVec3, tangentTowards, leftOfTravel, travel, DEG,
} from './sphere.js';
import { tracePolyline } from './polyline.js';
import { fetchMaybeGzippedJSON } from './gzipFetch.js';

export const DEFAULT_STYLE = {
  subduction: { stroke: '#ffd8c2', width: 1.9, label: 'Subduction zone' },
  ridge:      { stroke: '#ff6b6b', width: 1.5, label: 'Mid-ocean ridge' },
  transform:  { stroke: '#ffc857', width: 1.3, label: 'Transform' },
  other:      { stroke: 'rgba(200,214,230,0.55)', width: 1.0, label: 'Other boundary' },
};

export const DEFAULT_OPTIONS = {
  style: DEFAULT_STYLE,

  // Decoration spacing is measured on SCREEN, not along the arc. Even arc spacing
  // crowds the triangles together near the limb where the projection foreshortens;
  // GMT's -Sf spaces decorations in map distance for the same reason.
  triangleGap: 24.2,
  triangleSize: 10.125,

  // Near the limb the surface is nearly edge-on, the projected normal collapses, and a
  // triangle drawn there reads as pointing the wrong way as often as the right one.
  // Cull rather than mislead. depth is cos(angle from view centre); 0.25 is ~75 deg.
  minDecorationDepth: 0.25,
};

// Angular step used to probe the polarity side on the sphere. Large enough that the
// projected offset survives foreshortening near the limb without being lost to float
// noise, small enough that it is still a local direction.
const SIDE_PROBE_DEG = 0.25;

export class BoundaryLayer {
  constructor(geojson, options = {}) {
    this.meta = geojson.meta || {};
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.options.style = { ...DEFAULT_STYLE, ...(options.style || {}) };

    // One flat vertex buffer for the whole layer; each feature is an offset/count into it.
    let total = 0;
    for (const f of geojson.features) total += f.geometry.coordinates.length;

    this.xyz = new Float64Array(total * 3);
    this.features = [];

    const tmp = [0, 0, 0];
    let o = 0;
    for (const f of geojson.features) {
      const coords = f.geometry.coordinates;
      for (let i = 0; i < coords.length; i++) {
        lonLatToVec3(coords[i][0], coords[i][1], tmp);
        this.xyz[(o + i) * 3] = tmp[0];
        this.xyz[(o + i) * 3 + 1] = tmp[1];
        this.xyz[(o + i) * 3 + 2] = tmp[2];
      }
      this.features.push({
        type: f.properties.boundary_type,
        // +1 for 'Left', -1 for 'Right': the sign applied to the spherical
        // left-of-travel direction. 0 for anything undecorated.
        side: f.properties.polarity === 'Left' ? 1
            : f.properties.polarity === 'Right' ? -1 : 0,
        offset: o,
        count: coords.length,
      });
      o += coords.length;
    }

    this.visible = { subduction: true, ridge: true, transform: true, other: true };

    this._pts = [];
    this._a = [0, 0, 0];
    this._b = [0, 0, 0];
    this._tangent = [0, 0, 0];
    this._side = [0, 0, 0];
    this._probe = [0, 0, 0];
    this._scratch = null;
  }

  static async load(url, options) {
    return new BoundaryLayer(await fetchMaybeGzippedJSON(url), options);
  }

  /** Share a visibility object across layers, so a toggle applies to a whole series. */
  useVisibility(visible) {
    this.visible = visible;
    return this;
  }

  /**
   * @param ctx        CanvasRenderingContext2D
   * @param projector  anything with project(vec3) -> [x, y, depth] | null
   */
  /**
   * Replace stroke colours/widths and decoration sizes after construction --
   * what a Theme switch needs (see themes.js).
   *
   * Takes effect on the next frame with nothing rebuilt: draw() and
   * _drawTriangles() both read `this.options` live, and neither style nor
   * decoration size touches the vertex buffer.
   *
   * `style` is merged per TYPE, not shallowly over the whole object, so a
   * caller may pass `{ridge: {stroke}}` without silently dropping ridge's
   * width -- unlike the constructor, whose shallow merge is load-bearing for
   * its own "replace the entry wholesale" contract and is left alone.
   */
  restyle({ style, triangleGap, triangleSize } = {}) {
    if (style) {
      for (const [type, s] of Object.entries(style)) {
        this.options.style[type] = { ...this.options.style[type], ...s };
      }
    }
    if (triangleGap !== undefined) this.options.triangleGap = triangleGap;
    if (triangleSize !== undefined) this.options.triangleSize = triangleSize;
    return this;
  }

  draw(ctx, projector) {
    const project = (v) => projector.project(v);
    // Optional part of the contract -- a flat map supplies it, a camera doesn't.
    // See polyline.js's own comment for why the break has to be driven from the
    // segment here rather than from inside project().
    const seam = projector.seamSplit ? (a, b) => projector.seamSplit(a, b) : null;
    const { style } = this.options;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Undecorated types first, so trench triangles are never buried under a ridge that
    // happens to abut them.
    for (const type of ['other', 'transform', 'ridge', 'subduction']) {
      if (!this.visible[type]) continue;
      ctx.strokeStyle = style[type].stroke;
      ctx.lineWidth = style[type].width;
      ctx.beginPath();
      for (const f of this.features) {
        if (f.type === type) {
          tracePolyline(ctx, project, this.xyz, f.offset, f.count, { seam });
        }
      }
      ctx.stroke();
    }

    if (this.visible.subduction) {
      ctx.fillStyle = style.subduction.stroke;
      for (const f of this.features) {
        if (f.type === 'subduction' && f.side !== 0) {
          this._drawTriangles(ctx, project, f, seam);
        }
      }
    }

    ctx.restore();
  }

  /** Triangles along a trench, every `triangleGap` screen pixels. */
  _drawTriangles(ctx, project, f, seam = null) {
    const { triangleGap, triangleSize, minDecorationDepth } = this.options;

    // tracePolyline needs a live path to write into; use a throwaway one so the
    // projected points can be collected without disturbing the stroke path.
    this._scratch = this._scratch || new Path2D();
    const pts = this._pts;
    tracePolyline(this._scratch, project, this.xyz, f.offset, f.count,
                  { projected: pts });

    const xyz = this.xyz;
    const a = this._a, b = this._b;
    const tangent = this._tangent, side = this._side, probe = this._probe;
    const probeAngle = SIDE_PROBE_DEG * DEG;

    let carry = triangleGap * 0.5;   // half a gap in, so short trenches still get one

    for (let i = 1; i < pts.length; i++) {
      const pa = pts[i - 1];
      const pb = pts[i];
      if (!pa || !pb) { carry = triangleGap * 0.5; continue; }

      // `pts` holds the real vertices only, unsplit, so a segment spanning the
      // map's seam still looks like one enormous screen-space step here even
      // though the stroked line was broken at it. Spacing triangles along that
      // would strew them right across the map, so skip it -- the same "drop
      // rather than draw a wrong thing" choice the line itself makes.
      if (seam) {
        const is0 = (f.offset + i - 1) * 3;
        const is1 = (f.offset + i) * 3;
        a[0] = xyz[is0]; a[1] = xyz[is0 + 1]; a[2] = xyz[is0 + 2];
        b[0] = xyz[is1]; b[1] = xyz[is1 + 1]; b[2] = xyz[is1 + 2];
        if (seam(a, b)) { carry = triangleGap * 0.5; continue; }
      }

      const dx = pb[0] - pa[0];
      const dy = pb[1] - pa[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;

      const ux = dx / len;
      const uy = dy / len;

      let s = carry;
      if (s > len) { carry = s - len; continue; }   // no triangle on this segment

      // --- the polarity side, resolved on the sphere -------------------------------
      const ia = (f.offset + i - 1) * 3;
      const ib = (f.offset + i) * 3;
      a[0] = xyz[ia]; a[1] = xyz[ia + 1]; a[2] = xyz[ia + 2];
      b[0] = xyz[ib]; b[1] = xyz[ib + 1]; b[2] = xyz[ib + 2];

      if (!tangentTowards(a, b, tangent)) { carry = triangleGap * 0.5; continue; }
      leftOfTravel(a, tangent, side);
      if (f.side < 0) { side[0] = -side[0]; side[1] = -side[1]; side[2] = -side[2]; }

      // Step a short way onto that side and project, so the screen-space normal is
      // whatever this projection actually makes of it -- no handedness assumed.
      travel(a, side, probeAngle, probe);
      const pp = project(probe);
      if (!pp) { carry = triangleGap * 0.5; continue; }

      let nx = pp[0] - pa[0];
      let ny = pp[1] - pa[1];
      const nlen = Math.hypot(nx, ny);
      if (nlen < 1e-9) { carry = triangleGap * 0.5; continue; }
      nx /= nlen;
      ny /= nlen;
      // ------------------------------------------------------------------------------

      const half = triangleSize * 0.5;
      while (s <= len) {
        const depth = pa[2] + (pb[2] - pa[2]) * (s / len);
        if (depth >= minDecorationDepth) {
          const cx = pa[0] + ux * s;
          const cy = pa[1] + uy * s;

          ctx.beginPath();
          ctx.moveTo(cx - ux * half, cy - uy * half);
          ctx.lineTo(cx + ux * half, cy + uy * half);
          ctx.lineTo(cx + nx * triangleSize, cy + ny * triangleSize);
          ctx.closePath();
          // Fill only, no keyline: the triangle is the same colour as the trench it
          // sits on and should read as one symbol, not a line with beads on it.
          ctx.fill();
        }
        s += triangleGap;
      }
      carry = s - len;
    }
  }
}

/**
 * A time series of boundary frames, loaded on demand.
 *
 * Frames are NOT interpolated. Resolved topologies change discontinuously between
 * timesteps -- the feature count can halve from one Myr to the next -- so there is no
 * correspondence between one frame's features and the next to interpolate along. The
 * series shows the nearest frame and the transition is a hard cut.
 */
export class BoundarySeries {
  constructor(manifest, baseUrl, options = {}) {
    this.meta = manifest;
    this.baseUrl = baseUrl;
    this.options = options;
    this.frames = manifest.frames.slice().sort((a, b) => a.time - b.time);
    this.layers = new Map();
    this.visible = { subduction: true, ridge: true, transform: true, other: true };
    this.current = null;
    this.currentTime = null;
    // Bumped on every setTime, so a slow fetch that lands after the reader has already
    // scrubbed past it is discarded instead of painting a frame nobody asked for.
    this._request = 0;
  }

  static async load(url, options) {
    const manifest = await fetchMaybeGzippedJSON(url);
    return new BoundarySeries(manifest, url.replace(/[^/]*$/, ''), options);
  }

  get timeRange() {
    return [this.frames[0].time, this.frames[this.frames.length - 1].time];
  }

  nearestFrame(time) {
    let best = this.frames[0];
    let bestGap = Math.abs(best.time - time);
    for (const f of this.frames) {
      const gap = Math.abs(f.time - time);
      if (gap < bestGap) { best = f; bestGap = gap; }
    }
    return best;
  }

  _load(frame) {
    const existing = this.layers.get(frame.time);
    if (existing) return existing.promise;

    const entry = { layer: null };
    entry.promise = BoundaryLayer.load(this.baseUrl + frame.file, this.options)
      .then((layer) => {
        entry.layer = layer.useVisibility(this.visible);
        return entry;
      })
      .catch(() => entry);   // a missing frame leaves the previous one on screen
    this.layers.set(frame.time, entry);
    return entry.promise;
  }

  /**
   * Point the series at a time. The previously shown frame stays up until the new one
   * arrives, so scrubbing fast does not flash an empty globe.
   *
   * Returns synchronously when the frame is already built. That matters: after prefetchAll
   * every frame is cached, and awaiting a resolved promise still defers `onReady` by a
   * microtask -- long enough that the caller has already painted the old frame and has to
   * paint again. Scrubbing over warm frames was costing two full renders per slider event
   * for no reason.
   */
  setTime(time, onReady) {
    const frame = this.nearestFrame(time);
    if (frame.time === this.currentTime && this.current) return this.current;

    const request = ++this._request;
    const cached = this.layers.get(frame.time);
    if (cached && cached.layer) {
      this.current = cached.layer;
      this.currentTime = frame.time;
      onReady?.(frame);
      return this.current;
    }
    return this._setTimeAsync(frame, onReady, request);
  }

  async _setTimeAsync(frame, onReady, request) {
    const entry = await this._load(frame);
    // Scrubbed on while this was in flight: showing it now would jump the map backwards.
    if (request !== this._request) return this.current;
    if (entry.layer) {
      this.current = entry.layer;
      this.currentTime = frame.time;
      onReady?.(frame);
    }
    return this.current;
  }

  prefetchAll() {
    for (const f of this.frames) this._load(f);
  }

  /**
   * Restyle every frame this series has built AND the options future frames
   * will be built from. Both halves are needed: layers are cached per frame
   * time (see _load), so styling only `this.options` would leave every
   * already-visited age on the old palette until it was evicted -- which it
   * never is.
   */
  restyle(opts) {
    this.options = {
      ...this.options,
      ...opts,
      style: { ...(this.options.style || {}), ...(opts.style || {}) },
    };
    for (const entry of this.layers.values()) entry.layer?.restyle(opts);
    return this;
  }

  draw(ctx, projector) {
    this.current?.draw(ctx, projector);
  }
}
