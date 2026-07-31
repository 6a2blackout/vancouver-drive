/**
 * Street centrelines → a routable road graph and drivable road surfaces.
 *
 * `public-streets` gives centrelines only, already split at intersections, with
 * a road class but no width and no topology. This module recovers the topology
 * by snapping shared endpoints into nodes, assigns widths per class, and
 * generates surface geometry.
 *
 * The graph is a deliberate output rather than an intermediate: AI traffic
 * (Phase 7) needs nodes, one-way direction and signal positions, and
 * reconstructing that later would mean rewriting this file.
 */
import { toWorld } from './projection';

export interface RoadPoint { x: number; z: number }

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  /** Ids of every edge incident to this node. */
  edges: number[];
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** Full shape, world metres, including both endpoints. */
  points: RoadPoint[];
  width: number;
  klass: string;
  name: string;
  oneway: boolean;
  length: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/**
 * Paved width in metres by street class.
 *
 * These are pavement widths, not rights of way. The `right-of-way-widths`
 * dataset does exist, but it is point labels carrying strings in *feet*
 * ("66", "20(m)") measured property line to property line — which includes
 * sidewalks and boulevards, so it overstates drivable width by a third or more.
 * Class-based values are more predictable and easier to tune by eye.
 */
const WIDTH_BY_CLASS: Record<string, number> = {
  Arterial: 18,
  'Secondary Arterial': 14.5,
  Collector: 12.5,
  Residential: 11,
  Closed: 9,
};
const DEFAULT_WIDTH = 11;
/** Back alleys, from the separate `lanes` layer. */
export const LANE_WIDTH = 6.5;
/**
 * Roads from `non-city-streets`. Stanley Park Drive and the causeway live only
 * here — `public-streets` covers City-owned roads, so the entire park road
 * network is missing without this layer.
 */
export const NON_CITY_WIDTH = 9.5;

type RoadKind = 'street' | 'lane' | 'nonCity';

/** Endpoints closer than this are treated as the same junction. */
const SNAP_TOLERANCE = 1.2;

export interface StreetFeature {
  geometry: { type: string; coordinates: [number, number][] };
  properties: {
    streetuse?: string | null;
    hblock?: string | null;
    std_street?: string | null;
    streetname?: string | null;
    type?: string | null;
  };
}

/**
 * Spatial hash for merging coincident endpoints.
 *
 * A plain rounded-coordinate key would split two points that sit either side of
 * a cell boundary, so lookups scan the 3x3 neighbourhood.
 */
class PointSnapper {
  private readonly cells = new Map<string, number[]>();
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly cellSize = SNAP_TOLERANCE * 2;

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  /** Returns the id of an existing nearby point, or creates a new one. */
  snap(x: number, z: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);

    let best = -1;
    let bestDist = SNAP_TOLERANCE * SNAP_TOLERANCE;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.cells.get(this.key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const id of bucket) {
          const d = (this.xs[id]! - x) ** 2 + (this.zs[id]! - z) ** 2;
          if (d < bestDist) { bestDist = d; best = id; }
        }
      }
    }
    if (best >= 0) return best;

    const id = this.xs.length;
    this.xs.push(x);
    this.zs.push(z);
    const k = this.key(cx, cz);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(id);
    else this.cells.set(k, [id]);
    return id;
  }

  get count(): number { return this.xs.length; }
  position(id: number): RoadPoint { return { x: this.xs[id]!, z: this.zs[id]! }; }
}

function polylineLength(points: RoadPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  }
  return total;
}

export interface BuildGraphOptions {
  /** Street features from `public-streets`. */
  streets: StreetFeature[];
  /** Optional back alleys from `lanes`, rendered narrower. */
  lanes?: StreetFeature[];
  /** Optional roads from `non-city-streets` (Stanley Park, private roads). */
  nonCity?: StreetFeature[];
  /** Optional one-way segments, matched to edges by proximity. */
  oneWays?: StreetFeature[];
  onProgress?: (message: string) => void;
}

