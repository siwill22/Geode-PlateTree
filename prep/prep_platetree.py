#!/usr/bin/env python3
"""Export a Reconstruction Model's Plate Tree -- the hierarchy of relative
rotations it is built from, reduced to plates that carry geometry.

The algorithm is `gprm.utils.platetree`'s, used as the reference implementation
rather than reimplemented: chains come from `get_plate_chains()`, roots from
`get_root_static_polygon_plate_ids()`, and the node-defining polygon is the one
`get_polygon_centroids()` would pick (the plate's largest at that age).

What this exports, and why it is these things and not others -- see ADR-0042,
ADR-0043 and ADR-0044 in the Geode repo:

  * CHAINS, not the reconstruction tree's edges. The full tree carries
    thousands of plate ids per age, almost all of which have no polygon and so
    no position to draw. The reduced chain set is what a viewer renders.

  * EACH ROOT'S OWN PATH TO THE ANCHOR, alongside the roots. A root plate has
    no chain at all -- `patch_links_between_polygon()` returns None when it
    reaches the anchor without finding geometry -- so without this every plate
    circuit silently stops one plate short of the anchor.

  * WHICH POLYGON defines each node, not WHERE the node is. The client rotates
    the chosen ring to the exact (continuous) reconstruction age and takes its
    boundary centroid, so nodes move smoothly while the choice stays discrete.
    Exporting the choice rather than recomputing it in the browser is what
    makes parity with gprm a fact rather than a hope: the choice is a tie-break
    among near-equal areas, and ties really do flip.

  * ONE LOCKED GROUP ID per plate per age. A group is a maximal set of plates
    with no relative motion between any two of them. Crucially this is NOT the
    connected components of locked tree links -- co-rotation relates any two
    plates, not just tree-adjacent ones -- so it is computed by grouping plates
    on their own rotation relative to the anchor, which is a true equivalence
    relation and therefore a canonical partition. A tree link is locked exactly
    when its endpoints share a group id, so the link flag is not exported
    separately.

Output: platetree/chains.bin, little-endian:

  magic      'ESPT' (4 bytes)
  version    uint32 = 2
  node_mode  uint32   0 = node is a polygon index into staticpolygons/
                        geometry.bin, rotated client-side (RIGID polygons)
                      1 = node is a lon/lat pair, already reconstructed
                        (TOPOLOGICAL plates, which are not rigid and so have
                        no present-day ring to rotate)
  nages      uint32
  nplates    uint32                 distinct plate ids appearing anywhere
  plate_ids  int32 * nplates        sorted; every other plate reference below
                                     is an INDEX into this table
  ages       float32 * nages
  then per age:
    nchains    uint32
    nroots     uint32
    nrootpath  uint32               total ints across all root paths
    ngroups    uint32
    npresent   uint32               plates carrying geometry at this age
    roots      int32 * nroots       indices into plate_ids
    rootpaths  int32 * nrootpath    each: uint32 length then that many indices,
                                     packed; path[0] is the root, path[-1] the
                                     anchor
    chains     packed               each: uint32 length then that many indices
    present    int32 * npresent     indices, sorted
    poly_of    int32 * npresent     node_mode 0 only: index of the defining
                                     polygon within staticpolygons/geometry.bin,
                                     parallel to `present`
    node_ll    float32 * 2 * npresent  node_mode 1 only: (lon, lat) per plate,
                                     parallel to `present`
    group_of   int32 * npresent     locked-group id, parallel to `present`;
                                     ids are per-age and carry no meaning
                                     across ages
"""

import hashlib
import struct
import sys

import numpy as np
import pygplates

sys.path.insert(0, "/Users/simon/GIT/GPlatesReconstructionModel")
from gprm.utils import platetree  # noqa: E402

# Float guard, in degrees, for "is this rotation the identity". Not a physical
# threshold: stage rotations for plates in the same group are composed along
# different paths, so they agree to float dust rather than bit-exactly. The
# real membership test is exact identity -- measured across Muller 2019, a
# 10,000x looser threshold moves the group count by about 2%, so nothing here
# is sensitive to this value.
IDENTITY_EPS_DEG = 1e-6

