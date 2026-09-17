import { Mesh, ShaderMaterial, FrontSide } from 'three';
import {
  createVolumeSurfaceMaterial, setMaskMode, setProjectionMode, setReferenceRotation,
} from './material';
import { R_SURFACE } from './constants';
import { createSurfaceGeometry, type ProjectionMode } from './projection';
import type { Quaternion } from './rotation';
import type { Manifest } from './types';

export interface DepthSliceState {
  enabled: boolean;
  /** Manual depth when sinking mode is off; the sinking-computed depth when
   *  it's on -- kept here (not derived on read) so the material and the
   *  readout always agree on the same number. */
  depthKm: number;
  sinkingEnabled: boolean;
  /** Which published model (if any) the two rates below were seeded from.
   *  CUSTOM_PRESET_ID once either rate is hand-edited -- this is display
   *  state for the dropdown, not something the sinking arithmetic reads. */
  sinkingPreset: string;
  rateUpperCmPerYr: number;   // above 660 km
  rateLowerCmPerYr: number;   // below 660 km
}

export interface SinkingRatePreset {
  id: string;
  label: string;
  upperCmPerYr: number;
  lowerCmPerYr: number;
}

export const CUSTOM_PRESET_ID = 'custom';

/**
 * Published slab sinking-rate estimates, offered as starting points -- both
 * sliders stay free to edit, and editing either one reverts the dropdown to
 * "Custom" (see ui.ts). Each entry was checked against the paper's own
 * reported number rather than copied from a secondhand table; a few
 * candidates that didn't hold up on checking were left out entirely:
 *
 *   - "Goes et al. 2008" -- real paper, but the upper-mantle figure floating
 *     around for it is a generic surface plate-convergence rate, not this
 *     paper's own sinking-rate estimate.
 *   - "Glerum et al. 2023" -- no such paper. The real paper with these
 *     numbers is van der Wiel et al. 2024 (below); "Glerum" was a wrong
 *     author name attached to a real result.
 *   - "Peng & Liu 2024" -- the real paper is Peng & Liu (2022), and it
 *     reports a rate that declines with depth (>2 cm/yr near 1600 km to
 *     ~0 near the CMB) rather than a single whole-mantle number, so it
 *     doesn't reduce to this two-segment model without misrepresenting it.
 *
 * Most of these papers report one lower-mantle rate, applied to both
 * segments here (the single-rate case). Shephard et al. 2017 is the one
 * exception with a genuine reported upper/lower split -- their explicitly
 * tested "fast upper mantle" scenario.
 */
export const SINKING_RATE_PRESETS: SinkingRatePreset[] = [
  {
    id: 'vandermeer2010',
    label: 'van der Meer et al. 2010 / Atlas of the Underworld (2018) -- 1.2 cm/yr',
    upperCmPerYr: 1.2,
    lowerCmPerYr: 1.2,
  },
  {
    id: 'butterworth2014',
    label: 'Butterworth et al. 2014 -- 1.3 cm/yr',
    upperCmPerYr: 1.3,
    lowerCmPerYr: 1.3,
  },
  {
    id: 'domeier2016',
    label: 'Domeier et al. 2016 -- 1.5 cm/yr (range 1.1-1.9)',
    upperCmPerYr: 1.5,
    lowerCmPerYr: 1.5,
  },
  {
    id: 'shephard2017',
    label: 'Shephard et al. 2017 -- 1.1 cm/yr',
    upperCmPerYr: 1.1,
    lowerCmPerYr: 1.1,
  },
  {
    id: 'shephard2017-fast-upper',
    label: 'Shephard et al. 2017, fast-upper-mantle scenario -- 5.0 / 1.1 cm/yr',
    upperCmPerYr: 5.0,
    lowerCmPerYr: 1.1,
  },
  {
    id: 'vanderwiel2024',
    label: 'van der Wiel et al. 2024 -- 1.25 cm/yr',
    upperCmPerYr: 1.25,
    lowerCmPerYr: 1.25,
  },
];

