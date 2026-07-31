/**
 * Contour lines → dense terrain heightmap.
 *
 * The 1 m contours cover only ~14% of grid cells, with gaps over open water
 * exceeding a kilometre. Filling that by relaxing Laplace's equation directly on
 * the fine grid would need on the order of 100,000 iterations for information to
 * propagate across the widest gap, so this uses a *cascadic multigrid* scheme:
 * solve on a tiny grid where the gaps are only a few cells wide, then use each
 * solution as the starting guess one level finer. Cost becomes near-linear.
 *
 * The result is a smooth, artifact-free surface that honours every contour.
 */
import type { WorldBounds } from './projection';
import { toWorld } from './projection';

export interface Heightfield {
  /** Row-major, `width * height` samples, in metres above datum. */
  heights: Float32Array;
  width: number;
  height: number;
  /** Grid spacing in metres. */
  resolution: number;
  bounds: WorldBounds;
  minHeight: number;
  maxHeight: number;
  /** 1 where the cell is open water connected to the map edge. */
  water: Uint8Array;
  waterCells: number;
  clampedCells: number;
}

/** Terrain is clamped to this height; Vancouver has no land below it. */
export const SEA_LEVEL = 0;

/**
 * How far a cell must be from any contour line, in metres, before it can be
 * considered open water.
 *
 * Water carries no contours at all, whereas inland the 1 m contours are dense
 * (mean spacing ~33 m). Anything this far from a contour *and* reachable from
 * the map edge is sea. Distance-from-data is a far more reliable signal than
 * height here, because height over water is exactly the thing the solver gets
 * wrong before it is told where the water is.
 */
const WATER_MIN_DISTANCE = 120;

/**
 * Once a region is established as water, it may grow into neighbouring cells
 * this far from a contour.
 *
 * This is a hysteresis threshold, in the same spirit as Canny edge detection: a
 * strict bar to *start* calling something sea, a looser one to continue. Without
 * it, narrow channels — False Creek most importantly — never connect to the open
 * water, because their middle is closer than 120 m to the seawall contours on
 * both banks, and the flood fill stalls at the entrance.
 */
const WATER_GROW_DISTANCE = 52;

export interface ContourFeature {
  geometry: { type: string; coordinates: [number, number][] };
  properties: { elevation?: number | null };
}

/** Grid index from world coordinates, or -1 when outside. */
function gridIndex(
  x: number, z: number,
  bounds: WorldBounds, res: number, W: number, H: number,
): number {
  const gx = Math.round((x - bounds.minX) / res);
  const gy = Math.round((z - bounds.minZ) / res);
  if (gx < 0 || gx >= W || gy < 0 || gy >= H) return -1;
  return gy * W + gx;
}

/**
 * Rasterises contour polylines into the grid.
 *
 * Segments are walked rather than just their endpoints plotted: contour
 * vertices can be many metres apart on straight runs, and plotting only vertices
 * leaves dashed lines that the solver then smooths straight through.
 */
function rasterizeContours(
  features: ContourFeature[],
  bounds: WorldBounds,
  res: number,
  W: number,
  H: number,
): { sum: Float32Array; count: Float32Array } {
  const sum = new Float32Array(W * H);
  const count = new Float32Array(W * H);

  const plot = (x: number, z: number, elev: number): void => {
    const i = gridIndex(x, z, bounds, res, W, H);
    if (i < 0) return;
    // Where contours of different elevations land in one cell, average them.
    sum[i] += elev;
    count[i] += 1;
  };

  for (const f of features) {
    const elev = f.properties.elevation;
    if (elev === null || elev === undefined) continue;
    if (f.geometry.type !== 'LineString') continue;

    const coords = f.geometry.coordinates;
    let prev: { x: number; z: number } | null = null;

    for (const [lon, lat] of coords) {
      const p = toWorld(lon, lat);
      if (prev) {
        // Walk the segment at roughly half-cell steps so no cell is skipped.
        const dx = p.x - prev.x;
        const dz = p.z - prev.z;
        const dist = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil((dist / res) * 2));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          plot(prev.x + dx * t, prev.z + dz * t, elev);
        }
      } else {
        plot(p.x, p.z, elev);
      }
      prev = p;
    }
  }

  return { sum, count };
}

