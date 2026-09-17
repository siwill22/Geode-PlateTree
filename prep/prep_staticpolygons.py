#!/usr/bin/env python3
"""Export a Reconstruction Model's static polygons for browser-side plate
assignment (Plate-Frame Point, see docs/adr/0025).

Static polygons are digitized in present-day space and rotated in the
browser -- the same reasoning as coastlines, ADR-0001 -- so this ships
present-day geometry once; the client rotates it per plate id, per age,
through the SAME rotations.json a Reconstruction Model's coastlines already
use (see prep_reconstruction.py -- the plate id sets are unioned before that
file is written, so it covers whichever plate ids either source needs).

Assignment tests against one static-polygon FEATURE, not just a plate id: a
plate id's coverage is typically built from several features, each with its
own valid-time BEGIN age (the age this piece of crust appeared). By
construction every static-polygon feature persists to present -- it was
digitized FROM present-day geometry -- so ADR-0025 established there is no
"disappeared before present" case to design for. disappear_age is exported
anyway and handled with the same generic sentinel/skip convention coastlines
already use, so the rare shapefile exception (see ADR-0025) degrades
gracefully instead of being silently assumed away.

"Continental" is a per-feature flag, not a separate geometry export (see
ADR-0025 -- exporting continent_polygons_files alongside this would ship
near-duplicate geometry for a distinction the static-polygon file can
already carry as one bit per feature). Which feature-type value means
"continental" is a per-Reconstruction-Model fact, checked directly against
that model's own static polygon shapefile -- see CONTINENTAL_FEATURE_TYPES
below -- never inferred or assumed shared, the same discipline ADR-0024
already established for polygon availability itself.

Output: staticpolygons/geometry.bin, binary, little-endian:
  magic     'ESSP' (4 bytes)
  version   uint32 = 1
  npolys    uint32
  then per polygon:
    plate_id        int32
    continental     uint8   (1 = continental, 0 = not; padded to 4 bytes)
    appear_age      float32 (larger Ma -- when this crust appeared; +inf -> 1e9)
    disappear_age   float32 (smaller Ma; -inf -> -1e9 -- expected to always
                             be ~0/-1e9 by construction, see ADR-0025)
    npoints         uint32
    xyz             float32 * 3 * npoints (unit sphere, present-day, open ring)
"""

import struct

import numpy as np
import pygplates

from prep_coastlines import finite_or

# Checked directly against gprm's own static-polygon shapefile per model (see
# docs/adr/0025). Scotese's static_polygon_files IS its continent_polygons_files
# -- the literal same shapefile, no oceanic coverage at all -- so every feature
# there is continental by construction, not by a feature-type check (None
# means exactly that, not "unknown").
#
# Merdith2021 needed nine types, not one, and the check that established them is
# worth recording because it is the strongest form this test can take: that
# model ships BOTH a static-polygon file and a separate continents file, and
# comparing the two settles the question from the model's own statement rather
# than from the type names. Measured over every polygon in each file:
#
#   - gpml:Basin covers 58.99% of the globe in the static polygons (named
#     'Pacific', 'Panthalassa', ...) and appears ZERO times in the continents
#     file. It is the model's oceanic crust.
#   - All nine other types appear in the continents file with matching areas,
#     summing to 41.04% of the globe -- high against today's ~29%, as expected
#     for a compilation that includes submerged and stretched continental crust.
#   - The two files' non-Basin contents differ by exactly one polygon and a
#     batch of Tien Shan renames/plate-id swaps, all ClosedContinentalBoundary
#     on both sides. No type-level disagreement at all.
#
# So the mapping below is the complement of {gpml:Basin}. It is written out
# positively anyway, to keep one schema for every model and because an unknown
# future type defaulting to oceanic is the safer of the two failure modes.
# Note Merdith2021 counts gpml:IslandArc (Tonga, Kermadec) as continental --
# that is the model's call, not ours.
CONTINENTAL_FEATURE_TYPES = {
    "Muller2019": {"gpml:ClosedContinentalBoundary"},
    "Seton2012": {"gpml:ContinentalFragment"},
    "Scotese": None,
    "Merdith2021": {
        "gpml:ClosedContinentalBoundary", "gpml:UnclassifiedFeature",
        "gpml:Craton", "gpml:IslandArc", "gpml:Coastline",
        "gpml:TerraneBoundary", "gpml:InferredPaleoBoundary",
        "gpml:ContinentalFragment", "gpml:PassiveContinentalBoundary",
    },
    # Cao2024, checked the same way Merdith2021 was -- against its own two
    # files, not by analogy -- and giving the same answer. gpml:Basin (1546 of
    # 2417 static-polygon features) appears ZERO times in
    # continent_polygons_files; all nine other types appear there with matching
    # counts (652/651 ClosedContinentalBoundary, 152/153 UnclassifiedFeature,
    # 34/34 IslandArc, 15/15 TerraneBoundary, 5/5 Craton, 5/5
    # ContinentalFragment, 4/4 Coastline, 3/3 InferredPaleoBoundary, 1/2
    # PassiveContinentalBoundary). So this is the complement of {gpml:Basin},
    # written out positively for the same reasons given above.
    "Cao2024": {
        "gpml:ClosedContinentalBoundary", "gpml:UnclassifiedFeature",
        "gpml:Craton", "gpml:IslandArc", "gpml:Coastline",
        "gpml:TerraneBoundary", "gpml:InferredPaleoBoundary",
        "gpml:ContinentalFragment", "gpml:PassiveContinentalBoundary",
    },
}


