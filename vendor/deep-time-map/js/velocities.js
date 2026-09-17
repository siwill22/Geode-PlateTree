/*
 * Plate velocity arrows.
 *
 * The domain is a fixed HEALPix sampling grid -- equal-area, so arrows are evenly spaced
 * on the sphere rather than bunching towards the poles the way a lon/lat grid would. The
 * points do not move between frames; only the east/north components do, so a whole time
 * series is one small file loaded once.
 *
 * The arrow tip is computed ON THE SPHERE, not by drawing a fixed-length line from a
 * projected azimuth. Given the base unit vector `b` and a unit tangent `d` along the
 * velocity, the point an angular distance θ away is
 *
 *     tip = b·cos θ + d·sin θ
 *
 * which is the great circle the plate is actually moving along. Both ends are then
 * projected independently, so an arrow near the limb foreshortens onto the surface
 * instead of standing up off it. For short arrows near the centre the difference is
 * negligible; near the horizon it is the whole difference between right and wrong.
 */

import { DEG, lonLatToVec3, tangentFrame, travel } from './sphere.js';
import { fetchMaybeGzippedJSON } from './gzipFetch.js';

export const DEFAULT_OPTIONS = {
  // Arrow length: degrees of arc per km/Myr. Plate speeds top out near 210 km/Myr
  // (21 cm/yr), so this puts the fastest arrows at roughly 8 degrees of arc.
  scale: 0.038,

  // Below this the arrow is too short to show a direction and just adds speckle. Note
  // the cost: near-stationary plates read as empty rather than as slow.
  minSpeed: 8,            // km/Myr, i.e. 0.8 cm/yr

  headLength: 6,          // px
  headWidth: 4.5,         // px
  shaftWidth: 1.3,
  colour: 'rgba(190, 228, 255, 0.9)',
};

export class VelocityField {
  constructor(data, options = {}) {
    this.meta = data;
    this.frames = data.frames;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.visible = true;

    const n = data.lon.length;
    this.count = n;

    // Base position and the local east/north basis at each point, all precomputed.
    this.base = new Float64Array(n * 3);
    this.east = new Float64Array(n * 3);
    this.north = new Float64Array(n * 3);

    const b = [0, 0, 0], e = [0, 0, 0], nn = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      lonLatToVec3(data.lon[i], data.lat[i], b);
      tangentFrame(data.lon[i], data.lat[i], e, nn);
      for (let k = 0; k < 3; k++) {
        this.base[i * 3 + k] = b[k];
        this.east[i * 3 + k] = e[k];
        this.north[i * 3 + k] = nn[k];
      }
    }

    this.current = null;
    this._base = [0, 0, 0];
    this._dir = [0, 0, 0];
    this._tip = [0, 0, 0];
  }

  static async load(url, options) {
    return new VelocityField(await fetchMaybeGzippedJSON(url), options);
  }

  /** Frames are keyed by integer time; falls back to the nearest available key. */
  setTime(time) {
    const key = String(Math.round(time));
    this.current = this.frames[key] ?? this.current;
    return this.current;
  }

  /** Fastest speed in the current frame, km/Myr -- for a scale reference. */
  maxSpeed() {
    if (!this.current) return 0;
    const [ve, vn] = this.current;
    let max = 0;
    for (let i = 0; i < ve.length; i++) {
      const s = Math.hypot(ve[i], vn[i]);
      if (s > max) max = s;
    }
    return max;
  }

  /** Screen length in px an arrow of the given speed would have, for a scale bar. */
  lengthFor(kmPerMyr, radiusPx) {
    return kmPerMyr * this.options.scale * DEG * radiusPx;
  }

  /*
   * Every arrow is the same colour and the same width, so the whole field is two canvas
   * operations: one stroke for all the shafts, one fill for all the heads. Issuing a
   * stroke() and a fill() per arrow meant ~760 separate draw calls per frame on a dense
   * field, and each one carries fixed overhead no matter how short the line is.
   */
  draw(ctx, projector) {
    if (!this.visible || !this.current) return;
    const [ve, vn] = this.current;
    const { colour, shaftWidth, minSpeed, scale } = this.options;

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = shaftWidth;
    ctx.lineCap = 'round';

    // Projected arrow endpoints, four numbers each, into a reused array so a dense field
    // costs no allocation per frame.
    const ends = this._ends || (this._ends = []);
    ends.length = 0;

    const base = this._base, dir = this._dir, tip = this._tip;

    for (let i = 0; i < this.count; i++) {
      const e = ve[i];
      const n = vn[i];
      const speed = Math.hypot(e, n);
      if (speed < minSpeed) continue;       // also skips points outside every plate

      const i3 = i * 3;
      base[0] = this.base[i3];
      base[1] = this.base[i3 + 1];
      base[2] = this.base[i3 + 2];

      const a = projector.project(base);
      if (!a) continue;                     // base is over the horizon

      // Unit tangent along the velocity, in world coordinates.
      for (let k = 0; k < 3; k++) {
        dir[k] = (this.east[i3 + k] * e + this.north[i3 + k] * n) / speed;
      }

      travel(base, dir, speed * scale * DEG, tip);
      const b = projector.project(tip);
      if (!b) continue;                     // arrow would run off the visible side

      ends.push(a[0], a[1], b[0], b[1]);
    }

    const { headLength, headWidth } = this.options;
    const w = headWidth * 0.5;

    // Pass 1: every shaft into one path, one stroke.
    ctx.beginPath();
    for (let i = 0; i < ends.length; i += 4) {
      const x0 = ends[i], y0 = ends[i + 1], x1 = ends[i + 2], y1 = ends[i + 3];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1.5) continue;              // degenerate once foreshortened
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      // Stop the shaft where the head begins so the point stays sharp.
      const head = Math.min(headLength, len * 0.6);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - ux * head, y1 - uy * head);
    }
    ctx.stroke();

    // Pass 2: every head into one path, one fill. The triangles are closed by repeating
    // the first vertex rather than with closePath(), which is not O(1) in Blink once
    // subpaths are being accumulated -- the same trap that made the continent fill quadratic.
    ctx.beginPath();
    for (let i = 0; i < ends.length; i += 4) {
      const x0 = ends[i], y0 = ends[i + 1], x1 = ends[i + 2], y1 = ends[i + 3];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1.5) continue;
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      const head = Math.min(headLength, len * 0.6);
      const px = -uy, py = ux;              // perpendicular, screen space
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * head + px * w, y1 - uy * head + py * w);
      ctx.lineTo(x1 - ux * head - px * w, y1 - uy * head - py * w);
      ctx.lineTo(x1, y1);
    }
    ctx.fill();

    ctx.restore();
  }
}
