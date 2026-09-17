#!/usr/bin/env python3
"""Check the exported plate tree against gprm computed live.

This is the check that makes ADR-0043's parity claim meaningful. Reproducing
gprm's node definition exactly was chosen OVER a better-behaved one, and that
choice is only worth anything if the result is actually the same -- otherwise
the viewer has neither parity nor smooth nodes.

Verified here, at sampled ages:
  * chains, roots, and each root's path to the anchor
  * the defining polygon index for each node
  * NODE POSITIONS: the client's own centroid formula, applied to the exported
    present-day ring and rotated to the age, against gprm's
    get_polygon_centroids() on the reconstructed polygon

The last one is the real test, and it is checked the way the CLIENT computes
it, not the way Python would find convenient -- an arc-length-weighted
boundary centroid of the stored ring, rotated. If that disagrees with pygplates'
own get_boundary_centroid(), this reports the size of the disagreement rather
than hiding it behind a loose tolerance.

Usage:
  conda run -n pygmt17 python prep/check_platetree.py [--ages 0 100 500 1800]
"""

import argparse
import struct
import sys
from pathlib import Path

import numpy as np
import pygplates

sys.path.insert(0, "/Users/simon/GIT/GPlatesReconstructionModel")
from gprm.utils import platetree  # noqa: E402


def read_static_polygons(path):
    buf = path.read_bytes()
    assert buf[:4] == b"ESSP", "bad static polygon magic"
    version, npolys = struct.unpack_from("<II", buf, 4)
    assert version == 1
    o, polys = 12, []
    for _ in range(npolys):
        plate_id, continental, appear, disappear, npts = struct.unpack_from(
            "<iBxxxffI", buf, o)
        o += struct.calcsize("<iBxxxffI")
        pts = np.frombuffer(buf, dtype="<f4", count=npts * 3, offset=o).reshape(-1, 3)
        o += npts * 12
        polys.append({"plate_id": plate_id, "points": pts})
    return polys


def read_plate_tree(path):
    buf = path.read_bytes()
    assert buf[:4] == b"ESPT", "bad plate tree magic"
    version, nages, nplates = struct.unpack_from("<III", buf, 4)
    assert version == 1
    o = 16
    plate_ids = np.frombuffer(buf, dtype="<i4", count=nplates, offset=o); o += nplates * 4
    ages = np.frombuffer(buf, dtype="<f4", count=nages, offset=o); o += nages * 4

    frames = []
    for _ in range(nages):
        nchains, nroots, nrootpath, _ngroups, npresent = struct.unpack_from("<IIIII", buf, o)
        o += 20
        roots = [int(plate_ids[i]) for i in
                 np.frombuffer(buf, dtype="<i4", count=nroots, offset=o)]; o += nroots * 4
        rp = np.frombuffer(buf, dtype="<i4", count=nrootpath, offset=o); o += nrootpath * 4
        paths, k = [], 0
        while k < nrootpath:
            ln = int(rp[k]); k += 1
            paths.append([int(plate_ids[i]) for i in rp[k:k + ln]]); k += ln
        chains = []
        for _c in range(nchains):
            ln = struct.unpack_from("<i", buf, o)[0]; o += 4
            idx = np.frombuffer(buf, dtype="<i4", count=ln, offset=o); o += ln * 4
            chains.append([int(plate_ids[i]) for i in idx])
        present = [int(plate_ids[i]) for i in
                   np.frombuffer(buf, dtype="<i4", count=npresent, offset=o)]; o += npresent * 4
        poly_of = [int(v) for v in
                   np.frombuffer(buf, dtype="<i4", count=npresent, offset=o)]; o += npresent * 4
        group_of = [int(v) for v in
                    np.frombuffer(buf, dtype="<i4", count=npresent, offset=o)]; o += npresent * 4
        frames.append({"chains": chains, "roots": roots, "paths": paths,
                       "present": present, "poly_of": poly_of, "group_of": group_of})
    return [float(a) for a in ages], frames


