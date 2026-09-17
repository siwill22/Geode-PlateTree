import { Mesh, ShaderMaterial, type BufferGeometry } from 'three';

import { passthroughColor } from './material';
import { LIGHT_DIR, R_SURFACE } from './constants';
import { createSurfaceGeometry, isFlat, type ProjectionMode } from './projection';
import { DEFAULT_THEME, resolveTheme, type ResolvedTheme } from './theme';

/**
 * A solid, opaque ocean: the globe's own surface, painted with a Theme's
 * `water` role.
 *
 * Exists because the reconstruction-only wrappers had no surface at all --
 * continents were drawn straight onto the page colour, so "the ocean" was
 * whatever happened to be behind the globe, and a Theme's `water` role went
 * unrendered. That also made the globe read as a flat cut-out rather than a
 * sphere, since nothing occluded the far hemisphere's coastlines.
 *
 * Distinct from the opaque surfaces the data viewers already have (a Volume
 * raster in climate/globe/paleobio, paleogeography relief in Valdes,
 * tomography's own `createSurfaceSphere`): those paint a Model onto the
 * sphere, and a Theme must never touch them (docs/adr/0038). This one paints
 * nothing but furniture, which is why it belongs in core/ and they do not.
 *
 * Land sits ABOVE this at `LAND_R`, and the coastline pen above that at
 * `COASTLINE_R` -- the arrangement those constants were written for. A wrapper
 * adding an OceanSurface must therefore stop passing LAND_R_UNDER_SURFACE,
 * which exists for the opposite case (land as a backdrop beneath a data
 * sphere) and would put the continents inside this sphere, invisible.
 */

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Shaded with the same expression as coastlines.ts's LAND_FRAG, deliberately:
 * ocean and land are lit by one shared LIGHT_DIR and must agree about where
 * the sun is, or the continents look pasted on. `uShadeStrength` drops to 0 on
 * a flat map, where every point has the same normal and shading would only
 * darken the whole plane by a constant.
 */
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uLightDir;
uniform float uShadeStrength;
varying vec3 vWorldPos;
void main() {
  vec3 n = normalize(vWorldPos);
  float ndl = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  float shade = mix(1.0, 0.5 + 0.5 * ndl * ndl, uShadeStrength);
  gl_FragColor = vec4(uColor * shade, 1.0);
}
`;

export class OceanSurface {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private mode: ProjectionMode;

  constructor(mode: ProjectionMode = 'globe') {
    this.mode = mode;
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uColor: { value: passthroughColor(resolveTheme(DEFAULT_THEME).water) },
        uLightDir: { value: LIGHT_DIR.clone() },
        uShadeStrength: { value: isFlat(mode) ? 0 : 1 },
      },
    });
    this.mesh = new Mesh(this.buildGeometry(mode), this.material);
    // Below land (2) and the pen (3). Opaque and written to depth, so the far
    // hemisphere's coastlines are occluded rather than showing through.
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  private buildGeometry(mode: ProjectionMode): BufferGeometry {
    return createSurfaceGeometry(mode, R_SURFACE);
  }

  setProjection(mode: ProjectionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.buildGeometry(mode);
    this.material.uniforms.uShadeStrength.value = isFlat(mode) ? 0 : 1;
  }

  applyTheme(theme: ResolvedTheme): void {
    this.material.uniforms.uColor.value = passthroughColor(theme.water);
  }

  set visible(v: boolean) { this.mesh.visible = v; }
  get visible(): boolean { return this.mesh.visible; }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
