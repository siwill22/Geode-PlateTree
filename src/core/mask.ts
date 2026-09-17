import { DataTexture, RedFormat, UnsignedByteType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping } from 'three';
import { DEG, wrapLon, wrapLonDelta, type LonLat } from './constants';

export const MASK_W = 2048;
export const MASK_H = 1024;

/**
 * Rasterise the cutaway polygon by SPHERICAL SCANLINE.
 *
 * The key observation is that raster rows ARE latitude circles. So per row we
 * find where the polygon's edges cross that latitude, sort the crossings by
 * longitude, and parity-fill in CYCLIC longitude.
 *
 * Two special cases that a planar canvas fill needs hacks for simply do not
 * arise here:
 *   - the antimeridian, because longitude is cyclic from the start and there is
 *     no seam to unwrap;
 *   - pole enclosure, because a row with no crossings inherits its state from
 *     the row below, with no path-extension to the canvas edge.
 *
 * Which of the two regions ends up marked is resolved by AREA, not by winding
 * order: the parity seed below is arbitrary, and we flip at the end if the
 * marked set turned out to be the larger one. That matches the spec's rule --
 * smaller region removed by default, `inverted` to override.
 */
export function rasteriseMask(
  boundary: LonLat[],
  inverted: boolean,
): Uint8Array {
  const data = new Uint8Array(MASK_W * MASK_H);
  const n = boundary.length;
  if (n < 3) return data;

  // Latitudes at which the boundary crosses the -180 meridian. The parity at
  // the left edge of the raster flips at each of these, which is what keeps the
  // per-row fills consistent with one another.
  //
  // Detected in Cartesian terms rather than by comparing wrapped longitudes.
  // The antimeridian is the half-plane where sin(lon) = 0 and cos(lon) < 0, so
  // a crossing is a sign change in sin(lon) that resolves to the negative-x
  // side. Comparing wrapped longitudes instead puts an edge that lands exactly
  // on +/-180 -- which happens for any polygon with a vertex at lon 180 or -90
  // -- right on a strict inequality, where it is silently missed.
  const seamCrossings: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = boundary[i];
    const b = boundary[(i + 1) % n];
    const sa = Math.sin(a.lon * DEG);
    const sb = Math.sin(b.lon * DEG);
    // Half-open so a vertex sitting exactly on the meridian counts once.
    if ((sa <= 0) === (sb <= 0)) continue;
    const t = sa / (sa - sb);
    const x = Math.cos(a.lon * DEG) * (1 - t) + Math.cos(b.lon * DEG) * t;
    if (x < 0) {
      seamCrossings.push(a.lat + t * (b.lat - a.lat));
    }
  }
  seamCrossings.sort((p, q) => p - q);

  const xs: number[] = [];
  let filledWeight = 0;
  let totalWeight = 0;

  for (let j = 0; j < MASK_H; j++) {
    const lat = -90 + ((j + 0.5) * 180) / MASK_H;
    const w = Math.cos(lat * DEG);
    totalWeight += w * MASK_W;

    // Parity at lon = -180 for this row: start arbitrarily false at the south
    // pole and flip once per seam crossing below this latitude. An arbitrary
    // seed only mislabels which region is which, and the area test fixes that.
    let leftInside = false;
    for (const c of seamCrossings) {
      if (c < lat) leftInside = !leftInside;
      else break;
    }

    // Crossings of this latitude circle.
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = boundary[i];
      const b = boundary[(i + 1) % n];
      // Half-open rule so a vertex exactly on the row is counted once.
      if ((a.lat <= lat && b.lat > lat) || (b.lat <= lat && a.lat > lat)) {
        const t = (lat - a.lat) / (b.lat - a.lat);
        xs.push(wrapLon(a.lon + t * wrapLonDelta(b.lon - a.lon)));
      }
    }

    const row = j * MASK_W;
    if (xs.length === 0) {
      // Wholly inside or wholly outside; inherit from the seam parity.
      if (leftInside) {
        data.fill(255, row, row + MASK_W);
        filledWeight += w * MASK_W;
      }
      continue;
    }

    xs.sort((p, q) => p - q);

    // Build the filled intervals. lon = -180 lies in the wrapping interval
    // [x_last, x_0 + 360), so `leftInside` selects which alternation to use.
    const spans: Array<[number, number]> = [];
    if (leftInside) {
      spans.push([-180, xs[0]]);
      for (let k = 1; k + 1 < xs.length; k += 2) spans.push([xs[k], xs[k + 1]]);
      spans.push([xs[xs.length - 1], 180]);
    } else {
      for (let k = 0; k + 1 < xs.length; k += 2) spans.push([xs[k], xs[k + 1]]);
    }

    for (const [lo, hi] of spans) {
      let i0 = Math.round(((lo + 180) / 360) * MASK_W);
      let i1 = Math.round(((hi + 180) / 360) * MASK_W);
      i0 = Math.max(0, Math.min(MASK_W, i0));
      i1 = Math.max(0, Math.min(MASK_W, i1));
      if (i1 > i0) {
        data.fill(255, row + i0, row + i1);
        filledWeight += w * (i1 - i0);
      }
    }
  }

  // Smaller region is the one removed, unless the user has inverted it.
  const fraction = filledWeight / totalWeight;
  const flip = fraction > 0.5 ? !inverted : inverted;
  if (flip) {
    for (let i = 0; i < data.length; i++) data[i] = data[i] ? 0 : 255;
  }
  return data;
}

/**
 * Is this lon/lat inside the removed region?
 *
 * Reads the rasterised mask rather than re-testing the polygon. A second
 * point-in-polygon implementation would be a second thing to get wrong, and
 * this raster is the one that check_mask.py holds to account against pygplates
 * -- so anything that consults it inherits that guarantee. Overlay layers drawn
 * on the surface use this to lift the pen where the cutaway has removed the
 * ground beneath them.
 */
export function maskAt(mask: Uint8Array, lon: number, lat: number): boolean {
  let i = Math.floor(((wrapLon(lon) + 180) / 360) * MASK_W);
  let j = Math.floor(((lat + 90) / 180) * MASK_H);
  if (i < 0) i = 0; else if (i >= MASK_W) i = MASK_W - 1;
  if (j < 0) j = 0; else if (j >= MASK_H) j = MASK_H - 1;
  return mask[j * MASK_W + i] > 127;
}

/** Fraction of the sphere's area that a polygon's smaller region covers. */
export function markedAreaFraction(mask: Uint8Array): number {
  let filled = 0;
  let total = 0;
  for (let j = 0; j < MASK_H; j++) {
    const lat = -90 + ((j + 0.5) * 180) / MASK_H;
    const w = Math.cos(lat * DEG);
    total += w * MASK_W;
    const row = j * MASK_W;
    for (let i = 0; i < MASK_W; i++) if (mask[row + i]) filled += w;
  }
  return filled / total;
}

export function createMaskTexture(): DataTexture {
  const tex = new DataTexture(
    new Uint8Array(MASK_W * MASK_H),
    MASK_W,
    MASK_H,
    RedFormat,
    UnsignedByteType,
  );
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
