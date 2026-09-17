# Plate Tree

A plate reconstruction is not a list of plate positions. It is a **hierarchy of
relative rotations**: every plate's motion is defined relative to another, up to
an anchor. Nothing on an ordinary reconstruction map shows you that — you cannot
tell, looking at two continents, that one is being positioned *through* the
other, or that its position is the product of thirty-seven composed rotations.

This viewer shows the hierarchy, on the globe, through time.

**Model:** Cao et al. 2024, 0–1800 Ma, anchored at plate 0.

## What you are looking at

- **Nodes** — one per plate that carries geometry at this age, drawn at the
  boundary centroid of that plate's largest polygon.
- **Links** — one per hop of the hierarchy. Orange links carry real relative
  motion. Faint links are **locked**: the two plates have no relative motion at
  all, and the link is bookkeeping. Most links are locked (426 of 496 at 0 Ma),
  which is why the distinction is drawn.
- **Dashed links** are **patched**: the rotation circuit runs through plates
  with no geometry here, so the two plates the line joins are *not* neighbours
  in the hierarchy.
- **Node colour** is the **locked group** — the set of plates the model moves as
  one mass. The count is a supercontinent signal read straight out of the
  rotation file, with no geometry involved: 71 groups at 0 Ma, 26 at 100 Ma,
  11 by 1000 Ma.
- **Yellow nodes** are **root plates** — the plates closest to the anchor that
  carry geometry. There is often more than one (four at 500 Ma).

**Click a plate** to see its full circuit to the anchor.

## Building

```bash
npm install
npm run dev          # http://localhost:5173/GeodeViewers/PlateTree/
npm run typecheck
npm run build
```

## Regenerating the data

```bash
conda run -n pygmt17 python prep/prep_viewer_data.py \
    --model Cao2024 --name "Cao et al. 2024" --age-max 1800 --age-step 5
```

Every asset comes from a single `gprm.datasets.Reconstructions.fetch_Cao2024()`
call rather than hand-picked paths. That is load-bearing: Cao 2024 is an 1800 Ma
model split across two rotation files at the 1000 Ma boundary, and loading only
one makes pygplates silently return the identity rotation for the plates missing
from it — so a subset of plates simply never moves, with no error raised.

The tree is sampled every 5 Myr. Node *positions* stay continuous regardless:
which polygon defines a node is discrete and snaps to a sampled age, but that
polygon's ring is rotated to the exact age on the slider.

## Checking it

```bash
conda run -n pygmt17 python prep/check_platetree.py
```

Compares the exported chains, roots, root-to-anchor paths and node positions
against `gprm.utils.platetree` computed live. This matters more than usual here:
the node definition deliberately reproduces gprm's own, **including its
discontinuities** — a plate's largest polygon can change between ages and move
its node by tens of degrees — so "same as gprm" is the only correctness standard
available, and it has to be measured rather than assumed.

Current result: chains, roots and root paths match **exactly** at every sampled
age. Node positions match to a median of 0.000000° and a 99th percentile of
0.003°.

**One known exception.** Plate 8011's node sits 1.65° (~184 km) from where
gprm puts it, at every age. This is not precision and not the wrong ring: the
stored float32 ring and the float64 source ring give the same answer to 3e-8,
and the ring is well conditioned. For that single polygon, pygplates'
`get_boundary_centroid()` simply differs from the arc-length-weighted-midpoint
definition every other polygon agrees with. One node in 497, and it affects no
chain, root or group.

Worth knowing if you change the centroid code: an earlier version computed each
edge's arc as `acos(dot)`, which is catastrophically imprecise for the
nearly-parallel vertex pairs a densely digitised ring is made of. It put nine
nodes more than 0.01° out and the worst 1.68° out, scaling with vertex count.
The chord form `2·asin(|a−b|/2)` fixed it and took the median to exact.

## Design notes

The design, its measurements, and the decisions behind it are recorded in the
Geode repo: `docs/plans/plate-tree-viewer.md` and ADR-0042 (what the export
carries), ADR-0043 (why node positions reproduce gprm's discontinuities) and
ADR-0044 (why a locked group is an equivalence class, not a connected component
of locked links).