export const DEFAULT_DEPTH_SLICE: DepthSliceState = {
  enabled: false,
  depthKm: 660,
  sinkingEnabled: false,
  sinkingPreset: 'vandermeer2010',
  rateUpperCmPerYr: 1.2,
  rateLowerCmPerYr: 1.2,
};

export const SINKING_BREAK_KM = 660;
const KM_PER_MYR_PER_CM_PER_YR = 10; // 1 cm/yr = 10 km/Myr

/**
 * depth = rate x age x 10, but slabs slow at the 660 km transition rather
 * than sinking at one rate throughout: two linear segments meeting at
 * SINKING_BREAK_KM, continuous by construction. upperRate == lowerRate
 * reduces this to the single-rate case, the default.
 */
export function sinkingDepthKm(
  ageMa: number, upperRateCmPerYr: number, lowerRateCmPerYr: number,
): number {
  const upperKmPerMyr = upperRateCmPerYr * KM_PER_MYR_PER_CM_PER_YR;
  const ageAtBreak = SINKING_BREAK_KM / upperKmPerMyr;
  if (ageMa <= ageAtBreak) return upperKmPerMyr * ageMa;
  return SINKING_BREAK_KM + lowerRateCmPerYr * KM_PER_MYR_PER_CM_PER_YR * (ageMa - ageAtBreak);
}

/**
 * Sinking mode pins the volume to the present day, so it only makes sense
 * for a static tomography snapshot. A convection run already has real time
 * in it; letting one slider drive both the loaded frame and the sinking
 * depth would double-count. See docs/plans/depth-slice-and-sinking-rate.md.
 */
export function canUseSinkingMode(manifest: Manifest | undefined): boolean {
  return manifest?.type === 'tomography';
}

/**
 * Paints the WHOLE outer sphere (R_SURFACE, not the true radius for the
 * depth) with the volume sampled at one fixed depth, reusing the shared
 * material unchanged apart from one uniform. Unlike Isosurface there is no
 * radius/shell clamping to do: an out-of-range depth already renders as the
 * shader's own no-data grey once uDepthMin/uDepthMax land on this material.
 */
export class DepthSlice {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly radius: number;

  /** `radius` defaults to R_SURFACE (every existing caller); a second
   *  DepthSlice at a slightly larger radius is how the paleoclimate
   *  viewer's shaded-relief overlay sits just clear of the primary field
   *  without z-fighting it -- see climateInstance.ts and the LAND_R
   *  precedent in coastlines.ts. */
  constructor(radius: number = R_SURFACE) {
    this.radius = radius;
    this.mat = createVolumeSurfaceMaterial();
    this.mat.side = FrontSide; // a whole sphere/plane: only the outward face is ever seen
    setMaskMode(this.mat, 'none'); // paints the WHOLE surface, ignoring any cutaway polygon
    this.mat.uniforms.uUseSliceDepth.value = 1;

    this.mesh = new Mesh(createSurfaceGeometry('globe', radius), this.mat);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  get material(): ShaderMaterial { return this.mat; }

  setDepthKm(km: number): void {
    this.mat.uniforms.uSliceDepthKm.value = km;
  }

  /** See CONTEXT.md's Reference Plate entry and docs/adr/0030 -- `q` must
   *  already be a render-frame quaternion (core/rotation.ts's
   *  toRenderFrameRotation()). */
  setReferenceRotation(q: Quaternion): void {
    setReferenceRotation(this.mat, q);
  }

  /** Rebuild this surface's geometry for `mode` and flip the shader's
   *  worldToGeographic branch to match (see core/projection.ts). Cheap
   *  enough to rebuild on every switch rather than keep both geometries
   *  live -- see docs/adr/0003-plate-carree-as-first-alternate-projection.md. */
  setProjection(mode: ProjectionMode): void {
    const old = this.mesh.geometry;
    this.mesh.geometry = createSurfaceGeometry(mode, this.radius);
    old.dispose();
    setProjectionMode(this.mat, mode);
  }
}
