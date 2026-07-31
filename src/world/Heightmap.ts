/**
 * Terrain elevation data, decoupled from both the renderer and the physics
 * engine so it can be exercised headlessly.
 *
 * The pipeline writes row-major uint16 samples; Rapier wants column-major
 * float32. Getting that conversion — or the row/column axis mapping — wrong
 * produces a world that looks right but whose collision is transposed, which is
 * near-impossible to diagnose by eye. Keeping the logic here means it can be
 * checked against a ground-truth sampler in a test.
 */

export interface TerrainManifest {
  file: string;
  width: number;
  height: number;
  resolution: number;
  scale: number;
  offset: number;
  minHeight: number;
  maxHeight: number;
}

export interface WorldManifest {
  generated: string;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  origin: { easting: number; northing: number };
  bounds: {
    minX: number; maxX: number;
    minZ: number; maxZ: number;
    width: number; depth: number;
  };
  chunkSize: number;
  terrain: TerrainManifest;
  water: { file: string; cells: number; fraction: number };
}

export class Heightmap {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly bounds: WorldManifest['bounds'];
  /** Elevation in metres, row-major: `heights[row * width + col]`. */
  readonly heights: Float32Array;
  readonly water: Uint8Array | null;

  constructor(manifest: WorldManifest, raw: Uint16Array, water: Uint8Array | null = null) {
    const t = manifest.terrain;
    this.width = t.width;
    this.height = t.height;
    this.resolution = t.resolution;
    this.bounds = manifest.bounds;
    this.water = water;

    if (raw.length !== t.width * t.height) {
      throw new Error(
        `heightmap size mismatch: got ${raw.length} samples, ` +
        `manifest says ${t.width} x ${t.height} = ${t.width * t.height}`,
      );
    }

    this.heights = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.heights[i] = raw[i]! * t.scale + t.offset;
  }

  /** Grid column for a world X coordinate (fractional). */
  private colOf(x: number): number {
    return (x - this.bounds.minX) / this.resolution;
  }

  /** Grid row for a world Z coordinate (fractional). */
  private rowOf(z: number): number {
    return (z - this.bounds.minZ) / this.resolution;
  }

  /** Nearest-sample elevation. Clamps outside the map. */
  sampleNearest(x: number, z: number): number {
    const c = Math.round(Math.min(this.width - 1, Math.max(0, this.colOf(x))));
    const r = Math.round(Math.min(this.height - 1, Math.max(0, this.rowOf(z))));
    return this.heights[r * this.width + c]!;
  }

  /**
   * Bilinearly interpolated elevation — this is what the game should use, since
   * nearest-sampling makes a car crossing a 4 m grid feel like a staircase.
   */
  sample(x: number, z: number): number {
    const cf = Math.min(this.width - 1, Math.max(0, this.colOf(x)));
    const rf = Math.min(this.height - 1, Math.max(0, this.rowOf(z)));

    const c0 = Math.floor(cf);
    const r0 = Math.floor(rf);
    const c1 = Math.min(this.width - 1, c0 + 1);
    const r1 = Math.min(this.height - 1, r0 + 1);
    const tc = cf - c0;
    const tr = rf - r0;

    const h00 = this.heights[r0 * this.width + c0]!;
    const h10 = this.heights[r0 * this.width + c1]!;
    const h01 = this.heights[r1 * this.width + c0]!;
    const h11 = this.heights[r1 * this.width + c1]!;

    return (
      h00 * (1 - tc) * (1 - tr) +
      h10 * tc * (1 - tr) +
      h01 * (1 - tc) * tr +
      h11 * tc * tr
    );
  }

  /** True if the sample nearest this point is open water. */
  isWater(x: number, z: number): boolean {
    if (!this.water) return false;
    const c = Math.round(Math.min(this.width - 1, Math.max(0, this.colOf(x))));
    const r = Math.round(Math.min(this.height - 1, Math.max(0, this.rowOf(z))));
    return this.water[r * this.width + c] === 1;
  }

  /**
   * Repacks the heights for `ColliderDesc.heightfield`, which expects a
   * column-major matrix.
   *
   * Rapier lays a heightfield across its local XZ plane centred on the
   * collider, indexing rows along Z and columns along X — the same orientation
   * this grid uses, so only the storage order changes.
   */
  toRapierHeights(): Float32Array {
    const out = new Float32Array(this.width * this.height);
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        out[c * this.height + r] = this.heights[r * this.width + c]!;
      }
    }
    return out;
  }

  /**
   * Scale vector for the Rapier heightfield collider.
   *
   * A heightfield spans one unit in each horizontal axis before scaling, so the
   * scale is the full extent of the map. `y` is 1 because heights are already
   * in metres.
   */
  rapierScale(): { x: number; y: number; z: number } {
    // The grid has `width` samples spanning `width - 1` cells.
    return {
      x: (this.width - 1) * this.resolution,
      y: 1,
      z: (this.height - 1) * this.resolution,
    };
  }

  /** Centre of the map, where the heightfield collider must be positioned. */
  center(): { x: number; z: number } {
    return {
      x: this.bounds.minX + ((this.width - 1) * this.resolution) / 2,
      z: this.bounds.minZ + ((this.height - 1) * this.resolution) / 2,
    };
  }
}
