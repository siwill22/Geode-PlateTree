import type { Rect } from './layout';

/**
 * A generic alluvial diagram: columns of coloured bands (nodes), joined by
 * ribbons (flows) whose thickness is proportional to a value. No domain
 * knowledge lives here -- lockedGroupFlow.ts turns a Plate Tree's Locked
 * Groups into the shapes this module draws, the same split
 * core/plateTree.ts (data) and platetree/plateTreeUi.ts (chrome) already
 * follow.
 *
 * Unlike a classic Sankey diagram, columns are NOT evenly spaced: a caller
 * asks for a variable-width column so the x axis can stay a true, linear
 * time axis (see lockedGroupFlow.ts's Checkpoint compression) rather than
 * implying every column covers an equal span.
 */
export interface SankeyNode {
  /** Unique within its own column only -- a ribbon addresses a node via
   *  (column index, id), never id alone, so two unrelated columns are free
   *  to reuse the same id. */
  id: string;
  value: number;
  color: string;
}

export interface SankeyColumn {
  x0: number;
  x1: number;
  nodes: SankeyNode[];
}

export interface SankeyFlow {
  fromColumn: number;
  fromNode: string;
  toColumn: number;
  toNode: string;
  value: number;
}

interface LaidOutNode extends SankeyNode {
  y0: number;
  y1: number;
}

interface LaidOutColumn {
  x0: number;
  x1: number;
  nodes: LaidOutNode[];
}

export interface SankeyLayout {
  columns: LaidOutColumn[];
}

/**
 * Carve a small transition gap out of every INTERNAL column boundary, split
 * evenly between the two columns it separates. Columns handed to this module
 * commonly abut exactly -- lockedGroupFlow.ts's Checkpoints tile the full age
 * range with no gaps, since every Myr belongs to exactly one partition -- but
 * a ribbon between two touching columns has zero width to be drawn in and
 * disappears entirely. This trades a sliver of each column's own plateau for
 * room to draw the merge/split as an actual curve.
 *
 * A column wins its outer edge (the first column's x0, the last column's x1)
 * untouched. A column narrower than `gapPx` collapses to a single point
 * rather than going negative -- correct for a genuinely instantaneous
 * reorganisation event, which should read as a pinch, not a gap.
 */
export function withTransitionGaps(columns: readonly SankeyColumn[], gapPx: number): SankeyColumn[] {
  const half = gapPx / 2;
  // A column clamped to a literal zero-width point relies entirely on its
  // two neighbouring ribbons to paint that x-coordinate, and drawPlateaus()
  // skips it outright (x1 <= x0) -- any tiny float mismatch between where a
  // ribbon's curve actually lands and this exact coordinate then shows as a
  // hairline of bare background. A small minimum width keeps drawPlateaus
  // painting a real (if tiny) plateau there instead, which reliably bridges
  // both ribbons regardless of that mismatch.
  const minCore = 0.6;
  return columns.map((col, i) => {
    let x0 = i === 0 ? col.x0 : col.x0 + half;
    let x1 = i === columns.length - 1 ? col.x1 : col.x1 - half;
    if (x1 - x0 < minCore) {
      const mid = (x0 + x1) / 2;
      x0 = mid - minCore / 2;
      x1 = mid + minCore / 2;
    }
    return { ...col, x0, x1 };
  });
}

export interface LayoutSankeyOptions {
  padY: number;
  /**
   * The node value that maps to the full rect height. Omit to normalise
   * each column to its OWN total (every column then fills the full height
   * regardless of how much value it actually carries -- the classic Sankey
   * behaviour). Pass the largest column total across the whole diagram to
   * get an ABSOLUTE scale instead: a column with less total value than that
   * maximum then draws shorter and centred, rather than stretched to match
   * every other column. lockedGroupFlowPanel.ts uses the latter -- a
   * Checkpoint with less modelled area than 0 Ma should look like less is
   * known then, not be stretched to imply parity it doesn't have.
   */
  referenceTotal?: number;
}

