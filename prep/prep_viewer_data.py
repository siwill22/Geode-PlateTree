#!/usr/bin/env python3
"""Export everything the Plate Tree viewer needs for one Reconstruction Model.

Every asset comes from a SINGLE `gprm.datasets.Reconstructions.fetch_<model>()`
call, never from hand-picked file paths. That is what keeps rotations, present-
day geometry and static polygons a coherent set that cannot be mixed -- and it
is not theoretical: Cao2024 is an 1800 Ma model split across TWO rotation files
at the 1000 Ma boundary, and loading only one of them makes pygplates silently
return the identity rotation for every plate id absent from it, so a subset of
plates simply never moves. The fetch object returns both.

Usage:
  conda run -n pygmt17 python prep/prep_viewer_data.py \\
      --model Cao2024 --name "Cao et al. 2024" --age-max 1800 --age-step 5
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from prep_coastlines import export_geometry, export_rotations  # noqa: E402
from prep_staticpolygons import export_static_polygons  # noqa: E402
from prep_plate_names import export_plate_names  # noqa: E402
from prep_platetree import export_plate_tree  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True,
                    help="gprm Reconstructions name, e.g. Cao2024")
    ap.add_argument("--id", help="output directory name (default: model lowercased)")
    ap.add_argument("--name", required=True, help="display name")
    ap.add_argument("--citation", default="")
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=1800.0)
    ap.add_argument("--age-step", type=float, default=5.0,
                    help="sampling step for the tree and the rotation table. "
                         "Node POSITIONS stay continuous regardless -- only "
                         "tree topology and group membership snap to this.")
    ap.add_argument("--anchor", type=int, default=0)
    ap.add_argument("--fill-spacing-deg", type=float, default=2.0)
    ap.add_argument("--out", type=Path, default=Path("public/data"))
    args = ap.parse_args()

    from gprm.datasets import Reconstructions
    fetch = getattr(Reconstructions, f"fetch_{args.model}", None)
    if fetch is None:
        available = sorted(n[len("fetch_"):] for n in dir(Reconstructions)
                           if n.startswith("fetch_"))
        raise SystemExit(f"unknown model {args.model!r}. Available: {', '.join(available)}")

    recon_id = args.id or args.model.lower()
    out = args.out / "reconstructions" / recon_id
    (out / "coastlines").mkdir(parents=True, exist_ok=True)

    print(f"fetching {args.model} ...")
    m = fetch()

    geometry_files = list(m.coastlines_files) or list(m.continent_polygons_files)
    if not geometry_files:
        raise SystemExit(f"{args.model} ships no present-day geometry to reconstruct")
    source_kind = "coastlines" if m.coastlines_files else "continent_polygons"
    rotation_files = list(m.rotation_files)
    static_polygon_files = list(m.static_polygon_files)
    if not static_polygon_files:
        raise SystemExit(
            f"{args.model} has no static polygons. A Plate Tree gets its nodes "
            "from static-polygon centroids, so this model cannot be shown.")

    print(f"  geometry source : {source_kind} ({len(geometry_files)} file(s))")
    print(f"  rotation files  : {len(rotation_files)}")
    for f in rotation_files:
        print(f"                    {Path(str(f)).name}")

    print("\nexporting coastlines ...")
    plate_ids, line_counts = export_geometry(
        geometry_files, out / "coastlines" / "geometry.bin", args.fill_spacing_deg)

    print("\nexporting static polygons ...")
    static_plate_ids, static_counts = export_static_polygons(
        args.model, static_polygon_files, out / "staticpolygons" / "geometry.bin")
    plate_ids = sorted(set(plate_ids) | set(static_plate_ids))
    for pid, (n, npts) in static_counts.items():
        ln, lp = line_counts.get(pid, (0, 0))
        line_counts[pid] = (ln + n, lp + npts)

    plate_names = export_plate_names(
        static_polygon_files, out / "staticpolygons" / "plate_names.json")
    has_plate_names = plate_names is not None
    print(f"  plate names      {'yes' if has_plate_names else 'none in source data'}")

    ages = np.arange(args.age_min, args.age_max + args.age_step / 2, args.age_step)

    print("\nexporting rotations ...")
    export_rotations(rotation_files, plate_ids, ages, args.anchor,
                     out / "coastlines" / "rotations.json", line_counts)

    print(f"\nexporting plate tree over {len(ages)} ages ...")
    n_ages = export_plate_tree(args.model, static_polygon_files, rotation_files,
                               ages, out / "platetree" / "chains.bin", args.anchor)

    manifest = {
        "id": recon_id,
        "name": args.name,
        "citation": args.citation,
        "source_fetch": f"fetch_{args.model}",
        "age_min": float(args.age_min),
        "age_max": float(args.age_max),
        "age_step": float(args.age_step),
        "anchor_plate_id": args.anchor,
        "coastlines": {
            "geometry": "coastlines/geometry.bin",
            "rotations": "coastlines/rotations.json",
        },
        "static_polygons": {
            "geometry": "staticpolygons/geometry.bin",
            "rotations": "coastlines/rotations.json",
        },
        "plate_tree": "platetree/chains.bin",
        "has_plate_names": has_plate_names,
        "tree_ages": n_ages,
    }
    if has_plate_names:
        manifest["static_polygons"]["plate_names"] = "staticpolygons/plate_names.json"
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {out}/manifest.json")


if __name__ == "__main__":
    main()
