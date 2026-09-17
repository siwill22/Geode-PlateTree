/*
 * Symbolised point datasets, with hit-testing.
 *
 * This is the first layer in the library that answers "what is under the pointer?", which
 * is what makes a map explorable rather than only looked-at. The answer has to agree with
 * what is on screen, so picking reads the SAME projected positions that draw() just
 * computed rather than recomputing them -- if the two ever disagree, the popup describes a
 * symbol other than the one under the cursor, and that is invisible in a screenshot.
 *
 * ---- Two transports -------------------------------------------------------------------
 *
 * Points are rigid bodies with correspondence across time -- a deposit is the same deposit
 * at 0 and 250 Ma, just somewhere else. (Resolved topologies are not, which is why
 * boundary frames cut hard while these interpolate.) So positions can be shipped two ways:
 *
 *   'rotations'   present-day position per point + an Euler pole/angle per PLATE per time.
 *                 Cost scales with plates x times.
 *   'trajectory'  a reconstructed position per point per time. Scales with points x times.
 *
 * Which is smaller is a property of the dataset, not a matter of taste -- roughly,
 * rotations win once `effective_points > 2 x distinct_plates`. Both are read here behind
 * one API so a consumer can switch without touching page code, and so the two can be
 * compared against each other.
 *
 * ---- Appearance through time ----------------------------------------------------------
 *
 * A point exists from its `age` to the present. The two transports encode that
 * differently -- trajectory writes null coordinates, rotations carries a scalar age -- so
 * both paths are normalised to the same `_live` flags here.
 */

import { lonLatToVec3 } from './sphere.js';
import { fetchMaybeGzippedJSON } from './gzipFetch.js';
import { quatFromPoleAngle, quatSlerp, quatToMat3, mat3Apply } from './rotations.js';

export const DEFAULT_SYMBOLS = {
  circle: 'circle',
  square: 'square',
  diamond: 'diamond',
  hexagon: 'hexagon',
  triangle: 'triangle',
  'triangle-down': 'triangle-down',
  cross: 'cross',
};

export const DEFAULT_OPTIONS = {
  /*
   * When is a point drawn?
   *
   *   'always'  ignore age entirely.
   *   'since'   from its `age` to the present: time <= age. For things that form and
   *             then persist -- an ore deposit still exists today.
   *   'window'  within `ageWindow` Myr either side of `age`. For showing WHEN something
   *             happened rather than that it exists: the map becomes a moving slice
   *             through time, and scrubbing shows events switching on and off.
   *   'range'   between the point's own `from` and `to` properties, in Ma, with
   *             from >= to. For data that carries its own interval.
   *
   * The exported data deliberately does NOT encode this -- it carries positions at every
   * time, and the rule lives here. A 'window' consumer needs positions from before the
   * point's age, which a rule baked into the export would have thrown away.
   */
  lifespan: 'since',
  ageWindow: 5,

  // Fixed size: shape already encodes type on a globe that also carries coloured boundary
  // lines and velocity arrows, and a second visual variable would overload it.
  size: 3.4,

  // A dark keyline so a symbol separates from whatever lies beneath. Deliberately the
  // opposite of the subduction triangles, which have no keyline because they must read as
  // part of the trench they decorate; these belong to nothing on the map underneath them.
  keyline: 'rgba(6, 11, 20, 0.85)',
  keylineWidth: 0.9,

  fill: 'rgba(200, 214, 230, 0.9)',

  // Fitts's law: a 3.4 px symbol is impossible to hit precisely, so the target is bigger
  // than the mark.
  hitRadius: 9,

  highlight: 'rgba(255, 255, 255, 0.95)',
  highlightWidth: 1.6,
  highlightRadius: 4.0,

  /*
   * ---- Spiderfy -----------------------------------------------------------------------
   *
   * Real point datasets cluster: ore districts, sample sites, seismometers. On a globe a
   * district is a few pixels wide, so pick() returns *a* point from the pile and the rest
   * are unreachable no matter how far you zoom -- measured on the deposit dataset, 71% of
   * drawn points share a hit radius with another, and zooming 4x barely moves it.
   *
   * So on hover the cluster fans out, with a leader line from each displaced symbol back
   * to where it really is. Set `spiderfy: false` to disable the whole mechanism.
   */
  spiderfy: true,

  // Members are gathered within this radius of the point nearest the cursor -- of the
  // POINT, not the cursor, so the cluster does not shift as the pointer jitters.
  clusterRadius: 14,
  spiderfyMinPoints: 2,        // one point is not a pile; nothing to disambiguate

  spiderfyDuration: 180,       // ms, ease-out
  leaderStroke: 'rgba(232, 240, 248, 0.35)',
  leaderWidth: 0.8,

  // Layout constants, after Leaflet.MarkerCluster but about two thirds the size, since
  // these symbols are ~3.4 px rather than 25 px map pins.
  circleFootSeparation: 18,
  spiralFootSeparation: 20,
  spiralLengthStart: 9,
  spiralLengthFactor: 3.5,
};