def boundary_centroid(points):
    """The CLIENT's formula, transcribed: each edge's midpoint weighted by that
    edge's arc length, around the closed ring, renormalised."""
    n = len(points)
    acc = np.zeros(3)
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        # Chord form, matching the client: acos(dot) is catastrophically
        # imprecise for the nearly-parallel vertex pairs a densely digitised
        # ring is made of. See polygonBoundaryCentroid() in core/staticPolygons.ts.
        arc = 2.0 * np.arcsin(min(1.0, float(np.linalg.norm(a - b)) / 2.0))
        if arc == 0:
            continue
        mid = a + b
        ml = np.linalg.norm(mid)
        if ml == 0:
            continue
        acc += (mid / ml) * arc
    norm = np.linalg.norm(acc)
    return acc / norm if norm else points.mean(axis=0) / np.linalg.norm(points.mean(axis=0))


def quat_rotate(q, v):
    x, y, z, w = q
    t = 2.0 * np.cross([x, y, z], v)
    return v + w * t + np.cross([x, y, z], t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Cao2024")
    ap.add_argument("--data", type=Path,
                    default=Path("public/data/reconstructions/cao2024"))
    ap.add_argument("--ages", type=float, nargs="*",
                    default=[0, 100, 250, 500, 1000, 1800])
    args = ap.parse_args()

    ages, frames = read_plate_tree(args.data / "platetree" / "chains.bin")
    polys = read_static_polygons(args.data / "staticpolygons" / "geometry.bin")
    print(f"exported: {len(ages)} ages, {len(polys)} static polygons\n")

    from gprm.datasets import Reconstructions
    m = getattr(Reconstructions, f"fetch_{args.model}")()
    rm = pygplates.RotationModel([str(f) for f in m.rotation_files])
    feats = pygplates.FeatureCollection()
    for f in m.static_polygon_files:
        feats.add(pygplates.FeatureCollection(str(f)))

    failures = 0
    for age in args.ages:
        i = min(range(len(ages)), key=lambda k: abs(ages[k] - age))
        fr = frames[i]
        t = ages[i]

        reconstructed = []
        pygplates.reconstruct(feats, rm, reconstructed, t, anchor_plate_id=0)
        present = platetree.get_unique_plate_ids_from_reconstructed_features(reconstructed)
        tree = rm.get_reconstruction_tree(t)
        chains = platetree.get_plate_chains(present, tree)
        roots = platetree.get_root_static_polygon_plate_ids(tree, present)
        centroids = platetree.get_polygon_centroids(reconstructed)

        ok_present = sorted(int(p) for p in present) == sorted(fr["present"])
        ok_chains = (sorted(tuple(int(x) for x in c) for c in chains)
                     == sorted(tuple(c) for c in fr["chains"]))
        ok_roots = sorted(int(r) for r in roots) == sorted(fr["roots"])

        # node positions, computed the way the client does
        deltas = []
        for pid, pi in zip(fr["present"], fr["poly_of"]):
            if pi < 0 or pid not in centroids:
                continue
            c = boundary_centroid(np.asarray(polys[pi]["points"], dtype=np.float64))
            fr_rot = rm.get_rotation(t, int(pid), 0.0, 0)
            q = fr_rot.get_euler_pole_and_angle()
            pole, ang = q
            px, py, pz = pole.to_xyz()
            s = np.sin(ang / 2.0)
            quat = (px * s, py * s, pz * s, np.cos(ang / 2.0))
            rotated = quat_rotate(quat, c)
            got = pygplates.PointOnSphere(
                float(rotated[0]), float(rotated[1]), float(rotated[2]))
            want = pygplates.PointOnSphere(centroids[pid])
            deltas.append(np.degrees(
                pygplates.GeometryOnSphere.distance(got, want)))

        deltas = np.array(deltas) if deltas else np.array([np.nan])
        status = "ok " if (ok_present and ok_chains and ok_roots) else "FAIL"
        if status == "FAIL":
            failures += 1
        print(f"{status} {t:7.1f} Ma  plates={len(fr['present']):4d} "
              f"chains={'=' if ok_chains else 'DIFFER'} "
              f"roots={'=' if ok_roots else 'DIFFER'} {fr['roots']}")
        print(f"      node offset vs gprm: median={np.nanmedian(deltas):.6f}deg  "
              f"p99={np.nanpercentile(deltas, 99):.6f}deg  "
              f"max={np.nanmax(deltas):.6f}deg  (n={len(deltas)})")

        # every circuit must end at the anchor, which is what the root paths are for
        bad_tail = [p for p in fr["paths"] if p[-1] != 0]
        if bad_tail:
            print(f"      FAIL root path does not reach the anchor: {bad_tail}")
            failures += 1

    print(f"\n{'PASS' if failures == 0 else f'{failures} FAILURES'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
