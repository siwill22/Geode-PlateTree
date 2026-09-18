import {
  Clock, Color, Raycaster, Scene, Vector2, WebGLRenderer,
} from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Coastlines, fetchCoastlineData } from '../core/coastlines';
import { OceanSurface } from '../core/oceanSurface';
import { createMaskTexture } from '../core/mask';
import {
  applyChromeLightness, DEFAULT_THEME, resolveTheme, type ResolvedTheme, type ThemeId,
} from '../core/theme';
import {
  createProjectionCamera, createProjectionControls, isFlat,
  updateProjectionCameraAspect, type ProjectionMode,
} from '../core/projection';
import { fetchStaticPolygonData, assignPlate } from '../core/staticPolygons';
import { fetchVolumeBytes } from '../core/volume';
import { vec3ToLonLat, type LonLat } from '../core/constants';
import { PlateTreeOverlay, parsePlateTree, type PlateTreeData } from '../core/plateTree';
import { BoundaryOverlay } from '../core/boundaries';
import { centralMeridianRotation } from '../core/rotation';
import { PlateTreeUi, type PlateTreeViewState, type TreeSource } from './plateTreeUi';

const DATA = `${import.meta.env.BASE_URL}data`;
const RECON = 'cao2024';

interface Manifest {
  id: string;
  name: string;
  citation: string;
  age_min: number;
  age_max: number;
  age_step: number;
  anchor_plate_id: number;
  coastlines: { geometry: string; rotations: string };
  static_polygons: {
    geometry: string; mesh?: string; rotations: string; plate_names?: string;
  };
  plate_tree: string;
  plate_tree_topological?: string;
  has_topological_tree?: boolean;
  boundaries?: string;
  has_plate_names: boolean;
}

const view: PlateTreeViewState = {
  age: 0,
  projection: 'globe',
  theme: DEFAULT_THEME,
  treeSource: 'static',
  centreLon: 0,
  showLocked: true,
  showLabels: false,
  colorByGroup: true,
  showCoastlines: true,
  showPlates: true,
  showTopology: true,
};

const scene = new Scene();
let camera = createProjectionCamera('globe', innerWidth / innerHeight);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(resolveTheme(view.theme).page));
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);
tuneControls();

/**
 * Take the left button off OrbitControls on a flat map.
 *
 * `createProjectionControls` maps it to PAN there, which is the right default
 * for a flat map in general -- but this viewer spends left-drag on the central
 * meridian instead, and a plane that both slides under the camera and rotates
 * beneath itself is impossible to aim. Panning stays on the right button.
 */
function tuneControls(): void {
  if (isFlat(view.projection)) controls.mouseButtons.LEFT = null;
}

const ocean = new OceanSurface('globe');
scene.add(ocean.mesh);

/** Resolved plate-boundary topologies (ridge/subduction/transform), drawn
 *  muted underneath the tree -- context for where a circuit's plates actually
 *  sit relative to real tectonic features, not this viewer's own subject.
 *  Left unloaded (draw()/setAge() both no-op with no series) for a model with
 *  no dynamic polygons to resolve -- see prep_boundaries.py. Constructed (and
 *  so appended to the DOM) BEFORE the tree overlay, so its canvas paints
 *  underneath the tree's -- neither sets an explicit z-index, so plain DOM
 *  order is the paint order. */
const topology = new BoundaryOverlay(camera as never);
let hasTopology = false;
const overlay = new PlateTreeOverlay(camera as never);
let coastlines: Coastlines | null = null;
/** The full static-polygon mosaic, drawn as a second Coastlines instance --
 *  the same triangulated-mesh format, so it gets the antimeridian handling and
 *  the GPU path for free. This is what makes OCEANIC crust visible: the
 *  coastline file carries continents only. */
let plates: Coastlines | null = null;
let manifest: Manifest;
let tree: PlateTreeData;
let topoTree: PlateTreeData | null = null;

const ui = new PlateTreeUi(view, {
  onAge: (age) => { applyAge(age); },
  onProjection: (mode) => { applyProjection(mode); },
  onTheme: (id) => { applyTheme(id); },
  onTreeSource: (src) => { applyTreeSource(src); },
  onShowPlates: (v) => { applyShowPlates(v); },
  onShowLocked: (v) => { overlay.showLocked = v; },
  onShowLabels: (v) => { overlay.showLabels = v; },
  onColorByGroup: (v) => { overlay.colorByGroup = v; },
  onShowCoastlines: (v) => {
    view.showCoastlines = v;
    if (!coastlines) return;
    coastlines.lines.visible = v;
    coastlines.landVisible = v;
    coastlines.setPaused(!v);
  },
  onShowTopology: (v) => { view.showTopology = v; topology.visible = v; },
  onClearSelection: () => { overlay.selected = null; ui.hideCircuit(); refreshStatus(); },
}, 'Plate Tree');

