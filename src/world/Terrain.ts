import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Heightmap, type WorldManifest } from './Heightmap';
import { buildRoads, type RoadMeshes } from './Roads';
import { buildBuildings, type BuildingMeshes } from './Buildings';

/**
 * Loads the generated world and installs Vancouver's terrain as a single Rapier
 * heightfield plus a render mesh.
 *
 * Collision uses the full-resolution grid — heightfield queries are O(1), so
 * there is no reason to approximate what the car actually drives on. The render
 * mesh is decimated, since 1.5M samples would be 3M triangles in one draw call.
 * Phase 6 replaces the single mesh with streamed chunks.
 */

/** Render every Nth terrain sample. 1 = full resolution. */
const RENDER_DECIMATION = 2;

export interface LoadedWorld {
  manifest: WorldManifest & {
    spawn: { x: number; z: number; headingDeg: number; lon: number; lat: number };
    roads: {
      file: string; graph: string;
      vertexCount: number; triangleCount: number;
      edgeCount: number; nodeCount: number; lengthKm: number;
    };
    buildings?: {
      file: string; count: number; vertexCount: number;
      triangleCount: number; chunkCount: number; tallest: number;
    };
  };
  heightmap: Heightmap;
  terrainMesh: THREE.Mesh;
  waterMesh: THREE.Mesh;
  roads: RoadMeshes | null;
  buildings: BuildingMeshes | null;
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

export async function loadWorld(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  scene: THREE.Scene,
  base = '/world',
): Promise<LoadedWorld> {
  const manifestRes = await fetch(`${base}/manifest.json`);
  if (!manifestRes.ok) {
    throw new Error(
      `no world data at ${base}/manifest.json — run \`npm run fetch && npm run world\``,
    );
  }
  const manifest = (await manifestRes.json()) as LoadedWorld['manifest'];

  const [heightBuf, waterBuf] = await Promise.all([
    fetchBinary(`${base}/${manifest.terrain.file}`),
    fetchBinary(`${base}/${manifest.water.file}`),
  ]);

  const heightmap = new Heightmap(
    manifest,
    new Uint16Array(heightBuf),
    new Uint8Array(waterBuf),
  );

  addTerrainCollider(rapier, world, heightmap);
  const terrainMesh = buildTerrainMesh(heightmap);
  scene.add(terrainMesh);

  const waterMesh = buildWaterMesh(heightmap);
  scene.add(waterMesh);

  // Roads are optional so a world built before Phase 3 still loads.
  let roads: RoadMeshes | null = null;
  if (manifest.roads) {
    try {
      roads = buildRoads(await fetchBinary(`${base}/${manifest.roads.file}`), heightmap);
      scene.add(roads.surface);
    } catch (e) {
      console.warn('roads failed to load:', e);
    }
  }

  let buildings: BuildingMeshes | null = null;
  if (manifest.buildings) {
    try {
      buildings = buildBuildings(
        await fetchBinary(`${base}/${manifest.buildings.file}`),
        { rapier, world },
      );
      scene.add(buildings.mesh);
    } catch (e) {
      console.warn('buildings failed to load:', e);
    }
  }

  return { manifest, heightmap, terrainMesh, waterMesh, roads, buildings };
}

function addTerrainCollider(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  hm: Heightmap,
): void {
  const centre = hm.center();
  const body = world.createRigidBody(
    rapier.RigidBodyDesc.fixed().setTranslation(centre.x, 0, centre.z),
  );
  world.createCollider(
    rapier.ColliderDesc.heightfield(
      hm.height - 1, // nrows — samples along Z
      hm.width - 1,  // ncols — samples along X
      hm.toRapierHeights(),
      hm.rapierScale(),
    )
      // Grippy: this stands in for asphalt until roads are burned in (Phase 3).
      .setFriction(1.0),
    body,
  );
}

/**
 * Builds the visible terrain surface.
 *
 * Vertices are placed at absolute world coordinates rather than offsetting the
 * mesh, so the geometry lines up with the collider by construction.
 */
function buildTerrainMesh(hm: Heightmap): THREE.Mesh {
  const step = RENDER_DECIMATION;
  const cols = Math.floor((hm.width - 1) / step) + 1;
  const rows = Math.floor((hm.height - 1) / step) + 1;

  const positions = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 3);

  const land = new THREE.Color(0x2c3242);
  const shore = new THREE.Color(0x39404f);
  const high = new THREE.Color(0x3c4658);
  const tmp = new THREE.Color();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sc = Math.min(hm.width - 1, c * step);
      const sr = Math.min(hm.height - 1, r * step);
      const x = hm.bounds.minX + sc * hm.resolution;
      const z = hm.bounds.minZ + sr * hm.resolution;
      const y = hm.heights[sr * hm.width + sc]!;

      const i = (r * cols + c) * 3;
      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = z;

      // Subtle height tinting gives the eye something to read the relief by,
      // which matters at night where there is little else lighting the ground.
      const t = Math.min(1, y / 60);
      tmp.copy(y < 3 ? shore : land).lerp(high, t);
      colors[i] = tmp.r;
      colors[i + 1] = tmp.g;
      colors[i + 2] = tmp.b;
    }
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      // Wound counter-clockwise when viewed from +Y, so normals point up.
      indices[k++] = a; indices[k++] = d; indices[k++] = b;
      indices[k++] = b; indices[k++] = d; indices[k++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

function buildWaterMesh(hm: Heightmap): THREE.Mesh {
  const w = (hm.width - 1) * hm.resolution;
  const d = (hm.height - 1) * hm.resolution;
  const centre = hm.center();

  // Oversized so the sea reaches past the map edge to the horizon.
  const geometry = new THREE.PlaneGeometry(w * 3, d * 3);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color: 0x060c18,
    roughness: 0.06,
    metalness: 0.95,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Just below datum: land at exactly 0 should not z-fight with the sea.
  mesh.position.set(centre.x, -0.15, centre.z);
  mesh.name = 'water';
  return mesh;
}
