import type { PerspectiveCamera, Camera } from 'three';

import { ThreeProjector } from './boundaries';
import { FlatProjector } from './flatProjector';
import { isFlat, type ProjectionMode } from './projection';
import { polygonBoundaryCentroid } from './staticPolygons';
import { rotationAt, rotateVector, type Quaternion } from './rotation';
import type { Rect } from './layout';
import type { ResolvedTheme } from './theme';
import type { RotationTable, StaticPolygon } from './types';

/** One exported age's Plate Tree. Plate ids are real ids, not table indices --
 *  the index encoding in chains.bin is unpacked away at parse time. */
export interface PlateTreeFrame {
  age: number;
  /** Each chain runs child -> ... -> parent; first and last both carry
   *  geometry, anything between them does not (a Patched Link). */
  chains: number[][];
  /** Plural by nature: measured at four simultaneous roots at 500 Ma in
   *  Cao 2024. Never assume one. */
  roots: number[];
  /** Each root's own path up to and including the anchor. Without this a Plate
   *  Circuit stops one plate short -- a root has no chain of its own. */
  rootPaths: number[][];
  /** Plates carrying geometry at this age, sorted. */
  present: number[];
  /** Node mode 0 only: index into the static-polygon array of the polygon
   *  defining each present plate's node, parallel to `present`. */
  polyOf: number[];
  /** Node mode 1 only: each present plate's already-reconstructed node
   *  position as [lon, lat], parallel to `present`. A topological plate is
   *  resolved at each age rather than rotated from a present-day ring, so
   *  there is nothing to rotate client-side and the position is what gets
   *  exported. */
  nodeLonLat: [number, number][];
  /** Locked Group id per present plate, parallel to `present`. Ids are
   *  per-age and carry NO meaning across ages -- group 3 at 100 Ma and group 3
   *  at 105 Ma are unrelated. */
  groupOf: number[];
}

/** How a frame's Tree Node positions are stored. See PlateTreeFrame. */
export type NodeMode = 'polygon' | 'lonlat';

export interface PlateTreeData {
  ages: number[];
  frames: PlateTreeFrame[];
  /** `polygon` for a tree built from rigid static polygons (the client rotates
   *  the named ring to any continuous age); `lonlat` for one built from
   *  resolved topologies, which have no present-day ring to rotate. */
  nodeMode: NodeMode;
}

export function parsePlateTree(buf: ArrayBuffer): PlateTreeData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'ESPT') throw new Error(`bad plate-tree magic: ${magic}`);
  const version = dv.getUint32(4, true);
  if (version !== 2) {
    throw new Error(`plate tree is version ${version}, expected 2 -- re-run prep_platetree.py`);
  }
  const nodeMode: NodeMode = dv.getUint32(8, true) === 1 ? 'lonlat' : 'polygon';
  const nages = dv.getUint32(12, true);
  const nplates = dv.getUint32(16, true);

  let o = 20;
  const plateIds = new Int32Array(buf.slice(o, o + nplates * 4)); o += nplates * 4;
  const ages = new Float32Array(buf.slice(o, o + nages * 4)); o += nages * 4;

  const frames: PlateTreeFrame[] = [];
  for (let f = 0; f < nages; f++) {
    const nchains = dv.getUint32(o, true); o += 4;
    const nroots = dv.getUint32(o, true); o += 4;
    const nrootpath = dv.getUint32(o, true); o += 4;
    o += 4; // ngroups -- derivable from groupOf, read past it
    const npresent = dv.getUint32(o, true); o += 4;

    const roots: number[] = [];
    for (let i = 0; i < nroots; i++) { roots.push(plateIds[dv.getInt32(o, true)]); o += 4; }

    const rootPaths: number[][] = [];
    for (let read = 0; read < nrootpath;) {
      const len = dv.getInt32(o, true); o += 4; read += 1;
      const path: number[] = [];
      for (let i = 0; i < len; i++) { path.push(plateIds[dv.getInt32(o, true)]); o += 4; read += 1; }
      rootPaths.push(path);
    }

    const chains: number[][] = [];
    for (let i = 0; i < nchains; i++) {
      const len = dv.getInt32(o, true); o += 4;
      const chain: number[] = [];
      for (let k = 0; k < len; k++) { chain.push(plateIds[dv.getInt32(o, true)]); o += 4; }
      chains.push(chain);
    }

    const present: number[] = [];
    for (let i = 0; i < npresent; i++) { present.push(plateIds[dv.getInt32(o, true)]); o += 4; }

    const polyOf: number[] = [];
    const nodeLonLat: [number, number][] = [];
    if (nodeMode === 'lonlat') {
      for (let i = 0; i < npresent; i++) {
        nodeLonLat.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true)]);
        o += 8;
      }
    } else {
      for (let i = 0; i < npresent; i++) { polyOf.push(dv.getInt32(o, true)); o += 4; }
    }

    const groupOf: number[] = [];
    for (let i = 0; i < npresent; i++) { groupOf.push(dv.getInt32(o, true)); o += 4; }

    frames.push({ age: ages[f], chains, roots, rootPaths, present, polyOf, nodeLonLat, groupOf });
  }

  return { ages: Array.from(ages), frames, nodeMode };
}