// --- age ----------------------------------------------------------------

function applyAge(age: number): void {
  view.age = age;
  coastlines?.setAge(age);
  plates?.setAge(age);
  overlay.setAge(age);
  // Fire-and-forget, like every other reconstruction wrapper's boundary series:
  // the previous frame stays on screen until the new one resolves rather than
  // flashing empty, so there is nothing here to await.
  void topology.setAge(age);
  refreshStatus();
  refreshCircuit();
}

/**
 * Which longitude sits at the centre of a flat map.
 *
 * One rotation, in the GEOGRAPHIC frame, applied to every layer through the
 * path each already has for the Reference Plate: the meshes rebuild their
 * geometry, the overlay hands it to its projectors. Doing it as a rotation
 * rather than a camera pan is what makes the map still end at its own edges --
 * panning a camera over a fixed plane would just show empty space past the
 * antimeridian.
 */
function applyCentreLon(lon: number): void {
  view.centreLon = wrapLon(lon);
  const flat = isFlat(view.projection);
  const at = flat ? view.centreLon : 0;
  coastlines?.setCentralMeridian(at);
  plates?.setCentralMeridian(at);
  overlay.setReferenceRotation(centralMeridianRotation(at));
  topology.setReferenceRotation(centralMeridianRotation(at));
  refreshStatus();
}

/** Longitude wrapped to (-180, 180]. Dragging is unbounded, so the value has to
 *  come back round rather than clamp at an edge. */