export function buildRoadGraph(options: BuildGraphOptions): RoadGraph {
  const { streets, lanes = [], nonCity = [], oneWays = [], onProgress = () => {} } = options;

  const snapper = new PointSnapper();
  const edges: RoadEdge[] = [];

  const addFeature = (f: StreetFeature, kind: RoadKind): void => {
    if (f.geometry.type !== 'LineString') return;
    const coords = f.geometry.coordinates;
    if (coords.length < 2) return;

    const points = coords.map(([lon, lat]) => toWorld(lon, lat));

    // Degenerate geometry (repeated vertices) would produce zero-length
    // direction vectors later, so drop consecutive duplicates.
    const cleaned: RoadPoint[] = [points[0]!];
    for (let i = 1; i < points.length; i++) {
      const prev = cleaned[cleaned.length - 1]!;
      if (Math.hypot(points[i]!.x - prev.x, points[i]!.z - prev.z) > 0.05) {
        cleaned.push(points[i]!);
      }
    }
    if (cleaned.length < 2) return;

    const klass =
      kind === 'lane' ? 'Lane'
      : kind === 'nonCity' ? 'Non-City'
      : (f.properties.streetuse ?? 'Residential');
    const width =
      kind === 'lane' ? LANE_WIDTH
      : kind === 'nonCity' ? NON_CITY_WIDTH
      : (WIDTH_BY_CLASS[klass] ?? DEFAULT_WIDTH);

    const a = snapper.snap(cleaned[0]!.x, cleaned[0]!.z);
    const b = snapper.snap(cleaned[cleaned.length - 1]!.x, cleaned[cleaned.length - 1]!.z);
    if (a === b && cleaned.length < 3) return; // zero-length stub

    // Use the snapped positions for the endpoints so neighbouring edges share
    // exactly the same coordinates and no seam appears at the junction.
    cleaned[0] = snapper.position(a);
    cleaned[cleaned.length - 1] = snapper.position(b);

    edges.push({
      id: edges.length,
      a, b,
      points: cleaned,
      width,
      klass,
      name: (f.properties.hblock ?? f.properties.std_street ?? f.properties.streetname ?? '').trim(),
      oneway: false,
      length: polylineLength(cleaned),
    });
  };

  for (const f of streets) addFeature(f, 'street');
  for (const f of lanes) addFeature(f, 'lane');
  for (const f of nonCity) addFeature(f, 'nonCity');

  const nodes: RoadNode[] = [];
  for (let i = 0; i < snapper.count; i++) {
    const p = snapper.position(i);
    nodes.push({ id: i, x: p.x, z: p.z, edges: [] });
  }
  for (const e of edges) {
    nodes[e.a]!.edges.push(e.id);
    if (e.b !== e.a) nodes[e.b]!.edges.push(e.id);
  }

  markOneWays(edges, oneWays);

  const degrees = new Map<number, number>();
  for (const n of nodes) degrees.set(n.edges.length, (degrees.get(n.edges.length) ?? 0) + 1);
  const junctions = nodes.filter((n) => n.edges.length >= 3).length;
  const deadEnds = nodes.filter((n) => n.edges.length === 1).length;

  onProgress(
    `${edges.length} edges, ${nodes.length} nodes ` +
    `(${junctions} junctions, ${deadEnds} dead ends)`,
  );
  onProgress(`total road length ${(edges.reduce((s, e) => s + e.length, 0) / 1000).toFixed(1)} km`);

  return { nodes, edges };
}

/**
 * Flags edges that appear in the one-way layer, matched by midpoint proximity.
 *
 * The two datasets share geometry but not identifiers, so a spatial match is
 * the only join available.
 */