/** In-place Gauss-Seidel relaxation toward the discrete Laplace solution. */
function relax(
  values: Float32Array, fixed: Uint8Array,
  W: number, H: number, iterations: number,
): void {
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (fixed[i]) continue;
        // Mirror at the borders (Neumann / zero-gradient boundary), so the
        // terrain does not get dragged toward zero at the map edge.
        const left = values[x > 0 ? i - 1 : i + 1]!;
        const right = values[x < W - 1 ? i + 1 : i - 1]!;
        const up = values[y > 0 ? i - W : i + W]!;
        const down = values[y < H - 1 ? i + W : i - W]!;
        values[i] = 0.25 * (left + right + up + down);
      }
    }
  }
}

interface Level {
  values: Float32Array;
  fixed: Uint8Array;
  W: number;
  H: number;
}

/** Halves a level, keeping a cell known if any of its four children were. */
function coarsen(level: Level): Level {
  const W = Math.max(1, Math.ceil(level.W / 2));
  const H = Math.max(1, Math.ceil(level.H / 2));
  const values = new Float32Array(W * H);
  const counts = new Float32Array(W * H);
  const fixed = new Uint8Array(W * H);

  for (let y = 0; y < level.H; y++) {
    for (let x = 0; x < level.W; x++) {
      const i = y * level.W + x;
      if (!level.fixed[i]) continue;
      const j = (y >> 1) * W + (x >> 1);
      values[j]! += level.values[i]!;
      counts[j]! += 1;
    }
  }
  for (let j = 0; j < values.length; j++) {
    if (counts[j]! > 0) {
      values[j]! /= counts[j]!;
      fixed[j] = 1;
    }
  }
  return { values, fixed, W, H };
}

/** Seeds a finer level's unknown cells from the coarse solution. */
function prolongate(coarse: Level, fine: Level): void {
  for (let y = 0; y < fine.H; y++) {
    const cy = Math.min(coarse.H - 1, y >> 1);
    for (let x = 0; x < fine.W; x++) {
      const i = y * fine.W + x;
      if (fine.fixed[i]) continue;
      const cx = Math.min(coarse.W - 1, x >> 1);
      fine.values[i] = coarse.values[cy * coarse.W + cx]!;
    }
  }
}

export interface TerrainOptions {
  /** Stop coarsening once a level is this small. */
  coarsestSize?: number;
  /** Relaxation sweeps on the coarsest level. */
  coarseIterations?: number;
  /** Relaxation sweeps on every finer level. */
  fineIterations?: number;
  /**
   * Skip depression filling. Set when roads will be burned in afterwards, so
   * the fill can run last and also catch any dips the burn introduces.
   */
  skipDepressionFill?: boolean;
  onProgress?: (message: string) => void;
}

/** Re-exported so the pipeline can run the fill after burning roads. */
export { fillDepressions };

