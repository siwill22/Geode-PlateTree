import type { LonLat } from './constants';

export interface VariableInfo {
  id: string;
  name: string;
  source_var: string;
  units: string;
  diverging: boolean;
  /**
   * What a HIGH value means physically, which fixes the colour polarity.
   * 'fast' -> cold material at the high end (velocity anomaly);
   * 'hot'  -> warm material at the high end (temperature anomaly).
   * A slab is positive in one and negative in the other, so this cannot be
   * inferred from the model. Absent means 'fast': every model ingested before
   * the convection series was a velocity anomaly.
   */
  high_means?: 'fast' | 'hot';
  /** Range the uint8 quantisation spans. Fixed at ingest; clip cannot exceed it. */
  encode_min: number;
  encode_max: number;
  /** True physical extremes in the source. Metadata only, never used for display. */
  value_min: number;
  value_max: number;
  /** Where the colour ramp starts and ends when first shown. Draggable at runtime. */
  default_clip_min: number;
  default_clip_max: number;
  default_colormap: string;
  /** True for a variable that exists to drive a render layer (e.g. a
   *  shaded-relief overlay) rather than be picked as the primary display
   *  variable -- absent/false for every normal variable. */
  overlay_only?: boolean;
  /** True for a variable that only backs a vector-field render layer (e.g.
   *  a wind glyph field's U or V component) rather than being picked as
   *  the primary display variable -- see Manifest.vector_fields for how
   *  such a pair is declared. Absent/false for every normal variable. */
  vector_only?: boolean;
  /** True for a variable whose encoded value is a CLASS INDEX (e.g. a
   *  Koppen climate classification), not a continuous physical quantity --
   *  the clip sliders are meaningless for it and the colour ramp must be
   *  read as discrete flat blocks, not interpolated. See class_names for
   *  the label of each index and ClimateInstance for where this drives
   *  the shader's uSteps uniform. Absent/false for every normal variable. */
  categorical?: boolean;
  /** Ordered class names/abbreviations matching the encoded class indices
   *  0..N-1, present only when categorical is true. */
  class_names?: string[];
  /** True for a variable that exists only to drive a per-texel validity
   *  mask (land=1/ocean=0 for a continental-only climate run) rather than
   *  being picked as the primary display variable or shown in a legend --
   *  same idea as overlay_only, see Manifest.mask_variable for how the
   *  active one is declared. Absent/false for every normal variable. */
  mask_only?: boolean;
}

/** Declares that two scalar variables in this manifest are the components
 *  of one vector field (e.g. wind), for consumers like core/windGlyphs.ts.
 *  Kept as data rather than a viewer-side assumption about variable ids, so
 *  a different model -- or a different viewer entirely -- can declare its
 *  own pairing without a code change. */
export interface VectorFieldInfo {
  id: string;
  name: string;
  u_variable: string;
  v_variable: string;
  units: string;
  /**
   * Multiplier applied to (u, v) purely for on-screen motion -- arrow
   * length/thickness and streak advection distance -- before the shared
   * SPEED_CLIP_MS-style clip in windGlyphs.ts/windStreaks.ts. Absent means
   * 1 (wind: 10-20 m/s typical, already reads well at that clip). Ocean
   * currents are real but mostly < 0.5 m/s away from a few boundary-current
   * extremes -- at scale 1 they'd sit near MIN_ARROW_LEN and barely creep
   * along as a streak, both correct but visually unreadable. This is a
   * deliberate, disclosed distortion of relative speed (see
   * STREAK_SPEED_SCALE's own doc comment for the precedent: wind's time
   * compression is exactly the same idea, just already baked into one
   * constant because wind was the only field that existed then).
   */
  display_speed_scale?: number;
}

export interface ResolutionInfo {
  id: string;
  nlon: number;
  nlat: number;
  ndepth: number;
}

export interface FrameInfo {
  id: string;
  age_ma: number;
}