# The interval a locked group is measured over. Fixed at 1 Myr regardless of
# the export step, so the flag means the same physical thing in every model
# however densely it was sampled.
LOCKED_WINDOW_MYR = 1.0


class _UnionFind:
    def __init__(self, items):
        self._p = {i: i for i in items}

    def find(self, x):
        while self._p[x] != x:
            self._p[x] = self._p[self._p[x]]
            x = self._p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._p[ra] = rb


def locked_groups(rotation_model, plate_ids, time, age_max, anchor=0):
    """Partition `plate_ids` into locked groups at `time`.

    Two plates are in the same group when their rotations relative to the
    anchor over the window are equal -- equivalently, when they have no
    relative motion. Computed as one rotation query per plate rather than
    pairwise against group representatives.

    The window runs forward, except at the model's own oldest age where it runs
    backward instead. That exception is not cosmetic: rotations flatten beyond
    a model's range, so a forward window at age_max makes every plate look
    locked -- for Muller 2019 it reported a single spurious 150-plate group
    where a backward window reports 78.
    """
    dt = LOCKED_WINDOW_MYR if time + LOCKED_WINDOW_MYR <= age_max else -LOCKED_WINDOW_MYR

    keyed = []
    for pid in plate_ids:
        stage = rotation_model.get_rotation(time + dt, int(pid), time, anchor)
        if stage.represents_identity_rotation():
            angle = 0.0
        else:
            _, a = stage.get_euler_pole_and_angle()
            angle = abs(np.degrees(a))
        keyed.append((angle, int(pid), stage))
    keyed.sort(key=lambda k: k[0])

    # Sort by angle, then union every pair inside an epsilon angle window --
    # NOT just adjacent entries. Comparing only neighbours splits a genuine
    # group whenever float noise reorders its members, which was caught by
    # disagreeing with an exhaustive all-pairs check (16 groups against 15).
    uf = _UnionFind([k[1] for k in keyed])
    n = len(keyed)
    for i in range(n):
        ai, _, si = keyed[i]
        for j in range(i + 1, n):
            if keyed[j][0] - ai > IDENTITY_EPS_DEG:
                break
            if pygplates.FiniteRotation.are_equal(si, keyed[j][2], IDENTITY_EPS_DEG):
                uf.union(keyed[i][1], keyed[j][1])

    roots, group_of = {}, {}
    for pid in plate_ids:
        r = uf.find(int(pid))
        if r not in roots:
            roots[r] = len(roots)
        group_of[int(pid)] = roots[r]
    return group_of


def root_path_to_anchor(reconstruction_tree, root_plate):
    """Every plate id from `root_plate` up to and including the anchor.

    Root plates are where `get_plate_chains()` stops, so this is the only
    source for the last hop of a plate circuit.
    """
    edges = {e.get_moving_plate_id(): e for e in reconstruction_tree.get_edges()}
    path, seen, p = [int(root_plate)], {int(root_plate)}, int(root_plate)
    while p in edges:
        p = int(edges[p].get_fixed_plate_id())
        if p in seen:
            break
        path.append(p)
        seen.add(p)
    return path


def _ring_coords(points):
    return np.array([p.to_xyz() for p in points], dtype=np.float64)


def _ring_key(fid, points):
    """Identify one ring exactly, so it can be found again after reconstruction.

    Hashes every coordinate, and that is not over-engineering -- it is the
    third attempt, and the first two were both wrong in ways that looked like
    something else entirely:

      * (feature id, point count) collides when one feature carries several
        rings of the same length. Plate 4601's node landed 4.9 degrees from
        gprm's, which reads as a centroid-formula disagreement and is nothing
        of the kind.
      * (feature id, count, first/middle/last vertex) still collided for one
        pair of 3137-point plate-8011 rings whose sampled vertices happen to
        coincide, leaving a 1.68 degree offset that survived the first fix.

    Sampling a few vertices is a guess about which rings differ; hashing all of
    them is not. The cost is one pass over coordinates already in memory.
    """
    coords = _ring_coords(points)
    return (fid, len(coords), hashlib.blake2b(coords.tobytes(), digest_size=16).hexdigest())


