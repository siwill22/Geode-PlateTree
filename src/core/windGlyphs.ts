import type { ResolvedTheme } from './theme';
import {
  BufferGeometry, ConeGeometry, CylinderGeometry, InstancedMesh, MeshBasicMaterial,
  Object3D, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEG, R_SURFACE, eastNorthAt, lonLatToVec3 } from './constants';
import { referencePlateProjectedSample, type ProjectionMode } from './projection';
import { texelIndex, texelToPhysical } from './volume';
import { rotateVector, type Quaternion } from './rotation';
import type { VariableInfo } from './types';

const IDENTITY_QUAT: Quaternion = [0, 0, 0, 1];

// Just clear of the overlay sphere (R_SURFACE * 1.0006, see
// climateInstance.ts's OVERLAY_R) -- arrows are real 3D geometry, not a
// second coincident sphere surface, so there is no z-fighting concern here;
// this only needs to clear the surface visually.
const GLYPH_R = R_SURFACE * 1.001;
// The Plate Carrée equivalent: GLYPH_R's clearance ABOVE R_SURFACE, applied
// as a Z offset instead of a radius (see lonLatToFlatVec3's own doc comment).
const FLAT_GLYPH_Z = GLYPH_R - R_SURFACE;

// The lattice step at density=1 (WindGlyphs.setDensity's default) -- halving
// the previous step in BOTH directions (rings and per-ring count each
// double, see buildLattice) made this 4x the arrow count of the original for
// 2x the linear density.
const BASE_LAT_STEP_DEG = 7.5;
// setDensity()'s allowed range: density = BASE_LAT_STEP_DEG / step, so
// smaller step = denser. MIN_LAT_STEP_DEG (density=3) sets the InstancedMesh
// capacity allocated up front -- see WindGlyphs's constructor -- since an
// InstancedMesh's instance count is fixed at creation; MAX_LAT_STEP_DEG
// (density=0.5) is the sparsest the slider goes.
const MIN_LAT_STEP_DEG = 2.5;
const MAX_LAT_STEP_DEG = 15;
const HEAD_RADIUS = 0.005;
const SHAFT_RADIUS = 0.0018;
// Fraction of an arrow's total length given to the head -- the rest is shaft.
const HEAD_FRACTION = 0.35;
const MIN_ARROW_LEN = 0.012;
const MAX_ARROW_LEN = 0.045;
// m/s beyond which an arrow's length stops growing. 1000 hPa wind at this
// clip is already brisk; without it, one storm-force outlier in 55 ages
// would compress every other arrow on the whole globe toward invisibility --
// the same "one outlier distorts the whole shared scale" failure mode fixed
// for the hillshade overlay, avoided here the same way: clip, don't rescale
// to the extremum.
const SPEED_CLIP_MS = 20;

interface Sample { lon: number; lat: number; }

/**
 * A coarse lon/lat sample lattice for the glyph field.
 *
 * Excludes the rows within one lat-step of either pole outright -- "east" is
 * undefined exactly at lat=+-90 (every longitude is the same physical
 * point there; see eastNorthAt's own doc comment), so there is no
 * physically meaningful arrow to draw on those rows at all, not just a
 * numerically awkward one. Longitude spacing widens toward the poles
 * (divided by cos(lat)) so the lattice stays roughly even in physical area
 * rather than clustering where meridians converge -- a uniform lon/lat step
 * would put far more arrows per unit ground area near +-75 deg than at the
 * equator.
 */
function buildLattice(latStep = BASE_LAT_STEP_DEG): Sample[] {
  const samples: Sample[] = [];
  for (let lat = -90 + latStep; lat <= 90 - latStep + 1e-6; lat += latStep) {
    const nLon = Math.max(4, Math.round(360 / Math.min(180, latStep / Math.cos(lat * DEG))));
    for (let i = 0; i < nLon; i++) {
      samples.push({ lon: -180 + (360 * i) / nLon, lat });
    }
  }
  return samples;
}

/**
 * The Plate Carrée equivalent of buildLattice(): a PLAIN uniform lon/lat
 * grid, without the cos(lat) longitude-widening buildLattice() uses to keep
 * roughly even PHYSICAL-sphere-area coverage. On a flat equirectangular map
 * there is no meridian convergence to compensate for -- every row already
 * covers the same screen width per degree of longitude -- so applying the
 * sphere's compensation here would UNDER-populate high latitudes relative to
 * how the map actually reads, the opposite of what it's for. Same pole-row
 * exclusion as buildLattice() for a consistent look between the two, even
 * though "east is undefined at the pole" doesn't apply on a plane. */
function buildLatticeFlat(latStep = BASE_LAT_STEP_DEG): Sample[] {
  const samples: Sample[] = [];
  const nLon = Math.max(4, Math.round(360 / latStep));
  for (let lat = -90 + latStep; lat <= 90 - latStep + 1e-6; lat += latStep) {
    for (let i = 0; i < nLon; i++) {
      samples.push({ lon: -180 + (360 * i) / nLon, lat });
    }
  }
  return samples;
}

