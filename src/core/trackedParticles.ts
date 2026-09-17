import type { ResolvedTheme } from './theme';
import { isFlat, type ProjectionMode } from './projection';
import {
  BufferAttribute, BufferGeometry, Color, Line, LineBasicMaterial, Object3D, Points, PointsMaterial,
} from 'three';
import {
  EARTH_RADIUS_KM, R_SURFACE, eastNorthAt, lonLatToVec3, vec3ToLonLat, type LonLat,
} from './constants';
import { texelIndex, texelToPhysical } from './volume';
import { rotateVector, type Quaternion } from './rotation';
import type { VariableInfo } from './types';

const IDENTITY_QUAT: Quaternion = [0, 0, 0, 1];

// Same clearance reasoning as windStreaks.ts's RIBBON_R, at a slightly
// different radius so a tracked path never z-fights the ambient ribbon
// overlay when both are visible over the same ground track.
const PATH_R = R_SURFACE * 1.0012;
const HEAD_SIZE = R_SURFACE * 0.018;
// Preallocated per-particle capacity -- see compact() for what happens once
// a long-running particle fills it, rather than growing this unboundedly.
const MAX_PATH_POINTS = 4000;
/** The rampTrack role's two ends -- deliberately distinct from windStreaks'
 *  rampFlow, because tracked particles and wind streaks are simultaneously
 *  visible in the Valdes and climate viewers and have to stay tellable apart.
 *  Instance state for the same reason as there. */
const DEFAULT_TRACK_RAMP: [number, number] = [0x2ea043, 0xe6ffe9];
// Same clip as windStreaks.ts's SPEED_CLIP_MS -- one outlier shouldn't wash
// out the colour ramp.
const SPEED_CLIP_MS = 20;
// Identical artistic time compression to windStreaks.ts's STREAK_SPEED_SCALE
// (see its own doc comment for the physical justification). A tracked
// particle rides the SAME animation clock as Vector Streak, so it has to
// move at the identical visual rate -- using a different constant here
// would make the two visibly disagree about "how fast the flow is" even
// though they sample the same field.
const STREAK_SPEED_SCALE = 45000;
const EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000;

interface Particle {
  lon: number;
  lat: number;
  /** True once this particle has landed on a no-data/masked texel -- frozen
   *  in place from then on, never advanced again. Unlike Vector Streak's
   *  ambient particles (which retry into a new random spot on the same
   *  event, see WindStreaks.advect()'s own doc comment), a tracked
   *  particle's position is user-chosen, so silently relocating it would
   *  defeat the point of having seeded it there. */
  stalled: boolean;
  positions: Float32Array; // MAX_PATH_POINTS * 3, chronological order [0, count)
  colors: Float32Array; // MAX_PATH_POINTS * 3, parallel to positions
  count: number;
  geometry: BufferGeometry;
  line: Line;
  head: Points;
}

/**
 * User-seeded particles that advect continuously through a live Vector
 * Field snapshot -- see docs/plans/tracked-particle-seeding.md. Sibling to
 * WindStreaks (core/windStreaks.ts), reusing its per-tick technique (sample
 * (u, v) at the current position, step along the local tangent plane,
 * renormalise onto the sphere) but inverting every one of the three choices
 * that make WindStreaks specifically an AMBIENT flow visualization:
 *
 *   - no finite lifetime or random respawn -- a tracked particle persists
 *     exactly where the user put it, indefinitely;
 *   - the FULL path is kept (bounded by MAX_PATH_POINTS + compact() below),
 *     not a short fading ring buffer -- the path itself is the answer to
 *     the "where does the flow starting here actually go" query;
 *   - particles are added one at a time by the user, not preallocated as a
 *     dense ambient cloud.
 *
 * The advection step is deliberately duplicated rather than shared with
 * WindStreaks -- the two modules' surrounding behaviour (lifetime, trail
 * depth, population shape) differs enough that factoring out just the
 * inner step would buy little while risking the existing, already-tuned
 * ambient visualization.
 *
 * Globe projection only for v1: Plate Carrée's antimeridian seam would need
 * each particle's path to split into a fresh stroke on every wrap (a
 * tracked particle can't just respawn elsewhere the way an ambient one
 * does) -- not designed yet, see docs/plans/tracked-particle-seeding.md.
 * setProjection() clears every particle on switching away from Globe rather
 * than draw them incorrectly.
 */