/** A Tree Node, positioned in the GEOGRAPHIC frame (X -> 0N/0E, Y -> 0N/90E,
 *  Z -> pole) -- the frame both projectors expect, and the one the rotation
 *  table acts in. Never the viewer's (X, Z, -Y) render frame. */
export interface TreeNode {
  plateId: number;
  group: number;
  xyz: [number, number, number];
}

/**
 * Which exported frame to show at `age`.
 *
 * Nearest, not interpolated. A Plate Tree's topology changes discontinuously —
 * chains appear and vanish, a plate's parent switches — so there is nothing to
 * interpolate between two frames, exactly as for Boundary Frames. Node
 * POSITIONS are continuous and are handled separately, in nodesAt().
 */
export function frameIndexFor(data: PlateTreeData, age: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < data.ages.length; i++) {
    const d = Math.abs(data.ages[i] - age);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Tree Node positions at a continuous `age`.
 *
 * The defining polygon comes from the nearest exported frame (discrete, chosen
 * by pygplates at export time so the tie-break matches gprm exactly); its ring
 * is then rotated to the EXACT age asked for. That split is deliberate: which
 * polygon defines a node is discontinuous in age, where that polygon sits is
 * not, and treating both the same way produces either a node that jogs between
 * exported ages or a tie broken differently from the reference implementation.
 *
 * Node positions therefore move smoothly as the age slider is dragged, but can
 * still jump when the defining polygon switches between frames -- up to tens of
 * degrees. That is gprm's own behaviour, kept on purpose.
 */
export function nodesAt(
  frame: PlateTreeFrame, polygons: StaticPolygon[], table: RotationTable, age: number,
  nodeMode: NodeMode = 'polygon',
): Map<number, TreeNode> {
  const out = new Map<number, TreeNode>();
  for (let i = 0; i < frame.present.length; i++) {
    const plateId = frame.present[i];

    if (nodeMode === 'lonlat') {
      // A resolved topological plate is rebuilt from its bounding features at
      // each age -- it has no present-day ring and no single rotation that
      // places it -- so its node comes straight from the export, at the
      // sampled age. Unlike the polygon mode below, this does NOT move
      // continuously as the slider is dragged between samples; it cannot,
      // because the plate itself is only defined where it was resolved.
      const [lon, lat] = frame.nodeLonLat[i];
      const la = lat * DEG, lo = lon * DEG;
      const cl = Math.cos(la);
      out.set(plateId, {
        plateId,
        group: frame.groupOf[i],
        xyz: [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)],
      });
      continue;
    }

    const pi = frame.polyOf[i];
    if (pi < 0 || pi >= polygons.length) continue;
    const c = polygonBoundaryCentroid(polygons[pi].points);
    const q = rotationAt(table, plateId, age);
    const [x, y, z] = rotateVector(q, c[0], c[1], c[2]);
    out.set(plateId, { plateId, group: frame.groupOf[i], xyz: [x, y, z] });
  }
  return out;
}

/**
 * The full Plate Circuit for `plateId`: every plate whose rotation is composed
 * to place it, ending at the anchor.
 *
 * Walks chains up to a Root Plate, then appends that root's own path to the
 * anchor -- the last hop exists in no chain, so a circuit built from chains
 * alone stops one plate short of the anchor for every plate in the model.
 */
export function circuitFor(frame: PlateTreeFrame, plateId: number): number[] {
  const chainFrom = new Map<number, number[]>();
  for (const c of frame.chains) if (!chainFrom.has(c[0])) chainFrom.set(c[0], c);

  const out = [plateId];
  const seen = new Set<number>([plateId]);
  let p = plateId;
  while (chainFrom.has(p)) {
    const c = chainFrom.get(p)!;
    for (let i = 1; i < c.length; i++) out.push(c[i]);
    p = c[c.length - 1];
    if (seen.has(p)) return out;
    seen.add(p);
  }
  const path = frame.rootPaths[frame.roots.indexOf(p)];
  if (path) for (let i = 1; i < path.length; i++) out.push(path[i]);
  return out;
}