/**
 * Stack each column's nodes in the order given -- the caller decides
 * ordering (lockedGroupFlow.ts uses a barycentre heuristic against the
 * previous column) since minimising ribbon crossings needs the flow graph,
 * which this module never sees. Each column is vertically CENTRED within
 * the rect: with a shared `referenceTotal`, a column short of the maximum
 * leaves equal empty space above and below rather than pinning to one edge.
 */
export function layoutSankey(
  columns: SankeyColumn[], rect: Rect, opts: LayoutSankeyOptions = { padY: 4 },
): SankeyLayout {
  const h = Math.max(0, rect.height - 2 * opts.padY);
  const out: LaidOutColumn[] = columns.map((col) => {
    const colTotal = col.nodes.reduce((s, n) => s + n.value, 0);
    const scaleTotal = opts.referenceTotal ?? colTotal ?? 0;
    const colHeight = scaleTotal > 0 ? (colTotal / scaleTotal) * h : 0;
    let y = rect.y + opts.padY + (h - colHeight) / 2;
    const nodes: LaidOutNode[] = col.nodes.map((n) => {
      const nh = scaleTotal > 0 ? (n.value / scaleTotal) * h : 0;
      const laid = { ...n, y0: y, y1: y + nh };
      y += nh;
      return laid;
    });
    return { x0: col.x0, x1: col.x1, nodes };
  });
  return { columns: out };
}

function findNode(layout: SankeyLayout, column: number, id: string): LaidOutNode | undefined {
  return layout.columns[column]?.nodes.find((n) => n.id === id);
}

/** One flow's ribbon, already split into a stacked sub-band of both its
 *  source and destination node's extent -- see stackRibbons(). */
interface Ribbon {
  x0: number; y0top: number; y0bot: number;
  x1: number; y1top: number; y1bot: number;
  color: string;
}

/**
 * Turn flows into stacked ribbons: every node's incoming and outgoing edges
 * are ordered by the OTHER end's vertical position, then packed top-to-bottom
 * within that node's own y-extent -- the same convention d3-sankey uses, so
 * ribbons leaving the top of a node connect to targets in top-to-bottom
 * order and rarely cross each other needlessly.
 */
function stackRibbons(layout: SankeyLayout, flows: readonly SankeyFlow[]): Ribbon[] {
  const byPair = new Map<number, SankeyFlow[]>();
  for (const f of flows) {
    if (!byPair.has(f.fromColumn)) byPair.set(f.fromColumn, []);
    byPair.get(f.fromColumn)!.push(f);
  }

  const ribbons: Ribbon[] = [];
  for (const [fromColumn, list] of byPair) {
    const toColumn = fromColumn + 1;
    const sorted = [...list].sort((a, b) => {
      const as = findNode(layout, fromColumn, a.fromNode)?.y0 ?? 0;
      const bs = findNode(layout, fromColumn, b.fromNode)?.y0 ?? 0;
      if (as !== bs) return as - bs;
      const ad = findNode(layout, toColumn, a.toNode)?.y0 ?? 0;
      const bd = findNode(layout, toColumn, b.toNode)?.y0 ?? 0;
      return ad - bd;
    });

    const outCursor = new Map<string, number>();
    const inCursor = new Map<string, number>();
    for (const f of sorted) {
      const src = findNode(layout, fromColumn, f.fromNode);
      const dst = findNode(layout, toColumn, f.toNode);
      if (!src || !dst) continue;
      const srcTotal = src.value || 1;
      const dstTotal = dst.value || 1;
      const sOff = outCursor.get(f.fromNode) ?? src.y0;
      const sH = (f.value / srcTotal) * (src.y1 - src.y0);
      const dOff = inCursor.get(f.toNode) ?? dst.y0;
      const dH = (f.value / dstTotal) * (dst.y1 - dst.y0);
      ribbons.push({
        x0: layout.columns[fromColumn].x1, y0top: sOff, y0bot: sOff + sH,
        x1: layout.columns[toColumn].x0, y1top: dOff, y1bot: dOff + dH,
        color: src.color,
      });
      outCursor.set(f.fromNode, sOff + sH);
      inCursor.set(f.toNode, dOff + dH);
    }
  }
  return ribbons;
}