export function buildHeightfield(
  features: ContourFeature[],
  bounds: WorldBounds,
  resolution: number,
  options: TerrainOptions = {},
): Heightfield {
  const {
    coarsestSize = 24,
    coarseIterations = 400,
    fineIterations = 28,
    skipDepressionFill = false,
    onProgress = () => {},
  } = options;

  const W = Math.ceil(bounds.width / resolution) + 1;
  const H = Math.ceil(bounds.depth / resolution) + 1;
  onProgress(`grid ${W} x ${H} (${((W * H) / 1e6).toFixed(2)}M cells) @ ${resolution} m`);

  const { sum, count } = rasterizeContours(features, bounds, resolution, W, H);

  const values = new Float32Array(W * H);
  const fixed = new Uint8Array(W * H);
  const contourCells = new Uint8Array(W * H);
  let known = 0;
  for (let i = 0; i < values.length; i++) {
    if (count[i]! > 0) {
      values[i] = sum[i]! / count[i]!;
      fixed[i] = 1;
      contourCells[i] = 1;
      known++;
    }
  }
  onProgress(`rasterised ${known.toLocaleString()} cells (${((100 * known) / (W * H)).toFixed(1)}%)`);
  if (known === 0) throw new Error('no contour cells rasterised — check bbox and projection');

  // Pin open water to sea level *before* solving. Without this the solve has no
  // constraint anywhere out in the inlet, so the surrounding land elevations
  // diffuse outward and the sea domes upward into a hill several metres high.
  const water = findWater(contourCells, W, H, resolution);
  let waterCells = 0;
  for (let i = 0; i < water.length; i++) {
    if (water[i]) {
      waterCells++;
      values[i] = SEA_LEVEL;
      fixed[i] = 1;
    }
  }
  onProgress(`water: ${waterCells.toLocaleString()} cells (${((100 * waterCells) / (W * H)).toFixed(1)}%) pinned to sea level`);

  // Build the pyramid down to a grid small enough to solve almost exactly.
  const levels: Level[] = [{ values, fixed, W, H }];
  while (
    levels[levels.length - 1]!.W > coarsestSize &&
    levels[levels.length - 1]!.H > coarsestSize
  ) {
    levels.push(coarsen(levels[levels.length - 1]!));
  }
  onProgress(`multigrid: ${levels.length} levels, coarsest ${levels[levels.length - 1]!.W} x ${levels[levels.length - 1]!.H}`);

  // Seed the coarsest level's unknowns with the mean, then solve hard.
  const coarsest = levels[levels.length - 1]!;
  let mean = 0;
  let n = 0;
  for (let i = 0; i < coarsest.values.length; i++) {
    if (coarsest.fixed[i]) { mean += coarsest.values[i]!; n++; }
  }
  mean = n > 0 ? mean / n : 0;
  for (let i = 0; i < coarsest.values.length; i++) {
    if (!coarsest.fixed[i]) coarsest.values[i] = mean;
  }
  relax(coarsest.values, coarsest.fixed, coarsest.W, coarsest.H, coarseIterations);

  // Cascade back up, refining at each level.
  for (let l = levels.length - 2; l >= 0; l--) {
    prolongate(levels[l + 1]!, levels[l]!);
    relax(levels[l]!.values, levels[l]!.fixed, levels[l]!.W, levels[l]!.H, fineIterations);
    onProgress(`  level ${l}: ${levels[l]!.W} x ${levels[l]!.H} solved`);
  }

  const heights = levels[0]!.values;

  // The 2013 LiDAR captured a handful of construction excavations as genuine
  // sub-sea-level contours (one reaches -10 m in the West End). Left alone they
  // become pits in the middle of a city block that swallow the car. Clamping to
  // sea level removes them and flattens the solver's drift across open water,
  // where there are no contours to constrain it.
  let clampedCells = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i]! < SEA_LEVEL) {
      heights[i] = SEA_LEVEL;
      clampedCells++;
    }
  }
  onProgress(`clamped ${clampedCells.toLocaleString()} cells to sea level`);

  if (!skipDepressionFill) {
    const { raised, maxFill } = fillDepressions(heights, W, H);
    onProgress(
      `filled ${raised.toLocaleString()} depression cells ` +
      `(deepest ${maxFill.toFixed(1)} m)`,
    );
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i]! < minHeight) minHeight = heights[i]!;
    if (heights[i]! > maxHeight) maxHeight = heights[i]!;
  }

  return {
    heights, width: W, height: H, resolution, bounds,
    minHeight, maxHeight, water, waterCells, clampedCells,
  };
}

/**
 * Fills closed depressions, so no cell sits lower than the lowest path from it
 * to the map edge (the Barnes/Planchon priority-flood algorithm).
 *
 * The 2013 LiDAR captured construction excavations as real terrain, leaving
 * pits several metres deep in the middle of city blocks. Since a closed basin
 * with no outlet is almost always an artifact — and always a car trap — every
 * depression is raised to its spill level.
 *
 * Returns the number of cells raised and the deepest fill applied.
 */
