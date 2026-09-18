/*
 * Globe: a WebGL raster layer with a 2D vector overlay on top.
 *
 * The raster layer is a single full-screen quad whose fragment shader does the
 * inverse projection and samples an equirectangular paleogeography texture. Doing
 * it in the shader rather than per-pixel on the CPU is what makes a full-viewport
 * globe redraw cheaply enough to be driven by scrolling.
 *
 * Three projections are available. 'orthographic' is the globe seen from far
 * away, centred on state.lon/state.lat, and is what a rotatable map wants.
 * 'spilhaus' is a fixed Southern Ocean view -- its centre is baked into the
 * shader, so it ignores state.lon/state.lat entirely; that is the default only
 * because the existing stories were built against it. 'robinson' is a flat,
 * pannable world map (state.lon sets the central meridian; state.lat is
 * unused, there is no tilt) -- unlike the other two it has no closed-form
 * inverse, so its shader inverts a standard published lookup table instead of
 * a formula (see ROBINSON_FRAG's own comment). setProjection() switches
 * between projections at runtime, compiling each one's program once and
 * caching it.
 *
 * The overlay is a plain 2D canvas using the identical camera maths from ./camera.js,
 * so vectors register with the raster exactly. It draws strokes only -- never
 * filled polygons -- which sidesteps the awkward business of clipping filled
 * shapes to the horizon, since the raster already supplies the fill. (Robinson
 * has no horizon, so this does not apply to it the same way -- see the `axis`
 * getter on `projector` below: it reports no axis at all in Robinson mode,
 * which the vendored PolygonLayer already treats as "behaves like a
 * polyline", i.e. still fills, just without horizon-specific culling. A ring
 * or line that straddles the antimeridian relative to the current central
 * meridian is a SEPARATE problem from the horizon -- see
 * ./robinson.js's `meridianCrossing()`/`wrapLonDelta()`, which a page's own
 * overlay code is expected to use for anything long/large enough to actually
 * cross it; `projectDelta()` below is that seam handling's other half.)
 */

import {
  quatFromPoleAngle, quatSlerp, quatToMat3, mat3Multiply,
} from './rotations.js';
import {
  DEG,
  lonLatToVec3,
  viewMatrix,
  spilhausForward,
  spilhausViewMatrix,
  robinsonForward,
  robinsonForwardDelta,
  ROBINSON_TABLE,
  ROBINSON_XSCALE,
  ROBINSON_YSCALE,
} from './camera.js';
import { tracePolyline } from './polyline.js';

const VERT_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/*
 * Shared preamble and epilogue for both projections. Each projection only has to
 * turn gl_FragCoord into a lon/lat; the texture sampling, antimeridian wrap and
 * limb feathering are identical either way.
 */
const FRAG_HEAD = `
precision highp float;

uniform vec2  uCentre;     // globe centre in pixels
uniform float uRadius;     // globe radius in pixels
uniform vec3  uEast;       // camera basis, world coords
uniform vec3  uNorth;
uniform vec3  uOut;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uMix;
uniform float uOpacity;

const float PI = 3.141592653589793;

// Sample the two paleogeography frames at a lon/lat and feather the limb.
// rho_raw is the normalised distance from the centre, 1.0 at the edge.
void shade(float lon, float lat, float rho_raw) {
  // WebGL 1 NPOT textures must not use REPEAT wrapping. The longitudes are
  // wrapped by fract() rather than a repeating wrap mode so the antimeridian is
  // still continuous without creating incomplete textures on 3600x1800 maps.
  float u = fract(lon / (2.0 * PI) + 0.5);
  float v = clamp(0.5 - lat / PI, 0.0, 1.0);
  vec2 uv = vec2(u, v);

  vec3 col = mix(texture2D(uTexA, uv).rgb, texture2D(uTexB, uv).rgb, uMix);

  float feather = 1.5 / uRadius;
  float alpha = smoothstep(1.0, 1.0 - feather, rho_raw) * uOpacity;

  gl_FragColor = vec4(col * alpha, alpha);
}`;