function ribbonPath(ctx: CanvasRenderingContext2D, r: Ribbon): void {
  const xm = (r.x0 + r.x1) / 2;
  ctx.beginPath();
  ctx.moveTo(r.x0, r.y0top);
  ctx.bezierCurveTo(xm, r.y0top, xm, r.y1top, r.x1, r.y1top);
  ctx.lineTo(r.x1, r.y1bot);
  ctx.bezierCurveTo(xm, r.y1bot, xm, r.y0bot, r.x0, r.y0bot);
  ctx.closePath();
}

export interface SankeyDrawOptions {
  ribbonAlpha: number;
  nodeAlpha: number;
}

const DEFAULT_DRAW_OPTIONS: SankeyDrawOptions = { ribbonAlpha: 0.75, nodeAlpha: 0.95 };

/**
 * Fill each node's own column span as a flat, solid-colour plateau -- the
 * "nothing changed here" part of the diagram, as opposed to the curved
 * ribbons at a column boundary where something did. Drawn as plain rects
 * rather than bezier ribbons because within one column nothing moves: the
 * partition is, by construction (see lockedGroupFlow.ts's Checkpoint
 * compression), identical from x0 to x1.
 */
function drawPlateaus(ctx: CanvasRenderingContext2D, layout: SankeyLayout): void {
  // Overlaps its own column by half a pixel on each side, into the
  // transition gap the adjoining ribbon is drawn in. The two shapes meet at
  // the exact same coordinate in theory, but canvas antialiasing softens a
  // rect edge and a bezier edge slightly differently, and at the width most
  // Checkpoints render at (a few px) that mismatch is a visible hairline.
  // Overlapping hides the seam under whichever shape paints second.
  const bleed = 0.5;
  for (const col of layout.columns) {
    if (col.x1 <= col.x0) continue;
    for (const n of col.nodes) {
      if (n.y1 - n.y0 < 0.3) continue;
      ctx.fillStyle = n.color;
      ctx.fillRect(col.x0 - bleed, n.y0, (col.x1 - col.x0) + 2 * bleed, n.y1 - n.y0);
    }
  }
}

export function drawSankey(
  ctx: CanvasRenderingContext2D, layout: SankeyLayout, flows: readonly SankeyFlow[],
  opts: Partial<SankeyDrawOptions> = {},
): void {
  const o = { ...DEFAULT_DRAW_OPTIONS, ...opts };
  ctx.save();
  ctx.globalAlpha = o.nodeAlpha;
  drawPlateaus(ctx, layout);
  ctx.globalAlpha = o.ribbonAlpha;
  for (const r of stackRibbons(layout, flows)) {
    ribbonPath(ctx, r);
    ctx.fillStyle = r.color;
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Nearest node to a point, by column (x) then vertical position (y) within
 * that column -- for hover/click.
 *
 * Snaps to the nearest column within `maxSnapPx` rather than requiring an
 * exact x0..x1 hit: withTransitionGaps() can carve a gap wider than a
 * column's own plateau wherever Checkpoints are dense (dozens of
 * reorganisation events packed into a few hundred pixels), so an exact-hit
 * test would leave much of the diagram's width dead to the pointer. A reader
 * hovering near a boundary wants the nearer checkpoint's answer, not nothing.
 */
export function pickSankeyNode(
  layout: SankeyLayout, x: number, y: number, maxSnapPx = 24,
): { columnIndex: number; node: LaidOutNode } | null {
  let columnIndex = -1;
  let bestDist = maxSnapPx;
  layout.columns.forEach((c, i) => {
    const d = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
    if (d <= bestDist) { bestDist = d; columnIndex = i; }
  });
  if (columnIndex < 0) return null;
  const col = layout.columns[columnIndex];
  const node = col.nodes.find((n) => y >= n.y0 && y <= n.y1);
  return node ? { columnIndex, node } : null;
}
