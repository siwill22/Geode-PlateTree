import { fetchVolumeBytes } from './volume';

/**
 * A per-Reconstruction-Model plate id -> name lookup for the Reference
 * Plate autocomplete control -- see CONTEXT.md's Reference Plate entry and
 * docs/adr/0030. Generated at prep time (prep_plate_names.py) from the
 * SAME static-polygon source feature collection a model's own
 * staticpolygons/geometry.bin comes from, not hand-curated: earlier
 * attempts to hand-write this table (301 = Antarctica) turned out to be
 * simply invented, unrelated to any real dataset -- see
 * docs/plans/reference-plate.md's correction. Not every model's source
 * data carries names at all (Scotese's shapefile has none, checked
 * directly), so an empty PlateNameTable is a real, expected outcome, not a
 * loading failure -- callers fall back to plain numeric plate-id entry
 * (see findReferencePlateMatches()'s own numeric branch).
 */
export type PlateNameTable = Readonly<Record<number, string>>;

const EMPTY_TABLE: PlateNameTable = {};

/** Fetch and parse a Reconstruction Model's plate_names.json (see
 *  ReconstructionManifest.static_polygons.plate_names) -- empty if the path
 *  is undefined (has_plate_names was false for this model). */
export async function fetchPlateNames(
  base: string, path: string | undefined,
): Promise<PlateNameTable> {
  if (!path) return EMPTY_TABLE;
  const bytes = await fetchVolumeBytes(`${base}/${path}`);
  const raw: Record<string, string> = JSON.parse(new TextDecoder().decode(bytes));
  const out: Record<number, string> = {};
  for (const [id, name] of Object.entries(raw)) out[Number(id)] = name;
  return out;
}

export interface ReferencePlateMatch {
  plateId: number;
  name: string;
}

/**
 * Candidates for the Reference Plate autocomplete: `names` entries whose
 * name matches `query` (case-insensitive substring), restricted to plate ids
 * that actually have a rotation series in `availablePlateIds` -- so a
 * suggestion is always immediately selectable, never a dead end (see
 * docs/adr/0030's plate-coverage decision). Bare numeric input (`query` is
 * all digits) matches by id prefix instead, for a user who already knows the
 * plate id and doesn't need the name -- the ONLY thing offered at all for a
 * model with an empty `names` table (see PlateNameTable's own doc comment).
 *
 * An empty `query` (the box just cleared or freshly focused, see
 * ClimateUI's own focus handler) returns exactly plate 0, the default/no-op
 * anchor -- otherwise there would be NO way to discover how to switch back
 * to it once a different plate is set, since 0 is often absent from
 * `availablePlateIds` itself (a plate with an identity rotation frequently
 * isn't written out to the table at all, see prep_reconstruction.py) and
 * the committed display value never shows it as typeable text (see
 * ClimateUI.commitReferencePlateInput's empty-string branch). Plate 0 is
 * likewise always treated as available for an explicit numeric "0" query,
 * for the same reason.
 */
export function findReferencePlateMatches(
  query: string, availablePlateIds: ReadonlySet<number>, names: PlateNameTable,
): ReferencePlateMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ plateId: 0, name: names[0] ?? 'Default' }];

  const isNumeric = /^\d+$/.test(q);
  const ids = availablePlateIds.has(0) ? availablePlateIds : new Set([0, ...availablePlateIds]);
  const out: ReferencePlateMatch[] = [];
  for (const plateId of ids) {
    const name = names[plateId] ?? (plateId === 0 ? 'Default' : undefined);
    if (isNumeric) {
      if (String(plateId).startsWith(q)) out.push({ plateId, name: name ?? `Plate ${plateId}` });
    } else if (name && name.toLowerCase().includes(q)) {
      out.push({ plateId, name });
    }
  }
  return out.sort((a, b) => a.plateId - b.plateId);
}
