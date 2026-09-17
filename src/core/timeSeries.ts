import { DEG } from './constants';
import type { FrameByteCache } from './frameByteCache';
import { texelToPhysical } from './volume';
import type { Manifest, VariableInfo } from './types';

export interface TimeSeriesPoint {
  age: number;
  /** Area-weighted global mean, or NaN if every texel at this Frame was
   *  masked/no-data -- callers must skip NaN points (a gap), not plot them
   *  as zero. */
  mean: number;
  /** Area-weighted percentiles of the same Frame's texel distribution --
   *  NaN together with `mean` whenever every texel was masked/no-data. p50
   *  is the fan chart's drawn median line; p25/p75 its darker IQR band;
   *  p5/p95 its lighter outer band (deliberately not literal min/max -- see
   *  weightedPercentile's doc comment). */
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

/** The smallest byte whose cumulative weighted histogram mass reaches
 *  `fraction` of the Frame's total weight, decoded to physical units -- a
 *  weighted-cumulative walk over the SAME 256-bin histogram the reduction
 *  loop already builds, so this costs no second read of the volume.
 *  Nearest-bin, not interpolated between bins: the source data is already
 *  only 256 distinct levels (a uint8 texel), so interpolating between two
 *  adjacent bins would fabricate precision the encoding never had. NaN
 *  when the Frame had no valid weight at all (fully masked). */
function weightedPercentile(
  hist: Float64Array, weightSum: number, variable: VariableInfo, fraction: number,
): number {
  if (weightSum <= 0) return NaN;
  const target = fraction * weightSum;
  let cum = 0;
  for (let b = 0; b < 256; b++) {
    cum += hist[b];
    if (cum >= target) return texelToPhysical(variable, b);
  }
  return texelToPhysical(variable, 255);
}

/** How many Frames to fetch/reduce at once -- bounded so a 100+ Frame model
 *  doesn't fire that many simultaneous requests, but high enough that this
 *  doesn't read as one-request-at-a-time slow. Not tied to FrameCache's
 *  FRAME_LIMIT (GPU-residency concern, irrelevant here -- see
 *  fetchVariableBytes's own doc comment). Exported for core/queryPoint.ts's
 *  ageSeries, which fetches/reduces per-Frame the same way. */
export const CONCURRENCY = 8;

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The area-weighted (cos(lat)) global mean of `variable` at every Frame in
 * `manifest`, one point per Frame, in Frame order (not necessarily sorted by
 * age -- see manifest.frames).
 *
 * Reads ONE fixed layer per Frame -- index (ndepth - 1), which is the
 * Annual mean for a climate manifest (prep_climate.py always appends it
 * last) and the only layer for a single-layer one (paleogeography) -- not
 * whichever month `view.month` currently selects. A time-series overview
 * answers "how does the long-term mean move through geological time", a
 * different question from "what does this one season look like right now";
 * tying it to the scrubbable month would also mean recomputing on every
 * month drag, for a chart meant to be computed once and left alone.
 *
 * Honours the model's own validity mask if it has one (manifest.mask_variable,
 * e.g. Pohl's continental-only coverage) -- an unmasked mean would silently
 * average in whatever garbage bytes fill the ocean texels of a run that never
 * computed them, the same "say so, don't fabricate" principle the shader's
 * own uValidMask enforces on screen. The mask has no depth axis of its own
 * (broadcast identically across every layer at prep time -- see
 * loadMask2D's doc comment), so it's read from its own layer 0 regardless of
 * which layer `variable` itself is being read from.
 *
 * Also accumulates a weighted 256-bin histogram per Frame (the byte itself
 * IS the bin, since texelToPhysical decodes it via one linear map) so the
 * five percentiles on TimeSeriesPoint come from the same single pass over
 * the volume that the mean does -- see weightedPercentile.
 *
 * Reads Frame bytes through `cache` (core/frameByteCache.ts) rather than
 * fetching directly, so a session that also queries an Anchored Point
 * (core/queryPoint.ts's ageSeries) on the same (model, variable, resolution)
 * shares the fetch instead of downloading every Frame twice -- see
 * ADR-0011.
 */
export async function computeTimeSeries(
  cache: FrameByteCache, manifest: Manifest, variable: VariableInfo,
  resolutionId: string = manifest.default_resolution,
): Promise<TimeSeriesPoint[]> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId);
  if (!res) throw new Error(`${manifest.id}: no resolution ${resolutionId}`);
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const layerOffset = (ndepth - 1) * plane;
  const maskVar = manifest.mask_variable;
  const sentinel = manifest.no_data_sentinel;

  return mapPool(manifest.frames, CONCURRENCY, async (frame) => {
    const [valueBytes, maskBytes] = await Promise.all([
      cache.get(manifest, variable.id, frame.id, resolutionId),
      maskVar
        ? cache.get(manifest, maskVar, frame.id, resolutionId)
        : Promise.resolve(null),
    ]);

    let weightSum = 0;
    let valueSum = 0;
    const hist = new Float64Array(256);
    for (let j = 0; j < nlat; j++) {
      const lat = -90 + (j * 180) / (nlat - 1);
      const w = Math.cos(lat * DEG);
      const rowBase = j * nlon;
      for (let i = 0; i < nlon; i++) {
        // Mirrors material.ts's uValidMask check (byte >= 128 -- half of
        // 255 -- is the raw-byte equivalent of the shader's `valid >= 0.5`
        // on the GPU-normalised sample).
        if (maskBytes && maskBytes[rowBase + i] < 128) continue;
        const byte = valueBytes[layerOffset + rowBase + i];
        if (sentinel !== undefined && byte === sentinel) continue;
        hist[byte] += w;
        valueSum += w * texelToPhysical(variable, byte);
        weightSum += w;
      }
    }
    return {
      age: frame.age_ma,
      mean: weightSum > 0 ? valueSum / weightSum : NaN,
      p5: weightedPercentile(hist, weightSum, variable, 0.05),
      p25: weightedPercentile(hist, weightSum, variable, 0.25),
      p50: weightedPercentile(hist, weightSum, variable, 0.50),
      p75: weightedPercentile(hist, weightSum, variable, 0.75),
      p95: weightedPercentile(hist, weightSum, variable, 0.95),
    };
  });
}
