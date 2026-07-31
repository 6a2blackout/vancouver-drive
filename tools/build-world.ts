/**
 * Turns the cached GeoJSON in `data/raw/` into the binary world artifacts the
 * game loads from `public/world/`. Run with `npm run world`.
 *
 * Stages land here one phase at a time; terrain is first because roads are
 * burned into the heightmap and buildings are seated on it, so everything
 * downstream depends on it existing.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TERRAIN_RESOLUTION, CHUNK_SIZE, ORIGIN, BBOX, SPAWN } from './config';
import { worldBounds, toWorld } from './lib/projection';
import { buildHeightfield, fillDepressions, type Heightfield, type ContourFeature } from './lib/terrain';
import { buildRoadGraph, buildRoadSurface, type StreetFeature, type RoadGraph } from './lib/roads';
import { burnRoads } from './lib/burn';
import { buildBuildings, makeSampler, type BuildingFeature } from './lib/buildings';
import { heightPng, rgbPng, downsampleField } from './lib/png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const OUT_DIR = join(ROOT, 'public', 'world');
const PREVIEW_DIR = join(ROOT, 'data', 'preview');

async function readLayer<T>(id: string): Promise<T[]> {
  const path = join(RAW_DIR, `${id}.geojson`);
  try {
    const json = JSON.parse(await readFile(path, 'utf8')) as { features: T[] };
    return json.features;
  } catch (e) {
    throw new Error(
      `could not read ${id}.geojson — run \`npm run fetch\` first ` +
      `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/**
 * Quantises heights to uint16 for transport.
 *
 * At 4 m spacing over a ~90 m range this gives ~1.4 mm vertical precision,
 * far below what a car can feel, for half the bytes of float32.
 */
function quantise(field: Heightfield): { buffer: Buffer; scale: number; offset: number } {
  const offset = field.minHeight;
  const span = Math.max(1e-6, field.maxHeight - field.minHeight);
  const scale = span / 65535;

  const out = new Uint16Array(field.heights.length);
  for (let i = 0; i < field.heights.length; i++) {
    out[i] = Math.round((field.heights[i]! - offset) / scale);
  }
  return { buffer: Buffer.from(out.buffer), scale, offset };
}

/**
 * Fills building footprints into an RGB preview, shaded by height.
 *
 * The downtown tower cluster is distinctive enough that this immediately shows
 * whether heights were read correctly and whether buildings landed in the right
 * place relative to the street grid.
 */
function drawBuildings(
  rgb: Uint8Array,
  width: number,
  height: number,
  features: BuildingFeature[],
  bounds: { minX: number; minZ: number; width: number; depth: number },
): void {
  const toPixel = (x: number, z: number): [number, number] => [
    ((x - bounds.minX) / bounds.width) * (width - 1),
    ((z - bounds.minZ) / bounds.depth) * (height - 1),
  ];

  for (const f of features) {
    if (f.geometry.type !== 'Polygon') continue;
    const ring = f.geometry.coordinates[0];
    if (!ring || ring.length < 3) continue;

    const pts = ring.map(([lon, lat]) => {
      const w = toWorld(lon, lat);
      return toPixel(w.x, w.z);
    });

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of pts) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }

    const h = Math.max(0, f.properties.hgt_agl ?? 0);
    // Low buildings stay dim; towers go bright and warm.
    const t = Math.min(1, h / 90);
    const r = Math.round(70 + 185 * t);
    const g = Math.round(70 + 140 * t);
    const b = Math.round(85 + 40 * t);

    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(width - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height - 1, Math.ceil(maxY));

    // Footprints are only a few pixels at preview scale, so always mark at
    // least one pixel rather than losing small buildings to rounding.
    if (x1 - x0 < 1 && y1 - y0 < 1) {
      const i = (Math.round(minY) * width + Math.round(minX)) * 3;
      if (i >= 0 && i + 2 < rgb.length) { rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; }
      continue;
    }

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i]!;
          const [xj, yj] = pts[j]!;
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        if (!inside) continue;
        const idx = (py * width + px) * 3;
        rgb[idx] = r; rgb[idx + 1] = g; rgb[idx + 2] = b;
      }
    }
  }
}