export interface Manifest {
  id: string;
  name: string;
  /**
   * 'climate-monthly'/'climate-ocean-depth' are Valdes/BRIDGE's own two
   * Layers, deliberately distinct from 'climate' so archive.json's shared
   * model list naturally sorts them away from climate.html's Li/Pohl picker
   * (which filters on `type === 'climate'` alone) without climate.html
   * needing to know Valdes/BRIDGE exists -- see
   * docs/adr/0008-valdes-bridge-gets-its-own-instance.md. valdes.html reads
   * these two types instead, the same "pick your own models out of the
   * shared archive, unknown to every other viewer" pattern.
   */
  type: 'tomography' | 'convection' | 'climate' | 'paleogeography'
    | 'climate-monthly' | 'climate-ocean-depth';
  source: string;
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
  /** The MODEL's valid depth range, not the mantle's. Never use R_CMB for this. */
  depth_min_km: number;
  depth_max_km: number;
  /**
   * Per-index real-depth labels (km), present only when depth_min_km/
   * depth_max_km are an INDEX range in disguise rather than literal depth
   * -- Valdes/BRIDGE's Ocean Depth Layer, whose 20 native levels are wildly
   * non-uniformly spaced (5m near-surface spacing widening to ~600m near
   * the bottom). volumeUVW's depth mapping is linear across
   * depth_min_km..depth_max_km, which would sample the wrong layer entirely
   * for a non-uniform grid -- so this Layer instead reuses Month's existing
   * trick (see CONTEXT.md's Month/Ocean Depth entries): depth_min_km=0,
   * depth_max_km=ndepth-1, a plain layer INDEX, with this array supplying
   * the real km value to LABEL whichever index is selected. Length always
   * equals the active resolution's `ndepth`. Absent for every model whose
   * depth axis already IS literal depth (uniform by construction) or a
   * calendar index with no physical distance to report (Month).
   */
  depth_labels_km?: number[];
  dtype: string;
  /** The byte (0-255) reserved for "no value at this texel", for a model
   *  where absence is common rather than a thin edge case. Absent for a
   *  model with no such sentinel -- see core/timeSeries.ts's
   *  computeTimeSeries, which skips this byte when tallying its per-Frame
   *  histogram. */
  no_data_sentinel?: number;
  /** Which reconstruction this output was actually built against, read from
   *  that run's own config rather than assumed from the model id or name --
   *  see docs/adr/0004-per-run-coastline-rotations.md. Absent for a model
   *  ingested before this field existed, or one with no per-run
   *  reconstruction concept (e.g. a fixed-geometry static field). Use
   *  core/coastlines.ts's resolveCoastlineSet() to turn this into an actual
   *  coastline set -- never pair a model with coastlines by guessing from
   *  its id/name. */
  reconstruction_model?: string;
  /** Which role this Model plays within its own reconstruction's family
   *  (e.g. "Deformation" vs "Age & Heat Flux") -- a declared catalog fact
   *  (see prep_deformation.py), never inferred from the model id. Lets a
   *  generator recipe group several Models into one comparison viewer
   *  (see generator/recipeTypes.ts) purely from archive.json, without any
   *  id-naming convention. Absent for a Model with no such family concept. */
  comparison_role?: string;
  default_resolution: string;
  resolutions: ResolutionInfo[];
  frames: FrameInfo[];
  path_template: string;
  default_variable: string;
  variables: VariableInfo[];
  vector_fields?: VectorFieldInfo[];
  /** Which variable (marked mask_only) is this model's own land/ocean
   *  validity mask, for a continental-only run -- absent for a model with
   *  full global coverage (nothing to mask). See core/material.ts's
   *  uValidMask and climate/climateInstance.ts's landmask fetch. */
  mask_variable?: string;
}

/** One reconstructable coastline set: present-day geometry plus a rotation
 *  table, the shape core/coastlines.ts's fetchCoastlineData() expects. */
export interface CoastlineSet {
  geometry: string;
  rotations: string;
  age_min: number;
  age_max: number;
}

/** One reconstructable static-polygon set: present-day geometry plus a
 *  rotation table -- the shape core/staticPolygons.ts's
 *  fetchStaticPolygonData() expects. See docs/adr/0025 (Plate-Frame Point).
 *  Unlike CoastlineSet, no archive-wide age_min/age_max: each polygon
 *  feature carries its own begin age (StaticPolygon.beginAge), which is what
 *  bounds a Plate-Frame Point's validity, not a shared range spanning every
 *  feature. */
export interface StaticPolygonSet {
  geometry: string;
  rotations: string;
  /** Present only if the model's own has_plate_names is true -- see
   *  prep_plate_names.py and CONTEXT.md's Reference Plate entry. Not every
   *  model's source data carries plate names at all (Scotese's shapefile
   *  has none, checked directly), so this is genuinely absent sometimes,
   *  never an empty/guessed fallback. */
  plate_names?: string;
}

