#!/usr/bin/env python3
"""Export a per-plate-id name lookup for the Reference Plate autocomplete
control (see CONTEXT.md's Reference Plate entry and docs/adr/0030).

Not a hand-curated table -- generated from the SAME static-polygon source
feature collection a model's own staticpolygons/geometry.bin already comes
from (see prep_staticpolygons.py), because that source data genuinely
carries a shapefile NAME attribute for Muller2019 and Seton2012 (checked
directly, empirically, against the real fetched files -- see
docs/plans/reference-plate.md's correction). A plate id is typically built
from several named features at different scales (a whole continent, plus
cratons/microcontinents/fragments), so one name per plate id is chosen as
the LARGEST-AREA named feature assigned to that id -- the same "largest
polygon wins" tie-break docs/adr/0025's assignPlate() already uses for an
analogous problem, not a new invented rule.

Scotese's static-polygon shapefile carries NO name data at all on any
feature (confirmed directly: 0 of 240 features named) -- this script then
writes nothing for it (an absent plate_names.json, matching the has_boundaries
/has_static_polygons "not every model has this" convention), and the client
falls back to plain numeric plate-id entry for that model, not a guess.

Output: plate_names.json, {"<plate_id>": "<name>", ...}, sorted by key.
Never written if no feature in the source collection carries a name at all.
"""

import json

import pygplates


def export_plate_names(static_polygon_files, out_path):
    """Write plate_names.json from `static_polygon_files` (the same list
    passed to export_static_polygons()). Returns the dict written, or None
    if no feature in the source collection had a name at all (nothing
    written in that case -- see module doc comment).
    """
    features = pygplates.FeatureCollection()
    for f in static_polygon_files:
        features.add(pygplates.FeatureCollection(str(f)))

    best = {}  # plate_id -> (area, name)
    n_named = 0
    for feature in features:
        name = feature.get_name()
        if not name:
            continue
        n_named += 1
        plate_id = feature.get_reconstruction_plate_id()
        area = sum(
            geom.get_area() for geom in feature.get_geometries()
            if isinstance(geom, pygplates.PolygonOnSphere)
        )
        if area <= 0:
            continue
        prev = best.get(plate_id)
        if prev is None or area > prev[0]:
            best[plate_id] = (area, name)

    if n_named == 0:
        print("  plate names      none -- no feature in this model's source "
              "shapefile carries a name (client falls back to numeric ids)")
        return None

    names = {str(pid): name for pid, (_area, name) in best.items()}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(names, indent=2, sort_keys=True))
    print(f"  plate names      {len(names)} plate ids named "
          f"(from {n_named} named features)")
    return names