function markOneWays(edges: RoadEdge[], oneWays: StreetFeature[]): void {
  if (oneWays.length === 0) return;

  const CELL = 40;
  const index = new Map<string, number[]>();
  const midpoint = (pts: RoadPoint[]): RoadPoint => pts[Math.floor(pts.length / 2)]!;

  for (const e of edges) {
    const m = midpoint(e.points);
    const k = `${Math.floor(m.x / CELL)},${Math.floor(m.z / CELL)}`;
    const bucket = index.get(k);
    if (bucket) bucket.push(e.id);
    else index.set(k, [e.id]);
  }

  for (const f of oneWays) {
    if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
    const pts = f.geometry.coordinates.map(([lon, lat]) => toWorld(lon, lat));
    const m = pts[Math.floor(pts.length / 2)]!;
    const cx = Math.floor(m.x / CELL);
    const cz = Math.floor(m.z / CELL);

    let best = -1;
    let bestDist = 25 * 25;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const id of index.get(`${cx + dx},${cz + dz}`) ?? []) {
          const em = midpoint(edges[id]!.points);
          const d = (em.x - m.x) ** 2 + (em.z - m.z) ** 2;
          if (d < bestDist) { bestDist = d; best = id; }
        }
      }
    }
    if (best >= 0) edges[best]!.oneway = true;
  }
}

// ---------------------------------------------------------------------------
// Surface geometry
// ---------------------------------------------------------------------------

export interface RoadSurface {
  /** Triangle list, xz pairs — heights are sampled from terrain at build time. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Per-vertex distance from the road centreline, normalised to [-1, 1]. */
  edgeOffset: Float32Array;
  triangleCount: number;
}

/**
 * How far back from a junction each approaching ribbon stops, as a multiple of
 * the widest incident road's half-width. The junction itself is then capped with
 * a single polygon.
 *
 * Without this, ribbons meeting at an angle overlap into a visible lump and
 * leave a gap on the outside of the turn. Trimming and capping is what makes
 * intersections read as intersections.
 */
const TRIM_FACTOR = 1.15;

function normalAt(from: RoadPoint, to: RoadPoint): RoadPoint {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  // Left-hand normal in the XZ plane.
  return { x: -dz / len, z: dx / len };
}

/** Walks `distance` metres inward along a polyline from one end. */
function pointAlong(points: RoadPoint[], distance: number, fromStart: boolean): {
  point: RoadPoint; normal: RoadPoint; index: number;
} {
  const pts = fromStart ? points : [...points].reverse();
  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
    if (travelled + seg >= distance) {
      const t = seg > 0 ? (distance - travelled) / seg : 0;
      const point = {
        x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t,
        z: pts[i - 1]!.z + (pts[i]!.z - pts[i - 1]!.z) * t,
      };
      const normal = normalAt(pts[i - 1]!, pts[i]!);
      return {
        point,
        normal: fromStart ? normal : { x: -normal.x, z: -normal.z },
        index: fromStart ? i : points.length - i,
      };
    }
    travelled += seg;
  }
  const last = pts[pts.length - 1]!;
  const normal = normalAt(pts[pts.length - 2]!, last);
  return {
    point: last,
    normal: fromStart ? normal : { x: -normal.x, z: -normal.z },
    index: fromStart ? points.length - 1 : 0,
  };
}

/** Trim distance for each node, indexed by node id. */
export function computeTrims(graph: RoadGraph): Float32Array {
  const trims = new Float32Array(graph.nodes.length);
  for (const node of graph.nodes) {
    if (node.edges.length < 3) continue; // only real junctions get trimmed
    let widest = 0;
    for (const id of node.edges) widest = Math.max(widest, graph.edges[id]!.width);
    trims[node.id] = (widest / 2) * TRIM_FACTOR;
  }
  return trims;
}

/** Andrew's monotone chain convex hull. */
function convexHull(points: RoadPoint[]): RoadPoint[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => (a.x - b.x) || (a.z - b.z));
  const cross = (o: RoadPoint, a: RoadPoint, b: RoadPoint): number =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const build = (source: RoadPoint[]): RoadPoint[] => {
    const out: RoadPoint[] = [];
    for (const p of source) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...build(pts), ...build([...pts].reverse())];
}

/**
 * Generates the drivable surface: a ribbon per edge plus a cap per junction.
 *
 * Y is left at zero here; the caller samples terrain so the surface follows the
 * ground it was burned into.
 */
