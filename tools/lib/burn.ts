/**
 * Burns road corridors into the terrain heightmap.
 *
 * This is the pipeline's central design decision. The obvious alternative —
 * generating road meshes and using them as trimesh colliders — produces seams
 * at every junction, gaps on the outside of bends, and expensive collision.
 * Instead, each road corridor is flattened into the heightmap itself along a
 * smoothed longitudinal profile. The car then collides with nothing but a
 * single Rapier heightfield: fast, seamless, and immune to z-fighting. Road
 * meshes become purely visual, laid a few centimetres above the ground they
 * were burned into.
 *
 * Raw terrain follows every contour wiggle, so driving straight on it would
 * feel like a washboard. Smoothing the profile along each road's length is what
 * turns the surface into something a car can actually travel at speed.
 */
import type { WorldBounds } from './projection';
import type { RoadEdge, RoadPoint } from './roads';

/** Longitudinal smoothing window, in metres. Longer = gentler grades. */
const PROFILE_SMOOTHING = 34;

/** Spacing at which each road is resampled before burning, in metres. */
const SAMPLE_SPACING = 2;

/**
 * Width of the blend from road level back to natural terrain, in metres.
 * Without a shoulder, roads sit on top of visible cliffs wherever they cut
 * across a slope.
 */
const SHOULDER = 5;

export interface BurnResult {
  cellsModified: number;
  maxAdjustment: number;
}

/** Resamples a polyline at even spacing, preserving its shape. */
function resample(points: RoadPoint[], spacing: number): RoadPoint[] {
  const out: RoadPoint[] = [points[0]!];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segLength = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLength < 1e-6) continue;

    let travelled = spacing - carry;
    while (travelled < segLength) {
      const t = travelled / segLength;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      travelled += spacing;
    }
    carry = segLength - (travelled - spacing);
  }

  const last = points[points.length - 1]!;
  const tail = out[out.length - 1]!;
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > 0.01) out.push(last);
  return out;
}

/** Moving average over a height profile, clamped at the ends. */
function smoothProfile(heights: number[], windowSamples: number): number[] {
  if (heights.length < 3 || windowSamples < 1) return heights;
  const half = Math.max(1, Math.floor(windowSamples / 2));
  const out = new Array<number>(heights.length);

  for (let i = 0; i < heights.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= heights.length) continue;
      sum += heights[j]!;
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

/**
 * Flattens every road corridor into `heights`.
 *
 * Contributions are accumulated as a weighted average so that overlapping
 * burns — which happen at every junction — agree instead of the last road
 * written winning and leaving a step.
 */
export function burnRoads(
  heights: Float32Array,
  width: number,
  height: number,
  bounds: WorldBounds,
  resolution: number,
  edges: RoadEdge[],
): BurnResult {
  const n = width * height;
  const targetSum = new Float64Array(n);
  const weightSum = new Float64Array(n);
  const maxWeight = new Float32Array(n);

  const sampleTerrain = (x: number, z: number): number => {
    const c = Math.round(Math.min(width - 1, Math.max(0, (x - bounds.minX) / resolution)));
    const r = Math.round(Math.min(height - 1, Math.max(0, (z - bounds.minZ) / resolution)));
    return heights[r * width + c]!;
  };

  for (const edge of edges) {
    const path = resample(edge.points, SAMPLE_SPACING);
    if (path.length < 2) continue;

    const raw = path.map((p) => sampleTerrain(p.x, p.z));
    const profile = smoothProfile(raw, Math.round(PROFILE_SMOOTHING / SAMPLE_SPACING));

    const half = edge.width / 2;
    const reach = half + SHOULDER;
    const reachCells = Math.ceil(reach / resolution);

    for (let i = 0; i < path.length; i++) {
      const p = path[i]!;
      const target = profile[i]!;

      const c0 = Math.floor((p.x - bounds.minX) / resolution);
      const r0 = Math.floor((p.z - bounds.minZ) / resolution);

      for (let dr = -reachCells; dr <= reachCells; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= height) continue;
        const cellZ = bounds.minZ + r * resolution;

        for (let dc = -reachCells; dc <= reachCells; dc++) {
          const c = c0 + dc;
          if (c < 0 || c >= width) continue;
          const cellX = bounds.minX + c * resolution;

          const dist = Math.hypot(cellX - p.x, cellZ - p.z);
          if (dist > reach) continue;

          // Full strength across the carriageway, easing off over the shoulder.
          let w: number;
          if (dist <= half) w = 1;
          else {
            const t = (dist - half) / SHOULDER;
            w = 1 - t * t * (3 - 2 * t); // smoothstep
          }
          if (w <= 0) continue;

          const idx = r * width + c;
          targetSum[idx]! += target * w;
          weightSum[idx]! += w;
          if (w > maxWeight[idx]!) maxWeight[idx] = w;
        }
      }
    }
  }

  let cellsModified = 0;
  let maxAdjustment = 0;
  for (let i = 0; i < n; i++) {
    if (weightSum[i]! <= 0) continue;
    const target = targetSum[i]! / weightSum[i]!;
    const blend = Math.min(1, maxWeight[i]!);
    const before = heights[i]!;
    const after = before + (target - before) * blend;
    heights[i] = after;
    cellsModified++;
    maxAdjustment = Math.max(maxAdjustment, Math.abs(after - before));
  }

  return { cellsModified, maxAdjustment };
}
