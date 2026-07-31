/**
 * Verifies that the Rapier heightfield collider agrees with the CPU heightmap
 * sampler — `npx tsx tools/test-terrain.ts`.
 *
 * Rapier wants a column-major matrix and maps rows to Z, columns to X. Get any
 * of that wrong and the world still renders plausibly while the *collision*
 * surface is transposed or mirrored: the car floats over downtown and sinks
 * through Stanley Park. Comparing downward raycasts against an independent
 * sampler at known landmarks catches every variant of that bug immediately.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Heightmap, type WorldManifest } from '../src/world/Heightmap';
import { toWorld } from './lib/projection';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = join(ROOT, 'public', 'world');

/** Real Vancouver places, with the elevation we should roughly expect. */
const LANDMARKS: Array<{ name: string; lon: number; lat: number; expect: string }> = [
  { name: 'Canada Place',      lon: -123.1119, lat: 49.2888, expect: 'waterfront, near sea level' },
  // Kept inside BBOX: Prospect Point itself (49.3117) sits past maxLat 49.31,
  // so the northern tip of Stanley Park is currently off the map.
  { name: 'Stanley Park (interior)', lon: -123.1430, lat: 49.3020, expect: 'elevated, forested' },
  { name: 'Robson & Burrard',  lon: -123.1207, lat: 49.2856, expect: 'downtown plateau' },
  { name: 'Science World',     lon: -123.1035, lat: 49.2733, expect: 'False Creek shore, low' },
  { name: 'English Bay Beach', lon: -123.1425, lat: 49.2861, expect: 'beach, near sea level' },
  { name: 'Burrard Inlet',     lon: -123.1200, lat: 49.3050, expect: 'open water = 0 m' },
];

function loadHeightmap(): Heightmap {
  const manifest = JSON.parse(
    readFileSync(join(WORLD, 'manifest.json'), 'utf8'),
  ) as WorldManifest;

  const hBuf = readFileSync(join(WORLD, manifest.terrain.file));
  const raw = new Uint16Array(hBuf.buffer, hBuf.byteOffset, hBuf.length / 2);

  const wBuf = readFileSync(join(WORLD, manifest.water.file));
  const water = new Uint8Array(wBuf.buffer, wBuf.byteOffset, wBuf.length);

  return new Heightmap(manifest, raw, water);
}

async function main(): Promise<void> {
  await RAPIER.init();
  const hm = loadHeightmap();

  console.log('Terrain verification');
  console.log(`  grid       ${hm.width} x ${hm.height} @ ${hm.resolution} m`);
  console.log(`  extent     ${((hm.width - 1) * hm.resolution).toFixed(0)} x ${((hm.height - 1) * hm.resolution).toFixed(0)} m`);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const centre = hm.center();
  const scale = hm.rapierScale();

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(centre.x, 0, centre.z),
  );
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(
      hm.height - 1, // nrows: samples along Z
      hm.width - 1,  // ncols: samples along X
      hm.toRapierHeights(),
      scale,
    ),
    body,
  );
  console.log(`  collider   centred at x=${centre.x.toFixed(0)} z=${centre.z.toFixed(0)}`);

  // Ray casts go through the query pipeline, which is only populated when the
  // world steps. Without this every cast silently misses.
  world.step();
  console.log('');

  // --- Raycast every landmark and compare against the CPU sampler -----------
  const RAY_FROM = 400;
  let worstError = 0;
  let failures = 0;

  console.log('  landmark                       sampler   raycast    delta');
  console.log('  ' + '─'.repeat(64));

  for (const lm of LANDMARKS) {
    const p = toWorld(lm.lon, lm.lat);
    const expected = hm.sample(p.x, p.z);

    // The sampler clamps outside the map while the collider genuinely ends, so
    // an out-of-bounds landmark would otherwise look like a collider bug.
    const inBounds =
      p.x >= hm.bounds.minX && p.x <= hm.bounds.minX + (hm.width - 1) * hm.resolution &&
      p.z >= hm.bounds.minZ && p.z <= hm.bounds.minZ + (hm.height - 1) * hm.resolution;
    if (!inBounds) {
      console.log(`  ${lm.name.padEnd(28)} ${'— outside map bounds —'.padStart(28)}`);
      continue;
    }

    const ray = new RAPIER.Ray({ x: p.x, y: RAY_FROM, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, RAY_FROM * 2, true);
    const actual = hit ? RAY_FROM - hit.timeOfImpact : NaN;

    const delta = Number.isNaN(actual) ? NaN : Math.abs(actual - expected);
    if (Number.isNaN(delta) || delta > 1.0) failures++;
    if (!Number.isNaN(delta)) worstError = Math.max(worstError, delta);

    console.log(
      `  ${lm.name.padEnd(28)} ${expected.toFixed(1).padStart(7)} m ` +
      `${(Number.isNaN(actual) ? 'MISS' : actual.toFixed(1) + ' m').padStart(9)} ` +
      `${(Number.isNaN(delta) ? '—' : delta.toFixed(2)).padStart(8)}`,
    );
  }

  // --- Random sampling across the whole map --------------------------------
  let randomFailures = 0;
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const x = hm.bounds.minX + Math.random() * ((hm.width - 1) * hm.resolution);
    const z = hm.bounds.minZ + Math.random() * ((hm.height - 1) * hm.resolution);
    const expected = hm.sample(x, z);
    const ray = new RAPIER.Ray({ x, y: RAY_FROM, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, RAY_FROM * 2, true);
    if (!hit) { randomFailures++; continue; }
    checked++;
    const actual = RAY_FROM - hit.timeOfImpact;
    if (Math.abs(actual - expected) > 1.0) randomFailures++;
    worstError = Math.max(worstError, Math.abs(actual - expected));
  }

  console.log(`\n  random points   ${checked}/400 hit, ${randomFailures} disagreed`);
  console.log(`  worst delta     ${worstError.toFixed(3)} m`);

  // --- Sanity: geography should match reality ------------------------------
  console.log('\n── Geography sanity ────────────────────────');
  const checks: Array<[string, boolean, string]> = [];

  const inlet = toWorld(-123.12, 49.305);
  checks.push([
    'Burrard Inlet is water at 0 m',
    hm.isWater(inlet.x, inlet.z) && hm.sample(inlet.x, inlet.z) < 0.5,
    `${hm.sample(inlet.x, inlet.z).toFixed(2)} m, water=${hm.isWater(inlet.x, inlet.z)}`,
  ]);

  const downtown = toWorld(-123.1207, 49.2856);
  checks.push([
    'Downtown sits above sea level',
    hm.sample(downtown.x, downtown.z) > 10 && !hm.isWater(downtown.x, downtown.z),
    `${hm.sample(downtown.x, downtown.z).toFixed(1)} m`,
  ]);

  const beach = toWorld(-123.1425, 49.2861);
  checks.push([
    'English Bay beach is low but dry land',
    hm.sample(beach.x, beach.z) < 12 && !hm.isWater(beach.x, beach.z),
    `${hm.sample(beach.x, beach.z).toFixed(1)} m`,
  ]);

  checks.push([
    'Downtown is higher than the waterfront',
    hm.sample(downtown.x, downtown.z) > hm.sample(toWorld(-123.1119, 49.2888).x, toWorld(-123.1119, 49.2888).z),
    '',
  ]);

  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures++;
  }

  const pass = failures === 0 && randomFailures === 0;
  console.log(`\n  → ${pass ? 'PASS — collider matches the heightmap' : `FAIL — ${failures + randomFailures} problem(s)`}\n`);
  if (!pass) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