/** A thin shaft (cylinder) with a cone head on top, merged into one
 *  geometry so a single InstancedMesh instance -- and a single per-instance
 *  matrix -- draws both: root at local +Y=0, tip at local +Y=1, oriented
 *  per-instance by rotating +Y onto the wind direction (see update()).
 *  Radii are baked in absolute (not unit) so only the Y axis needs scaling
 *  per instance for length -- the line stays a constant thickness regardless
 *  of wind speed, only its length changes. */
function makeArrowGeometry(): BufferGeometry {
  const shaftHeight = 1 - HEAD_FRACTION;
  const shaft = new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, shaftHeight, 6);
  shaft.translate(0, shaftHeight / 2, 0);
  const head = new ConeGeometry(HEAD_RADIUS, HEAD_FRACTION, 6);
  head.translate(0, shaftHeight + HEAD_FRACTION / 2, 0);
  const merged = mergeGeometries([shaft, head]);
  shaft.dispose();
  head.dispose();
  if (!merged) throw new Error('windGlyphs: failed to merge shaft+head arrow geometry');
  return merged;
}

const UP = new Vector3(0, 1, 0);

/**
 * A vector field of arrow glyphs on the globe's surface -- generic, no
 * paleoclimate-specific knowledge (mirrors DepthSlice/FrameCache as a shared
 * engine primitive). One InstancedMesh, built once; update() re-poses every
 * instance from a pair of decoded scalar planes (u, v components) without
 * touching geometry or material.
 */
export class WindGlyphs {
  private material!: MeshBasicMaterial;

  /** Re-colour to a Theme. Glyphs claim `accentCool`, the same role velocity
   *  arrows take in petrify: both are "an arrow showing a vector field",
   *  and giving them one role is what stops a future overlay inventing a tenth
   *  colour. */
  applyTheme(theme: ResolvedTheme): void {
    this.material.color.setHex(theme.accents.cool);
  }

  readonly mesh: InstancedMesh;
  private lattice = buildLattice();
  private latStep = BASE_LAT_STEP_DEG;
  private mode: ProjectionMode = 'globe';
  private readonly tmp = new Object3D();
  private readonly dir = new Vector3();
  /** Uniform multiplier on top of the speed-driven length (and, unlike
   *  speed, the thickness too) -- a user-facing "how big" control,
   *  independent of the physical wind magnitude. See setSize(). */
  private sizeScale = 1;

