import {
  Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, NearestFilter,
  RepeatWrapping, ClampToEdgeWrapping, DataTexture, RGBAFormat,
} from 'three';
import type {
  ArchiveIndex, ColormapData, FrameInfo, Manifest, VariableInfo,
} from './types';
import type { LonLat } from './constants';

export async function loadArchive(base: string): Promise<ArchiveIndex> {
  const r = await fetch(`${base}/archive.json`);
  if (!r.ok) throw new Error(`archive.json: ${r.status}`);
  return r.json();
}

export async function loadManifest(base: string, path: string): Promise<Manifest> {
  const r = await fetch(`${base}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export async function loadColormaps(base: string, path: string): Promise<ColormapData> {
  const r = await fetch(`${base}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/**
 * Build the 256x1 colour ramp texture.
 *
 * The .cpt files already carry all 256 entries, so prep copies them verbatim
 * and we upload them verbatim -- no interpolation anywhere. These maps are
 * perceptually uniform because of their specific sampling; re-deriving them
 * from a sparse subset would quietly destroy that.
 */
export function makeColormapTexture(colors: [number, number, number][]): DataTexture {
  const n = colors.length;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4 + 0] = colors[i][0];
    data[i * 4 + 1] = colors[i][1];
    data[i * 4 + 2] = colors[i][2];
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, n, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function resolvePath(
  m: Manifest, variable: string, frame: string, resolutionId: string = m.default_resolution,
): string {
  return m.path_template
    .replace('{variable}', variable)
    .replace('{resolution}', resolutionId)
    .replace('{frame}', frame);
}

/**
 * Fetch a URL's bytes, transparently un-gzipping a `.gz` file.
 *
 * The deployed archive gzips volumes AND, per prep/pack_deploy.mjs, the
 * larger coastline/boundary assets (a static host will not compress
 * application/octet-stream for us, and these files roughly halve) --
 * despite the name, this is the one gzip-aware fetch every asset type
 * routes through (core/coastlines.ts's fetchCoastlineData() included), so
 * there is exactly one place that knows how to tell a gzipped response
 * from a plain one. The referencing manifest field carries the `.gz`, so
 * nothing else has to know.
 *
 * The extension alone is NOT enough to decide whether to decompress. A server
 * may serve a .gz file with `Content-Encoding: gzip`, in which case the browser
 * has already decoded it by the time we see the bytes -- and decompressing
 * again fails. Browsers strip Content-Encoding from the readable headers, so we
 * cannot ask; instead we look for the gzip magic number in the bytes we
 * actually got. That is correct under either transport, which is what lets the
 * dev server and GitHub Pages disagree about this without anyone noticing.
 */
export async function fetchVolumeBytes(path: string): Promise<Uint8Array> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const raw = new Uint8Array(await r.arrayBuffer());

  const gzipped = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!path.endsWith('.gz') || !gzipped) return raw;

  const stream = new Blob([raw as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Load one volume as a Data3DTexture.
 *
 * Memory order is longitude fastest, then latitude, then depth -- which is what
 * Data3DTexture expects for (width, height, depth). RepeatWrapping on S so that
 * profiles crossing the antimeridian interpolate across the seam; clamp on T
 * and R so the poles and the top/bottom levels do not wrap into each other.
 *
 * Categorical variables (e.g. Köppen class) use NearestFilter instead: their
 * texel values are class indices, not samples of a continuous field, so
 * blending two neighbouring classes' bytes produces a meaningless third
 * class rather than an in-between physical value.
 */
export async function loadVolume(
  base: string,
  modelId: string,
  manifest: Manifest,
  variableId: string,
  frameId: string,
  resolutionId: string = manifest.default_resolution,
): Promise<Data3DTexture> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId)!;
  const path = `${base}/models/${modelId}/${resolvePath(manifest, variableId, frameId, resolutionId)}`;
  const buf = await fetchVolumeBytes(path);

  const expected = res.nlon * res.nlat * res.ndepth;
  if (buf.length !== expected) {
    throw new Error(`${path}: got ${buf.length} bytes, expected ${expected}`);
  }

  // Categorical values are class indices (see above); a model that reserves
  // a NO-DATA sentinel byte (manifest.no_data_sentinel, see ADR-0005) has
  // the same problem in the other direction -- linear-blending a real value
  // against the sentinel fabricates a plausible-looking intermediate colour
  // at every boundary, which core/material.ts's sentinel check would then
  // fail to catch (a blend is almost never exactly the sentinel value).
  // Nearest sampling keeps every texel one of its original bytes.
  const categorical = manifest.variables.find((v) => v.id === variableId)?.categorical ?? false;
  const sparse = manifest.no_data_sentinel !== undefined;
  const filter = (categorical || sparse) ? NearestFilter : LinearFilter;

  const tex = new Data3DTexture(buf, res.nlon, res.nlat, res.ndepth);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.magFilter = filter;
  tex.minFilter = filter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Fetch one variable's raw undecoded bytes for one frame, without creating a
 * GPU texture -- the CPU-only twin of loadVolume(), for a consumer that only
 * ever reduces the bytes itself (see core/timeSeries.ts) and would otherwise
 * pay for a texture upload (and, at FrameCache's FRAME_LIMIT, an immediate
 * eviction/disposal) it has no use for. Same path-resolution and
 * gzip-transparency as loadVolume(); no shape validation here, since a CPU
 * reducer indexes the buffer directly against its own (nlon, nlat, ndepth)
 * rather than through a texture that would fail to construct on a mismatch.
 */
export async function fetchVariableBytes(
  base: string, modelId: string, manifest: Manifest, variableId: string, frameId: string,
  resolutionId: string = manifest.default_resolution,
): Promise<Uint8Array> {
  const path = `${base}/models/${modelId}/${resolvePath(manifest, variableId, frameId, resolutionId)}`;
  return fetchVolumeBytes(path);
}

/**
 * Load a per-age validity/landmask frame as a plain 2D DataTexture, for
 * core/material.ts's uValidMask -- distinct from loadVolume()'s
 * Data3DTexture, since a land/ocean mask has no month axis (ClimateInstance
 * only re-fetches this on an age change, see applyAge()). The frame file on
 * disk is still shaped (ndepth, nlat, nlon) like every other variable in the
 * manifest -- broadcast across every layer at prep time (see
 * prep_pohl.py's MASK_VAR_ID), so every layer is an identical copy and only
 * the first nlat*nlon slice is used here. No FrameCache entry: at ~65 KB
 * (360x181) and only refetched per age, not worth generalising that class's
 * Data3DTexture-only typing for this one caller.
 */
export async function loadMask2D(
  base: string,
  modelId: string,
  manifest: Manifest,
  variableId: string,
  frameId: string,
  resolutionId: string = manifest.default_resolution,
): Promise<DataTexture> {
  const res = manifest.resolutions.find((r) => r.id === resolutionId)!;
  const path = `${base}/models/${modelId}/${resolvePath(manifest, variableId, frameId, resolutionId)}`;
  const buf = await fetchVolumeBytes(path);

  const plane = res.nlon * res.nlat;
  const expected = plane * res.ndepth;
  if (buf.length !== expected) {
    throw new Error(`${path}: got ${buf.length} bytes, expected ${expected}`);
  }

  const tex = new DataTexture(buf.subarray(0, plane), res.nlon, res.nlat, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** The frame whose age is closest to `age`. Frames need not be evenly spaced. */
export function nearestFrame(m: Manifest, age: number): FrameInfo {
  let best = m.frames[0];
  let bestGap = Math.abs(best.age_ma - age);
  for (const f of m.frames) {
    const gap = Math.abs(f.age_ma - age);
    if (gap < bestGap) { best = f; bestGap = gap; }
  }
  return best;
}

/**
 * Volume frames, kept as GPU textures with an LRU bound.
 *
 * A convection series is one 12 MB texture per age, so it can neither be
 * preloaded whole nor re-fetched on every slider move. Four frames is enough to
 * hold the current one plus its neighbours in both directions, which is the
 * access pattern scrubbing actually produces.
 *
 * The frame on screen is pinned: evicting a texture still bound to a material's
 * uVolume would leave the wall sampling a disposed texture.
 */
const FRAME_LIMIT = 4;

export class FrameCache {
  private lru = new Map<string, Data3DTexture>();
  private inflight = new Map<string, Promise<Data3DTexture>>();
  private pinned: string | null = null;

  constructor(private base: string) {}

  /** `resolutionId` defaults to the manifest's own default so every
   *  existing caller (which never had a resolution to choose) keeps working
   *  unchanged. Embedding the ACTUALLY-requested resolution here (not
   *  `m.default_resolution`) is what makes a resolution switch fetch a new
   *  texture instead of silently re-serving whatever is cached under the
   *  default -- see climate/climateInstance.ts's setResolution(). */
  private key(
    m: Manifest, variableId: string, frameId: string, resolutionId: string = m.default_resolution,
  ): string {
    return `${m.id}/${variableId}/${resolutionId}/${frameId}`;
  }

  async get(
    m: Manifest, variableId: string, frameId: string, resolutionId: string = m.default_resolution,
  ): Promise<Data3DTexture> {
    const k = this.key(m, variableId, frameId, resolutionId);

    const hit = this.lru.get(k);
    if (hit) {                       // refresh recency
      this.lru.delete(k);
      this.lru.set(k, hit);
      return hit;
    }
    const pending = this.inflight.get(k);
    if (pending) return pending;

    const p = loadVolume(this.base, m.id, m, variableId, frameId, resolutionId)
      .then((tex) => {
        this.lru.set(k, tex);
        this.inflight.delete(k);
        this.evict();
        return tex;
      })
      .catch((e) => { this.inflight.delete(k); throw e; });
    this.inflight.set(k, p);
    return p;
  }

  /** Mark a frame as on-screen so it survives eviction. */
  pin(
    m: Manifest, variableId: string, frameId: string, resolutionId: string = m.default_resolution,
  ): void {
    this.pinned = this.key(m, variableId, frameId, resolutionId);
  }

  /** Warm the neighbours of `frameId` in the background; failures are ignored. */
  prefetchNeighbours(
    m: Manifest, variableId: string, frameId: string, resolutionId: string = m.default_resolution,
  ): void {
    const i = m.frames.findIndex((f) => f.id === frameId);
    if (i < 0) return;
    for (const j of [i + 1, i - 1]) {
      if (j >= 0 && j < m.frames.length) {
        void this.get(m, variableId, m.frames[j].id, resolutionId).catch(() => {});
      }
    }
  }

  private evict(): void {
    for (const k of [...this.lru.keys()]) {
      if (this.lru.size <= FRAME_LIMIT) break;
      if (k === this.pinned) continue;
      this.lru.get(k)!.dispose();
      this.lru.delete(k);
    }
  }
}

/** Physical value -> the 0..1 space the shader clips in. */
export function physicalToEncoded(v: VariableInfo, x: number): number {
  return (x - v.encode_min) / (v.encode_max - v.encode_min);
}

/** A raw uint8 texel (0..255) -> the physical value it encodes. Inverse of
 *  physicalToEncoded's mapping, for CPU-side reads of a Data3DTexture's own
 *  backing buffer (see core/windGlyphs.ts) rather than the GPU shader path. */
export function texelToPhysical(v: VariableInfo, byte: number): number {
  return v.encode_min + (byte / 255) * (v.encode_max - v.encode_min);
}

/**
 * A categorical Variable's already-decoded texelToPhysical() value -> its
 * class index. FLOOR, never round: prep_climate.py encodes each class at
 * its band centre (class + 0.5, not the raw integer) specifically so that
 * decoding via floor() recovers it correctly -- the GPU shader path decodes
 * the exact same way (floor(t * uSteps)), see material.ts. A naive round()
 * looks equivalent at first glance but silently shifts every class down by
 * one except class 0 (this exact bug shipped once for Koppen -- see
 * prep_climate.py's own comment on the encode step -- confirmed by reading
 * back the actual encoded bytes, not the pre-encoding array).
 */
export function classIndexFromValue(value: number): number {
  return Math.floor(value);
}

/** A categorical Variable's decoded value -> its class name, or a numbered
 *  fallback if `class_names` doesn't cover the index (stale manifest, or a
 *  variable marked categorical without names). */
export function classNameFor(v: VariableInfo, value: number): string {
  const i = classIndexFromValue(value);
  return v.class_names?.[i] ?? `class ${i}`;
}

/** (lon, lat) -> the flat index into one month's (nlat, nlon) plane. Mirrors
 *  geographic.ts's volumeUVW mapping exactly (see GEOGRAPHIC_GLSL): no
 *  half-texel offset on longitude (it wraps, no duplicate column), nearest
 *  gridline-registered row on latitude. Shared by every CPU-side consumer of
 *  a wind plane's raw bytes (core/windGlyphs.ts, core/windStreaks.ts) so the
 *  two can never drift apart on this mapping. */
export function texelIndex(nlon: number, nlat: number, lon: number, lat: number): number {
  const pLon = (lon + 180) / 360;
  let iLon = Math.floor(pLon * nlon) % nlon;
  if (iLon < 0) iLon += nlon;
  const pLat = (lat + 90) / 180;
  const jLat = Math.min(nlat - 1, Math.max(0, Math.round(pLat * (nlat - 1))));
  return jLat * nlon + iLon;
}

/** (iLon, jLat) -> that cell's own centre. The exact inverse of texelIndex's
 *  mapping (longitude is a cell index -> its midpoint; latitude is already a
 *  gridline node -> itself), for a query result to report "this is the cell
 *  that actually answered" rather than only echo the coordinate a caller
 *  asked for -- see core/queryPoint.ts and ADR-0011. */
export function cellCenter(nlon: number, nlat: number, iLon: number, jLat: number): LonLat {
  return {
    lon: ((iLon + 0.5) / nlon) * 360 - 180,
    lat: (jLat / (nlat - 1)) * 180 - 90,
  };
}