export class TrackedParticles {
  /** The active speed ramp's two ends. See DEFAULT_TRACK_RAMP for why these are
   *  per-instance rather than module constants. */
  private calmColor = new Color(DEFAULT_TRACK_RAMP[0]);
  private fastColor = new Color(DEFAULT_TRACK_RAMP[1]);

  /** Re-colour to a Theme. Only the ramp is claimed here; positions, lifetimes
   *  and seeding are untouched, so a Theme switch never disturbs an animation
   *  already in flight. */
  applyTheme(theme: ResolvedTheme): void {
    this.calmColor.setHex(theme.rampTrack[0]);
    this.fastColor.setHex(theme.rampTrack[1]);
  }

  readonly group = new Object3D();
  private readonly particles: Particle[] = [];
  /** Reference Plate rotation, already in the render frame (see
   *  core/rotation.ts's toRenderFrameRotation, docs/adr/0030). Applied to
   *  each particle's rendered position, never to `lon`/`lat` (the advection
   *  STATE sampled against the live Vector Field, which must stay physical).
   *
   *  Updated via a plain assignment, NOT a forced clear() -- this value is
   *  age-dependent, so it changes on every ordinary age-slider tick, not
   *  just when the user picks a new Reference Plate (see
   *  WindStreaks.qRef's identical reasoning). A particle's history recorded
   *  before a Reference Plate change keeps whatever rotation was in effect
   *  when each point was appended; only NEW points use the latest rotation.
   *  Acceptable for a still-undiscoverable feature (see the class doc
   *  comment) -- the caller can clear() explicitly on the discrete
   *  "Reference Plate actually changed" action if the resulting kink proves
   *  objectionable in practice. */
  private qRef: Quaternion = IDENTITY_QUAT;

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** See `qRef`'s own doc comment -- no clear() here. */
  setReferenceRotation(q: Quaternion): void {
    this.qRef = q;
  }

  get count(): number { return this.particles.length; }

  /** Seed one new particle at `at` -- the caller's already-resolved click
   *  location (see ClimateInstance.addTrackedParticleAt()'s raycast, which
   *  mirrors Anchored Point's own Globe-only hit test). */
  add(at: LonLat): void {
    const positions = new Float32Array(MAX_PATH_POINTS * 3);
    const colors = new Float32Array(MAX_PATH_POINTS * 3);
    const [x0, y0, z0] = lonLatToVec3(at.lon, at.lat, PATH_R);
    const [x, y, z] = rotateVector(this.qRef, x0, y0, z0);
    positions[0] = x; positions[1] = y; positions[2] = z;
    colors[0] = this.calmColor.r; colors[1] = this.calmColor.g; colors[2] = this.calmColor.b;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setDrawRange(0, 1);
    const line = new Line(
      geometry,
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    );
    line.frustumCulled = false; // a long path can range over the whole globe, same reasoning as WindStreaks' mesh

    const headGeometry = new BufferGeometry();
    headGeometry.setAttribute('position', new BufferAttribute(new Float32Array([x, y, z]), 3));
    const head = new Points(
      headGeometry,
      new PointsMaterial({ color: 0xffffff, size: HEAD_SIZE, sizeAttenuation: true }),
    );
    head.frustumCulled = false;

    this.group.add(line, head);
    this.particles.push({
      lon: at.lon, lat: at.lat, stalled: false, positions, colors, count: 1, geometry, line, head,
    });
  }

  /** Remove every tracked particle, disposing their geometry/material so a
   *  long session that seeds and clears repeatedly doesn't leak GPU
   *  buffers -- same thoroughness precedent as Coastlines.dispose(). */
  clear(): void {
    for (const p of this.particles) {
      this.group.remove(p.line, p.head);
      p.geometry.dispose();
      (p.line.material as LineBasicMaterial).dispose();
      p.head.geometry.dispose();
      (p.head.material as PointsMaterial).dispose();
    }
    this.particles.length = 0;
  }

