import type { ResolvedTheme } from './theme';
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial,
} from 'three';
import {
  DEG, EARTH_RADIUS_KM, R_SURFACE, eastNorthAt, lonLatToVec3, vec3ToLonLat, wrapLon,
} from './constants';
import {
  flatDirection, lonLatToFlatVec3, referencePlateProjectedPosition, type ProjectionMode,
} from './projection';
import { texelIndex, texelToPhysical } from './volume';
import { rotateVector, type Quaternion } from './rotation';
import type { VariableInfo } from './types';

const IDENTITY_QUAT: Quaternion = [0, 0, 0, 1];

// Same clearance reasoning as windGlyphs.ts's GLYPH_R -- just clear of the
// overlay sphere so there is no z-fighting concern.
const RIBBON_R = R_SURFACE * 1.001;
// The Plate Carrée equivalent, same derivation as windGlyphs.ts's FLAT_GLYPH_Z.
const FLAT_RIBBON_Z = RIBBON_R - R_SURFACE;

// Trail points per particle -- the ring buffer DEPTH, not a time duration by
// itself. How much real time a trail visually spans is TRAIL_LEN *
// RECORD_INTERVAL_S (below), since a fresh ring slot is only committed on
// that slower cadence, not every animation frame -- see advect()'s doc
// comment for why a per-frame commit (~12 frames = ~0.2s at 60fps) would be
// far too short a trail to read as a streak at all.
const TRAIL_LEN = 12;
const INDICES_PER_PARTICLE = (TRAIL_LEN - 1) * 6; // 2 triangles per segment
// ~1.5s of visible trail (TRAIL_LEN * RECORD_INTERVAL_S) against a 6s
// particle lifetime -- a trail that is a large minority, not the whole, of
// how long a particle lives, tuned by eye alongside STREAK_SPEED_SCALE.
const RECORD_INTERVAL_S = 0.125;

// setDensity()'s allowed range and the count at density=1 -- same
// "allocate for the densest setting, draw fewer via a range" pattern as
// WindGlyphs' InstancedMesh.count, but via BufferGeometry.setDrawRange()
// since this isn't instanced geometry (each particle's ribbon has its own
// vertices, not a shared mesh repeated by a per-instance matrix).
const BASE_PARTICLES = 2000;
const MIN_DENSITY = 0.5;
const MAX_DENSITY = 3;
const MAX_PARTICLES = Math.round(BASE_PARTICLES * MAX_DENSITY);

// Seconds a particle lives before respawning elsewhere. Finite lifetime +
// respawn (rather than particles living forever) keeps coverage even: wind
// continuously concentrates real air (and, without this, particles) toward
// convergence zones like the ITCZ while divergent regions empty out.
const PARTICLE_LIFETIME_S = 6;
const BASE_HALF_WIDTH = 0.0025; // ribbon half-width in scene units at size=1
// m/s beyond which colour stops getting brighter -- same "one outlier
// shouldn't wash out the whole scale" reasoning as windGlyphs.ts's own
// SPEED_CLIP_MS, independently tunable since it drives colour here, not length.
const SPEED_CLIP_MS = 20;

// Real wind speeds take DAYS to circle the globe -- a 10 m/s wind against
// EARTH_RADIUS_KM=6371 needs ~7 days to circumnavigate, which is invisible
// over a several-second trail lifetime. This is a deliberate artistic time
// compression, the same thing the Godot prototype's `speed: 50.0` and the
// real NASA/earth.nullschool renderings do -- tuned by eye (see README) so a
// ~10 m/s particle sweeps roughly 10-20 degrees of arc over its lifetime,
// not derived from anything physical.
const STREAK_SPEED_SCALE = 45000;
const EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000;

/** The rampFlow role's two ends. Instance state, not module constants: two
 *  wrappers can show different Themes at once (see the theme lab), and a
 *  module-level colour is shared by every instance in the page. Seeded to the
 *  default Theme's own rampFlow so a wrapper that never calls applyTheme()
 *  still renders. */