// A ring is only legible up to about this many feet; beyond it the circumference needed
// puts the symbols so far from their origin that the leader lines cross. Past this, spiral.
const MAX_CIRCLE_MEMBERS = 9;

export class PointLayer {
  constructor(data, options = {}) {
    this.meta = data.meta || {};
    this.data = data;
    this.transport = data.transport;
    this.times = data.times;
    this.points = data.points;
    this.categories = data.categories || {};
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.visible = true;

    const n = this.points.length;
    this.count = n;

    // Per-category visibility, so the legend can filter a dense map down to one type.
    this.types = {};
    for (const p of this.points) {
      if (p.type != null) this.types[p.type] = true;
    }

    // Present-day unit vectors. The rotations transport rotates these; the trajectory
    // transport overwrites them per frame. Either way `_xyz` is what gets projected.
    this._home = new Float64Array(n * 3);
    this._xyz = new Float64Array(n * 3);
    this._live = new Uint8Array(n);

    // _screen is where a symbol IS DRAWN -- displaced when the point is part of a fanned
    // cluster. pick() reads this same array, so "picking returns exactly what you can
    // see" stays literally true, which is what makes the popup trustworthy.
    this._screen = new Array(n).fill(null);
    // _origin is the true projected position, non-null only for fanned members. It is the
    // leader line's origin, and is deliberately NOT pickable -- the whole point of fanning
    // is to get out of the pile, so the pile must not still be sitting there under the
    // lines' convergence point.
    this._origin = new Array(n).fill(null);
    this._spider = null;

    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      lonLatToVec3(this.points[i].lon, this.points[i].lat, tmp);
      this._home[i * 3] = tmp[0];
      this._home[i * 3 + 1] = tmp[1];
      this._home[i * 3 + 2] = tmp[2];
    }

    if (this.transport === 'rotations') {
      // Pre-convert every pole/angle to a quaternion once. Slerping is cheap; rebuilding
      // quaternions from trigonometry every frame is not.
      this._quats = new Map();
      for (const [plate, series] of Object.entries(data.rotations)) {
        this._quats.set(plate, series.map((r) => quatFromPoleAngle(r[0], r[1], r[2])));
      }
      this._plate = this.points.map((p) => String(p.plate_id));
      this._plates = [...new Set(this._plate)];
      // One matrix per plate, allocated once and overwritten each frame rather than a fresh
      // Map and 174 fresh Float64Arrays per time change.
      this._mats = new Map();
      for (const plate of this._plates) {
        if (this._quats.has(plate)) this._mats.set(plate, new Float64Array(9));
      }
    }

    this._style = null;
    this.restyle();