/** Is this Tree Link locked -- do its endpoints have no relative motion?
 *  Equivalent to sharing a Locked Group, by transitivity of co-rotation, which
 *  is why no separate per-link flag is exported. */
export function isLockedLink(frame: PlateTreeFrame, a: number, b: number): boolean {
  const ga = frame.groupOf[frame.present.indexOf(a)];
  const gb = frame.groupOf[frame.present.indexOf(b)];
  return ga !== undefined && ga === gb;
}

/** Distinguishable hues for Locked Groups. Group ids are per-age and carry no
 *  meaning across ages, so this is a palette to tell groups APART within one
 *  age, never to track one group through time -- a colour is not an identity. */
function groupColor(group: number, lightness: 'light' | 'dark'): string {
  const hue = (group * 137.508) % 360; // golden angle: adjacent ids stay apart
  return lightness === 'dark'
    ? `hsl(${hue.toFixed(1)}, 70%, 62%)`
    : `hsl(${hue.toFixed(1)}, 62%, 42%)`;
}

const DEG = Math.PI / 180;

/** Great-circle interpolation between two unit vectors, so a long link follows
 *  the sphere instead of cutting through it. gprm draws a straight line in
 *  lon/lat, which is wrong on a sphere and visibly so for a long link. */
function slerpArc(
  a: [number, number, number], b: [number, number, number], steps: number,
): [number, number, number][] {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return [a, b];
  const sin = Math.sin(omega);
  const out: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s0 = Math.sin((1 - t) * omega) / sin;
    const s1 = Math.sin(t * omega) / sin;
    out.push([a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1]);
  }
  return out;
}

export interface PlateTreeStyle {
  /** Links whose endpoints actually move relative to each other. */
  movingLink: string;
  /** Links with no relative motion -- the majority, ~78% at 0 Ma, so they are
   *  drawn faint or the map shows mostly plates that are not moving. */
  lockedLink: string;
  /** A Patched Link joins two plates that are NOT adjacent in the hierarchy. */
  patchedDash: number[];
  root: string;
  highlight: string;
  label: string;
}

/**
 * The Plate Tree, drawn on a 2D canvas over the WebGL globe -- the same
 * arrangement `core/boundaries.ts` uses, and for the same reasons: hit-testing
 * and text are far easier here than in three.js geometry, and the projector
 * contract (`project(vec3) -> [x, y, depth] | null`) already handles the
 * horizon test on a sphere and the antimeridian seam on a flat map.
 */
