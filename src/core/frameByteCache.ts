import { fetchVariableBytes } from './volume';
import type { Manifest } from './types';

/**
 * Decoded per-Frame bytes, cached by (model, variable, resolution, frame) --
 * the CPU-only twin of FrameCache's GPU-texture cache (core/volume.ts),
 * for consumers that reduce a Frame's bytes themselves (core/timeSeries.ts,
 * core/queryPoint.ts's ageSeries) rather than render them.
 *
 * No eviction: a decoded Frame is ~830 KB, far smaller than a GPU texture,
 * and small enough that a whole model's worth (a few hundred MB) is an
 * acceptable session-lifetime cost against re-fetching bytes two features
 * both already need for the same Frame.
 */
export class FrameByteCache {
  private cache = new Map<string, Promise<Uint8Array>>();

  constructor(private base: string) {}

  private key(
    m: Manifest, variableId: string, frameId: string, resolutionId: string,
  ): string {
    return `${m.id}/${variableId}/${resolutionId}/${frameId}`;
  }

  async get(
    m: Manifest, variableId: string, frameId: string,
    resolutionId: string = m.default_resolution,
  ): Promise<Uint8Array> {
    const k = this.key(m, variableId, frameId, resolutionId);
    const hit = this.cache.get(k);
    if (hit) return hit;

    const p = fetchVariableBytes(this.base, m.id, m, variableId, frameId, resolutionId);
    this.cache.set(k, p);
    p.catch(() => this.cache.delete(k)); // let a failed fetch be retried, not cached forever
    return p;
  }
}