    this.hovered = -1;
    this.currentTime = null;
    this._q = [0, 0, 0, 1];
    this._m = new Float64Array(9);
    this._v = [0, 0, 0];
    this._visible = [];
  }

  static async load(url, options) {
    // Transparently un-gzips a `.gz` URL. A real point export runs to megabytes and a
    // static host will not compress it for you, so the choice to pre-gzip belongs to the
    // deployment rather than to page code -- see gzipFetch.js for why sniffing the bytes
    // beats trusting the extension.
    return new PointLayer(await fetchMaybeGzippedJSON(url), options);
  }

  /** Bracketing sample indices and the fraction between them, for a time in Ma. */
  _bracket(time) {
    const times = this.times;
    const first = times[0];
    const last = times[times.length - 1];
    const t = Math.max(first, Math.min(last, time));

    // Samples are evenly spaced by construction, so this is arithmetic rather than a
    // search.
    const step = times.length > 1 ? (last - first) / (times.length - 1) : 1;
    let i = Math.floor((t - first) / step);
    if (i >= times.length - 1) i = times.length - 2;
    if (i < 0) i = 0;
    return [i, i + 1, (t - times[i]) / step];
  }

  /**
   * Should this point be drawn at this time?
   *
   * One rule, applied identically by both transports -- which is what keeps them
   * comparable. Points with no age are always shown: a missing age is "unknown", and
   * hiding a point because its age was not recorded would quietly drop data.
   */
  isLive(point, time) {
    if (!this._plateValidAt(point, time)) return false;
    switch (this.options.lifespan) {
      case 'always':
        return true;

      case 'window': {
        if (point.age == null) return true;
        return Math.abs(time - point.age) <= this.options.ageWindow;
      }

      case 'range': {
        // from/to are in Ma, so `from` is the LARGER number -- time runs backwards.
        const from = point.from ?? point.age;
        const to = point.to ?? 0;
        if (from == null) return true;
        return time <= from && time >= to;
      }

      case 'since':
      default:
        return point.age == null || time <= point.age;
    }
  }

  /**
   * Is `time` within the geologically meaningful window of this point's assigned
   * plate? `points_from_dataframe()` exposes `plate_begin_age` (see SCHEMA.md) -- the
   * assigned static polygon's own begin age -- because `pygplates` does not error on
   * reconstructing a point older than that: it silently holds the plate's oldest
   * defined rotation pole fixed instead. Left unchecked, an over-old point does not
   * disappear or complain, it just stops moving, which reads as "this category never
   * moves" rather than "this assignment stopped being meaningful" (the bug a Geode
   * consumer hit and reported upstream). A point assigned NO plate at all (`plate_id:
   * 0`, `plate_begin_age: null`) has no crust history whatsoever behind it -- valid
   * only at the present day, the same as a beginAge of 0.
   *
   * Absent for datasets that never went through `points_from_dataframe()` (both fields
   * `undefined`, not `null`) -- always valid, unchanged from before this check existed.
   */
  _plateValidAt(point, time) {
    if (point.plate_begin_age != null) return time <= point.plate_begin_age;
    if (point.plate_id === 0) return time <= 0;
    return true;
  }

  /** How many points are currently drawable, optionally of one type. */
  liveCount(type) {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this._live[i]) continue;
      if (type == null || this.points[i].type === type) n++;
    }
    return n;
  }

  setTime(time) {
    this.currentTime = time;
    // Any open fan describes a cluster at the old time. Points move and appear between
    // frames, so its members may not even be on screen any more -- collapse rather than
    // leave leader lines pointing at where something used to be.
    this.unspiderfy();
    if (this.transport === 'rotations') this._setTimeRotations(time);
    else this._setTimeTrajectory(time);
    return this;
  }

  _setTimeRotations(time) {
    const [ia, ib, f] = this._bracket(time);
    const q = this._q;
    const v = this._v;

    // One slerp and one matrix per PLATE, not per point: this is the whole reason the
    // rotations transport is cheap on a large dataset. 1987 deposits share 174 plates.
    const mats = this._mats;
    for (const [plate, mat] of mats) {
      const series = this._quats.get(plate);
      quatSlerp(series[ia], series[ib], f, q);
      quatToMat3(q, mat);
    }

    for (let i = 0; i < this.count; i++) {
      this._live[i] = this.isLive(this.points[i], time) ? 1 : 0;
      if (!this._live[i]) continue;

      const mat = mats.get(this._plate[i]);
      if (!mat) { this._live[i] = 0; continue; }

      const i3 = i * 3;
      v[0] = this._home[i3];
      v[1] = this._home[i3 + 1];
      v[2] = this._home[i3 + 2];
      mat3Apply(mat, v, v);
      this._xyz[i3] = v[0];
      this._xyz[i3 + 1] = v[1];
      this._xyz[i3 + 2] = v[2];
    }
  }

  _setTimeTrajectory(time) {
    const [ia, ib, f] = this._bracket(time);
    const frames = this.data.frames;
    const a = frames[String(this.times[ia])];
    const b = frames[String(this.times[ib])];
    if (!a) return;

    const [alon, alat] = a;
    const [blon, blat] = b || a;
    const va = [0, 0, 0];
    const vb = [0, 0, 0];

    for (let i = 0; i < this.count; i++) {
      // The same lifespan rule the rotations path uses -- that identity is what makes the
      // two transports comparable. A null coordinate is a separate matter: it means no
      // position could be computed at all, so there is nothing to draw regardless.
      if (alon[i] == null || !this.isLive(this.points[i], time)) {
        this._live[i] = 0;
        continue;
      }
      this._live[i] = 1;

      lonLatToVec3(alon[i], alat[i], va);
      const i3 = i * 3;

      if (blon[i] == null || f === 0) {
        this._xyz[i3] = va[0];
        this._xyz[i3 + 1] = va[1];
        this._xyz[i3 + 2] = va[2];
        continue;
      }

      // Slerp the two unit vectors, so a point crossing the antimeridian between samples
      // takes the short way round instead of sweeping back across the globe.
      lonLatToVec3(blon[i], blat[i], vb);
      let dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
      dot = Math.max(-1, Math.min(1, dot));

      let x, y, z;
      if (dot > 0.9995) {
        x = va[0] + (vb[0] - va[0]) * f;
        y = va[1] + (vb[1] - va[1]) * f;
        z = va[2] + (vb[2] - va[2]) * f;
      } else {
        const theta = Math.acos(dot);
        const s = Math.sin(theta);
        const s0 = Math.sin((1 - f) * theta) / s;
        const s1 = Math.sin(f * theta) / s;
        x = s0 * va[0] + s1 * vb[0];
        y = s0 * va[1] + s1 * vb[1];
        z = s0 * va[2] + s1 * vb[2];
      }

      const len = Math.hypot(x, y, z) || 1;
      this._xyz[i3] = x / len;
      this._xyz[i3 + 1] = y / len;
      this._xyz[i3 + 2] = z / len;
    }
  }

  /**
   * Resolve every point's symbol, once.
   *
   * Doing this per point per frame would allocate an object per symbol per draw, so it is
   * cached; call restyle() after changing `categories` or the style option.
   *
   * `options.style(point, category, defaults)` is the escape hatch for a consumer whose
   * palette is a property of its page rather than of the data -- which is the common case.
   * Colours do not belong in the exported JSON, because rebuilding the data to restyle a
   * map would be the wrong seam.
   */
  restyle() {
    const custom = this.options.style;
    const defaults = { symbol: 'circle', fill: this.options.fill,
                       size: this.options.size };

    this._style = this.points.map((p) => {
      const cat = this.categories[p.type] || {};
      const base = {
        symbol: cat.symbol || defaults.symbol,
        fill: cat.fill || defaults.fill,
        size: cat.size ?? defaults.size,
      };
      if (!custom) return base;
      // Skip undefined so a hook that only sets `fill`, or that returns nothing for an
      // unrecognised category, cannot blank out the rest of the symbol.
      const over = custom(p, cat, base) || {};
      for (const key of Object.keys(over)) {
        if (over[key] !== undefined) base[key] = over[key];
      }
      return base;
    });
    return this;
  }

  /** Resolved symbol for a point index. */
  styleFor(index) {
    return this._style[index];
  }

  isTypeVisible(point) {
    return point.type == null || this.types[point.type] !== false;
  }

  draw(ctx, projector, now = null) {
    const n = this.count;
    const screen = this._screen;
    const origin = this._origin;
    for (let i = 0; i < n; i++) { screen[i] = null; origin[i] = null; }
    if (!this.visible) return;

    // Remember where the middle of the canvas is, so a fan can open inward. Taken from the
    // projector rather than the context, since a host may draw the globe off-centre.
    this._cx = projector.cx ?? (ctx.canvas ? ctx.canvas.width / 2 : 0);
    this._cy = projector.cy ?? (ctx.canvas ? ctx.canvas.height / 2 : 0);

    const v = this._v;
    for (let i = 0; i < n; i++) {
      if (!this._live[i] || !this.isTypeVisible(this.points[i])) continue;
      const i3 = i * 3;
      v[0] = this._xyz[i3];
      v[1] = this._xyz[i3 + 1];
      v[2] = this._xyz[i3 + 2];
      // null behind the horizon, which makes the point unpickable as well as invisible.
      screen[i] = projector.project(v);
    }

    // Displace fanned members before anything reads `screen`, so drawing and picking see
    // one consistent set of positions.
    this._applySpider(now ?? nowMs());

    // Painter's algorithm: far first, so a near symbol overlaps a far one rather than the
    // draw order deciding arbitrarily. One reused array, so no per-frame allocation.
    const visible = this._visible;
    visible.length = 0;
    for (let i = 0; i < n; i++) if (screen[i]) visible.push(i);

    // Depth order, except that fanned members always come last. They have been pulled off
    // their true positions specifically to be reachable, so nothing may cover them.
    const fanned = this._spider ? new Set(this._spider.members) : null;
    visible.sort((a, b) => {
      if (fanned) {
        const fa = fanned.has(a) ? 1 : 0;
        const fb = fanned.has(b) ? 1 : 0;
        if (fa !== fb) return fa - fb;
      }
      return screen[a][2] - screen[b][2];
    });

    const { keyline, keylineWidth } = this.options;

    ctx.save();
    ctx.lineJoin = 'round';

    // Leader lines first, under every symbol: they are a relationship, not a mark, and
    // should never sit on top of the thing they point at.
    if (this._spider) {
      ctx.strokeStyle = this.options.leaderStroke;
      ctx.lineWidth = this.options.leaderWidth;
      ctx.beginPath();
      for (const i of this._spider.members) {
        const a = origin[i];
        const b = screen[i];
        if (!a || !b) continue;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    }

    ctx.lineWidth = keylineWidth;
    ctx.strokeStyle = keyline;

    for (let k = 0; k < visible.length; k++) {
      const i = visible[k];
      const p = screen[i];
      const style = this._style[i];
      ctx.fillStyle = style.fill;
      ctx.beginPath();
      symbolPath(ctx, style.symbol, p[0], p[1], style.size);
      // The cross is a stroke-only mark; filling it would just make a blob.
      if (style.symbol === 'cross') {
        ctx.save();
        ctx.strokeStyle = style.fill;
        ctx.lineWidth = keylineWidth * 1.8;
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fill();
        ctx.stroke();
      }
    }

    if (this.hovered >= 0 && screen[this.hovered]) {
      const p = screen[this.hovered];
      ctx.beginPath();
      ctx.arc(p[0], p[1], this.options.highlightRadius + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = this.options.highlight;
      ctx.lineWidth = this.options.highlightWidth;
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * What is at this canvas position?
   *
   * Reads the positions cached by the last draw(), so the answer is guaranteed to match
   * what is on screen. Returns { index, point, x, y } or null.
   *
   * A linear scan over ~1000 visible points is well under a millisecond, so there is no
   * spatial index here -- one would be dead weight and another thing to keep in sync with
   * the frame.
   */
  pick(x, y) {
    if (!this.visible) return null;
    const screen = this._screen;
    const limit = this.options.hitRadius;
    // Within a pixel of each other, two symbols are effectively tied for the pointer, so
    // prefer the smaller one -- otherwise a small mark overlapping a large one would be
    // permanently shadowed by its neighbour and unreachable.
    const TIE = 1.0;
    let best = -1;
    let bestDist = limit * limit;
    let bestSize = Infinity;

    for (let i = 0; i < this.count; i++) {
      const p = screen[i];
      if (!p) continue;                        // not drawn: hidden, absent or occluded
      const dx = x - p[0];
      const dy = y - p[1];
      const d2 = dx * dx + dy * dy;
      if (d2 > bestDist) continue;

      const size = this._style[i].size;
      if (best >= 0 && Math.abs(Math.sqrt(d2) - Math.sqrt(bestDist)) <= TIE) {
        // Near-tie: the smaller symbol wins. Among equal sizes fall back to distance,
        // otherwise the first candidate found would block every later one -- including
        // the symbol exactly under the pointer.
        if (size > bestSize) continue;
        if (size === bestSize && d2 >= bestDist) continue;
      }

      best = i;
      bestDist = d2;
      bestSize = size;
    }

    if (best < 0) return null;
    const p = screen[best];
    return { index: best, point: this.points[best], x: p[0], y: p[1] };
  }

  /** Which symbol the popup is describing. Returns true if it changed. */
  highlight(index) {
    const next = index == null ? -1 : index;
    if (next === this.hovered) return false;
    this.hovered = next;
    return true;
  }

  /* ---- spiderfy ---------------------------------------------------------- */

  /**
   * How many drawn points are piled up near this canvas position?
   *
   * Lets a caller decide whether fanning is worth it before committing to it, without
   * having to reach into the layer's internals.
   */
  clusterSizeAt(x, y) {
    const anchor = this._nearestDrawn(x, y, this.options.hitRadius);
    if (anchor < 0) return 0;
    return this._membersNear(anchor).length;
  }

  /**
   * Fan the cluster near (x, y) apart so each point becomes its own target.
   *
   * Returns the number of members fanned, or 0 if there was no pile worth opening. Safe to
   * call repeatedly with the pointer inside the same cluster: it recognises the cluster it
   * already has open and leaves the animation alone rather than restarting it.
   */
  spiderfy(x, y, now = null) {
    if (!this.options.spiderfy) return 0;

    const anchor = this._nearestDrawn(x, y, this.options.hitRadius);
    if (anchor < 0) return 0;

    const members = this._membersNear(anchor);
    if (members.length < this.options.spiderfyMinPoints) return 0;

    // Already open on this same cluster -- don't restart the animation under the pointer.
    if (this._spider && sameMembers(this._spider.members, members)) {
      return this._spider.members.length;
    }

    const p = this._screen[anchor];
    this._spider = {
      members,
      // Anchor in SCREEN space, captured now. The fan does not track the globe as it
      // turns; a rotate collapses it instead, which is both simpler and less disorienting
      // than leader lines swinging around.
      ax: this._origin[anchor] ? this._origin[anchor][0] : p[0],
      ay: this._origin[anchor] ? this._origin[anchor][1] : p[1],
      offsets: null,
      t0: now ?? nowMs(),
    };
    this._spider.offsets = this._fanOffsets(members.length,
                                            this._spider.ax, this._spider.ay);
    return members.length;
  }

  unspiderfy() {
    if (!this._spider) return false;
    this._spider = null;
    return true;
  }

  get spiderfied() {
    return this._spider ? this._spider.members.slice() : null;
  }

  /**
   * How far the open fan reaches from its anchor, in px.
   *
   * Read from the computed offsets rather than from drawn positions, so it is correct the
   * instant the fan opens -- before any frame has been rendered, and regardless of how far
   * through the animation it is. A caller sizing a keep-alive radius needs the final
   * extent, not the current one.
   */
  spiderExtent() {
    if (!this._spider) return 0;
    let max = 0;
    for (const [dx, dy] of this._spider.offsets) {
      max = Math.max(max, Math.hypot(dx, dy));
    }
    return max;
  }

  /** True while the fan is still moving, so a host knows to keep rendering. */
  isAnimating(now = null) {
    if (!this._spider) return false;
    return (now ?? nowMs()) - this._spider.t0 < this.options.spiderfyDuration;
  }

  /** Nearest drawn point to a canvas position, or -1. */
  _nearestDrawn(x, y, limit) {
    let best = -1;
    let bestD2 = limit * limit;
    for (let i = 0; i < this.count; i++) {
      const p = this._screen[i];
      if (!p) continue;
      const d2 = (x - p[0]) ** 2 + (y - p[1]) ** 2;
      if (d2 <= bestD2) { best = i; bestD2 = d2; }
    }
    return best;
  }

  /**
   * Drawn points within clusterRadius OF THE ANCHOR POINT.
   *
   * A direct radius, deliberately not connected components. Clusters here are often chains
   * -- the Andean porphyry belt is a line of near-neighbours running the length of the
   * continent -- and transitive grouping would swallow the whole arc into one cluster and
   * fan forty points across the globe. A direct radius stays local and bounded.
   */
  _membersNear(anchor) {
    const a = this._origin[anchor] || this._screen[anchor];
    const r2 = this.options.clusterRadius ** 2;
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const p = this._origin[i] || this._screen[i];
      if (!p) continue;
      if ((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 <= r2) out.push(i);
    }
    return out;
  }

  /**
   * Where each member sits once fanned, as offsets from the anchor.
   *
   * Circle up to MAX_CIRCLE_MEMBERS, Archimedean spiral beyond -- a ring big enough for 25
   * would put its feet so far out that the leader lines cross each other. Measured on the
   * deposit data, the largest real cluster is 25, so the spiral is load-bearing.
   */
  _fanOffsets(n, ax, ay) {
    const o = this.options;
    const offsets = [];

    // Open the fan toward the middle of the canvas, so a cluster near the globe's limb or
    // a window edge unfolds inward instead of off-screen.
    const start = Math.atan2((this._cy ?? ay) - ay, (this._cx ?? ax) - ax) || 0;

    if (n <= MAX_CIRCLE_MEMBERS) {
      const radius = o.circleFootSeparation * (2 + n) / (2 * Math.PI);
      const step = (2 * Math.PI) / n;
      for (let i = 0; i < n; i++) {
        const a = start + i * step;
        offsets.push([Math.cos(a) * radius, Math.sin(a) * radius]);
      }
      return offsets;
    }

    let angle = start;
    for (let i = 0; i < n; i++) {
      const legLength = o.spiralLengthStart + o.spiralLengthFactor * i;
      offsets.push([Math.cos(angle) * legLength, Math.sin(angle) * legLength]);
      angle += o.spiralFootSeparation / legLength;
    }
    return offsets;
  }

  /**
   * Move fanned members from their true positions to their slots.
   *
   * Called from draw() once the projection is done, so the displacement always applies to
   * the current frame's geometry rather than a stale copy.
   */
  _applySpider(now) {
    const s = this._spider;
    if (!s) return;

    const duration = this.options.spiderfyDuration;
    const elapsed = now - s.t0;
    // Ease-out: fast away from the pile, settling into place. The motion is what tells a
    // reader these symbols came from one spot; instantly appearing reads as new symbols.
    const t = duration > 0 ? Math.min(1, elapsed / duration) : 1;
    const e = 1 - (1 - t) ** 3;

    for (let k = 0; k < s.members.length; k++) {
      const i = s.members[k];
      const p = this._screen[i];
      if (!p) continue;                      // rotated out of view since the fan opened
      const [dx, dy] = s.offsets[k];
      this._origin[i] = p;
      this._screen[i] = [p[0] + dx * e, p[1] + dy * e, p[2]];
    }
  }
}

function sameMembers(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Symbol outlines, all centred on (x, y) and sized by a nominal radius. */
function symbolPath(ctx, symbol, x, y, r) {
  switch (symbol) {
    case 'square':
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;

    case 'diamond':
      ctx.moveTo(x, y - r * 1.3);
      ctx.lineTo(x + r * 1.3, y);
      ctx.lineTo(x, y + r * 1.3);
      ctx.lineTo(x - r * 1.3, y);
      ctx.closePath();
      break;

    case 'triangle':
      ctx.moveTo(x, y - r * 1.4);
      ctx.lineTo(x + r * 1.25, y + r * 0.9);
      ctx.lineTo(x - r * 1.25, y + r * 0.9);
      ctx.closePath();
      break;

    case 'triangle-down':
      ctx.moveTo(x, y + r * 1.4);
      ctx.lineTo(x + r * 1.25, y - r * 0.9);
      ctx.lineTo(x - r * 1.25, y - r * 0.9);
      ctx.closePath();
      break;

    case 'hexagon':
      for (let k = 0; k < 6; k++) {
        // Start at -90 deg so the hexagon sits flat-topped rather than pointy-topped,
        // which reads more distinctly against the circle at these sizes.
        const a = (Math.PI / 3) * k - Math.PI / 2;
        const px = x + Math.cos(a) * r * 1.2;
        const py = y + Math.sin(a) * r * 1.2;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;

    case 'cross':
      ctx.moveTo(x - r * 1.2, y);
      ctx.lineTo(x + r * 1.2, y);
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x, y + r * 1.2);
      break;

    default:
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}
