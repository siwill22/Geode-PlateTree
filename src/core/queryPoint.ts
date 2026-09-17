import type { Data3DTexture } from 'three';
import type { LonLat } from './constants';
import type { FrameByteCache } from './frameByteCache';
import { CONCURRENCY, mapPool } from './timeSeries';
import { cellCenter, texelIndex, texelToPhysical } from './volume';
import { positionAt, type PlateFramePoint } from './staticPolygons';
import type { Manifest, ResolutionInfo, RotationTable, VariableInfo } from './types';

/**
 * One cell's value at one Frame -- the unit both Anchored Point query shapes
 * (Month Profile, Age Series) return one array of. `cell` is the sampled
 * cell's own centre (from texelIndex/cellCenter's shared nearest-neighbour
 * convention), not the raw `LonLat` a caller asked for -- at 1 degree
 * resolution the two can visibly disagree, so a caller/UI can show both. See
 * CONTEXT.md's Anchored Point entry and ADR-0011.
 */
export interface CellSample {
  cell: LonLat;
  /** NaN if this cell was masked or held the no-data sentinel at this Frame
   *  -- never a fabricated value, mirroring core/timeSeries.ts's rule. */
  value: number;
}

/** Honours the same validity-mask/sentinel convention core/timeSeries.ts
 *  applies -- byte >= 128 is valid (mirrors material.ts's uValidMask
 *  check), and a sentinel byte (Manifest.no_data_sentinel) is invalid
 *  regardless of the mask. Both are optional: a Model with neither declared
 *  passes every cell through. */
export interface NoDataRule {
  maskBytes?: Uint8Array | null;
  sentinel?: number;
}

function isInvalid(idx: number, byte: number, rule?: NoDataRule): boolean {
  if (!rule) return false;
  if (rule.maskBytes && rule.maskBytes[idx] < 128) return true;
  if (rule.sentinel !== undefined && byte === rule.sentinel) return true;
  return false;
}

/**
 * Month Profile: every layer of `variable`'s currently-loaded Frame (Months
 * plus Annual, or whatever `res.ndepth` holds) at the grid cell nearest
 * `at`. Synchronous and CPU-only -- `tex` is the same Data3DTexture
 * FrameCache already handed the caller for rendering, so this costs no
 * network request beyond what displaying that Frame already paid for.
 *
 * Does NOT exclude categorical Variables (Koppen): unlike Time Series's
 * area-weighted mean, this never combines cells, so a class-index Variable
 * is exactly as queryable as a continuous one -- see ADR-0011.
 */
export function monthProfile(
  tex: Data3DTexture, res: ResolutionInfo, variable: VariableInfo, at: LonLat,
  rule?: NoDataRule,
): CellSample[] {
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const idx = texelIndex(nlon, nlat, at.lon, at.lat);
  const cell = cellCenter(nlon, nlat, idx % nlon, Math.floor(idx / nlon));
  const data = tex.image.data as Uint8Array;

  const out: CellSample[] = new Array(ndepth);
  for (let d = 0; d < ndepth; d++) {
    const byte = data[d * plane + idx];
    out[d] = { cell, value: isInvalid(idx, byte, rule) ? NaN : texelToPhysical(variable, byte) };
  }
  return out;
}

/**
 * Age Series (point): one value per Frame of `manifest`, at the grid cell
 * nearest `at`, Annual layer only -- same reasoning as
 * core/timeSeries.ts's computeTimeSeries: a "how has this cell changed
 * across geological time" question, not tied to whichever Month the
 * scrubbable slider currently shows.
 *
 * Reads Frame bytes through `cache` (core/frameByteCache.ts), the same
 * shared cache computeTimeSeries uses, so a session with both a Time Series
 * panel and an Anchored Point open on the same (model, variable,
 * resolution) fetches each Frame's bytes once, not twice.
 *
 * TRAP for a future caller: `layerOffset` below hardcodes `ndepth - 1` as
 * "the Annual layer", which only holds for a manifest whose depth axis is a
 * calendar (Month + Annual, prep_climate.py always appends Annual last).
 * `bridge-valdes2021-ocean-depth` reuses that same "index range in
 * disguise" trick for actual DEPTH instead (see Manifest.depth_labels_km's
 * own doc comment in types.ts) -- there `ndepth - 1` is the DEEPEST level
 * (5.19 km for that model), not a surface/annual value, and reading it
 * silently returns whatever (likely no-data) sits at abyssal depth rather
 * than erroring. Currently unreachable in this viewer only because
 * ClimateInstance (this function's one caller) is itself restricted to
 * `type === 'climate' | 'climate-monthly'` manifests before it ever reaches
 * here (see climate/main.ts's model filter) -- ValdesInstance holds the
 * ocean-depth manifest instead and never calls this function. Confirmed by
 * a downstream project (SODP) hitting exactly this when it called
 * ageSeries() against the ocean-depth manifest directly, got the no-data
 * sentinel at a real ridge point, and traced it back to this line.
 */