/** Draws the road network over an RGB preview buffer, coloured by class. */
function drawRoads(
  rgb: Uint8Array,
  width: number,
  height: number,
  graph: RoadGraph,
  bounds: { minX: number; minZ: number; width: number; depth: number },
): void {
  const colourFor = (klass: string): [number, number, number] => {
    switch (klass) {
      case 'Arterial': return [255, 214, 120];
      case 'Secondary Arterial': return [255, 170, 90];
      case 'Collector': return [200, 220, 255];
      case 'Lane': return [90, 105, 130];
      case 'Non-City': return [130, 235, 170];
      default: return [225, 232, 245];
    }
  };

  const plot = (px: number, py: number, c: [number, number, number]): void => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const i = (py * width + px) * 3;
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
  };

  const toPixel = (x: number, z: number): [number, number] => [
    Math.round(((x - bounds.minX) / bounds.width) * (width - 1)),
    Math.round(((z - bounds.minZ) / bounds.depth) * (height - 1)),
  ];

  for (const edge of graph.edges) {
    const c = colourFor(edge.klass);
    for (let i = 1; i < edge.points.length; i++) {
      const [x0, y0] = toPixel(edge.points[i - 1]!.x, edge.points[i - 1]!.z);
      const [x1, y1] = toPixel(edge.points[i]!.x, edge.points[i]!.z);
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        plot(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), c);
      }
    }
  }

  // Junctions in red, so intersection placement can be eyeballed.
  for (const node of graph.nodes) {
    if (node.edges.length < 3) continue;
    const [px, py] = toPixel(node.x, node.z);
    plot(px, py, [255, 70, 70]);
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(PREVIEW_DIR, { recursive: true });

  const bounds = worldBounds();
  console.log('Building world');
  console.log(`  bounds  ${bounds.width.toFixed(0)} m x ${bounds.depth.toFixed(0)} m`);
  console.log(`  origin  UTM10N ${ORIGIN.easting} / ${ORIGIN.northing}\n`);

  // --- Terrain -------------------------------------------------------------
  console.log('Terrain');
  const contours = await readLayer<ContourFeature>('elevation-contour-lines-1-metre-contours');
  const t0 = Date.now();
  const field = buildHeightfield(contours, bounds, TERRAIN_RESOLUTION, {
    // Roads are burned in below, which can create new dips; fill afterwards so
    // that pass catches those too.
    skipDepressionFill: true,
    onProgress: (m) => console.log(`  ${m}`),
  });
  console.log(`  solved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // --- Roads ---------------------------------------------------------------
  console.log('\nRoads');
  const graph = buildRoadGraph({
    streets: await readLayer<StreetFeature>('public-streets'),
    lanes: await readLayer<StreetFeature>('lanes'),
    nonCity: await readLayer<StreetFeature>('non-city-streets'),
    oneWays: await readLayer<StreetFeature>('one-way-streets'),
    onProgress: (m) => console.log(`  ${m}`),
  });
  console.log(`  ${graph.edges.filter((e) => e.oneway).length} one-way segments`);

  const burn = burnRoads(
    field.heights, field.width, field.height, bounds, TERRAIN_RESOLUTION, graph.edges,
  );
  console.log(
    `  burned ${burn.cellsModified.toLocaleString()} cells ` +
    `(max adjustment ${burn.maxAdjustment.toFixed(1)} m)`,
  );

  const { raised, maxFill } = fillDepressions(field.heights, field.width, field.height);
  console.log(`  filled ${raised.toLocaleString()} depression cells (deepest ${maxFill.toFixed(1)} m)`);

  // Heights changed after the solve, so the recorded range must be refreshed
  // before quantisation or the encoding will clip.
  field.minHeight = Infinity;
  field.maxHeight = -Infinity;
  for (let i = 0; i < field.heights.length; i++) {
    if (field.heights[i]! < field.minHeight) field.minHeight = field.heights[i]!;
    if (field.heights[i]! > field.maxHeight) field.maxHeight = field.heights[i]!;
  }
  console.log(`  elevation now ${field.minHeight.toFixed(1)} m .. ${field.maxHeight.toFixed(1)} m`);

  const surface = buildRoadSurface(graph);
  console.log(`  surface: ${surface.triangleCount.toLocaleString()} triangles`);

  await writeFile(
    join(OUT_DIR, 'roads.bin'),
    Buffer.concat([
      Buffer.from(new Uint32Array([surface.positions.length / 3, surface.indices.length]).buffer),
      Buffer.from(surface.positions.buffer),
      Buffer.from(surface.edgeOffset.buffer),
      Buffer.from(surface.indices.buffer),
    ]),
  );
  await writeFile(
    join(OUT_DIR, 'roadgraph.json'),
    JSON.stringify({
      nodes: graph.nodes.map((n) => ({ i: n.id, x: +n.x.toFixed(2), z: +n.z.toFixed(2), e: n.edges })),
      edges: graph.edges.map((e) => ({
        i: e.id, a: e.a, b: e.b, w: e.width, k: e.klass,
        n: e.name, o: e.oneway ? 1 : 0,
        p: e.points.map((p) => [+p.x.toFixed(2), +p.z.toFixed(2)]),
      })),
    }),
  );
  console.log('  wrote roads.bin + roadgraph.json');

  // --- Buildings -----------------------------------------------------------
  // Runs after the burn so footprints are seated on final terrain heights.
  console.log('\nBuildings');
  const buildingFeatures = await readLayer<BuildingFeature>('building-footprints-2009');
  const buildings = buildBuildings(
    buildingFeatures,
    makeSampler(field.heights, field.width, field.height, bounds, TERRAIN_RESOLUTION),
    CHUNK_SIZE,
    (m) => console.log(`  ${m}`),
  );

  await writeFile(
    join(OUT_DIR, 'buildings.bin'),
    Buffer.concat([
      Buffer.from(new Uint32Array([
        buildings.positions.length / 3,
        buildings.indices.length,
        buildings.chunks.length,
      ]).buffer),
      Buffer.from(buildings.positions.buffer),
      Buffer.from(buildings.uvs.buffer),
      Buffer.from(buildings.seeds.buffer),
      Buffer.from(buildings.indices.buffer),
      Buffer.from(new Int32Array(
        buildings.chunks.flatMap((c) => [c.cx, c.cz, c.start, c.count]),
      ).buffer),
    ]),
  );
  console.log('  wrote buildings.bin');

  const { buffer, scale, offset } = quantise(field);
  await writeFile(join(OUT_DIR, 'heightmap.bin'), buffer);
  console.log(`  wrote heightmap.bin (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

  await writeFile(join(OUT_DIR, 'water.bin'), Buffer.from(field.water.buffer));
  console.log(`  wrote water.bin (${(field.water.length / 1024 / 1024).toFixed(1)} MB)`);

  // A top-down preview is the only practical way to confirm the projection and
  // the solve produced Vancouver rather than plausible-looking noise.
  const preview = downsampleField(field.heights, field.width, field.height, 900);
  await writeFile(
    join(PREVIEW_DIR, 'terrain.png'),
    heightPng(preview.width, preview.height, preview.values, field.minHeight, field.maxHeight),
  );

  // Land shaded by height, sea in blue — makes a wrong coastline obvious.
  const waterFloat = new Float32Array(field.water.length);
  for (let i = 0; i < field.water.length; i++) waterFloat[i] = field.water[i]!;
  const waterPreview = downsampleField(waterFloat, field.width, field.height, 900);
  const rgb = new Uint8Array(preview.width * preview.height * 3);
  const span = Math.max(1e-6, field.maxHeight - field.minHeight);
  for (let i = 0; i < preview.width * preview.height; i++) {
    const t = (preview.values[i]! - field.minHeight) / span;
    if (waterPreview.values[i]! > 0.5) {
      rgb[i * 3] = 10; rgb[i * 3 + 1] = 30; rgb[i * 3 + 2] = 70;
    } else {
      const v = Math.round(40 + t * 215);
      rgb[i * 3] = v; rgb[i * 3 + 1] = Math.round(v * 0.97); rgb[i * 3 + 2] = Math.round(v * 0.88);
    }
  }
  await writeFile(join(PREVIEW_DIR, 'terrain-land.png'), rgbPng(preview.width, preview.height, rgb));

  // Roads drawn over the terrain. Comparing this against a real map of
  // Vancouver is the check that catches a wrong projection, a bad snap
  // tolerance, or intersections in the wrong places.
  drawRoads(rgb, preview.width, preview.height, graph, bounds);
  await writeFile(join(PREVIEW_DIR, 'roads.png'), rgbPng(preview.width, preview.height, rgb));

  drawBuildings(rgb, preview.width, preview.height, buildingFeatures, bounds);
  await writeFile(join(PREVIEW_DIR, 'city.png'), rgbPng(preview.width, preview.height, rgb));
  console.log(`  wrote previews (${preview.width} x ${preview.height})`);

  // --- Manifest ------------------------------------------------------------
  const manifest = {
    generated: new Date().toISOString(),
    bbox: BBOX,
    origin: ORIGIN,
    bounds: {
      minX: bounds.minX, maxX: bounds.maxX,
      minZ: bounds.minZ, maxZ: bounds.maxZ,
      width: bounds.width, depth: bounds.depth,
    },
    chunkSize: CHUNK_SIZE,
    spawn: {
      ...toWorld(SPAWN.lon, SPAWN.lat),
      headingDeg: SPAWN.headingDeg,
      lon: SPAWN.lon,
      lat: SPAWN.lat,
    },
    terrain: {
      file: 'heightmap.bin',
      width: field.width,
      height: field.height,
      resolution: field.resolution,
      /** height_metres = value * scale + offset */
      scale,
      offset,
      minHeight: field.minHeight,
      maxHeight: field.maxHeight,
    },
    buildings: {
      file: 'buildings.bin',
      count: buildings.buildingCount,
      vertexCount: buildings.positions.length / 3,
      triangleCount: buildings.triangleCount,
      chunkCount: buildings.chunks.length,
      tallest: buildings.tallest,
    },
    roads: {
      file: 'roads.bin',
      graph: 'roadgraph.json',
      vertexCount: surface.positions.length / 3,
      triangleCount: surface.triangleCount,
      edgeCount: graph.edges.length,
      nodeCount: graph.nodes.length,
      lengthKm: graph.edges.reduce((s, e) => s + e.length, 0) / 1000,
    },
    water: {
      file: 'water.bin',
      /** Uint8 per terrain sample, same width/height as the heightmap. */
      cells: field.waterCells,
      fraction: field.waterCells / (field.width * field.height),
    },
  };
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('  wrote manifest.json');

  console.log('\nDone.\n');
}

main().catch((e: unknown) => {
  console.error(`\nFailed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
