/**
 * Tiling for an arbitrary number of globes sharing one canvas.
 *
 * All rects are in CSS pixels, top-left origin -- the same space `innerWidth`/
 * `innerHeight` and pointer events (`clientX`/`clientY`) live in. Both DOM
 * placement (GUI panels, boundary overlay canvases) and `renderer.setViewport`/
 * `setScissor` (which three.js internally scales by devicePixelRatio, the same
 * way it treats `setSize`) consume this space directly, so nothing here needs
 * to know the device pixel ratio.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pack `n` tiles into `width` x `height`, preferring a layout whose cells are
 * close to square -- a globe read best in a roughly circular viewport, not a
 * sliver -- and that wastes the fewest cells on a ragged last row.
 *
 * A short last row is centred rather than left-aligned, so five globes read as
 * a 3-over-2 group rather than three left-packed cells over two more.
 */
export function tileGrid(n: number, width: number, height: number): Rect[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, width, height }];

  let bestCols = 1;
  let bestRows = n;
  let bestScore = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = width / cols;
    const cellH = height / rows;
    const wasted = cols * rows - n;
    const aspectPenalty = Math.abs(Math.log(cellW / cellH));
    const score = wasted * 2 + aspectPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestCols = cols;
      bestRows = rows;
    }
  }

  const cellW = width / bestCols;
  const cellH = height / bestRows;
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / bestCols);
    const col = i % bestCols;
    const itemsInRow = Math.min(bestCols, n - row * bestCols);
    const rowOffset = ((bestCols - itemsInRow) * cellW) / 2;
    rects.push({
      x: rowOffset + col * cellW,
      y: row * cellH,
      width: cellW,
      height: cellH,
    });
  }
  return rects;
}