/*
 * Orthographic: the globe as seen from infinitely far away, centred wherever the
 * camera basis points. Inverting it is just reading the unit vector back off the
 * screen coordinates -- x and y ARE the east and north components, and the third
 * follows from the vector being unit length. This is the branch that actually uses
 * uEast/uNorth/uOut, so unlike the Spilhaus branch it responds to state.lon/lat.
 */
const ORTHO_FRAG = FRAG_HEAD + `
void main() {
  vec2 d = (gl_FragCoord.xy - uCentre) / uRadius;
  float rho2 = dot(d, d);
  if (rho2 > 1.0) discard;

  vec3 p = d.x * uEast + d.y * uNorth + sqrt(1.0 - rho2) * uOut;

  float lat = asin(clamp(p.z, -1.0, 1.0));
  float lon = atan(p.y, p.x);

  shade(lon, lat, sqrt(rho2));
}`;

const SPILHAUS_FRAG = FRAG_HEAD + `
// Spilhaus projection parameters
const float SPILHAUS_SCALE = 0.917;
const vec2 SPILHAUS_CENTER = vec2(142.0 * PI / 180.0, -71.0 * PI / 180.0);

void main() {
  vec2 d = (gl_FragCoord.xy - uCentre) / uRadius;
  float rho2 = dot(d, d);

  // Discard points outside the Spilhaus projection bounds
  if (rho2 > 1.0) discard;

  // Convert pixel coordinates to Spilhaus projected coordinates
  vec2 p = d * (1.0 / SPILHAUS_SCALE);
  float rho = sqrt(rho2) / SPILHAUS_SCALE;

  // Inverse Spilhaus: convert projected coords to lon/lat
  float c = 2.0 * atan(rho / (2.0 * SPILHAUS_SCALE));
  float sinc = sin(c);

  // Angular distance from center
  float cos_c = cos(c);
  float lat = asin(cos_c * sin(SPILHAUS_CENTER.y) +
                   (p.y * sinc * cos(SPILHAUS_CENTER.y)) / rho);

  float lon = SPILHAUS_CENTER.x + atan(p.x * sinc,
                   rho * cos(SPILHAUS_CENTER.y) * cos_c -
                   p.y * sin(SPILHAUS_CENTER.y) * sinc);

  shade(lon, lat, sqrt(rho2));
}`;

// The Robinson table's X/Y scale factors, written as GLSL array-assignment
// statements from ./camera.js's ROBINSON_TABLE -- the one place those numbers are
// transcribed, so the shader's inverse projection and the JS-side forward
// projection (used by vector overlays) can never drift apart. GLSL ES 1.00 (the
// WebGL1 shading language) has no array-literal syntax, only per-element
// assignment.
const ROBINSON_TABLE_GLSL = ROBINSON_TABLE
  .map(([, x, y], i) => `  rx[${i}] = ${x.toFixed(4)}; ry[${i}] = ${y.toFixed(4)};`)
  .join('\n');

/*
 * Robinson: a fixed pseudo-cylindrical world map, not a camera -- there is no
 * horizon and no tilt, only a pannable central meridian (uCenterLon). Robinson
 * has no closed-form inverse, so the standard approach (also what d3-geo-
 * projection and PROJ do on the CPU) is table lookup + interpolation: `absY`
 * (the fragment's distance from the equator, normalised) is monotonic in
 * |latitude|, so a linear search over the 18 five-degree bands finds where it
 * falls, and both latitude and the X scale factor are interpolated within that
 * band. The `for` loop's bound is a compile-time constant (18) specifically
 * because GLSL ES 1.00 only allows indexing an array by a loop variable inside
 * a loop of that restricted shape.
 */