export function buildRoadSurface(graph: RoadGraph): RoadSurface {
  const trims = computeTrims(graph);

  const positions: number[] = [];
  const offsets: number[] = [];
  const indices: number[] = [];

  const pushVertex = (p: RoadPoint, offset: number): number => {
    const index = positions.length / 3;
    positions.push(p.x, 0, p.z);
    offsets.push(offset);
    return index;
  };

  /** Corners left behind at each node by the trimmed ribbons, for the cap. */
  const nodeCorners = new Map<number, RoadPoint[]>();
  const addCorner = (nodeId: number, p: RoadPoint): void => {
    const list = nodeCorners.get(nodeId);
    if (list) list.push(p);
    else nodeCorners.set(nodeId, [p]);
  };

  // --- Ribbons -------------------------------------------------------------
  for (const edge of graph.edges) {
    const half = edge.width / 2;
    const trimA = trims[edge.a]!;
    const trimB = trims[edge.b]!;

    // Skip edges swallowed entirely by their junctions' trims.
    if (edge.length <= trimA + trimB + 0.5) continue;

    const startInfo = trimA > 0 ? pointAlong(edge.points, trimA, true) : null;
    const endInfo = trimB > 0 ? pointAlong(edge.points, trimB, false) : null;

    const shape: RoadPoint[] = [];
    shape.push(startInfo ? startInfo.point : edge.points[0]!);
    const firstInterior = startInfo ? startInfo.index : 1;
    const lastInterior = endInfo ? endInfo.index : edge.points.length - 2;
    for (let i = firstInterior; i <= lastInterior; i++) {
      if (i > 0 && i < edge.points.length - 1) shape.push(edge.points[i]!);
    }
    shape.push(endInfo ? endInfo.point : edge.points[edge.points.length - 1]!);

    if (shape.length < 2) continue;

    let prevLeft = -1;
    let prevRight = -1;
    for (let i = 0; i < shape.length; i++) {
      // Average the normals either side of an interior vertex so the ribbon
      // mitres round bends instead of pinching.
      let n: RoadPoint;
      if (i === 0) n = normalAt(shape[0]!, shape[1]!);
      else if (i === shape.length - 1) n = normalAt(shape[i - 1]!, shape[i]!);
      else {
        const n1 = normalAt(shape[i - 1]!, shape[i]!);
        const n2 = normalAt(shape[i]!, shape[i + 1]!);
        const mx = n1.x + n2.x;
        const mz = n1.z + n2.z;
        const len = Math.hypot(mx, mz) || 1;
        n = { x: mx / len, z: mz / len };
      }

      const p = shape[i]!;
      const left = pushVertex({ x: p.x + n.x * half, z: p.z + n.z * half }, 1);
      const right = pushVertex({ x: p.x - n.x * half, z: p.z - n.z * half }, -1);

      if (i === 0) {
        addCorner(edge.a, { x: p.x + n.x * half, z: p.z + n.z * half });
        addCorner(edge.a, { x: p.x - n.x * half, z: p.z - n.z * half });
      }
      if (i === shape.length - 1) {
        addCorner(edge.b, { x: p.x + n.x * half, z: p.z + n.z * half });
        addCorner(edge.b, { x: p.x - n.x * half, z: p.z - n.z * half });
      }

      if (prevLeft >= 0) {
        indices.push(prevLeft, prevRight, left);
        indices.push(left, prevRight, right);
      }
      prevLeft = left;
      prevRight = right;
    }
  }

  // --- Junction caps -------------------------------------------------------
  for (const node of graph.nodes) {
    const corners = nodeCorners.get(node.id);
    if (!corners || corners.length < 3) continue;

    const hull = convexHull(corners);
    if (hull.length < 3) continue;

    const centre = pushVertex({ x: node.x, z: node.z }, 0);
    const ring = hull.map((p) => pushVertex(p, 0.85));
    for (let i = 0; i < ring.length; i++) {
      indices.push(centre, ring[i]!, ring[(i + 1) % ring.length]!);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    edgeOffset: new Float32Array(offsets),
    triangleCount: indices.length / 3,
  };
}