export class PlateTreeOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private projector: ThreeProjector;
  private flatProjector: FlatProjector | null = null;
  private mode: ProjectionMode = 'globe';
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  private data: PlateTreeData | null = null;
  private polygons: StaticPolygon[] = [];
  private table: RotationTable | null = null;
  private names: Readonly<Record<number, string>> = {};

  private frame: PlateTreeFrame | null = null;
  private nodes = new Map<number, TreeNode>();
  /** Screen positions from the last draw, for hit-testing. Rebuilt every frame
   *  because the camera can move without the age changing. */
  private screen = new Map<number, [number, number]>();

  visible = true;
  showLocked = true;
  showLabels = false;
  colorByGroup = true;
  selected: number | null = null;
  private lightness: 'light' | 'dark' = 'dark';

  style: PlateTreeStyle = {
    movingLink: '#e8663c',
    lockedLink: 'rgba(160,170,185,0.30)',
    patchedDash: [4, 3],
    root: '#ffd34d',
    highlight: '#6fe3ff',
    label: 'rgba(235,240,250,0.9)',
  };

  constructor(camera: PerspectiveCamera) {
    this.projector = new ThreeProjector(camera);
    const c = document.createElement('canvas');
    Object.assign(c.style, { position: 'fixed', pointerEvents: 'none' });
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d')!;
    this.applyRect();
  }

  load(data: PlateTreeData, polygons: StaticPolygon[], table: RotationTable,
       names: Readonly<Record<number, string>>): void {
    this.data = data;
    this.polygons = polygons;
    this.table = table;
    this.names = names;
  }

  applyTheme(theme: ResolvedTheme): void {
    this.lightness = theme.lightness === 'light' ? 'light' : 'dark';
    this.style.lockedLink = this.lightness === 'light'
      ? 'rgba(70,80,95,0.28)' : 'rgba(160,170,185,0.30)';
    this.style.label = this.lightness === 'light'
      ? 'rgba(25,30,40,0.9)' : 'rgba(235,240,250,0.9)';
  }

  setCamera(camera: Camera, mode: ProjectionMode): void {
    this.mode = mode;
    if (isFlat(mode)) {
      if (!this.flatProjector) this.flatProjector = new FlatProjector(camera);
      else this.flatProjector.setCamera(camera);
      this.flatProjector.setFlatMode(mode);
    } else {
      this.projector.setCamera(camera as PerspectiveCamera);
    }
  }

  /** `q` in the GEOGRAPHIC frame -- the frame this overlay's own node vectors
   *  live in, and what both projectors take. */
  setReferenceRotation(q: Quaternion): void {
    this.projector.setReferenceRotation(q);
    this.flatProjector?.setReferenceRotation(q);
  }

  /**
   * How many degrees of longitude one screen pixel is worth on the current
   * flat map, so a drag can move the map exactly with the pointer at any zoom.
   *
   * Read from the live camera through `mapHalfWidth` rather than assumed from
   * the window width: the map is only as wide as the camera makes it, and half
   * a map is 180 degrees in both flat Projections. 0 before the first draw, or
   * on the globe, where a central meridian means nothing.
   */
  get degreesPerPixel(): number {
    if (!isFlat(this.mode)) return 0;
    const half = this.flatProjector?.mapHalfWidth ?? 0;
    return half > 0 ? 180 / half : 0;
  }

  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    Object.assign(this.canvas.style, {
      left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
    });
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Move to `age`: pick the nearest exported frame, then position every node
   *  at the exact age. See nodesAt() for why those are two different steps. */
  setAge(age: number): void {
    if (!this.data || !this.table) return;
    this.frame = this.data.frames[frameIndexFor(this.data, age)];
    this.nodes = nodesAt(this.frame, this.polygons, this.table, age, this.data.nodeMode);
  }

  /** Swap which Plate Tree is shown -- rigid static polygons or resolved
   *  topologies. A different statement about the model, not a different
   *  rendering of one, so the selection is cleared: plate ids do not carry
   *  over (a topological plate id need not exist in the static set at all). */
  setData(data: PlateTreeData): void {
    this.data = data;
    this.selected = null;
    this.frame = null;
  }

  get nodeMode(): NodeMode { return this.data?.nodeMode ?? 'polygon'; }

  get currentFrame(): PlateTreeFrame | null { return this.frame; }

  get stats(): { plates: number; links: number; patched: number; groups: number; roots: number[] } | null {
    if (!this.frame) return null;
    return {
      plates: this.frame.present.length,
      links: this.frame.chains.length,
      patched: this.frame.chains.filter((c) => c.length > 2).length,
      groups: new Set(this.frame.groupOf).size,
      roots: this.frame.roots,
    };
  }

  /** The Plate Circuit for the current selection, or null. */
  get selectedCircuit(): number[] | null {
    if (!this.frame || this.selected === null) return null;
    if (!this.frame.present.includes(this.selected)) return null;
    return circuitFor(this.frame, this.selected);
  }

  nameOf(plateId: number): string {
    const n = this.names[plateId];
    return n ? `${plateId} ${n}` : String(plateId);
  }

  /** Nearest Tree Node to a point in this overlay's own CSS pixels, within
   *  `maxPx`. Uses the screen positions from the last draw, so it follows the
   *  camera for free. */
  pickNode(cssX: number, cssY: number, maxPx = 18): number | null {
    let best: number | null = null;
    let bestD = maxPx * maxPx;
    for (const [plateId, [sx, sy]] of this.screen) {
      const dx = sx - cssX, dy = sy - cssY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = plateId; }
    }
    return best;
  }

  /** Where each Tree Node landed in the last draw, in CSS pixels. Exposed for
   *  the verification harness -- a central meridian must move nodes sideways
   *  only, which is a statement about these numbers. */
  get screenPositions(): ReadonlyMap<number, [number, number]> { return this.screen; }

  private project(v: [number, number, number]): [number, number, number] | null {
    return isFlat(this.mode) ? this.flatProjector!.project(v) : this.projector.project(v);
  }

  draw(): void {
    const { width, height } = this.rect;
    this.ctx.clearRect(0, 0, width, height);
    this.screen.clear();
    if (!this.visible || !this.frame) return;

    const dpr = Math.min(devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(width * dpr)) this.applyRect();

    const flat = isFlat(this.mode);
    if (flat) this.flatProjector!.update(width, height);
    else this.projector.update(width, height);

    const halfWidth = flat ? this.flatProjector!.mapHalfWidth : 0;
    const seamJumpPx = flat && halfWidth > 0 ? halfWidth : Infinity;

    const circuit = this.selectedCircuit;
    const onCircuit = new Set(circuit ?? []);

    // --- links --------------------------------------------------------
    for (const chain of this.frame.chains) {
      const a = this.nodes.get(chain[0]);
      const b = this.nodes.get(chain[chain.length - 1]);
      if (!a || !b) continue;

      const locked = a.group === b.group;
      if (locked && !this.showLocked) continue;
      const patched = chain.length > 2;
      const lit = onCircuit.has(chain[0]) && onCircuit.has(chain[chain.length - 1]);

      this.ctx.beginPath();
      let started = false;
      let prevX = 0;
      // A long link needs more segments; a short one is a straight line at
      // screen scale and subdividing it is wasted work. On a flat map the
      // density also sets how close to the seam the break lands, so a link
      // crossing the antimeridian is cut within a few pixels of the edge.
      const arcDeg = Math.acos(Math.max(-1, Math.min(1,
        a.xyz[0] * b.xyz[0] + a.xyz[1] * b.xyz[1] + a.xyz[2] * b.xyz[2]))) / DEG;
      const steps = Math.max(2, Math.min(96, Math.ceil(arcDeg / 2)));
      // Half the map in SCREEN pixels, measured through the live camera by
      // FlatProjector.mapHalfWidth so it tracks pan and zoom. A step that jumps
      // further than this has wrapped the seam rather than genuinely travelled.
      // 0 means "before the first update()", i.e. unknown -- disable the test
      // rather than break every segment.
      const seamJump = seamJumpPx;
      for (const p of slerpArc(a.xyz, b.xyz, steps)) {
        const s = this.project(p);
        // A null projection means the point is over the horizon (globe) or off
        // the map (flat) -- lift the pen rather than drawing a chord across it.
        if (!s) { started = false; continue; }
        // The antimeridian. Consecutive points on a great circle are a couple
        // of degrees apart, so a large jump in screen x can only mean the arc
        // left one edge of the map and re-entered at the other. Break the path
        // instead of drawing across: the arc then correctly appears as two
        // pieces running off opposite edges. Dropping it outright -- what
        // coastlines.ts does for a single short segment -- would lose the whole
        // link, and these links are long by nature.
        if (started && Math.abs(s[0] - prevX) > seamJump) started = false;
        if (!started) { this.ctx.moveTo(s[0], s[1]); started = true; }
        else this.ctx.lineTo(s[0], s[1]);
        prevX = s[0];
      }
      this.ctx.setLineDash(patched ? this.style.patchedDash : []);
      this.ctx.strokeStyle = lit ? this.style.highlight
        : locked ? this.style.lockedLink : this.style.movingLink;
      this.ctx.lineWidth = lit ? 2.6 : locked ? 0.8 : 1.6;
      this.ctx.stroke();
    }
    this.ctx.setLineDash([]);

    // --- nodes --------------------------------------------------------
    const rootSet = new Set(this.frame.roots);
    for (const node of this.nodes.values()) {
      const s = this.project(node.xyz);
      if (!s) continue;
      this.screen.set(node.plateId, [s[0], s[1]]);

      const isRoot = rootSet.has(node.plateId);
      const isSel = node.plateId === this.selected;
      const lit = onCircuit.has(node.plateId);

      this.ctx.beginPath();
      const r = isRoot ? 5.5 : isSel ? 5 : lit ? 3.6 : 2.6;
      this.ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      this.ctx.fillStyle = isRoot ? this.style.root
        : lit ? this.style.highlight
        : this.colorByGroup ? groupColor(node.group, this.lightness)
        : '#cfd6e4';
      this.ctx.fill();
      if (isRoot || isSel) {
        this.ctx.lineWidth = 1.4;
        this.ctx.strokeStyle = this.lightness === 'light' ? '#1a1f28' : '#0c0f14';
        this.ctx.stroke();
      }

      if (this.showLabels || isSel || isRoot) {
        this.ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        this.ctx.fillStyle = this.style.label;
        this.ctx.fillText(String(node.plateId), s[0] + r + 3, s[1] + 3.5);
      }
    }
  }

  dispose(): void {
    this.canvas.remove();
  }
}
