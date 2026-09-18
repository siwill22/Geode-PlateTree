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

- **The plate mosaic** is every static polygon, not just the continents — so
  oceanic crust, and the seafloor-age fabric it is built from, is visible. The
  continents are outlined on top of it. Toggle it off for continents only.
- **Built from** switches between the tree computed from rigid **static
  polygons** (497 plates at 0 Ma) and the one computed from resolved
  **topologies** (46). This is gprm's own `polygon_type` option, and the two
  are different statements about the model rather than two drawings of one.
  The contrast is the interesting part: static gives 70 moving / 426 locked
  links, topological gives 37 moving / 7 locked. Real plates mostly move
  relative to each other; static-polygon fragments are mostly bookkeeping.
- **Centre lon** slides the central meridian on a flat map, so the Pacific can
  be put in the middle instead of split down the antimeridian. Live in Robinson
  and Plate Carrée; disabled on the globe, where orbiting does the same job.

**Click a plate** to see its full circuit to the anchor.

### Supercontinent flows (v2)

Toggle **supercontinent flows** to open an alluvial diagram, full-width above
the time bar: Locked Groups merging and splitting across the whole model,
0–1800 Ma in one view. Every weight in it — which groups earn their own band,
how tall a band is, how thick a ribbon is — is **spherical area of
CONTINENTAL crust only**, not plate count and not oceanic crust: a single
enormous continental block and a one-plate sliver don't count the same, and a
Locked Group whose only members are oceanic fragments (the Pacific being the
extreme case) is invisible here on purpose — it isn't part of the
supercontinent story, only of the rigid-body-motion one the globe's Locked
Links already tell.

A band's colour tracks a lineage forward through time — inherited from
whichever earlier band contributed the most AREA to it — so a colour reads as
"this mass of crust," not as a raw (and otherwise meaningless-across-ages)
Locked Group id. **The globe's own nodes pick up the same colour** while the
panel is open (`colour by group`'s per-age palette is used only while it's
closed), so the same continental mass reads as the same colour in both views.
Hover a band for the plate ids it actually contains, its share of Earth's
surface, and the age range it covers; the vertical marker tracks the time
bar.

Colours are allocated from a small, fixed, evenly-spaced palette rather than
grown forever, and a lineage holds its slot only for as long as it is
visible: this GUARANTEES no two independently moving Locked Groups ever share
a colour within the same reorganisation event, including the case that broke
a naive "copy the parent's colour" rule — a group splitting into several
pieces at once, where every piece's strongest predecessor is the same parent
and only the piece carrying the largest share of it keeps that colour; the
rest are allocated fresh ones. `window.__platetree.flowColorCollisions()`
checks this directly across every Checkpoint the diagram drew, and
`scripts/shoot_flows.mjs` runs it on every check.

**Column height is absolute, not normalised.** Modelled continental coverage
itself shrinks with age — measured directly for Cao 2024, ~41% of Earth's
surface at 0 Ma down to ~12% by 1800 Ma, since deep time only reconstructs
the continental blocks the model is confident about. A Checkpoint's total
height is scaled against the richest Checkpoint in the whole diagram, so a
narrower column in deep time honestly shows "less is known here," rather than
being stretched to fill the same height as 0 Ma and implying a parity that
isn't there. The status line states the coverage number outright.

The diagram only redraws at a **reorganisation event** — an age where the
partition of large-vs-pooled Locked Groups actually changes — rather than at
every 5 Myr sample, so a stretch of unchanged structure reads as one flat
plateau instead of hundreds of identical slivers. The size cutoff is a fixed
fraction of THAT AGE's own modelled continental area, not "the N largest":
deep in time many groups sit within a sliver of area of each other, and a
rank-based cutoff would turn every swap among near-tied small groups into a
spurious event. It is also relative rather than sphere-absolute, since a
fixed absolute bar would quietly get harder to clear as coverage itself
shrinks, for a reason that has nothing to do with supercontinent assembly.

Available on both the **static** and **topological** trees; the topological
tree simply has far fewer plates (46 vs 497 at 0 Ma) to begin with.

### Node positions differ between the two trees

A static polygon is digitised present-day and rotated, so its node is exported
as "this ring, rotated by this plate" and moves continuously at any age the
slider asks for. A resolved topological plate has no present-day geometry — it
is rebuilt from its bounding features at each age, changes shape, and appears
and vanishes outright — so its node can only be exported as a position, at the
ages actually sampled. The file format carries a node mode for exactly this,
and the topological tree does not interpolate between samples.

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
