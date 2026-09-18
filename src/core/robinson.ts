import {
  ROBINSON_KX, ROBINSON_KY, ROBINSON_STEP, ROBINSON_X, ROBINSON_Y,
  robinsonForward as forwardUnits, robinsonInverse as inverseUnits,
} from '../../vendor/petrify/js/index.js';

import { R_SURFACE } from './constants';

/**
 * The Robinson projection in Geode's world units — a thin adapter over
 * petrify's copy, which owns the arithmetic.
 *
 * Robinson is a *tabulated* projection with no closed form. Both coordinates
 * come from a 19-entry table at 5° steps of latitude,
 *
 *     x = KX · R · lon · X(lat)          y = KY · R · Y(lat)
 *
 * with lon in radians. The table was generated from PROJ (`+proj=robin +R=1`)
 * rather than transcribed, and agrees with it to the 4 dp PROJ's own source
 * carries — which also confirms KX = 0.8487 and KY = 1.3523, since PROJ puts
 * (lon 180°, lat 0) at x = 2.666270 = 0.8487π and (lat 90°) at y = 1.352300.
 *
 * ---- Why this is an adapter and not the implementation ---------------------
 *
 * The table and the two transforms are pure sphere geometry, so by
 * petrify's ADR-0001 they belong there, and did once a second consumer
 * (StoryMaps) turned out to have grown its own copy of the same numbers with
 * *different* antimeridian behaviour. What stays here is everything that needs
 * Geode's own pipeline and is explicitly downstream under the same rule: the
 * world-unit scaling below, the GLSL the shader is built from, and the flat
 * plane's framing in core/projection.ts.
 *
 * The scaling is the whole of the difference. Upstream works in projection
 * units (x spans ±KX·π, y spans ±KY) because a canvas consumer multiplies by
 * its own radius; Geode's surfaces are built at R_SURFACE, so that is the
 * factor applied here. Re-exported table constants are the raw numbers, not
 * scaled, since the GLSL generator emits them verbatim.
 *
 * ---- Why the inverse matters more than the forward -------------------------
 *
 * The forward is what positions coastline vertices and overlay glyphs. But the
 * raster shader works the other way round: every fragment of the map plane has
 * to ask "which (lon, lat) am I?", so it needs the INVERSE. Robinson's inverse
 * has no closed form either — except that Y(lat) is strictly increasing, so it
 * can be inverted exactly by table search, and X is then evaluated at the
 * recovered latitude. No iteration, no root-finding, which is what makes this
 * cheap enough to run per fragment.
 *
 * ---- Interpolation, and the error it costs ---------------------------------
 *
 * PROJ interpolates the table with a higher-order scheme; this uses plain
 * linear interpolation between 5° nodes, because the same arithmetic has to run
 * in GLSL. `npm run check:robinson` measures the disagreement rather than
 * assuming it, and the measurement is worth knowing:
 *
 *   - **At the nodes: 7.6e-08.** Exact, to the precision the table carries.
 *     This is the part that would catch a mistyped entry.
 *   - **Between nodes, below ±85°: 8.5e-04** of the map's half-width — under a
 *     pixel on a full-screen map, and this band holds essentially all content.
 *   - **Between nodes, 85–90°: 1.4e-03 in x, 1.8e-03 in y** — roughly 1.5 px.
 *     The last interval is where the parallel-length factor turns hardest.
 *
 * An earlier version of this comment claimed "well under a pixel at any zoom",
 * which the check disproved the first time it ran. Accepted rather than fixed:
 * tightening it needs more nodes or a higher-order scheme, in GLSL, per
 * fragment, for a sliver of map with no coastline in it.
 */

export { ROBINSON_KX, ROBINSON_KY, ROBINSON_STEP, ROBINSON_X, ROBINSON_Y };

/** Half-extents of the whole map, in world units. */
export const ROBINSON_HALF_WIDTH = ROBINSON_KX * Math.PI * R_SURFACE;
export const ROBINSON_HALF_HEIGHT = ROBINSON_KY * R_SURFACE;

/** (lon, lat) in degrees -> world (x, y). `z` is a constant layer offset, the
 *  same role it plays in `lonLatToFlatVec3`. */
export function robinsonForward(lon: number, lat: number, z = 0): [number, number, number] {
  const [x, y] = forwardUnits(lon, lat) as [number, number];
  return [x * R_SURFACE, y * R_SURFACE, z];
}

/**
 * World (x, y) -> (lon, lat) in degrees, or null outside the map outline.
 *
 * Null is not an edge case to smooth over: Robinson's boundary is a curve, so a
 * rectangular plane covering the map necessarily has corners that are not on
 * the Earth at all. The renderer must discard there rather than clamp, or the
 * map grows rectangular ears of stretched polar data.
 */
export function robinsonInverse(x: number, y: number): { lon: number; lat: number } | null {
  return inverseUnits(x / R_SURFACE, y / R_SURFACE) as { lon: number; lat: number } | null;
}

/** The table, as a GLSL float array literal -- so the shader and the CPU read
 *  the same numbers instead of two transcriptions of them. Stays here rather
 *  than upstream: emitting GLSL is Geode's rendering pipeline, not sphere
 *  geometry. */
export function robinsonGlslTable(name: string, values: number[]): string {
  return `const float ${name}[${values.length}] = float[${values.length}](\n  `
    + values.map((v) => v.toFixed(4)).join(', ')
    + '\n);';
}