function fillDepressions(
  heights: Float32Array, W: number, H: number,
): { raised: number; maxFill: number } {
  const n = W * H;
  const filled = new Float32Array(heights);
  const closed = new Uint8Array(n);

  // Binary min-heap over (height, index), stored in parallel arrays.
  const heapH = new Float64Array(n + 1);
  const heapI = new Int32Array(n + 1);
  let size = 0;

  const push = (h: number, i: number): void => {
    let c = ++size;
    heapH[c] = h;
    heapI[c] = i;
    while (c > 1) {
      const p = c >> 1;
      if (heapH[p]! <= heapH[c]!) break;
      [heapH[p], heapH[c]] = [heapH[c]!, heapH[p]!];
      [heapI[p], heapI[c]] = [heapI[c]!, heapI[p]!];
      c = p;
    }
  };

  const pop = (): number => {
    const top = heapI[1]!;
    heapH[1] = heapH[size]!;
    heapI[1] = heapI[size]!;
    size--;
    let p = 1;
    while (true) {
      const l = p << 1;
      const r = l + 1;
      let m = p;
      if (l <= size && heapH[l]! < heapH[m]!) m = l;
      if (r <= size && heapH[r]! < heapH[m]!) m = r;
      if (m === p) break;
      [heapH[p], heapH[m]] = [heapH[m]!, heapH[p]!];
      [heapI[p], heapI[m]] = [heapI[m]!, heapI[p]!];
      p = m;
    }
    return top;
  };

  // Every border cell is by definition already drained.
  const seed = (i: number): void => {
    if (closed[i]) return;
    closed[i] = 1;
    push(filled[i]!, i);
  };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }

  let raised = 0;
  let maxFill = 0;

  while (size > 0) {
    const i = pop();
    const h = filled[i]!;
    const x = i % W;
    const y = (i / W) | 0;

    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (closed[j]) continue;
      closed[j] = 1;
      // A neighbour cannot be lower than the path that reached it.
      if (filled[j]! < h) {
        const fill = h - filled[j]!;
        if (fill > maxFill) maxFill = fill;
        raised++;
        filled[j] = h;
      }
      push(filled[j]!, j);
    }
  }

  heights.set(filled);
  return { raised, maxFill };
}

/**
 * Approximate Euclidean distance, in cells, from every cell to the nearest
 * seed. Two-pass 3-4 chamfer: linear time and easily accurate enough to tell
 * "next to a contour" from "a kilometre out in the inlet".
 */
function distanceTransform(seeds: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = seeds[i] ? 0 : INF;

  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? INF : d[y * W + x]!;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i]!,
        at(x - 1, y) + 3, at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4,
      );
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i]!,
        at(x + 1, y) + 3, at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4,
      );
    }
  }
  for (let i = 0; i < d.length; i++) d[i]! /= 3;
  return d;
}

/**
 * Marks open water: cells far from any contour that are reachable from the map
 * edge without crossing contoured land.
 *
 * Flooding from the edge rather than thresholding globally is what stops an
 * isolated inland gap in the contours — a large flat parking lot, say — from
 * being misread as sea.
 */
function findWater(
  contourCells: Uint8Array, W: number, H: number, resolution: number,
): Uint8Array {
  const dist = distanceTransform(contourCells, W, H);
  const seedCells = WATER_MIN_DISTANCE / resolution;
  const growCells = WATER_GROW_DISTANCE / resolution;

  const water = new Uint8Array(W * H);
  const stack: number[] = [];
  // Seeding uses the strict threshold; spreading uses the loose one.
  let threshold = seedCells;

  const tryPush = (i: number): void => {
    if (water[i] || dist[i]! < threshold) return;
    water[i] = 1;
    stack.push(i);
  };

  const spread = (): void => {
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i / W) | 0;
      if (x > 0) tryPush(i - 1);
      if (x < W - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - W);
      if (y < H - 1) tryPush(i + W);
    }
  };

  // Stage 1 — seed from the map edge, strict threshold: unambiguous open sea.
  for (let x = 0; x < W; x++) {
    tryPush(x);
    tryPush((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    tryPush(y * W);
    tryPush(y * W + W - 1);
  }
  spread();

  // Stage 2 — grow that region under the loose threshold, so narrow inlets
  // join up. Nothing new is seeded here: growth can only continue from cells
  // already proven to be sea, which is what keeps it from leaking inland.
  threshold = growCells;
  for (let i = 0; i < water.length; i++) if (water[i]) stack.push(i);
  spread();

  return water;
}