const DEFAULT_FLOW_RAMP: [number, number] = [0x1f5c7a, 0xeaffff];

/** Static (built once) index buffer: 2 triangles per trail segment, for
 *  every particle slot up to MAX_PARTICLES. Vertex data changes every tick;
 *  this topology never does, so it's built once and reused, mirroring how
 *  WindGlyphs' geometry is built once and only its instance matrices move. */
function buildIndex(): Uint32Array {
  const idx = new Uint32Array(MAX_PARTICLES * INDICES_PER_PARTICLE);
  let o = 0;
  for (let p = 0; p < MAX_PARTICLES; p++) {
    const base = p * TRAIL_LEN * 2;
    for (let i = 0; i < TRAIL_LEN - 1; i++) {
      const l0 = base + i * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      idx[o++] = l0; idx[o++] = r0; idx[o++] = l1;
      idx[o++] = r0; idx[o++] = r1; idx[o++] = l1;
    }
  }
  return idx;
}

/**
 * A "Perpetual Ocean"-style particle flow field -- generic, no
 * paleoclimate-specific knowledge, sibling to WindGlyphs (see
 * docs/adr/0002-world-space-trail-ribbons-for-wind-flow.md for why this
 * exists as a distinct mode rather than an option on WindGlyphs).
 *
 * Each particle advects along a STATIC (u, v) snapshot -- whichever plane
 * the caller passes to update() -- leaving a fading, tapered ribbon of its
 * last TRAIL_LEN surface positions, fixed in world space so it survives
 * camera orbiting (ADR-0002). Particle state lives in flat typed arrays,
 * not objects, and the per-particle advection step is a self-contained
 * piece of the update loop below -- the seam a future GPU
 * (GPUComputationRenderer) version would replace, without touching how the
 * resulting positions become ribbon geometry.
 */
export class WindStreaks {
  /** The active speed ramp's two ends. See DEFAULT_FLOW_RAMP for why these are
   *  per-instance rather than module constants. */
  private calmColor = new Color(DEFAULT_FLOW_RAMP[0]);
  private fastColor = new Color(DEFAULT_FLOW_RAMP[1]);

  /** Re-colour to a Theme. Only the ramp is claimed here; positions, lifetimes
   *  and seeding are untouched, so a Theme switch never disturbs an animation
   *  already in flight. */
  applyTheme(theme: ResolvedTheme): void {
    this.calmColor.setHex(theme.rampFlow[0]);
    this.fastColor.setHex(theme.rampFlow[1]);
  }

  readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;

  // Per-particle state, indexed 0..MAX_PARTICLES-1. Only the first
  // activeCount are advected/drawn -- see setDensity().
  private readonly lon: Float32Array;
  private readonly lat: Float32Array;
  private readonly age: Float32Array; // seconds remaining until respawn
  private readonly speed: Float32Array; // most recent |wind|, m/s, for colour
  private readonly cursor: Uint8Array; // ring-buffer write position, 0..TRAIL_LEN-1
  private readonly trail: Float32Array; // MAX_PARTICLES * TRAIL_LEN * 3 (xyz)

  private activeCount = BASE_PARTICLES;
  private sizeScale = 1;
  private mode: ProjectionMode = 'globe';
  /** Reference Plate rotation, already in the render frame (see
   *  core/rotation.ts's toRenderFrameRotation, docs/adr/0030). Applied only
   *  to `trail`'s stored RENDER positions (respawn()/advect()), never to
   *  `lon`/`lat` (the advection STATE, which must stay physical -- the field
   *  itself is never reconstructed, ADR-0001).
   *
   *  Updated via a plain assignment (setReferenceRotation()), NOT a forced
   *  resetAll() -- this value is age-dependent (see referenceRotationAt()),
   *  so it changes on every ordinary age-slider tick, not just when the
   *  user picks a new Reference Plate. Forcing a full reset on every tick
   *  would flicker-reset the whole streak animation while scrubbing; the
   *  caller (ClimateInstance) is responsible for calling resetAll() itself
   *  on the discrete "Reference Plate actually changed" action, where a
   *  clean break is the right call (same "clear rather than mis-draw"
   *  precedent as setProjection()) -- a small kink from gradual rotation
   *  drift during scrubbing is far less noticeable than a reset every tick. */
  private qRef: Quaternion = IDENTITY_QUAT;
  /** Seconds accumulated since the trail ring buffers last advanced to a
   *  fresh slot -- see update()'s `commit` flag and advect()'s doc comment
   *  for why this is decoupled from the per-frame advection step. */
  private recordAccum = 0;

