/**
 * Building footprints → extruded geometry.
 *
 * `building-footprints-2009` is the only Vancouver layer carrying heights, and
 * they are LiDAR-derived: `hgt_agl`, `baseelev_m` and `topelev_m` agree with
 * each other to within a centimetre across all 10,660 downtown buildings.
 *
 * Buildings are seated on *our* terrain rather than on `baseelev_m`. The two
 * disagree slightly — different capture years, and our surface has had roads
 * burned into it — and trusting the absolute value would leave buildings
 * hovering or half-buried. Taking the lowest terrain sample under each footprint
 * also stops a building on a slope from floating at its uphill corner.
 */
import * as THREE from 'three';
import { toWorld } from './projection';
import type { WorldBounds } from './projection';

/** Ground elevation at a world position, in metres. */
export type TerrainSampler = (x: number, z: number) => number;

/**
 * Bilinear sampler over a raw heightfield.
 *
 * Buildings only need to ask "how high is the ground here", so they take a
 * sampler rather than a Heightmap — that keeps the pipeline independent of the
 * runtime's quantised on-disk representation.
 */
export function makeSampler(
  heights: Float32Array,
  width: number,
  height: number,
  bounds: WorldBounds,
  resolution: number,
): TerrainSampler {
  return (x, z) => {
    const cf = Math.min(width - 1, Math.max(0, (x - bounds.minX) / resolution));
    const rf = Math.min(height - 1, Math.max(0, (z - bounds.minZ) / resolution));
    const c0 = Math.floor(cf);
    const r0 = Math.floor(rf);
    const c1 = Math.min(width - 1, c0 + 1);
    const r1 = Math.min(height - 1, r0 + 1);
    const tc = cf - c0;
    const tr = rf - r0;
    return (
      heights[r0 * width + c0]! * (1 - tc) * (1 - tr) +
      heights[r0 * width + c1]! * tc * (1 - tr) +
      heights[r1 * width + c0]! * (1 - tc) * tr +
      heights[r1 * width + c1]! * tc * tr
    );
  };
}

export interface BuildingFeature {
  geometry: { type: string; coordinates: [number, number][][] };
  properties: {
    hgt_agl?: number | null;
    baseelev_m?: number | null;
    topelev_m?: number | null;
    rooftype?: string | null;
  };
}

/** Heights below this are noise in the source data (5 are even negative). */
const MIN_HEIGHT = 2.5;

/** Sunk into the ground so no gap shows where terrain is uneven under a footprint. */
const FOUNDATION_EMBED = 0.8;

/** Pitched roofs rise by this fraction of wall height, capped. */
const ROOF_PITCH_RATIO = 0.22;
const ROOF_PITCH_MAX = 3.2;

export interface BuildingGeometry {
  positions: Float32Array;
  /** u = metres along the wall, v = metres above the building base. */
  uvs: Float32Array;
  /** Stable per-building pseudo-random value, for window variation. */
  seeds: Float32Array;
  indices: Uint32Array;
  /** Per-chunk index ranges, for streaming and culling later. */
  chunks: Array<{ cx: number; cz: number; start: number; count: number }>;
  buildingCount: number;
  triangleCount: number;
  tallest: number;
}

interface Ring { x: number; z: number }

/** Signed area in the XZ plane. Negative means counter-clockwise seen from above. */
function signedArea(ring: Ring[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function centroidOf(ring: Ring[]): Ring {
  let x = 0;
  let z = 0;
  for (const p of ring) { x += p.x; z += p.z; }
  return { x: x / ring.length, z: z / ring.length };
}

/** Ray-crossing point-in-polygon test. */
function contains(ring: Ring[], p: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.z > p.z) !== (b.z > p.z) &&
        p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Strips the duplicated closing vertex and any repeated points. */
function cleanRing(coords: [number, number][]): Ring[] {
  const out: Ring[] = [];
  for (const [lon, lat] of coords) {
    const p = toWorld(lon, lat);
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 1e-4 && Math.abs(prev.z - p.z) < 1e-4) continue;
    out.push(p);
  }
  // GeoJSON repeats the first point last.
  while (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(first.x - last.x) < 1e-4 && Math.abs(first.z - last.z) < 1e-4) out.pop();
    else break;
  }
  return out;
}

/** Geometric normal of the triangle starting at `at` in an index list. */
function triangleNormal(
  piece: { positions: number[] },
  indices: number[],
  at: number,
): { x: number; y: number; z: number } {
  const p = (k: number): [number, number, number] => {
    const i = indices[at + k]! * 3;
    return [piece.positions[i]!, piece.positions[i + 1]!, piece.positions[i + 2]!];
  };
  const [ax, ay, az] = p(0);
  const [bx, by, bz] = p(1);
  const [cx, cy, cz] = p(2);
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return {
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  };
}