export async function ageSeries(
  cache: FrameByteCache, manifest: Manifest, variable: VariableInfo, at: LonLat,
  resolutionId: string = manifest.default_resolution,
): Promise<(CellSample & { age: number })[]> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId);
  if (!res) throw new Error(`${manifest.id}: no resolution ${resolutionId}`);
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const layerOffset = (ndepth - 1) * plane;
  const maskVar = manifest.mask_variable;
  const sentinel = manifest.no_data_sentinel;

  const idx = texelIndex(nlon, nlat, at.lon, at.lat);
  const cell = cellCenter(nlon, nlat, idx % nlon, Math.floor(idx / nlon));

  return mapPool(manifest.frames, CONCURRENCY, async (frame) => {
    const [valueBytes, maskBytes] = await Promise.all([
      cache.get(manifest, variable.id, frame.id, resolutionId),
      maskVar ? cache.get(manifest, maskVar, frame.id, resolutionId) : Promise.resolve(null),
    ]);
    const byte = valueBytes[layerOffset + idx];
    const invalid = isInvalid(idx, byte, { maskBytes, sentinel });
    return { age: frame.age_ma, cell, value: invalid ? NaN : texelToPhysical(variable, byte) };
  });
}

/**
 * Age Series for a Plate-Frame Point (docs/adr/0025): the same "how has this
 * cell changed across geological time" question as ageSeries() above, except
 * the grid cell moves with the point's assigned Plate instead of staying
 * fixed. Frames older than `point.beginAge` are left out entirely rather
 * than padded with a per-entry "no plate" marker -- the ADR's resolution was
 * that the cutoff applies uniformly, once, not per age, so a caller already
 * holding `point.beginAge` needs no per-entry outcome to act on it (e.g. to
 * show "no plate before X Ma" as a series boundary, not a gap inside it).
 *
 * Same `ndepth - 1` = "Annual layer" trap as ageSeries() above applies here
 * too -- see its doc comment. Currently unreachable for the identical
 * reason (ClimateInstance never holds an ocean-depth manifest).
 */
export async function plateFrameAgeSeries(
  cache: FrameByteCache, manifest: Manifest, variable: VariableInfo,
  point: PlateFramePoint, table: RotationTable,
  resolutionId: string = manifest.default_resolution,
): Promise<(CellSample & { age: number })[]> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId);
  if (!res) throw new Error(`${manifest.id}: no resolution ${resolutionId}`);
  const { nlon, nlat, ndepth } = res;
  const plane = nlon * nlat;
  const layerOffset = (ndepth - 1) * plane;
  const maskVar = manifest.mask_variable;
  const sentinel = manifest.no_data_sentinel;

  const frames = manifest.frames.filter((f) => f.age_ma <= point.beginAge);

  return mapPool(frames, CONCURRENCY, async (frame) => {
    const at = positionAt(point, table, frame.age_ma)!; // frames filtered above, so never null
    const idx = texelIndex(nlon, nlat, at.lon, at.lat);
    const cell = cellCenter(nlon, nlat, idx % nlon, Math.floor(idx / nlon));

    const [valueBytes, maskBytes] = await Promise.all([
      cache.get(manifest, variable.id, frame.id, resolutionId),
      maskVar ? cache.get(manifest, maskVar, frame.id, resolutionId) : Promise.resolve(null),
    ]);
    const byte = valueBytes[layerOffset + idx];
    const invalid = isInvalid(idx, byte, { maskBytes, sentinel });
    return { age: frame.age_ma, cell, value: invalid ? NaN : texelToPhysical(variable, byte) };
  });
}

/**
 * Month Profile for a Plate-Frame Point (docs/adr/0025). Month Profile is
 * inherently single-Frame, so the plate machinery engages only trivially: one
 * rotation from the point's reference age to whichever Frame `tex`/`res`
 * currently hold, to find the grid cell -- then it's exactly monthProfile()
 * from there. Reading the point's raw reference-age LonLat against a
 * different Frame's age instead would silently reintroduce the
 * mismatched-provenance bug ADR-0004 already guards against, just in a new
 * dimension. Returns null if the given Frame's age is older than
 * `point.beginAge` -- "no plate here yet", the same outcome
 * plateFrameAgeSeries() applies per-Frame, here applied to the single
 * requested one.
 */
export function plateFrameMonthProfile(
  tex: Data3DTexture, res: ResolutionInfo, variable: VariableInfo,
  point: PlateFramePoint, table: RotationTable, frameAge: number,
  rule?: NoDataRule,
): CellSample[] | null {
  const at = positionAt(point, table, frameAge);
  if (!at) return null;
  return monthProfile(tex, res, variable, at, rule);
}