const ROBINSON_FRAG = FRAG_HEAD + `
const float ROBINSON_XSCALE = ${ROBINSON_XSCALE};
const float ROBINSON_YSCALE = ${ROBINSON_YSCALE};

uniform float uCenterLon;

void main() {
  vec2 d = (gl_FragCoord.xy - uCentre) / uRadius;

  float absY = abs(d.y) / ROBINSON_YSCALE;
  if (absY > 1.0) discard;

  float rx[19];
  float ry[19];
${ROBINSON_TABLE_GLSL}

  float lat = 0.0;
  float xFactor = 1.0;
  bool found = false;
  for (int i = 0; i < 18; i++) {
    if (!found && absY >= ry[i] && absY <= ry[i + 1]) {
      float t = (absY - ry[i]) / (ry[i + 1] - ry[i]);
      lat = (float(i) + t) * 5.0 * PI / 180.0;
      xFactor = rx[i] + (rx[i + 1] - rx[i]) * t;
      found = true;
    }
  }
  if (!found) discard;

  float boundaryX = ROBINSON_XSCALE * xFactor * PI;
  if (abs(d.x) > boundaryX) discard;

  float dLon = d.x / (ROBINSON_XSCALE * xFactor);
  float signedLat = d.y < 0.0 ? -lat : lat;
  float lon = uCenterLon + dLon;

  float rho_raw = max(abs(d.x) / boundaryX, absY);
  shade(lon, signedLat, rho_raw);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class RasterGlobe {
  /**
   * @param container    element to fill with the raster and overlay canvases
   * @param projection   'spilhaus' (default, what the existing stories use),
   *                     'orthographic' or 'robinson'. Only the orthographic
   *                     camera responds to state.lat (tilt); Spilhaus is fixed
   *                     on the Southern Ocean by construction; Robinson has no
   *                     camera at all, only a pannable central meridian, which
   *                     it reads from state.lon the same way orthographic does.
   */
  constructor(container, { projection = 'spilhaus' } = {}) {
    this.container = container;
    this.projection = projection;

    this.rasterCanvas = document.createElement('canvas');
    this.rasterCanvas.className = 'globe-raster';
    container.appendChild(this.rasterCanvas);

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'globe-overlay';
    container.appendChild(this.overlayCanvas);

    this.gl = this.rasterCanvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
    });
    if (!this.gl) throw new Error('WebGL unavailable');

    this.ctx = this.overlayCanvas.getContext('2d');

    this.state = { age: 0, lon: 135, lat: -60, zoom: 1, opacity: 1 };
    this.frames = [];
    this.textures = new Map();   // age -> { tex, image, loading }
    this.coast = null;
    this.overlays = [];

    this._view = new Float64Array(9);
    this._plateMat = new Map();
    this._qa = [0, 0, 0, 1];
    this._qb = [0, 0, 0, 1];
    this._q = [0, 0, 0, 1];
    this._m = new Float64Array(9);
    this._pt = [0, 0, 0];

    // One compiled program per projection, built lazily and cached -- switching
    // projection at runtime (setProjection()) just changes which cached program
    // _renderRaster() uses, rather than recompiling every toggle.
    this._programs = new Map();

    this._initGL();
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.render(); });
  }

  _initGL() {
    const gl = this.gl;

    this._quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this._ensureProgram(this.projection);
    this.blankTex = this._makeTexture(null);
  }

  /** Compiles (once) and caches the program for one projection's fragment
   *  shader. Uniform locations and the vertex attribute location are cached
   *  per-program, not globally -- both are only valid against the specific
   *  linked program they came from. */
  _ensureProgram(name) {
    let entry = this._programs.get(name);
    if (entry) return entry;

    const gl = this.gl;
    const fragSrc = name === 'orthographic' ? ORTHO_FRAG
                   : name === 'robinson' ? ROBINSON_FRAG
                   : SPILHAUS_FRAG;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }

    const attribLoc = gl.getAttribLocation(prog, 'aPos');
    const uniforms = {};
    // uCenterLon only exists in ROBINSON_FRAG; getUniformLocation returns null
    // for the others, and every gl.uniform*() call below silently no-ops on a
    // null location, so one shared list is fine for all three programs.
    for (const n of ['uCentre', 'uRadius', 'uEast', 'uNorth', 'uOut', 'uCenterLon',
                     'uTexA', 'uTexB', 'uMix', 'uOpacity']) {
      uniforms[n] = gl.getUniformLocation(prog, n);
    }

    entry = { prog, uniforms, attribLoc };
    this._programs.set(name, entry);
    return entry;
  }

  /** Switch projection at runtime (e.g. a UI toggle button). Compiles the new
   *  projection's program on first use, then just flips which cached program
   *  the next render() call picks up -- callers still need to call render() (or
   *  scheduleRender()) themselves afterwards, same as any other state change. */
  setProjection(name) {
    if (this.projection === name) return;
    this._ensureProgram(name);
    this.projection = name;
    this._projector = null;   // the projector getter memoises per-projection closures
  }

  _makeTexture(image) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (image) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB,
        gl.UNSIGNED_BYTE, new Uint8Array([10, 20, 40]));
    }
    const width = image ? image.width : 1;
    const height = image ? image.height : 1;
    const isNpot = (width & (width - 1)) !== 0 || (height & (height - 1)) !== 0;

    // WebGL 1 makes NPOT textures with REPEAT wrapping incomplete, which renders
    // as a fully black sample even though the upload succeeded.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, isNpot ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    for (const c of [this.rasterCanvas, this.overlayCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.dpr = dpr;
    this.cssWidth = w;
    this.cssHeight = h;
    this.gl.viewport(0, 0, this.rasterCanvas.width, this.rasterCanvas.height);
  }

  /* ---- data ------------------------------------------------------------- */

  async loadTextures(url) {
    this.cacheBuster = Date.now();
    const manifestUrl = `${url}${url.includes('?') ? '&' : '?'}v=${this.cacheBuster}`;
    const manifest = await (await fetch(manifestUrl, { cache: 'no-store' })).json();
    this.frames = manifest.frames.slice().sort((a, b) => a.age - b.age);
    this.textureBase = url.replace(/[^/]*$/, '');
    // Pull in the two endpoints up front so there is always something to show.
    await Promise.all([
      this._loadTexture(this.frames[0]),
      this._loadTexture(this.frames[this.frames.length - 1]),
    ]);
  }

  _loadTexture(frame) {
    const existing = this.textures.get(frame.age);
    if (existing) return existing.promise;

    const entry = { tex: null };
    entry.promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        entry.tex = this._makeTexture(img);
        resolve(entry);
        this.render();
      };
      img.onerror = () => resolve(entry);
      img.src = `${this.textureBase}${frame.file}?v=${this.cacheBuster ?? Date.now()}`;
    });
    this.textures.set(frame.age, entry);
    return entry.promise;
  }

  /** Warm the cache so scrolling does not stall on first paint of each frame. */
  prefetchAll() {
    for (const f of this.frames) this._loadTexture(f);
  }

  async loadCoastlines(url) {
    const data = await (await fetch(url)).json();
    this.coast = data;
    this.coast.times = data.times;

    // Pre-convert every vertex to a unit vector once. Per frame we only need a
    // matrix multiply per point, no trigonometry.
    let total = 0;
    for (const f of data.features) total += f.xy.length / 2;

    const xyz = new Float64Array(total * 3);
    const meta = [];
    let o = 0;
    const tmp = [0, 0, 0];
    for (const f of data.features) {
      const n = f.xy.length / 2;
      meta.push({ plate: String(f.p), closed: !!f.c, begin: f.b, end: f.e,
                  offset: o, count: n });
      for (let i = 0; i < n; i++) {
        lonLatToVec3(f.xy[i * 2], f.xy[i * 2 + 1], tmp);
        xyz[(o + i) * 3] = tmp[0];
        xyz[(o + i) * 3 + 1] = tmp[1];
        xyz[(o + i) * 3 + 2] = tmp[2];
      }
      o += n;
    }
    this.coastXYZ = xyz;
    this.coastMeta = meta;

    // Pre-convert the rotation series to quaternions, again once.
    this.quats = new Map();
    for (const [plate, series] of Object.entries(data.rotations)) {
      this.quats.set(plate, series.map(
        ([lon, lat, ang]) => quatFromPoleAngle(lon, lat, ang)));
    }
  }

  /* ---- state ------------------------------------------------------------ */

  set(state) {
    Object.assign(this.state, state);
    return this;
  }

  addOverlay(fn) {
    this.overlays.push(fn);
    return this;
  }

  /* ---- projection helpers used by overlays ------------------------------ */

  /** Project lon/lat to overlay canvas coords. Returns null if over the horizon
   *  (meaningless for Robinson, which has no horizon -- every lon/lat lands
   *  somewhere, though it may fall outside the projection's own oval outline;
   *  see projectVec3() for that boundary test). */
  project(lonDeg, latDeg) {
    if (this.projection === 'orthographic') {
      lonLatToVec3(lonDeg, latDeg, this._pt);
      return this.projectVec3(this._pt);
    }

    if (this.projection === 'robinson') {
      const [x, y] = robinsonForward(lonDeg, latDeg, this.state.lon ?? 0);
      return [this.cx + x * this._robinsonR, this.cy - y * this._robinsonR];
    }

    // Use Spilhaus projection for the Southern Ocean view
    const result = spilhausForward(lonDeg, latDeg);
    if (!result) return null;

    const [x, y] = result;
    // Scale and center for display
    const scale = this.radius * 0.5;  // Adjust scale to fit the view
    return [this.cx + x * scale, this.cy - y * scale];
  }

  /** Robinson only: project a longitude DELTA already known to be safe (see
   *  robinsonForwardDelta's own comment) instead of an absolute longitude to be
   *  re-derived and re-wrapped. Used by an antimeridian-split
   *  ring/line pieces, which must not have their already-correct delta undone. */
  projectDelta(dLonDeg, latDeg) {
    const [x, y] = robinsonForwardDelta(dLonDeg, latDeg);
    return [this.cx + x * this._robinsonR, this.cy - y * this._robinsonR];
  }

  /**
   * Orthographic projection of a unit vector, for overlays that keep their own
   * pre-converted vertex arrays. Returns [x, y, depth] with depth > 0 on the
   * visible hemisphere, or null behind the horizon -- an exact test, since depth
   * is just the component along the view direction.
   */
  /**
   * A deep-time-map projector view of this globe.
   *
   * The library's interface is project(vec3); Globe already has a project(lon, lat)
   * with different semantics, so the adapter keeps both without either shadowing the
   * other. Memoised because layers ask for it every frame.
   */
  get projector() {
    if (!this._projector) {
      const globe = this;
      this._projector = {
        project: (v) => globe.projectVec3(v),
        // Filled layers need the view axis to close a shape along the limb; everything
        // else can ignore it. Read live rather than captured, since render() rebuilds
        // the view matrix every frame. Robinson has no horizon to close a shape
        // against, so it reports no axis at all -- polygons.js's own fallback for
        // that ("no axis: behaves like a polyline") still fills every projectable
        // vertex, it just skips the horizon-specific visibility culling and
        // limb-clamping that only make sense for a camera projection.
        get axis() {
          if (globe.projection === 'robinson') return undefined;
          return [globe._view[6], globe._view[7], globe._view[8]];
        },
        get cx() { return globe.cx; },
        get cy() { return globe.cy; },
        get radius() { return globe.radius; },
      };
    }
    return this._projector;
  }

  projectVec3(v) {
    if (this.projection === 'robinson') {
      const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
      const lon = Math.atan2(v[1], v[0]) / DEG;
      const [x, y] = robinsonForward(lon, lat, this.state.lon ?? 0);
      // No horizon in Robinson -- depth is only ever consumed as a >0 visibility
      // test elsewhere, so a constant stands in for "always in front".
      return [this.cx + x * this._robinsonR, this.cy - y * this._robinsonR, 1];
    }

    const m = this._view;
    const depth = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
    if (depth <= 0) return null;
    return [
      this.cx + (m[0] * v[0] + m[1] * v[1] + m[2] * v[2]) * this.radius,
      this.cy - (m[3] * v[0] + m[4] * v[1] + m[5] * v[2]) * this.radius,
      depth,
    ];
  }

  get geometry() {
    return { cx: this.cx, cy: this.cy, radius: this.radius };
  }

  /* ---- rotations -------------------------------------------------------- */

  _plateMatrices(age) {
    const times = this.coast.times;
    const clamped = Math.max(times[0], Math.min(times[times.length - 1], age));

    // Bracketing 1 Myr steps, then slerp: motion between steps follows the
    // great circle traced by the Euler rotation, not a lon/lat shortcut.
    let i = Math.floor(clamped);
    if (i >= times.length - 1) i = times.length - 2;
    const t = clamped - times[i];

    this._plateMat.clear();
    for (const [plate, series] of this.quats) {
      const q = quatSlerp(series[i], series[i + 1], t, this._q);
      quatToMat3(q, this._m);
      // Fold the camera in now so each vertex needs one matrix multiply, not two.
      this._plateMat.set(plate, mat3Multiply(this._view, this._m,
        new Float64Array(9)));
    }
  }

  /* ---- render ----------------------------------------------------------- */

  render() {
    const { age, lon, lat, zoom, opacity } = this.state;

    this.radius = Math.min(this.cssWidth, this.cssHeight) * 0.42 * zoom;
    this.cx = this.cssWidth / 2;
    this.cy = this.cssHeight / 2;

    if (this.projection === 'orthographic') {
      viewMatrix(lon, lat, this._view);
    } else if (this.projection === 'robinson') {
      // No camera matrix -- Robinson has no tilt, only a pannable central
      // meridian, read directly off state.lon by project()/projectVec3(). This
      // is the scale factor that makes a full 180 degrees of longitude at the
      // equator span `this.radius` pixels, so Robinson and orthographic read as
      // comparably sized when a page toggles between them.
      this._robinsonR = this.radius / (ROBINSON_XSCALE * Math.PI);
    } else {
      // Spilhaus projection center is fixed at 71°S, 142°E
      // But allow override for different views
      const spilhausLon = lon !== undefined ? lon : 142;
      const spilhausLat = lat !== undefined ? lat : -71;
      spilhausViewMatrix(spilhausLon, spilhausLat, this._view);
    }
    this._renderRaster(age, opacity);
    this._renderOverlay(age);
  }

  _renderRaster(age, opacity) {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.frames.length) return;

    // Bracketing texture frames, so the paleogeography cross-fades rather than
    // jumping between the 5 Myr maps.
    let i = 0;
    while (i < this.frames.length - 1 && this.frames[i + 1].age <= age) i++;
    const a = this.frames[i];
    const b = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const span = b.age - a.age;
    const mix = span > 0 ? Math.max(0, Math.min(1, (age - a.age) / span)) : 0;

    this._loadTexture(a);
    this._loadTexture(b);
    const ta = this.textures.get(a.age)?.tex || this.blankTex;
    const tb = this.textures.get(b.age)?.tex || ta;

    const m = this._view;
    const { prog, uniforms: u, attribLoc } = this._ensureProgram(this.projection);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(attribLoc);
    gl.vertexAttribPointer(attribLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(u.uTexA, 0);
    gl.uniform1i(u.uTexB, 1);
    gl.uniform2f(u.uCentre, this.cx * this.dpr,
      (this.cssHeight - this.cy) * this.dpr);
    gl.uniform1f(u.uRadius,
      (this.projection === 'robinson' ? this._robinsonR : this.radius) * this.dpr);
    gl.uniform3f(u.uEast, m[0], m[1], m[2]);
    gl.uniform3f(u.uNorth, m[3], m[4], m[5]);
    gl.uniform3f(u.uOut, m[6], m[7], m[8]);
    gl.uniform1f(u.uCenterLon, (this.state.lon ?? 0) * DEG);
    gl.uniform1f(u.uMix, mix);
    gl.uniform1f(u.uOpacity, opacity ?? 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ta);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tb);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _renderOverlay(age) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    if (this.coast) {
      this._plateMatrices(age);
      this._drawCoastlines(age);
    }
    for (const fn of this.overlays) fn(ctx, this, age);
  }

  _drawCoastlines(age) {
    const ctx = this.ctx;
    const xyz = this.coastXYZ;
    const R = this.radius;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.9;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    for (const f of this.coastMeta) {
      if (age > f.begin || age < f.end) continue;
      const m = this._plateMat.get(f.plate);
      if (!m) continue;

      // The plate's rotation already has the camera folded into it, so a coastline
      // vertex needs one matrix multiply and no trigonometry. One closure per feature,
      // not per vertex.
      const project = (v) => {
        const depth = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
        if (depth <= 0) return null;
        return [
          this.cx + (m[0] * v[0] + m[1] * v[1] + m[2] * v[2]) * R,
          this.cy - (m[3] * v[0] + m[4] * v[1] + m[5] * v[2]) * R,
          depth,
        ];
      };

      // Closed rings repeat their first vertex so the outline joins up.
      tracePolyline(ctx, project, xyz, f.offset, f.count, { closed: f.closed });
    }
    ctx.stroke();
    ctx.restore();
  }
}
