import {
  Clock, Color, Raycaster, Scene, Vector2, WebGLRenderer,
} from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Coastlines, fetchCoastlineData } from '../core/coastlines';
import { OceanSurface } from '../core/oceanSurface';
import { createMaskTexture } from '../core/mask';
import { DEFAULT_THEME, resolveTheme, type ThemeId } from '../core/theme';
import {
  createProjectionCamera, createProjectionControls, isFlat,
  updateProjectionCameraAspect, type ProjectionMode,
} from '../core/projection';
import { fetchStaticPolygonData, assignPlate } from '../core/staticPolygons';
import { fetchVolumeBytes } from '../core/volume';
import { vec3ToLonLat, type LonLat } from '../core/constants';
import { PlateTreeOverlay, parsePlateTree, type PlateTreeData } from '../core/plateTree';
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
};

const scene = new Scene();
let camera = createProjectionCamera('globe', innerWidth / innerHeight);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(new Color(resolveTheme(view.theme).page));
document.body.appendChild(renderer.domElement);

let controls: OrbitControls = createProjectionControls('globe', camera, renderer.domElement);

const ocean = new OceanSurface('globe');
scene.add(ocean.mesh);

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
  onCentreLon: (lon) => { applyCentreLon(lon); },
  onShowPlates: (v) => { applyShowPlates(v); },
  onShowLocked: (v) => { overlay.showLocked = v; },
  onShowLabels: (v) => { overlay.showLabels = v; },
  onColorByGroup: (v) => { overlay.colorByGroup = v; },
  onShowCoastlines: (v) => {
    view.showCoastlines = v;
    if (!coastlines) return;
    coastlines.lines.visible = v;
    // Land fill only when the mosaic is not already covering everything --
    // see applyShowPlates().
    coastlines.landVisible = v && !view.showPlates;
  },
  onClearSelection: () => { overlay.selected = null; ui.hideCircuit(); refreshStatus(); },
}, 'Plate Tree');

// --- age ----------------------------------------------------------------

function applyAge(age: number): void {
  view.age = age;
  coastlines?.setAge(age);
  plates?.setAge(age);
  overlay.setAge(age);
  refreshStatus();
  refreshCircuit();
}

/**
 * Which longitude sits at the centre of a flat map.
 *
 * One rotation, applied to every layer through the path each already has for
 * the Reference Plate: the meshes rebuild their geometry, the overlay hands it
 * to its projectors. Doing it as a rotation rather than a camera pan is what
 * makes the map still end at its own edges -- panning a camera over a fixed
 * plane would just show empty space past the antimeridian.
 */
function applyCentreLon(lon: number): void {
  view.centreLon = lon;
  const flat = isFlat(view.projection);
  const q = centralMeridianRotation(flat ? lon : 0);
  coastlines?.setCentralMeridian(flat ? lon : 0);
  plates?.setCentralMeridian(flat ? lon : 0);
  overlay.setReferenceRotation(q);
}

function refreshStatus(): void {
  const s = overlay.stats;
  if (!s) { ui.setStatus(`${manifest.name}\nage ${view.age.toFixed(0)} Ma`); return; }
  const moving = s.links - countLocked();
  ui.setStatus(
    `${manifest.name}  ·  anchored at plate ${manifest.anchor_plate_id}\n`
    + `age ${view.age.toFixed(0)} Ma   (tree sampled every ${manifest.age_step} Myr)\n`
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
  ocean.setProjection?.(mode);
  coastlines?.setProjection(mode);
  plates?.setProjection(mode);
  overlay.setCamera(camera, mode);
  // A central meridian means nothing on a sphere, so it is dropped entering
  // the globe and restored on the way back out -- not silently kept, which
  // would leave the globe rotated for a reason the panel no longer shows.
  applyCentreLon(view.centreLon);
  ui.setCentreEnabled(isFlat(mode));
}

function applyTheme(id: ThemeId): void {
  view.theme = id;
  const theme = resolveTheme(id);
  renderer.setClearColor(new Color(theme.page));
  ocean.applyTheme(theme);
  coastlines?.applyTheme(theme);
  // The mosaic must NOT read as land: with it on, it covers oceanic and
  // continental crust alike, so painting it the land colour would erase the
  // land/sea distinction entirely. Sits between water and land instead, with a
  // near-invisible pen -- there are 2422 rings, and at coastline weight their
  // outlines bury everything else on the map.
  if (plates) {
    plates.setLandColor(mixHex(theme.water, theme.land, 0.42));
    plates.setLineColor(theme.outline ?? theme.land);
    plates.setLineOpacity(0.16);
    plates.setLandOpacity(1);
  }
  overlay.applyTheme(theme);
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

/** Show the whole plate mosaic, or just the continents.
 *
 *  With the mosaic on, the coastline LAND fill is switched off: the mosaic
 *  already covers every plate including the continental ones, and two filled
 *  meshes at the same depth on a flat map would z-fight. The coastline LINES
 *  stay, so continents are still outlined on top of the mosaic. */
function applyShowPlates(on: boolean): void {
  view.showPlates = on;
  if (plates) {
    plates.land.visible = on;
    plates.lines.visible = on;
  }
  if (coastlines) coastlines.landVisible = view.showCoastlines && !on;
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

  applyTheme(view.theme);
  applyShowPlates(view.showPlates);
  ui.setAgeRange(manifest.age_min, manifest.age_max);
  ui.setCentreEnabled(isFlat(view.projection));
  ui.setTopologicalAvailable(topoTree !== null);
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
});

// A plain click fights OrbitControls on the globe, so only treat a pointerup
// as a selection when the pointer barely moved since pointerdown.
let downAt: [number, number] | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved < 4) selectAt(e.clientX, e.clientY);
});

const clock = new Clock();
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  clock.getDelta();
  renderer.render(scene, camera);
  overlay.draw();
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="error">${String(e)}</pre>`);
});
animate();