export interface ArchiveIndex {
  models: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    path: string;
    variables: Array<{ id: string; name: string }>;
    depth_min_km: number;
    depth_max_km: number;
    /** Mirrors the same Model's own manifest.json field -- see Manifest's
     *  doc comment. Carried up to archive.json so a consumer can pick
     *  coastlines from the archive-level summary alone, without a second
     *  fetch of the full manifest. */
    reconstruction_model?: string;
    /** Mirrors the same Model's own manifest.json field -- see Manifest's
     *  doc comment. */
    comparison_role?: string;
  }>;
  colormaps: string;
  /** Muller et al., used by the tomography viewer (index.html). */
  coastlines: CoastlineSet;
  /** petrify series manifest, absent if the boundaries were not exported. */
  boundaries?: string;
  /** Scotese, used by the paleoclimate viewer (climate.html) -- the Li et al.
   *  climate simulations and the Scotese & Wright PaleoDEMs both sit on the
   *  Scotese plate model, so this is the one that's geographically
   *  consistent with them, not `coastlines` above. Absent if not exported. */
  scotese_coastlines?: CoastlineSet;
  /** Per-run coastlines under that run's OWN native rotations, keyed by the
   *  lowercased reconstruction_model string (e.g. "cao2024") -- see
   *  docs/adr/0004-per-run-coastline-rotations.md and
   *  core/coastlines.ts's resolveCoastlineSet(). Absent for an archive with
   *  no per-run coastline exports. */
  native_coastlines?: Record<string, CoastlineSet>;
  /** Reconstruction Models as a first-class catalog section -- see
   *  docs/adr/0021-reconstruction-models-get-their-own-catalog-section.md.
   *  Purely additive: none of the coastline buckets above change meaning,
   *  and this array's entries may point at files living in any of them (no
   *  data is duplicated just to appear here). `has_boundaries` is mirrored
   *  up from the entry's own manifest.json (see ReconstructionManifest) so
   *  a consumer can filter without a second fetch -- the same reason
   *  `reconstruction_model`/`comparison_role` are mirrored onto `models[]`
   *  entries above. Absent for an archive with no exported Reconstruction
   *  Models. */
  reconstruction_models?: ReconstructionEntry[];
}

/** One `ArchiveIndex.reconstruction_models[]` entry -- see
 *  docs/adr/0021-reconstruction-models-get-their-own-catalog-section.md. */
export interface ReconstructionEntry {
  id: string;
  name: string;
  source: string;
  path: string;
  has_boundaries: boolean;
  /** Mirrors the same Reconstruction Model's own manifest.json field --
   *  see ReconstructionManifest and docs/adr/0025. Independent of
   *  has_boundaries (docs/adr/0024): never derive one from the other. */
  has_static_polygons: boolean;
  /** Mirrors the same Reconstruction Model's own manifest.json field -- see
   *  ReconstructionManifest and CONTEXT.md's Reference Plate entry.
   *  Independent of has_static_polygons: a model can have static polygons
   *  with no name data in them at all (Scotese's source shapefile has
   *  none, checked directly -- see prep_plate_names.py). */
  has_plate_names: boolean;
  /** Mirrors the same Reconstruction Model's own manifest.json field -- see
   *  ReconstructionManifest and prep_boucot.py. Independent of the other
   *  `has_*` flags: today only Scotese has this, but nothing ties it to
   *  static polygons/plate names/boundaries existing too. */
  has_paleolithology: boolean;
}

/** A Reconstruction Model's own manifest.json (path from
 *  `ArchiveIndex.reconstruction_models[].path`) -- coastline geometry is
 *  mandatory (every Reconstruction Model has present-day geometry to
 *  reconstruct); Boundary Frames are independently optional and sometimes
 *  permanently absent (see docs/adr/0019 -- Scotese resolves no
 *  topological plates at all, not merely "not yet exported"). */