def defining_polygon_indices(reconstructed_polygons, polygon_index_of):
    """Which polygon defines each plate's node at this age.

    Mirrors `get_polygon_centroids()`: the plate's LARGEST polygon, chosen
    independently at each age. That choice is genuinely discontinuous -- a
    plate's largest polygon can switch between adjacent ages and move its node
    by tens of degrees -- and reproducing it exactly is deliberate (ADR-0043).

    Matched back to the exported ring through the polygon's own PRESENT-DAY
    geometry, which is what geometry.bin actually stores; matching on the
    reconstructed geometry would compare rotated coordinates against unrotated
    ones.
    """
    best = {}
    for rp in reconstructed_polygons:
        feature = rp.get_feature()
        pid = int(feature.get_reconstruction_plate_id())
        area = rp.get_reconstructed_geometry().get_area()
        if pid not in best or area > best[pid][0]:
            key = _ring_key(str(feature.get_feature_id()),
                            rp.get_present_day_geometry().get_points())
            best[pid] = (area, polygon_index_of.get(key, -1))
    return {pid: idx for pid, (_, idx) in best.items()}


def build_polygon_index(static_polygon_features):
    """Map each ring to the index it occupies in geometry.bin.

    Walks features and geometries in exactly the order
    `export_static_polygons()` writes them -- if the two ever diverge, every
    index points at the wrong ring.
    """
    index_of, i, duplicates = {}, 0, 0
    for feature in static_polygon_features:
        fid = str(feature.get_feature_id())
        for geom in feature.get_geometries():
            if not isinstance(geom, pygplates.PolygonOnSphere):
                continue
            pts = geom.get_points()
            if len(pts) < 3:
                continue
            key = _ring_key(fid, pts)
            if key in index_of:
                # The key hashes every coordinate, so a repeat really is the
                # same ring twice on one feature and either copy gives the same
                # node. Counted rather than asserted away, because a sudden
                # jump in this number means the source data changed shape.
                duplicates += 1
            else:
                index_of[key] = i
            i += 1
    if duplicates:
        print(f"  note            {duplicates} exactly-duplicated ring(s); "
              "same geometry, same node")
    return index_of