/** Deterministic hash so a building looks the same on every rebuild. */
function hashSeed(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function buildBuildings(
  features: BuildingFeature[],
  sampleTerrain: TerrainSampler,
  chunkSize: number,
  onProgress: (m: string) => void = () => {},
): BuildingGeometry {
  interface Piece {
    cx: number; cz: number;
    positions: number[];
    uvs: number[];
    seeds: number[];
    indices: number[];
  }
  const byChunk = new Map<string, Piece>();

  let buildingCount = 0;
  let tallest = 0;
  let skipped = 0;
  let flattened = 0;
  let inwardFacing = 0;
  let roofsDown = 0;

  for (let bi = 0; bi < features.length; bi++) {
    const f = features[bi]!;
    if (f.geometry.type !== 'Polygon') { skipped++; continue; }

    const rings = f.geometry.coordinates.map(cleanRing).filter((r) => r.length >= 3);
    if (rings.length === 0) { skipped++; continue; }

    const outer = rings[0]!;
    const holes = rings.slice(1);

    // Seat on the lowest ground under the footprint.
    let base = Infinity;
    for (const p of outer) base = Math.min(base, sampleTerrain(p.x, p.z));
    if (!Number.isFinite(base)) { skipped++; continue; }
    base -= FOUNDATION_EMBED;

    const rawHeight = f.properties.hgt_agl ?? 0;
    const height = Math.max(MIN_HEIGHT, rawHeight) + FOUNDATION_EMBED;
    if (rawHeight < MIN_HEIGHT) flattened++;
    const top = base + height;
    tallest = Math.max(tallest, height);

    const centre = centroidOf(outer);
    const key = `${Math.floor(centre.x / chunkSize)},${Math.floor(centre.z / chunkSize)}`;
    let piece = byChunk.get(key);
    if (!piece) {
      piece = {
        cx: Math.floor(centre.x / chunkSize),
        cz: Math.floor(centre.z / chunkSize),
        positions: [], uvs: [], seeds: [], indices: [],
      };
      byChunk.set(key, piece);
    }

    const seed = hashSeed(bi);
    const vertexBase = piece.positions.length / 3;

    /**
     * Roof vertices carry `seed + 2` so the shader can tell them from walls
     * without a second attribute: `fract()` recovers the seed, and a value
     * above 1 means "roof, draw no windows here".
     */
    const push = (
      x: number, y: number, z: number, u: number, v: number, isRoof = false,
    ): number => {
      const index = piece!.positions.length / 3;
      piece!.positions.push(x, y, z);
      piece!.uvs.push(u, v);
      piece!.seeds.push(isRoof ? seed + 2 : seed);
      return index;
    };

    // --- Walls -------------------------------------------------------------
    // Each wall quad gets its own four vertices so that computing normals at
    // load time yields flat faces rather than smoothing around the corners.
    const emitWalls = (ring: Ring[], outward: boolean): void => {
      let run = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const segment = Math.hypot(b.x - a.x, b.z - a.z);
        if (segment < 1e-3) continue;

        const u0 = run;
        const u1 = run + segment;
        run = u1;

        const bl = push(a.x, base, a.z, u0, 0);
        const br = push(b.x, base, b.z, u1, 0);
        const tr = push(b.x, top, b.z, u1, height);
        const tl = push(a.x, top, a.z, u0, height);

        if (outward) {
          piece!.indices.push(bl, br, tr, bl, tr, tl);
        } else {
          piece!.indices.push(bl, tr, br, bl, tl, tr);
        }
      }
    };

    // Outer ring wound counter-clockwise seen from above has negative signed
    // area in XZ; holes must run the opposite way for their walls to face in.
    const outerCCW = signedArea(outer) < 0;
    const wallStart = piece.indices.length;
    emitWalls(outerCCW ? outer : [...outer].reverse(), true);

    // Winding is the easiest thing to get silently backwards here, and the
    // symptom — a city rendered as interiors, lit from the wrong side — is hard
    // to attribute after the fact. Verify the first wall by stepping a short
    // way along its normal from the edge midpoint: that point must land outside
    // the footprint. Comparing against the centroid instead would be wrong for
    // any L- or U-shaped building, whose centroid is not inside it.
    if (piece.indices.length > wallStart) {
      const n = triangleNormal(piece, piece.indices, wallStart);
      const i0 = piece.indices[wallStart]! * 3;
      const i1 = piece.indices[wallStart + 1]! * 3;
      const mx = (piece.positions[i0]! + piece.positions[i1]!) / 2;
      const mz = (piece.positions[i0 + 2]! + piece.positions[i1 + 2]!) / 2;
      const len = Math.hypot(n.x, n.z) || 1;
      const probe = { x: mx + (n.x / len) * 0.05, z: mz + (n.z / len) * 0.05 };
      if (contains(outer, probe)) inwardFacing++;
    }
    for (const hole of holes) {
      const holeCCW = signedArea(hole) < 0;
      emitWalls(holeCCW ? [...hole].reverse() : hole, false);
    }

    // --- Roof --------------------------------------------------------------
    const pitched =
      f.properties.rooftype === 'Pitched' &&
      holes.length === 0 &&
      contains(outer, centre);

    if (pitched) {
      // A hip roof approximated as a fan from a raised centroid. Restricted to
      // hole-free footprints whose centroid is actually inside them, which is
      // the overwhelming majority of houses; anything else stays flat.
      const rise = Math.min(ROOF_PITCH_MAX, height * ROOF_PITCH_RATIO);
      const ring = outerCCW ? outer : [...outer].reverse();
      const apex = push(centre.x, top + rise, centre.z, 0, height + rise, true);
      const ringIdx = ring.map((p) => push(p.x, top, p.z, 0, height, true));
      for (let i = 0; i < ringIdx.length; i++) {
        piece.indices.push(apex, ringIdx[(i + 1) % ringIdx.length]!, ringIdx[i]!);
      }
    } else {
      const ring = outerCCW ? outer : [...outer].reverse();
      // Triangulate in (x, -z) so that a counter-clockwise result corresponds
      // to an upward-facing roof in three.js coordinates.
      const contour = ring.map((p) => new THREE.Vector2(p.x, -p.z));
      const holeContours = holes.map((h) => {
        const hr = signedArea(h) < 0 ? [...h].reverse() : h;
        return hr.map((p) => new THREE.Vector2(p.x, -p.z));
      });

      let faces: number[][];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
      } catch {
        faces = [];
      }

      const all = [...ring, ...holes.map((h) => (signedArea(h) < 0 ? [...h].reverse() : h)).flat()];
      const idx = all.map((p) => push(p.x, top, p.z, 0, height, true));
      const roofStart = piece.indices.length;
      for (const face of faces) {
        piece.indices.push(idx[face[0]!]!, idx[face[1]!]!, idx[face[2]!]!);
      }
      // Roofs must face the sky, or the building reads as an open box.
      if (piece.indices.length > roofStart) {
        if (triangleNormal(piece, piece.indices, roofStart).y < 0) roofsDown++;
      }
    }

    if (piece.positions.length / 3 > vertexBase) buildingCount++;
  }

  // --- Flatten chunks into one buffer, keeping index ranges contiguous ------
  let totalVertices = 0;
  let totalIndices = 0;
  for (const p of byChunk.values()) {
    totalVertices += p.positions.length / 3;
    totalIndices += p.indices.length;
  }

  const positions = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const seeds = new Float32Array(totalVertices);
  const indices = new Uint32Array(totalIndices);
  const chunks: BuildingGeometry['chunks'] = [];

  let vOffset = 0;
  let iOffset = 0;
  for (const p of byChunk.values()) {
    const count = p.positions.length / 3;
    positions.set(p.positions, vOffset * 3);
    uvs.set(p.uvs, vOffset * 2);
    seeds.set(p.seeds, vOffset);
    for (let i = 0; i < p.indices.length; i++) indices[iOffset + i] = p.indices[i]! + vOffset;

    chunks.push({ cx: p.cx, cz: p.cz, start: iOffset, count: p.indices.length });
    vOffset += count;
    iOffset += p.indices.length;
  }

  onProgress(`${buildingCount} buildings across ${chunks.length} chunks`);
  onProgress(`${totalVertices.toLocaleString()} vertices, ${(totalIndices / 3).toLocaleString()} triangles`);
  if (skipped > 0) onProgress(`skipped ${skipped} unusable footprints`);
  if (flattened > 0) onProgress(`raised ${flattened} buildings to the ${MIN_HEIGHT} m minimum`);
  onProgress(`tallest ${tallest.toFixed(1)} m`);
  onProgress(
    `winding: ${inwardFacing} inward-facing walls, ${roofsDown} downward roofs ` +
    `${inwardFacing === 0 && roofsDown === 0 ? '(ok)' : '(PROBLEM)'}`,
  );

  return {
    positions, uvs, seeds, indices, chunks,
    buildingCount,
    triangleCount: totalIndices / 3,
    tallest,
  };
}