export interface ReconstructionManifest {
  id: string;
  name: string;
  citation: string;
  /** The gprm.datasets.Reconstructions fetch function this was derived
   *  from (e.g. "fetch_Muller2019") -- provenance, and the guarantee that
   *  coastlines and boundaries below came from the SAME fetch call, never
   *  independently hand-picked files (see docs/adr/0021). */
  source_fetch: string;
  age_min: number;
  age_max: number;
  has_boundaries: boolean;
  /** Independent of has_boundaries -- see docs/adr/0024 and docs/adr/0025.
   *  Never derive one from the other. */
  has_static_polygons: boolean;
  coastlines: CoastlineSet;
  /** petrify series manifest path, present only if has_boundaries. */
  boundaries?: string;
  /** present only if has_static_polygons -- see docs/adr/0025 (Plate-Frame
   *  Point). Shares its rotations with `coastlines` above (same file: the
   *  two sources' plate ids are unioned before it's written, see
   *  prep_reconstruction.py), not a separate rotation table. */
  static_polygons?: StaticPolygonSet;
  /** Boucot, Chen & Scotese (2013) paleoclimate-lithology-indicator points --
   *  present only if exported for this Reconstruction Model (Scotese only,
   *  today) -- see prep_boucot.py and core/pointOverlay.ts. A petrify
   *  `points.json` payload (categories/rotations baked in at prep time), not
   *  a separate rotation table of its own. */
  paleolithology?: { points: string };
  /** The Old Map viewer's exports -- present only if prep/prep_oldmap.py has
   *  been run for this Reconstruction Model (Merdith2021 only, today). See
   *  docs/plans/old-map-viewer.md.
   *
   *  `mountains` is the glyph series, whose positions are real great-circle
   *  results (docs/adr/0037). `continents` is a petrify polygon payload,
   *  produced by that library's own exporter rather than by prep_oldmap.py,
   *  which is why it is optional independently of `mountains`. `volcanoes` comes
   *  from prep_oldmap_volcanoes.py, a separate run, and is optional for the same
   *  reason: an export predating it is still a complete map. */
  oldmap?: {
    mountains: string;
    continents?: string;
    volcanoes?: string;
    decay_myr: number;
    lip_window_myr?: number;
    age_min: number;
    age_max: number;
  };
}

export interface ColormapData {
  [name: string]: {
    diverging: boolean;
    /** Which end of the ramp is warm; null for sequential maps. */
    high_end?: 'warm' | 'cool' | null;
    /**
     * False for a ramp calibrated to one specific variable's own meaning --
     * a fixed class palette (koppen) or a ramp hinged at that variable's own
     * zero point (geo, hinged at sea level) -- rather than a general-purpose
     * scale. Absent/true for anything safe to offer as a generic option for
     * any variable. Only excludes a colormap from generic pickers (see
     * colormapOptions() in tomography/instance.ts); a manifest can still name
     * it directly as a variable's own default_colormap.
     */
    general?: boolean;
    colors: [number, number, number][];
  };
}

/**
 * The cutaway polygon plus how deep it cuts and which side is removed.
 * Every consumer (mask, walls, floor, UI) derives from this and rebuilds on change.
 */
export interface CutawayState {
  vertices: LonLat[];
  closed: boolean;
  depthKm: number;
  /**
   * Which of the two regions is removed. A closed curve on a sphere divides it
   * into two and neither is intrinsically the interior. Seeded on close so the
   * SMALLER region is removed, then sticky: never recomputed on vertex drag.
   */
  inverted: boolean;
}

/** One coastline polyline in present-day coordinates, with its lifespan. */
export interface CoastlineLine {
  plateId: number;
  /** Larger Ma value: when the feature comes into existence. */
  appearAge: number;
  /** Smaller Ma value: when it ceases to exist. */
  disappearAge: number;
  /** Unit vectors in the geographic frame, rotated before frame conversion. */
  points: Float32Array;
  /**
   * Vertices for the filled interior: the boundary plus interior sample points.
   * Separate from `points` because a fill triangulated only on the boundary
   * produces triangles that chord beneath the sphere on continent scales.
   */
  landPoints: Float32Array | null;
  /** Triangle indices into `landPoints`, or null for open polylines. */
  triangles: Uint32Array | null;
}

export interface RotationTable {
  ages: number[];
  anchor: number;
  plates: Record<string, [number, number, number, number][]>;
}

/** One static-polygon feature in present-day, geographic-frame coordinates
 *  -- see docs/adr/0025 (Plate-Frame Point) and prep_staticpolygons.py. */
export interface StaticPolygon {
  plateId: number;
  /** Derived from a feature-type value that differs per Reconstruction
   *  Model, checked directly -- never a separate geometry export, see
   *  docs/adr/0025. */
  continental: boolean;
  /** Larger Ma value: when this crust appeared. Every age older than this is
   *  "no plate here yet" for a point assigned to this feature -- see
   *  docs/adr/0025's "cannot answer" resolution. Named to match the plan
   *  doc/ADR's own vocabulary; semantically the same appear/begin-of-life
   *  concept as CoastlineLine.appearAge. */
  beginAge: number;
  /** Smaller Ma value. Expected to always be ~0/-1e9 by construction --
   *  static polygons are digitized present-day and rotated backward, so they
   *  persist to present (see docs/adr/0025) -- exported anyway so the rare
   *  shapefile exception degrades gracefully instead of being silently
   *  assumed away. */
  endAge: number;
  /** Unit vectors in the geographic frame, present-day, open ring (last
   *  vertex connects back to the first; not repeated in storage). */
  points: Float32Array;
}