def export_static_polygons(model_name, static_polygon_files, out_path):
    """Write present-day static polygons with plate id, continental flag,
    and valid time. Returns (sorted plate ids, {plate_id: (n_polys, n_pts)})
    -- the second matching export_geometry()'s line_counts shape, so
    prep_reconstruction.py can merge the two for one combined stuck-plate
    report.
    """
    if model_name not in CONTINENTAL_FEATURE_TYPES:
        raise SystemExit(
            f"{model_name}: no continental-feature-type mapping declared in "
            "CONTINENTAL_FEATURE_TYPES. Check this model's own static-polygon "
            "shapefile feature-type distribution directly before adding one -- "
            "never assume it matches an existing model, see docs/adr/0025.")
    continental_types = CONTINENTAL_FEATURE_TYPES[model_name]

    features = pygplates.FeatureCollection()
    for f in static_polygon_files:
        features.add(pygplates.FeatureCollection(str(f)))

    polys = []
    plate_ids = set()
    n_continental = 0
    for feature in features:
        plate_id = feature.get_reconstruction_plate_id()
        begin, end = feature.get_valid_time()
        appear = finite_or(begin, 1.0e9)
        disappear = finite_or(end, -1.0e9)
        continental = (
            True if continental_types is None
            else str(feature.get_feature_type()) in continental_types
        )

        for geom in feature.get_geometries():
            if not isinstance(geom, pygplates.PolygonOnSphere):
                continue
            pts = np.array([p.to_xyz() for p in geom.get_points()], dtype=np.float64)
            if len(pts) < 3:
                continue
            polys.append((plate_id, continental, appear, disappear,
                          pts.astype(np.float32)))
            plate_ids.add(plate_id)
            if continental:
                n_continental += 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(b"ESSP")
        fh.write(struct.pack("<II", 1, len(polys)))
        for plate_id, continental, appear, disappear, pts in polys:
            fh.write(struct.pack("<iBxxxffI", plate_id, 1 if continental else 0,
                                 appear, disappear, len(pts)))
            pts.tofile(fh)

    npts = sum(len(p) for _, _, _, _, p in polys)
    mb = out_path.stat().st_size / 1024 / 1024
    print(f"  static polygons  {len(polys)} polygons ({n_continental} continental), "
          f"{npts} points, {mb:.2f} MB")
    print(f"  plates           {len(plate_ids)} distinct ids")

    poly_counts = {}
    for plate_id, _, _, _, pts in polys:
        n, npts_ = poly_counts.get(plate_id, (0, 0))
        poly_counts[plate_id] = (n + 1, npts_ + len(pts))

    return sorted(plate_ids), poly_counts