function wrapLon(lon: number): number {
  const x = ((lon + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

function refreshStatus(): void {
  if (!manifest) return;
  const s = overlay.stats;
  // The central meridian has no panel control any more -- it is dragged -- so
  // this is the only place its value is legible.
  const centre = isFlat(view.projection)
    ? `   centre ${view.centreLon.toFixed(0)}°  (drag to scroll)` : '';
  if (!s) { ui.setStatus(`${manifest.name}\nage ${view.age.toFixed(0)} Ma${centre}`); return; }
  const moving = s.links - countLocked();
  ui.setStatus(
    `${manifest.name}  ·  anchored at plate ${manifest.anchor_plate_id}\n`
    + `age ${view.age.toFixed(0)} Ma   (tree sampled every ${manifest.age_step} Myr)${centre}\n`
    + `${s.plates} plates   ${s.links} links   ${moving} moving / ${s.links - moving} locked\n`
    + `${s.patched} patched   ${s.groups} locked groups   root${s.roots.length > 1 ? 's' : ''} ${s.roots.join(', ')}`,
  );
}

function countLocked(): number {
  const f = overlay.currentFrame;
  if (!f) return 0;
  const group = new Map<number, number>();
  for (let i = 0; i < f.present.length; i++) group.set(f.present[i], f.groupOf[i]);
  let n = 0;
  for (const c of f.chains) {
    const a = group.get(c[0]);
    const b = group.get(c[c.length - 1]);
    if (a !== undefined && a === b) n++;
  }
  return n;
}

// --- selection ----------------------------------------------------------

function refreshCircuit(): void {
  const circuit = overlay.selectedCircuit;
  const f = overlay.currentFrame;
  if (!circuit || !f) { ui.hideCircuit(); return; }

  // A circuit plate is marked when it carries NO geometry at this age, so it
  // has no node on the map and the plates either side of it are not neighbours
  // there. Testing membership of `present` directly -- rather than only
  // collecting the interiors of patched chains -- matters because the plates
  // ABOVE a Root Plate are exactly the same case: they sit on the root's path
  // to the anchor precisely because they have no geometry. An earlier version
  // checked only patched chains and so told the reader that every plate on a
  // circuit ending "-> 70 -> 0" carried geometry, which neither of those does.
  const present = new Set(f.present);

  const steps = circuit.map((pid) => ({
    label: overlay.nameOf(pid),
    patched: !present.has(pid),
  }));
  const depth = circuit.length - 1;
  const nGhost = steps.filter((s) => s.patched).length;
  ui.showCircuit(
    `plate circuit — ${depth} rotation${depth === 1 ? '' : 's'} to the anchor`,
    steps,
    nGhost
      ? `⇢ precedes a plate with no geometry at this age (${nGhost} of ${steps.length}): `
        + 'it has no node on the map, and the plates either side of it are not neighbours there.'
      : 'Every plate on this circuit carries geometry at this age.',
  );
}

function selectAt(clientX: number, clientY: number): void {
  // Prefer a node the user actually aimed at; fall back to "which plate is
  // under this point", so clicking a continent works as well as clicking a dot.
  let plateId = overlay.pickNode(clientX, clientY);

  if (plateId === null && !isFlat(view.projection)) {
    const at = pickLonLat(clientX, clientY);
    if (at && polygonData) {
      const assigned = assignPlate(polygonData.polygons, polygonData.table, at, view.age);
      if (assigned) plateId = assigned.plateId;
    }
  }

  if (plateId === null) return;
  const f = overlay.currentFrame;
  if (!f || !f.present.includes(plateId)) return;
  overlay.selected = plateId;
  refreshCircuit();
}

const raycaster = new Raycaster();
function pickLonLat(clientX: number, clientY: number): LonLat | null {
  const ndc = new Vector2(
    (clientX / innerWidth) * 2 - 1,
    -(clientY / innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(ocean.mesh, false)[0];
  if (!hit) return null;
  // Render frame (X, Z, -Y) back to the geographic frame the rotation table
  // and the polygon rings live in.
  const p = hit.point;
  return vec3ToLonLat(p.x, -p.z, p.y);
}

// --- projection / theme -------------------------------------------------

function applyProjection(mode: ProjectionMode): void {
  view.projection = mode;
  camera = createProjectionCamera(mode, innerWidth / innerHeight) as typeof camera;
  controls.dispose();
  controls = createProjectionControls(mode, camera, renderer.domElement);
  tuneControls();
  ocean.setProjection?.(mode);
  coastlines?.setProjection(mode);
  plates?.setProjection(mode);
  overlay.setCamera(camera, mode);
  topology.setCamera(camera, mode);
  // A central meridian means nothing on a sphere, so it is dropped entering
  // the globe and restored on the way back out -- not silently kept, which
  // would leave the globe rotated for a reason the panel no longer shows.
  applyCentreLon(view.centreLon);
}

function applyTheme(id: ThemeId): void {
  view.theme = id;
  const theme = resolveTheme(id);
  // The fixed panels (status, circuit, timebar, info) follow lightness only,
  // never a Theme's roles -- see plateTreeUi.ts's own DARK_CHROME/LIGHT_CHROME
  // comment for why. A light Theme (Frost, Parchment) with the OLD hardcoded
  // dark-panel styling put pale text on a dark box sitting on a near-white
  // globe: legible against neither.
  applyChromeLightness(theme.lightness);
  ui.applyLightness(theme.lightness);
  renderer.setClearColor(new Color(theme.page));
  ocean.applyTheme(theme);
  coastlines?.applyTheme(theme);
  // The mosaic's own fill is fully transparent: it exists only to carry the
  // full static-polygon boundary network (including internal continental/
  // oceanic subdivisions that the real coastline never draws) as an overlay
  // pen. Real land/sea colouring comes entirely from `coastlines` beneath it.
  if (plates) {
    plates.setLineColor(theme.outline ?? theme.land);
    plates.setLineOpacity(0.4);
    plates.setLandOpacity(0);
  }
  // The real continent OUTLINE (as opposed to the mosaic's own separately-
  // dimmed line above) draws at full Theme strength directly over the real
  // land fill. A 'contrast'-treatment Theme picks its pen from an
  // independently authored hue, which reads as a sharp, unrelated colour
  // against that fill. Blending the pen 40% toward `land` here -- a
  // PlateTree-local decision, not a change to the shared Theme table --
  // keeps that legible while softening the clash. 'shade'/'none' treatments
  // are already low-contrast by construction (docs/adr/0038 in the Geode
  // repo) and are left untouched, so a Theme like Parchment or Relief still
  // reads exactly as authored.
  if (coastlines && theme.outline !== null) {
    const softened = theme.theme.outline === 'contrast'
      ? mixHex(theme.outline, theme.land, 0.4)
      : theme.outline;
    coastlines.setLineColor(softened);
  }
  overlay.applyTheme(theme);
  topology.applyTheme(subdued(theme));
}

/**
 * A copy of `theme` with its boundary styling muted, for the topology
 * backdrop. This viewer's subject is the plate-tree links; the resolved
 * boundaries are context underneath them, so they draw at a fraction of the
 * weight and opacity the same Theme gives boundaries in a viewer where they
 * ARE the subject (e.g. Geode's reconstruction wrapper).
 */
function subdued(theme: ResolvedTheme): ResolvedTheme {
  const style: ResolvedTheme['boundaryStyle'] = {};
  for (const [type, s] of Object.entries(theme.boundaryStyle)) {
    style[type] = { ...s, stroke: hexToRgba(s.stroke, 0.4), width: s.width * 0.55 };
  }
  return {
    ...theme,
    boundaryStyle: style,
    boundaryDecoration: {
      triangleGap: theme.boundaryDecoration.triangleGap,
      triangleSize: theme.boundaryDecoration.triangleSize * 0.6,
    },
  };
}

/** A `#rrggbb` hex STRING (what `boundaryStyle` entries carry) at reduced
 *  alpha, as a `rgba()` CSS colour petrify's canvas drawing accepts
 *  directly. */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace(/^#/, ''), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/** Swap between the tree built from rigid static polygons and the one built
 *  from resolved topologies -- gprm's `polygon_type`. */
function applyTreeSource(src: TreeSource): void {
  view.treeSource = src;
  const next = src === 'topological' ? topoTree : tree;
  if (!next) return;
  overlay.setData(next);
  overlay.setAge(view.age);
  ui.hideCircuit();
  refreshStatus();
}

/** Show the whole plate mosaic's boundary network, or just the continents.
 *
 *  The mosaic's own fill is always transparent (see applyTheme()), so it
 *  never competes with the coastline LAND fill underneath -- both can be on
 *  at once. Turning the mosaic off just removes its boundary lines. */
function applyShowPlates(on: boolean): void {
  view.showPlates = on;
  if (plates) {
    // Visibility before pausing, both ways round: the rebuild that unpausing
    // triggers skips whatever is still hidden at that moment.
    plates.landVisible = on;
    plates.lines.visible = on;
    // The mosaic is the heaviest geometry here by a wide margin. Without this
    // it went on rebuilding itself on every age step and every drag frame
    // while switched off.
    plates.setPaused(!on);
  }
  if (coastlines) coastlines.landVisible = view.showCoastlines;
}

/** Blend two 0xrrggbb colours, `t` of the way from `a` to `b`. */
function mixHex(a: number, b: number, t: number): number {
  const ch = (v: number, sh: number) => (v >> sh) & 0xff;
  const m = (sh: number) => Math.round(ch(a, sh) * (1 - t) + ch(b, sh) * t) << sh;
  return m(16) | m(8) | m(0);
}

// --- boot ---------------------------------------------------------------

let polygonData: Awaited<ReturnType<typeof fetchStaticPolygonData>> | null = null;

async function boot(): Promise<void> {
  ui.setStatus('loading...');
  const base = `${DATA}/reconstructions/${RECON}`;
  manifest = await (await fetch(`${base}/manifest.json`)).json();

  const [coastData, polys, treeBytes, meshData, topoBytes] = await Promise.all([
    fetchCoastlineData(base, manifest.coastlines.geometry, manifest.coastlines.rotations),
    fetchStaticPolygonData(
      base,
      manifest.static_polygons.geometry,
      manifest.static_polygons.rotations,
      manifest.static_polygons.plate_names,
    ),
    fetchVolumeBytes(`${base}/${manifest.plate_tree}`),
    manifest.static_polygons.mesh
      ? fetchCoastlineData(base, manifest.static_polygons.mesh,
                           manifest.static_polygons.rotations)
      : Promise.resolve(null),
    manifest.plate_tree_topological
      ? fetchVolumeBytes(`${base}/${manifest.plate_tree_topological}`)
      : Promise.resolve(null),
    manifest.boundaries
      ? topology.load(`${base}/${manifest.boundaries}`).then(() => { hasTopology = true; })
      : Promise.resolve(),
  ]);
  polygonData = polys;

  if (meshData) {
    plates = new Coastlines(meshData.lines, meshData.table, createMaskTexture());
    plates.setMaskEnabled(false);
    plates.landVisible = true;
    scene.add(plates.lines, plates.land);
  }

  coastlines = new Coastlines(coastData.lines, coastData.table, createMaskTexture());
  coastlines.setMaskEnabled(false);
  coastlines.landVisible = true;
  scene.add(coastlines.lines, coastlines.land);

  tree = parsePlateTree(
    treeBytes.buffer.slice(
      treeBytes.byteOffset, treeBytes.byteOffset + treeBytes.byteLength,
    ) as ArrayBuffer,
  );
  if (topoBytes) {
    topoTree = parsePlateTree(
      topoBytes.buffer.slice(
        topoBytes.byteOffset, topoBytes.byteOffset + topoBytes.byteLength,
      ) as ArrayBuffer,
    );
  }

  overlay.load(tree, polys.polygons, polys.table, polys.plateNames);
  overlay.setCamera(camera, view.projection);
  topology.setCamera(camera, view.projection);
  topology.visible = view.showTopology;

  applyTheme(view.theme);
  applyShowPlates(view.showPlates);
  ui.setAgeRange(manifest.age_min, manifest.age_max);
  ui.setTopologicalAvailable(topoTree !== null);
  ui.setTopologyAvailable(hasTopology);
  applyAge(manifest.age_min);

  window.__platetree = {
    ready: true,
    setAge: (age: number) => { applyAge(age); ui.refreshDisplay(); },
    select: (plateId: number) => { overlay.selected = plateId; refreshCircuit(); },
    circuit: () => overlay.selectedCircuit,
    stats: () => overlay.stats,
    ages: () => tree.ages.length,
    presentPlates: () => overlay.currentFrame?.present ?? [],
    setProjection: (mode: ProjectionMode) => { applyProjection(mode); ui.refreshDisplay(); },
    setCentreLon: (lon: number) => { applyCentreLon(lon); ui.refreshDisplay(); },
    centreLon: () => view.centreLon,
    nodeScreens: () => Object.fromEntries(overlay.screenPositions),
    degreesPerPixel: () => overlay.degreesPerPixel,
    setTreeSource: (src: TreeSource) => { applyTreeSource(src); ui.refreshDisplay(); },
    setShowPlates: (v: boolean) => { applyShowPlates(v); ui.refreshDisplay(); },
    nodeMode: () => overlay.nodeMode,
    debugHide: (what: string) => {
      if (what === 'ocean') ocean.mesh.visible = !ocean.mesh.visible;
      if (what === 'land' && coastlines) coastlines.land.visible = !coastlines.land.visible;
      if (what === 'lines' && coastlines) coastlines.lines.visible = !coastlines.lines.visible;
      return {
        ocean: ocean.mesh.visible,
        land: coastlines?.land.visible,
        lines: coastlines?.lines.visible,
      };
    },
  };
}

declare global {
  interface Window { __platetree?: Record<string, unknown> }
}

// --- events -------------------------------------------------------------

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjectionCameraAspect(camera, innerWidth / innerHeight);
  overlay.setRect({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  topology.setRect({ x: 0, y: 0, width: innerWidth, height: innerHeight });
});

// A plain click fights OrbitControls on the globe, so only treat a pointerup
// as a selection when the pointer barely moved since pointerdown.
let downAt: [number, number] | null = null;

/**
 * Left-drag on a flat map scrolls the central meridian.
 *
 * The horizontal distance is converted at the map's own scale
 * (overlay.degreesPerPixel, measured through the live camera), so the ground
 * keeps up with the pointer at any zoom rather than sliding at a fixed rate.
 * Vertical movement is ignored: the map has no wrap in latitude, and mixing a
 * camera pan into the same gesture makes the two impossible to tell apart.
 * OrbitControls' right-button pan and the wheel still do their usual jobs.
 */
let dragLon: { x: number; lon: number } | null = null;
/** Set by pointermove, consumed once per animation frame. A drag can fire
 *  several moves between frames, and each applied one rebuilds every mesh. */
let pendingLon: number | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY];
  if (e.button === 0 && isFlat(view.projection)) {
    dragLon = { x: e.clientX, lon: view.centreLon };
    renderer.domElement.setPointerCapture(e.pointerId);
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragLon) return;
  // Before the first draw the map's width is unknown; a full window-width drag
  // being a full turn is the right order of magnitude to fall back to.
  const degPerPx = overlay.degreesPerPixel || 360 / innerWidth;
  // Drag right, map moves right: a feature's display longitude is its true
  // longitude MINUS the central meridian, so moving it east lowers the centre.
  pendingLon = dragLon.lon - (e.clientX - dragLon.x) * degPerPx;
});

function endDrag(e: PointerEvent): void {
  if (!dragLon) return;
  dragLon = null;
  if (renderer.domElement.hasPointerCapture(e.pointerId)) {
    renderer.domElement.releasePointerCapture(e.pointerId);
  }
}

renderer.domElement.addEventListener('pointerup', (e) => {
  endDrag(e);
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved < 4) selectAt(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('pointercancel', endDrag);

const clock = new Clock();
function animate(): void {
  requestAnimationFrame(animate);
  if (pendingLon !== null) { applyCentreLon(pendingLon); pendingLon = null; }
  controls.update();
  clock.getDelta();
  renderer.render(scene, camera);
  topology.draw();
  overlay.draw();
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="error">${String(e)}</pre>`);
});
animate();