  /** See the class doc comment -- no flat Projection is supported yet, so
   *  switching to one clears rather than mis-draws every existing path.
   *  Typed as the full ProjectionMode rather than a two-member subset: the
   *  `mode !== 'globe'` test was already the right behaviour for any flat
   *  projection, and the narrow type only meant adding one broke compilation
   *  here for no reason. */
  setProjection(mode: ProjectionMode): void {
    if (isFlat(mode)) this.clear();
  }

  /** Advance every non-stalled particle by one animation frame's worth of
   *  (real, wall-clock) time -- same `uData`/`vData` plane-decoding contract
   *  as WindStreaks.update(). `sentinel`: a particle whose current cell
   *  holds the no-data byte freezes there permanently (`stalled = true`)
   *  rather than retrying into a new position -- see `Particle.stalled`'s
   *  own doc comment for why that differs from Vector Streak's ambient
   *  respawn. */
  update(
    dtSeconds: number,
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo, sentinel?: number, speedScale = 1,
  ): void {
    const dt = Math.min(dtSeconds, 0.25); // guard a tab-backgrounded huge dt spike, same as WindStreaks
    for (const p of this.particles) {
      if (p.stalled) continue;
      const texel = texelIndex(nlon, nlat, p.lon, p.lat);
      if (sentinel !== undefined && (uData[texel] === sentinel || vData[texel] === sentinel)) {
        p.stalled = true;
        continue;
      }

      const u = texelToPhysical(uVar, uData[texel]) * speedScale;
      const v = texelToPhysical(vVar, vData[texel]) * speedScale;
      const speed = Math.hypot(u, v);
      const step = (dt * STREAK_SPEED_SCALE) / EARTH_RADIUS_M;

      const { east, north } = eastNorthAt(p.lon, p.lat);
      const [px, py, pz] = lonLatToVec3(p.lon, p.lat, PATH_R);
      let nx = px + (u * east[0] + v * north[0]) * step;
      let ny = py + (u * east[1] + v * north[1]) * step;
      let nz = pz + (u * east[2] + v * north[2]) * step;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx = (nx / len) * PATH_R; ny = (ny / len) * PATH_R; nz = (nz / len) * PATH_R;

      const next = vec3ToLonLat(nx, ny, nz);
      p.lon = next.lon;
      p.lat = next.lat;
      const [rx, ry, rz] = rotateVector(this.qRef, nx, ny, nz);
      this.appendPoint(p, rx, ry, rz, speed);
    }
  }

  private appendPoint(p: Particle, x: number, y: number, z: number, speed: number): void {
    if (p.count >= MAX_PATH_POINTS) this.compact(p);
    const i = p.count;
    p.positions[i * 3] = x; p.positions[i * 3 + 1] = y; p.positions[i * 3 + 2] = z;

    const t = Math.min(speed, SPEED_CLIP_MS) / SPEED_CLIP_MS;
    const calm = this.calmColor;
    const fast = this.fastColor;
    p.colors[i * 3] = calm.r + (fast.r - calm.r) * t;
    p.colors[i * 3 + 1] = calm.g + (fast.g - calm.g) * t;
    p.colors[i * 3 + 2] = calm.b + (fast.b - calm.b) * t;
    p.count = i + 1;

    p.geometry.setDrawRange(0, p.count);
    (p.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (p.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;

    const headPos = (p.head.geometry.getAttribute('position') as BufferAttribute);
    (headPos.array as Float32Array).set([x, y, z]);
    headPos.needsUpdate = true;
  }

  /** Halve a full particle's path resolution in place, keeping every 2nd
   *  point (oldest first) -- bounds memory on an indefinitely long-running
   *  particle by trading path resolution for runtime rather than capping
   *  the path outright or dropping old history entirely. Same "visual
   *  completeness over precision" trade-off ADR-0010 documents for ocean
   *  vertical velocity. */
  private compact(p: Particle): void {
    let w = 0;
    for (let r = 0; r < p.count; r += 2, w++) {
      p.positions[w * 3] = p.positions[r * 3];
      p.positions[w * 3 + 1] = p.positions[r * 3 + 1];
      p.positions[w * 3 + 2] = p.positions[r * 3 + 2];
      p.colors[w * 3] = p.colors[r * 3];
      p.colors[w * 3 + 1] = p.colors[r * 3 + 1];
      p.colors[w * 3 + 2] = p.colors[r * 3 + 2];
    }
    p.count = w;
  }
}