def export_plate_tree(model_name, polygon_files, rotation_files,
                      ages, out_path, anchor=0, polygon_type="static"):
    """Export a Plate Tree built from either rigid static polygons or resolved
    topologies -- gprm's own `polygon_type` option (see
    `utils.platetree.write_trees_to_file`), which its PlateTree class carries a
    `#TODO handle dynamic polygons` note about.

    The two differ in more than which features get loaded, and the difference
    is what forces two node modes in the file format. A static polygon is
    digitised present-day and rotated, so a node can be exported as "this ring,
    rotated by its plate" and stays continuous at any age the client asks for.
    A topological plate is RESOLVED at each age from its bounding features --
    it has no present-day geometry, its shape changes, and plates appear and
    vanish outright -- so its node can only be exported as a position, at the
    ages actually sampled.
    """
    features = pygplates.FeatureCollection()
    for f in polygon_files:
        features.add(pygplates.FeatureCollection(str(f)))
    rotation_model = pygplates.RotationModel([str(f) for f in rotation_files])

    topological = polygon_type in ("topological", "dynamic")
    node_mode = 1 if topological else 0
    polygon_index_of = {} if topological else build_polygon_index(features)
    age_max = float(max(ages))

    per_age, all_plates = [], set()
    for t in ages:
        t = float(t)
        reconstructed = []
        if topological:
            pygplates.resolve_topologies(features, rotation_model, reconstructed, t,
                                         anchor_plate_id=anchor)
            # resolve_topologies also yields line features (ResolvedTopological
            # Line); only closed boundaries have an area and a centroid, and
            # get_polygon_centroids() type-checks for exactly this class.
            reconstructed = [r for r in reconstructed
                             if isinstance(r, pygplates.ResolvedTopologicalBoundary)]
        else:
            pygplates.reconstruct(features, rotation_model, reconstructed, t,
                                  anchor_plate_id=anchor)
        present = platetree.get_unique_plate_ids_from_reconstructed_features(
            reconstructed)
        if not present:
            per_age.append(None)
            continue

        tree = rotation_model.get_reconstruction_tree(t)
        chains = platetree.get_plate_chains(present, tree)
        roots = platetree.get_root_static_polygon_plate_ids(tree, present)
        paths = [root_path_to_anchor(tree, r) for r in roots]
        if topological:
            centroids = platetree.get_polygon_centroids(reconstructed)
            poly_of = None
        else:
            poly_of = defining_polygon_indices(reconstructed, polygon_index_of)
        group_of = locked_groups(rotation_model, sorted(present), t, age_max, anchor)

        present_sorted = sorted(int(p) for p in present)
        per_age.append({
            "age": t,
            "chains": [[int(p) for p in c] for c in chains],
            "roots": [int(r) for r in roots],
            "paths": paths,
            "present": present_sorted,
            "poly_of": (None if topological
                        else [poly_of.get(p, -1) for p in present_sorted]),
            "node_ll": ([(float(centroids[p][1]), float(centroids[p][0]))
                         for p in present_sorted] if topological else None),
            "group_of": [group_of[p] for p in present_sorted],
        })
        for c in chains:
            all_plates.update(int(p) for p in c)
        all_plates.update(present_sorted)
        for p in paths:
            all_plates.update(p)

        n_patched = sum(1 for c in chains if len(c) > 2)
        n_groups = len(set(group_of.values()))
        print(f"  {t:7.1f} Ma  {len(present_sorted):4d} plates  "
              f"{len(chains):4d} links ({n_patched:3d} patched)  "
              f"{n_groups:4d} groups  roots {roots}")

    plate_ids = sorted(all_plates)
    index_of = {p: i for i, p in enumerate(plate_ids)}
    live = [a for a in per_age if a is not None]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(b"ESPT")
        fh.write(struct.pack("<IIII", 2, node_mode, len(live), len(plate_ids)))
        np.array(plate_ids, dtype="<i4").tofile(fh)
        np.array([a["age"] for a in live], dtype="<f4").tofile(fh)

        for a in live:
            packed_paths = []
            for p in a["paths"]:
                packed_paths.append(len(p))
                packed_paths.extend(index_of[x] for x in p)
            packed_chains = []
            for c in a["chains"]:
                packed_chains.append(len(c))
                packed_chains.extend(index_of[x] for x in c)

            fh.write(struct.pack("<IIIII", len(a["chains"]), len(a["roots"]),
                                 len(packed_paths), len(set(a["group_of"])),
                                 len(a["present"])))
            np.array([index_of[r] for r in a["roots"]], dtype="<i4").tofile(fh)
            np.array(packed_paths, dtype="<i4").tofile(fh)
            np.array(packed_chains, dtype="<i4").tofile(fh)
            np.array([index_of[p] for p in a["present"]], dtype="<i4").tofile(fh)
            if node_mode == 1:
                np.array(a["node_ll"], dtype="<f4").tofile(fh)
            else:
                np.array(a["poly_of"], dtype="<i4").tofile(fh)
            np.array(a["group_of"], dtype="<i4").tofile(fh)

    missing = (0 if node_mode == 1
               else sum(1 for a in live for x in a["poly_of"] if x < 0))
    mb = out_path.stat().st_size / 1024 / 1024
    kind = "topological" if topological else "static"
    print(f"\n  plate tree      {kind}: {len(live)} ages, {len(plate_ids)} "
          f"distinct plate ids, {mb:.2f} MB")
    if missing:
        print(f"  WARNING         {missing} nodes have no defining polygon index")
    return len(live)