  constructor() {
    const geo = makeArrowGeometry();
    this.material = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const mat = this.material;
    // Allocated for the DENSEST setDensity() can go, in EITHER Projection
    // (an InstancedMesh's instance count is fixed at construction, unlike a
    // plain BufferGeometry array) -- setDensity()/setProjection() then
    // narrow what's actually drawn via mesh.count, which three.js supports
    // rendering fewer than the allocated maximum without touching the
    // buffer's capacity. buildLatticeFlat() has MORE samples than
    // buildLattice() at the same step (no polar thinning), so it's the
    // binding one here even though Globe is the default mode.
    const maxCount = Math.max(
      buildLattice(MIN_LAT_STEP_DEG).length, buildLatticeFlat(MIN_LAT_STEP_DEG).length,
    );
    this.mesh = new InstancedMesh(geo, mat, maxCount);
    this.mesh.count = this.lattice.length;
    this.mesh.visible = false;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /** Set the size multiplier applied on the NEXT update() -- does not repose
   *  existing instances itself, since it has no data of its own to repose
   *  them from (see ClimateInstance.setWindScale, which follows this with a
   *  refreshWindGlyphs() using whatever U/V frame is already held). */
  setSize(scale: number): void {
    this.sizeScale = scale;
  }

  /** Rebuild the sample lattice at a new density (1 = BASE_LAT_STEP_DEG,
   *  higher = a finer step = more arrows -- see the constants above for the
   *  allowed range) and resize mesh.count to match. Like setSize(), this
   *  doesn't repose anything itself; see ClimateInstance.setWindDensity. */
  setDensity(density: number): void {
    this.latStep = Math.min(MAX_LAT_STEP_DEG, Math.max(MIN_LAT_STEP_DEG, BASE_LAT_STEP_DEG / density));
    this.rebuildLattice();
  }

  /** Switch which lattice/position math update() uses -- see buildLattice()
   *  vs. buildLatticeFlat()'s own doc comment for why these are genuinely
   *  different grids, not just a coordinate relabelling. Doesn't repose
   *  existing instances itself, same as setSize()/setDensity() -- see
   *  ClimateInstance.setProjection(), which follows this with a
   *  refreshWindGlyphs(). */
  setProjection(mode: ProjectionMode): void {
    this.mode = mode;
    this.rebuildLattice();
  }

  private rebuildLattice(): void {
    this.lattice = this.mode === 'globe' ? buildLattice(this.latStep) : buildLatticeFlat(this.latStep);
    this.mesh.count = this.lattice.length;
  }

  /** uData/vData: ONE month's plane, nlon*nlat bytes each, lon-fastest --
   *  a slice of the volume's raw backing buffer (see loadVolume's own doc
   *  comment on that memory order), not a whole Data3DTexture. Decoded
   *  through uVar/vVar's own encode range: the raw byte alone means nothing
   *  without it (see texelToPhysical).
   *
   *  `sentinel`: the model's NO-DATA byte (manifest.no_data_sentinel, see
   *  ADR-0005), undefined for a field with full coverage (wind, which has
   *  none). Ocean Surface Current and Sea-Ice Drift are only defined over
   *  ocean -- without this, a land texel's sentinel byte would decode
   *  through texelToPhysical() same as any other value and draw a bogus
   *  arrow at that cell's clip-range extreme. Scaled to zero rather than
   *  skipped outright, so mesh.count/lattice indexing stays untouched.
   *
   *  `speedScale`: VectorFieldInfo.display_speed_scale, applied to the
   *  decoded (u, v) before length/direction math -- see that field's own
   *  doc comment for why. 1 (its default) is a no-op.
   *
   *  `qRef`: the current Reference Plate rotation, already converted to the
   *  render frame (core/rotation.ts's toRenderFrameRotation) -- see
   *  docs/adr/0030. Applied to each glyph's position AND direction: on the
   *  Globe, directly, by rotating both 3D vectors (rotating a rigid body
   *  rotates its embedded vectors the same way); on Plate Carrée, via
   *  referencePlateProjectedSample()'s round-trip through the sphere, since the
   *  flat plane's own Cartesian position/basis aren't 3D directions a
   *  quaternion can rotate directly (see that function's doc comment).
   *  Never applied to the (lon, lat) used to sample uData/vData -- the
   *  field itself is never reconstructed (ADR-0001), only where it's
   *  drawn. Identity (its default) is a no-op, matching every existing
   *  caller. */
  update(
    uData: Uint8Array, vData: Uint8Array, nlon: number, nlat: number,
    uVar: VariableInfo, vVar: VariableInfo, sentinel?: number, speedScale = 1,
    qRef: Quaternion = IDENTITY_QUAT,
  ): void {
    for (let i = 0; i < this.lattice.length; i++) {
      const { lon, lat } = this.lattice[i];
      const texel = texelIndex(nlon, nlat, lon, lat);
      if (sentinel !== undefined && (uData[texel] === sentinel || vData[texel] === sentinel)) {
        this.tmp.position.set(0, 0, 0);
        this.tmp.scale.set(0, 0, 0);
        this.tmp.updateMatrix();
        this.mesh.setMatrixAt(i, this.tmp.matrix);
        continue;
      }
      const u = texelToPhysical(uVar, uData[texel]) * speedScale;
      const v = texelToPhysical(vVar, vData[texel]) * speedScale;
      const speed = Math.hypot(u, v);

      // u/v are already components in a local east/north tangent frame --
      // on the globe that frame rotates with position (eastNorthAt), so
      // this sum is a real 3D tangent-plane direction, not a flat
      // (u, v) -> (x, y) guess. On a flat map, referencePlateProjectedSample
      // handles east/north itself -- NOT as constant screen axes, which only
      // Plate Carrée has; Robinson's meridians converge, so it asks
      // flatDirection() where north actually points there (see its own doc
      // comment). It also does the Reference Plate round-trip a flat map
      // needs that a 3D rotation of the plane's own position can't give it
      // (docs/plans/reference-plate.md's "Known issue" postmortem).
      if (this.mode === 'globe') {
        const { east, north } = eastNorthAt(lon, lat);
        this.dir.set(
          u * east[0] + v * north[0],
          u * east[1] + v * north[1],
          u * east[2] + v * north[2],
        );
        if (this.dir.lengthSq() < 1e-8) this.dir.set(0, 1, 0); // calm: length ~0 makes orientation invisible anyway
        else this.dir.normalize();

        const [px0, py0, pz0] = lonLatToVec3(lon, lat, GLYPH_R);
        const [px, py, pz] = rotateVector(qRef, px0, py0, pz0);
        const [dx, dy, dz] = rotateVector(qRef, this.dir.x, this.dir.y, this.dir.z);
        this.tmp.position.set(px, py, pz);
        this.dir.set(dx, dy, dz);
      } else {
        const { position, direction } = referencePlateProjectedSample(
          this.mode, lon, lat, u, v, qRef, FLAT_GLYPH_Z,
        );
        this.dir.set(direction[0], direction[1], direction[2]);
        if (this.dir.lengthSq() < 1e-8) this.dir.set(0, 1, 0); // calm, same threshold as the globe branch
        else this.dir.normalize();
        this.tmp.position.set(position[0], position[1], position[2]);
      }
      this.tmp.quaternion.setFromUnitVectors(UP, this.dir);
      const len = (MIN_ARROW_LEN
        + (Math.min(speed, SPEED_CLIP_MS) / SPEED_CLIP_MS) * (MAX_ARROW_LEN - MIN_ARROW_LEN))
        * this.sizeScale;
      // Thickness scales too (not just length): a bigger arrow should look
      // like the same arrow zoomed in, not a longer thin one.
      this.tmp.scale.set(this.sizeScale, len, this.sizeScale);
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(i, this.tmp.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