  constructor() {
    this.geometry = new BufferGeometry();
    const posArray = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 2 * 3);
    const colArray = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 2 * 4);
    this.positions = posArray;
    this.colors = colArray;
    this.geometry.setAttribute('position', new BufferAttribute(posArray, 3));
    this.geometry.setAttribute('color', new BufferAttribute(colArray, 4));
    this.geometry.setIndex(new BufferAttribute(buildIndex(), 1));
    this.geometry.setDrawRange(0, this.activeCount * INDICES_PER_PARTICLE);

    // depthWrite: false avoids z-fighting artefacts between many
    // overlapping translucent ribbons; side: DoubleSide because a ribbon's
    // winding flips with its travel direction and there is no lighting here
    // to make winding otherwise matter.
    const mat = new MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide,
    });
    this.mesh = new Mesh(this.geometry, mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // particles range over the whole globe every frame

    this.lon = new Float32Array(MAX_PARTICLES);
    this.lat = new Float32Array(MAX_PARTICLES);
    this.age = new Float32Array(MAX_PARTICLES);
    this.speed = new Float32Array(MAX_PARTICLES);
    this.cursor = new Uint8Array(MAX_PARTICLES);
    this.trail = new Float32Array(MAX_PARTICLES * TRAIL_LEN * 3);

    // Seed every slot up front (not lazily on density increase -- it's
    // cheap and this way setDensity() never needs a special first-activation
    // branch). bulk=true here for the same reason as resetAll(): see
    // respawn()'s doc comment.
    for (let p = 0; p < MAX_PARTICLES; p++) this.respawn(p, true);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  setSize(scale: number): void {
    this.sizeScale = scale;
  }

  setDensity(density: number): void {
    const clamped = Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, density));
    this.activeCount = Math.min(MAX_PARTICLES, Math.round(BASE_PARTICLES * clamped));
    this.geometry.setDrawRange(0, this.activeCount * INDICES_PER_PARTICLE);
  }

  /** Switch which advection/ribbon math update() uses -- see advect() and
   *  writeRibbon()'s own mode branches. Every particle's trail is world
   *  positions baked under the OLD Projection's embedding, meaningless once
   *  the embedding changes, so this forces a full resetAll() rather than
   *  letting stale trails draw one wrong-looking frame before self-healing. */
  setProjection(mode: ProjectionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.resetAll();
  }

  /** See `qRef`'s own doc comment -- no reset here; call resetAll()
   *  separately for a discrete Reference Plate change. */
  setReferenceRotation(q: Quaternion): void {
    this.qRef = q;
  }

  /** Respawn every active particle at a fresh random position -- used when
   *  the mode becomes visible again after being hidden, so stale state (and
   *  the large dt that hiding accumulates) never produces a single huge,
   *  wrong-looking jump on the next update(). bulk=true, same reasoning as
   *  the constructor's cold-start seeding -- see respawn()'s doc comment.
   *
   *  Follows every respawn with an immediate FULL writeRibbon() -- respawn()
   *  resets the logical trail buffer, but the actual GPU-visible ribbon
   *  vertices only get rebuilt inside update()'s per-particle loop, and only
   *  in full mode when `commit || justRespawned`. Called from outside that
   *  loop, resetAll() is invisible to both flags: the NEXT ordinary
   *  update() tick sees an unremarkable in-progress particle (age just set
   *  to a fresh positive value, so it won't hit the age<=0 branch) and, most
   *  frames, does a PARTIAL rebuild -- only the head vertex, leaving the
   *  other 11 trail points holding stale pre-reset positions. A ribbon
   *  connecting a fresh head to a stale tail is a real glitch, not a cosmetic
   *  one: it's most dramatic exactly when this resets into a different
   *  Projection (setProjection(), above), where "stale" means a wildly
   *  different coordinate space, not just a different point on the same
   *  sphere -- every streak flashes the full width of the screen for the
   *  ~1.5s (TRAIL_LEN * RECORD_INTERVAL_S) it takes commit cycles to walk
   *  the ring buffer back to consistency on their own. */
  resetAll(): void {
    for (let p = 0; p < this.activeCount; p++) {
      this.respawn(p, true);
      this.writeRibbon(p, true);
    }
  }

  /** Uniform-area random respawn: `lat` must be drawn via asin(uniform(-1,1)),
   *  NOT a uniform draw over [-90, 90] -- the latter clusters samples toward
   *  the poles, because the area a degree of latitude covers shrinks by
   *  cos(lat) away from the equator.
   *
   *  `age` is NEVER reset to one fixed value, in either branch -- an
   *  earlier version reset every ordinary respawn to exactly
   *  PARTICLE_LIFETIME_S, on the reasoning that only the very first
   *  cold-start seeding needed randomisation and a fixed reset afterwards
   *  would preserve each particle's already-staggered phase forever. That
   *  reasoning missed a real failure mode: a single large `dt` in one
   *  frame (a layer/age/variable switch stalling the main thread for a
   *  moment) can push MANY particles' remaining age below zero in the SAME
   *  tick. Resetting all of them to the same fixed value phase-locked that
   *  whole cohort together -- and since every particle shares the same
   *  `dt` on every later tick, they stayed locked forever after, visibly
   *  worse the longer the page ran as more cohorts got caught by more
   *  hitches. resetAll() had the same bug in its own right: switching Wind
   *  Streak back to visible reset the ENTIRE active set to one fixed age
   *  at once, no hitch required.
   *
   *  `bulk` (cold-start seeding and resetAll(), reseeding a large
   *  population that needs to look staggered from frame one) draws
   *  uniformly over the FULL lifetime. An ordinary mid-simulation respawn
   *  (one particle at a time, already part of an established, staggered
   *  population) instead jitters +-30% around the full lifetime, not the
   *  full [0, lifetime) spread -- that keeps the mean respawn rate/trail
   *  quality where it was tuned, while still self-healing: even particles
   *  caught together by the same dt-spike or resetAll() immediately
   *  re-scatter into different phases rather than staying locked. */
  private respawn(p: number, bulk: boolean): void {
    const lat = Math.asin(Math.random() * 2 - 1) / DEG;
    const lon = Math.random() * 360 - 180;
    this.lat[p] = lat;
    this.lon[p] = lon;
    this.age[p] = bulk
      ? PARTICLE_LIFETIME_S * Math.random()
      : PARTICLE_LIFETIME_S * (0.7 + 0.6 * Math.random());
    this.speed[p] = 0;

    let x: number; let y: number; let z: number;
    if (this.mode === 'globe') {
      const [x0, y0, z0] = lonLatToVec3(lon, lat, RIBBON_R);
      [x, y, z] = rotateVector(this.qRef, x0, y0, z0);
    } else {
      // referencePlateProjectedPosition, not a direct rotateVector of the flat
      // Cartesian position -- see its own doc comment and
      // docs/plans/reference-plate.md's "Known issue" postmortem.
      [x, y, z] = referencePlateProjectedPosition(this.mode, lon, lat, this.qRef, FLAT_RIBBON_Z);
    }
    for (let k = 0; k < TRAIL_LEN; k++) {
      const base = (p * TRAIL_LEN + k) * 3;
      this.trail[base] = x; this.trail[base + 1] = y; this.trail[base + 2] = z;
    }
    this.cursor[p] = 0;
  }

  /** uData/vData: ONE month's plane, nlon*nlat bytes each, lon-fastest --
   *  see WindGlyphs.update()'s own doc comment; the two share the exact
   *  same plane-decoding contract. dtSeconds is real wall-clock time since
   *  the last tick (see STREAK_SPEED_SCALE for why it is NOT applied 1:1
   *  to physical wind speed). */
  /** `speedScale`: VectorFieldInfo.display_speed_scale, forwarded to
   *  advect() -- see windGlyphs.ts's update() doc comment and the field's
   *  own definition for why this exists (ocean currents need one, wind
   *  doesn't). 1 (its default) is a no-op. */
  update(
    dtSeconds: number,
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo, sentinel?: number, speedScale = 1,
  ): void {
    const dt = Math.min(dtSeconds, 0.25); // guard a tab-backgrounded huge dt spike
    this.recordAccum += dt;
    const commit = this.recordAccum >= RECORD_INTERVAL_S;
    if (commit) this.recordAccum -= RECORD_INTERVAL_S;

    for (let p = 0; p < this.activeCount; p++) {
      this.age[p] -= dt;
      let justRespawned = false;
      if (this.age[p] <= 0) {
        this.respawn(p, false);
        justRespawned = true;
      } else {
        // Plate Carrée: advect() can ALSO trigger a mid-step respawn, when a
        // particle crosses the antimeridian seam -- see its own doc comment.
        justRespawned = this.advect(
          p, dt, uData, vData, nlon, nlat, uVar, vVar, commit, sentinel, speedScale,
        );
      }
      // A respawn touches every trail slot (see respawn()'s doc comment),
      // so it needs the full rebuild below regardless of `commit`.
      this.writeRibbon(p, commit || justRespawned);
    }

    // Buffers are allocated for MAX_PARTICLES (setDensity()'s capacity, see
    // the constructor), but plain needsUpdate=true re-uploads the WHOLE
    // buffer to the GPU regardless of activeCount -- at density=1 that is
    // 3x more data transferred every frame than is actually active.
    // addUpdateRange() scopes the upload to just the active particles'
    // vertices, which are always the first activeCount (setDensity() never
    // reorders particles, only changes how many of the leading ones count).
    const activeFloats3 = this.activeCount * TRAIL_LEN * 2 * 3;
    const activeFloats4 = this.activeCount * TRAIL_LEN * 2 * 4;
    const posAttr = this.geometry.attributes.position as BufferAttribute;
    const colAttr = this.geometry.attributes.color as BufferAttribute;
    posAttr.clearUpdateRanges();
    posAttr.addUpdateRange(0, activeFloats3);
    posAttr.needsUpdate = true;
    colAttr.clearUpdateRanges();
    colAttr.addUpdateRange(0, activeFloats4);
    colAttr.needsUpdate = true;
  }

  /** The advection step, isolated from ribbon-building on either side of it
   *  (see the class doc comment): sample (u, v) at the particle's current
   *  position, take one small step along the local tangent plane, and
   *  re-derive lon/lat for the next tick's lookup.
   *
   *  On the globe, steps stay small (dt is one animation frame), which is
   *  what makes "step then renormalise onto the sphere" a valid substitute
   *  for exact geodesic integration -- the flat Godot prototype's plain
   *  `position += velocity * dt` has no sphere to renormalise onto and
   *  cannot be reused as-is.
   *
   *  On Plate Carrée, a step needs no such approximation -- a flat plane has
   *  no curvature to renormalise onto, so `position += velocity * dt` IS
   *  exact there. But the map has a real seam at the antimeridian the
   *  sphere doesn't: wrapping longitude across it would draw one ribbon
   *  segment stretching across the whole map width, since the trail's
   *  previous and new points would be geometrically far apart in world
   *  space despite being physically adjacent on the map. Respawning
   *  immediately on a crossing avoids that glitch rather than trying to
   *  split the ribbon; returns whether that happened, so update() can
   *  extend the same `justRespawned` full-rebuild treatment to it.
   *  Latitude has no such seam (it's a real edge, not a wraparound), so it's
   *  simply clamped -- a particle can't walk off the top/bottom of the map,
   *  and finite particle lifetime recycles it elsewhere within seconds
   *  regardless. */
  /** `sentinel`: the model's NO-DATA byte (see WindGlyphs.update()'s own
   *  doc comment for why Ocean Surface Current/Sea-Ice Drift need this and
   *  Wind never has). A particle currently sitting over a sentinel texel
   *  (freshly respawned there, or drifted there) gets re-respawned instead
   *  of advecting from a decoded garbage velocity -- up to 8 tries, which
   *  converges quickly against BRIDGE's ~40% ocean-only land fraction; a
   *  particle that still lands on a sentinel cell after 8 tries is left in
   *  place rather than looping forever, and simply retries again next tick
   *  (it advects with zero real motion in the meantime, not a wrong one --
   *  see the early return below skipping the decode/step entirely). */
  private advect(
    p: number, dt: number,
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo,
    commit: boolean, sentinel?: number, speedScale = 1,
  ): boolean {
    if (sentinel !== undefined) {
      let texel = texelIndex(nlon, nlat, this.lon[p], this.lat[p]);
      if (uData[texel] === sentinel || vData[texel] === sentinel) {
        for (let tries = 0; tries < 8; tries++) {
          this.respawn(p, false);
          texel = texelIndex(nlon, nlat, this.lon[p], this.lat[p]);
          if (uData[texel] !== sentinel && vData[texel] !== sentinel) break;
        }
        return true;
      }
    }
    const lon = this.lon[p];
    const lat = this.lat[p];
    const texel = texelIndex(nlon, nlat, lon, lat);
    const u = texelToPhysical(uVar, uData[texel]) * speedScale;
    const v = texelToPhysical(vVar, vData[texel]) * speedScale;
    this.speed[p] = Math.hypot(u, v);
    const step = (dt * STREAK_SPEED_SCALE) / EARTH_RADIUS_M;

    // rx/ry/rz are the RENDER (Reference-Plate-rotated) point this tick
    // commits to the trail -- Globe gets there by rotating the true sphere
    // point directly (rotateVector), a flat map by
    // referencePlateProjectedPosition's round-trip through the sphere, never by
    // rotating the flat plane's own Cartesian point directly (see that
    // function's doc comment and docs/plans/reference-plate.md's "Known issue"
    // postmortem).
    let rx: number; let ry: number; let rz: number;
    if (this.mode === 'globe') {
      const { east, north } = eastNorthAt(lon, lat);
      const [px, py, pz] = lonLatToVec3(lon, lat, RIBBON_R);
      let nx = px + (u * east[0] + v * north[0]) * step;
      let ny = py + (u * east[1] + v * north[1]) * step;
      let nz = pz + (u * east[2] + v * north[2]) * step;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx = (nx / len) * RIBBON_R; ny = (ny / len) * RIBBON_R; nz = (nz / len) * RIBBON_R;
      const next = vec3ToLonLat(nx, ny, nz);
      this.lon[p] = next.lon;
      this.lat[p] = next.lat;
      [rx, ry, rz] = rotateVector(this.qRef, nx, ny, nz);
    } else {
      // Advection itself is Projection-independent: the Plate Carrée round
      // trip here cancels, leaving "advance (lon, lat) by (u, v) * step". Only
      // the DISPLAY position below is per-Projection, which is why this half
      // is unchanged for Robinson while the line after it is not.
      const [px, py] = lonLatToFlatVec3(lon, lat);
      const nextLon = wrapLon((px + u * step) / (DEG * R_SURFACE));
      if (Math.abs(nextLon - lon) > 180) {
        this.respawn(p, false);
        return true;
      }
      const nextLat = Math.max(-90, Math.min(90, (py + v * step) / (DEG * R_SURFACE)));
      this.lon[p] = nextLon;
      this.lat[p] = nextLat;
      [rx, ry, rz] = referencePlateProjectedPosition(this.mode, nextLon, nextLat, this.qRef, FLAT_RIBBON_Z);

      // The check above catches a seam crossing in the TRUE (unrotated)
      // frame, which is all that mattered before Reference Plate existed.
      // A non-zero Reference Plate can put the antimeridian at a different
      // TRUE longitude than the map's own fixed DISPLAY edges (see
      // docs/plans/reference-plate.md), so a step that stays well clear of
      // the TRUE seam can still land its DISPLAY position on the opposite
      // edge from where this particle's trail was last drawn -- comparing
      // against the previously committed point's own DISPLAY x, not the
      // TRUE lon, is what actually determines whether the ribbon segment
      // about to be drawn would span the map. Same defensive respawn as
      // the TRUE-frame check.
      const prevX = this.trail[(p * TRAIL_LEN + this.cursor[p]) * 3];
      if (Math.abs(rx - prevX) > Math.PI * R_SURFACE) {
        this.respawn(p, false);
        return true;
      }
    }

    // Advection runs every frame so the HEAD moves smoothly, but committing
    // a new ring-buffer slot every frame would make the trail span only
    // TRAIL_LEN frames (~0.2s at 60fps) of real time -- far too short to
    // read as a streak. Instead the current slot is simply overwritten each
    // frame until `commit` (driven by a slower cadence in update(), see
    // RECORD_INTERVAL_S) says to advance to a fresh slot -- see writeRibbon
    // and its call site.
    const c = commit ? (this.cursor[p] + 1) % TRAIL_LEN : this.cursor[p];
    this.cursor[p] = c;
    const base = (p * TRAIL_LEN + c) * 3;
    this.trail[base] = rx; this.trail[base + 1] = ry; this.trail[base + 2] = rz;
    return false;
  }

  /** Walk one particle's trail ring in chronological order (oldest to
   *  newest) and write its ribbon's vertex positions and colours. Width and
   *  alpha both taper toward the tail (ADR-0002's "fading, tapered ribbon");
   *  colour is speed-tinted by whatever the particle's speed was AT THE TIME
   *  each point committed (see below), not repainted retroactively.
   *
   *  Performance: k=TRAIL_LEN-1 (the head, see the ring-index formula below)
   *  is the only point that moves on a non-commit frame -- advect() only
   *  overwrites the current cursor slot, and every OTHER trail point's
   *  ring index is unchanged until the cursor itself advances. So a
   *  non-commit tick only recomputes that one vertex pair rather than
   *  redoing the whole TRAIL_LEN loop; this is what keeps the per-frame CPU
   *  cost proportional to particle count rather than particle count *
   *  TRAIL_LEN for the common (7 out of 8, at RECORD_INTERVAL_S=0.125s and
   *  60fps) case. `full` forces the whole loop: on a commit (the ring index
   *  mapping shifts for every k) or a respawn (every trail slot changed). */
  private writeRibbon(p: number, full: boolean): void {
    const c = this.cursor[p];
    const halfWidth = BASE_HALF_WIDTH * this.sizeScale;
    const t = Math.min(this.speed[p], SPEED_CLIP_MS) / SPEED_CLIP_MS;
    const calm = this.calmColor;
    const fast = this.fastColor;
    const r = calm.r + (fast.r - calm.r) * t;
    const g = calm.g + (fast.g - calm.g) * t;
    const b = calm.b + (fast.b - calm.b) * t;

    for (let k = full ? 0 : TRAIL_LEN - 1; k < TRAIL_LEN; k++) {
      const ringIdx = (c + 1 + k) % TRAIL_LEN; // k=0 oldest (tail) .. k=TRAIL_LEN-1 newest (head)
      const base = (p * TRAIL_LEN + ringIdx) * 3;
      const x = this.trail[base]; const y = this.trail[base + 1]; const z = this.trail[base + 2];

      // Central difference for an interior direction estimate; one-sided at
      // the ends of the ring's chronological order (not the ring's raw
      // index order, which wraps arbitrarily).
      const kPrev = Math.max(0, k - 1);
      const kNext = Math.min(TRAIL_LEN - 1, k + 1);
      const prevBase = (p * TRAIL_LEN + ((c + 1 + kPrev) % TRAIL_LEN)) * 3;
      const nextBase = (p * TRAIL_LEN + ((c + 1 + kNext) % TRAIL_LEN)) * 3;
      let dx = this.trail[nextBase] - this.trail[prevBase];
      let dy = this.trail[nextBase + 1] - this.trail[prevBase + 1];
      let dz = this.trail[nextBase + 2] - this.trail[prevBase + 2];
      const dirLen = Math.hypot(dx, dy, dz);
      // Degenerate (freshly spawned or perfectly calm): fall back to the
      // local east direction rather than propagate a NaN from normalising
      // a zero vector -- it self-corrects within a few ticks as the
      // particle actually moves.
      if (dirLen < 1e-9) {
        const east = this.mode === 'globe'
          ? eastNorthAt(this.lon[p], this.lat[p]).east
          // Not a constant +x: east IS +x on Plate Carrée and on Robinson
          // (whose parallels are straight and horizontal), but asking
          // flatDirection keeps this correct for a flat projection where it
          // isn't, and costs nothing on a path that only runs for a calm or
          // freshly-spawned particle.
          : flatDirection(this.mode, this.lon[p], this.lat[p], 1, 0);
        // eastNorthAt returns a unit vector but flatDirection returns a raw
        // probe difference, and the branch below leaves dx/dy/dz expected to
        // be unit length -- the cross product further down collapses the
        // ribbon to nothing if they aren't.
        const el = Math.hypot(east[0], east[1], east[2]) || 1;
        dx = east[0] / el; dy = east[1] / el; dz = east[2] / el;
      } else {
        dx /= dirLen; dy /= dirLen; dz /= dirLen;
      }

      // Perpendicular to travel direction, in the local tangent plane. On
      // the globe that plane's normal is the position itself (radial =
      // outward from a sphere centred on the origin), which is what keeps
      // the ribbon lying flush against the surface regardless of camera
      // angle -- the same tangent-frame reasoning WindGlyphs uses for arrow
      // orientation. Plate Carrée's tangent plane is the SAME everywhere
      // (the flat plane itself), so its normal is the constant +Z rather
      // than a position-dependent radial direction.
      let rx: number; let ry: number; let rz: number;
      if (this.mode === 'globe') {
        const rl = Math.hypot(x, y, z) || 1;
        rx = x / rl; ry = y / rl; rz = z / rl;
      } else {
        rx = 0; ry = 0; rz = 1;
      }
      let sx = dy * rz - dz * ry;
      let sy = dz * rx - dx * rz;
      let sz = dx * ry - dy * rx;
      const sLen = Math.hypot(sx, sy, sz) || 1;
      const fade = k / (TRAIL_LEN - 1); // 0 at tail, 1 at head
      const w = (halfWidth * fade) / sLen;
      sx *= w; sy *= w; sz *= w;

      const vBase = (p * TRAIL_LEN + k) * 2; // 2 vertices (left, right) per trail point
      const posL = vBase * 3;
      const posR = posL + 3;
      this.positions[posL] = x + sx; this.positions[posL + 1] = y + sy; this.positions[posL + 2] = z + sz;
      this.positions[posR] = x - sx; this.positions[posR + 1] = y - sy; this.positions[posR + 2] = z - sz;

      const colL = vBase * 4;
      const colR = colL + 4;
      this.colors[colL] = r; this.colors[colL + 1] = g; this.colors[colL + 2] = b; this.colors[colL + 3] = fade;
      this.colors[colR] = r; this.colors[colR + 1] = g; this.colors[colR + 2] = b; this.colors[colR + 3] = fade;
    }
  }
}
