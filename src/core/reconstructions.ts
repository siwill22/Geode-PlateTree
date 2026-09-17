import type { ReconstructionManifest } from './types';

/** Fetch a Reconstruction Model's own manifest.json, given its
 *  `archive.json` `reconstruction_models[]` entry's `path`. */
export async function loadReconstructionManifest(base: string, path: string): Promise<ReconstructionManifest> {
  const r = await fetch(`${base}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/**
 * A Reconstruction Model's own manifest stores its `coastlines`/`boundaries`
 * paths relative to ITS OWN directory (`archive/reconstructions/<id>/`),
 * never archive-root-relative -- the same convention `core/volume.ts`'s
 * `loadVolume()` already uses for a numerical Model's `models/<id>/`
 * directory (see its hardcoded `models/${modelId}/` prefix). Centralized
 * here rather than duplicated in each wrapper because getting this wrong
 * (e.g. resolving against archive root instead) fails silently as a 404,
 * not a type error.
 */
export function reconstructionAssetUrl(
  archiveBase: string, manifest: ReconstructionManifest, relPath: string,
): string {
  return `${archiveBase}/${reconstructionAssetPath(manifest, relPath)}`;
}

/** Same as `reconstructionAssetUrl`, but relative to the archive base
 *  rather than a full URL -- what `core/coastlines.ts`'s
 *  `fetchCoastlineData(base, geometryPath, rotationsPath)` wants. */
export function reconstructionAssetPath(manifest: ReconstructionManifest, relPath: string): string {
  return `reconstructions/${manifest.id}/${relPath}`;
}
