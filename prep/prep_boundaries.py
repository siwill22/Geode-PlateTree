#!/usr/bin/env python3
"""Export resolved plate-boundary topologies -- ridges, subduction zones,
transforms -- as a subdued backdrop for the Plate Tree viewer.

This viewer's own point is the rotation hierarchy (the tree of nodes and
links), not the boundaries. The boundaries are context: they let a reader see
where a plate circuit's endpoints actually sit relative to real tectonic
features, without competing for attention -- see `src/platetree/main.ts`'s
`subdued()`, which mutes the Theme's own boundary colours before handing them
to the overlay.

This repo vendors petrify's `js/` layers only (a viewer needs those to
DRAW the data) and not its `python/` exporter, so this reuses Geode's copy
directly rather than duplicating ~300 lines of pygplates topology-resolution
code. That means a second `Reconstructions.fetch_<model>()` call beyond the
one `prep_viewer_data.py` already made for coastlines/static polygons/rotations
-- accepted deliberately: gprm's fetch returns the same correct, complete
object every time for a given model name (unlike hand-picking file paths,
which is the actual failure mode `prep_viewer_data.py`'s docstring warns
about), so a second call costs a cache hit, not a correctness risk.

Run:  conda run -n pygmt17 python prep/prep_boundaries.py \\
          --model Cao2024 --age-max 1800 --age-step 5
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, "/Users/simon/GIT/Geode/viewer/vendor/petrify/python")
from petrify import export_series  # noqa: E402


def export_boundaries(model_name, out_dir, age_min=0.0, age_max=1800.0,
                      age_step=5.0, anchor=0, tessellate=0.5, healpix_n=8):
    """Write `<out_dir>/boundaries.json` + `frames/` + `velocities.json`.

    Velocities come along for free -- `export_series` always builds both from
    the same resolved snapshot -- and are not currently drawn by this viewer,
    but are cheap to keep exported for whenever a velocity layer is wanted.
    """
    return export_series(
        model_name=model_name,
        start=int(age_min), end=int(age_max), step=int(age_step),
        anchor_plate=anchor, tessellate=tessellate, healpix_n=healpix_n,
        out_dir=str(out_dir),
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="gprm Reconstructions name, e.g. Cao2024")
    ap.add_argument("--id", help="output directory name (default: model lowercased)")
    ap.add_argument("--age-min", type=float, default=0.0)
    ap.add_argument("--age-max", type=float, default=1800.0)
    ap.add_argument("--age-step", type=float, default=5.0)
    ap.add_argument("--anchor", type=int, default=0)
    ap.add_argument("--tessellate", type=float, default=0.5)
    ap.add_argument("--healpix-n", type=int, default=8)
    ap.add_argument("--out", type=Path, default=Path("public/data"))
    args = ap.parse_args()

    recon_id = args.id or args.model.lower()
    out = args.out / "reconstructions" / recon_id / "boundaries"
    export_boundaries(args.model, out, args.age_min, args.age_max, args.age_step,
                      args.anchor, args.tessellate, args.healpix_n)


if __name__ == "__main__":
    main()
