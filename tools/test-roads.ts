/**
 * Verifies the road surface — `npx tsx tools/test-roads.ts`.
 *
 * The whole point of burning roads into the heightmap is that the car drives on
 * a flat, smoothly graded corridor rather than on raw contour-derived terrain.
 * That is a measurable claim: sample across a road and the carriageway should be
 * level; sample along it and the grade should be gentle and free of steps. This
 * checks both, plus that the binary the runtime decodes is internally
 * consistent.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Heightmap, type WorldManifest } from '../src/world/Heightmap';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = join(ROOT, 'public', 'world');

interface GraphEdge {
  i: number; a: number; b: number; w: number; k: string; n: string; o: number;
  p: [number, number][];
}

function loadHeightmap(manifest: WorldManifest): Heightmap {
  const hBuf = readFileSync(join(WORLD, manifest.terrain.file));
  const raw = new Uint16Array(hBuf.buffer, hBuf.byteOffset, hBuf.length / 2);
  const wBuf = readFileSync(join(WORLD, manifest.water.file));
  return new Heightmap(manifest, raw, new Uint8Array(wBuf.buffer, wBuf.byteOffset, wBuf.length));
}

function main(): void {
  const manifest = JSON.parse(
    readFileSync(join(WORLD, 'manifest.json'), 'utf8'),
  ) as WorldManifest & { roads: { file: string; vertexCount: number; triangleCount: number } };

  const hm = loadHeightmap(manifest);
  const graph = JSON.parse(readFileSync(join(WORLD, 'roadgraph.json'), 'utf8')) as {
    nodes: { i: number; x: number; z: number; e: number[] }[];
    edges: GraphEdge[];
  };

  console.log('Road verification');
  console.log(`  ${graph.edges.length} edges, ${graph.nodes.length} nodes`);

  let failures = 0;

  // --- Binary integrity ----------------------------------------------------
  const buf = readFileSync(join(WORLD, manifest.roads.file));
  const header = new Uint32Array(buf.buffer, buf.byteOffset, 2);
  const vertexCount = header[0]!;
  const indexCount = header[1]!;
  const expectedBytes = 8 + vertexCount * 3 * 4 + vertexCount * 4 + indexCount * 4;

  console.log('\n── roads.bin ───────────────────────────────');
  console.log(`  vertices        ${vertexCount.toLocaleString()}`);
  console.log(`  triangles       ${(indexCount / 3).toLocaleString()}`);
  console.log(`  size            ${buf.length.toLocaleString()} bytes (expected ${expectedBytes.toLocaleString()})`);
  if (buf.length !== expectedBytes) { console.log('  → FAIL: size mismatch'); failures++; }
  if (vertexCount !== manifest.roads.vertexCount) { console.log('  → FAIL: vertex count disagrees with manifest'); failures++; }

  const indices = new Uint32Array(
    buf.buffer, buf.byteOffset + 8 + vertexCount * 3 * 4 + vertexCount * 4, indexCount,
  );
  let badIndex = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i]! >= vertexCount) badIndex++;
  console.log(`  index range     ${badIndex === 0 ? 'ok' : `FAIL — ${badIndex} out of range`}`);
  if (badIndex > 0) failures++;

  // --- Cross-section flatness ---------------------------------------------
  // Sample perpendicular to the centreline, inside the carriageway only.
  console.log('\n── Cross-slope (carriageway should be level) ─');
  const crossDeviations: number[] = [];
  let sampled = 0;

  for (const edge of graph.edges) {
    if (edge.p.length < 2) continue;
    if (edge.i % 7 !== 0) continue; // sample a subset, for speed

    const mid = Math.floor(edge.p.length / 2);
    const a = edge.p[Math.max(0, mid - 1)]!;
    const b = edge.p[Math.min(edge.p.length - 1, mid)]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;

    const nx = -dz / len;
    const nz = dx / len;
    const cx = (a[0] + b[0]) / 2;
    const cz = (a[1] + b[1]) / 2;
    if (hm.isWater(cx, cz)) continue;

    const half = edge.w / 2;
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = -half * 0.8; t <= half * 0.8; t += 1) {
      const h = hm.sample(cx + nx * t, cz + nz * t);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    crossDeviations.push(hi - lo);
    sampled++;
  }

  crossDeviations.sort((x, y) => x - y);
  const median = crossDeviations[Math.floor(crossDeviations.length / 2)] ?? 0;
  const p95 = crossDeviations[Math.floor(crossDeviations.length * 0.95)] ?? 0;
  const worst = crossDeviations[crossDeviations.length - 1] ?? 0;

  console.log(`  sampled         ${sampled} road cross-sections`);
  console.log(`  median          ${(median * 100).toFixed(1)} cm across the carriageway`);
  console.log(`  95th pct        ${(p95 * 100).toFixed(1)} cm`);
  console.log(`  worst           ${(worst * 100).toFixed(1)} cm`);
  const crossOk = median < 0.25 && p95 < 1.0;
  console.log(`  → ${crossOk ? 'OK — roads are level across their width' : 'PROBLEM — carriageway is not flat'}`);
  if (!crossOk) failures++;

  // --- Longitudinal grade --------------------------------------------------
  console.log('\n── Grade (should be drivable, no steps) ────');
  let steepest = 0;
  let steepestName = '';
  let stepCount = 0;
  let maxStep = 0;

  for (const edge of graph.edges) {
    if (edge.p.length < 2) continue;
    for (let i = 1; i < edge.p.length; i++) {
      const [x0, z0] = edge.p[i - 1]!;
      const [x1, z1] = edge.p[i]!;
      const run = Math.hypot(x1 - x0, z1 - z0);
      if (run < 2) continue;
      if (hm.isWater(x0, z0) || hm.isWater(x1, z1)) continue;

      const rise = Math.abs(hm.sample(x1, z1) - hm.sample(x0, z0));
      const grade = rise / run;
      if (grade > steepest) { steepest = grade; steepestName = edge.n || edge.k; }

      // A "step" is a sudden vertical jump over a short distance — the
      // signature of a burn that failed to blend.
      if (run < 6 && rise > 1.2) { stepCount++; maxStep = Math.max(maxStep, rise); }
    }
  }

  console.log(`  steepest grade  ${(steepest * 100).toFixed(1)}%  (${steepestName})`);
  console.log(`  abrupt steps    ${stepCount}${stepCount > 0 ? ` (worst ${maxStep.toFixed(2)} m)` : ''}`);
  // Vancouver genuinely has steep streets; anything under ~25% is plausible.
  const gradeOk = steepest < 0.30 && stepCount < 40;
  console.log(`  → ${gradeOk ? 'OK — grades are drivable' : 'PROBLEM — impassable grade or unblended step'}`);
  if (!gradeOk) failures++;

  // --- Connectivity --------------------------------------------------------
  console.log('\n── Graph shape ─────────────────────────────');
  const degree = new Map<number, number>();
  for (const n of graph.nodes) degree.set(n.e.length, (degree.get(n.e.length) ?? 0) + 1);
  const orphans = graph.nodes.filter((n) => n.e.length === 0).length;
  const classes = new Map<string, number>();
  for (const e of graph.edges) classes.set(e.k, (classes.get(e.k) ?? 0) + 1);

  console.log(`  degrees         ${[...degree.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}:${c}`).join('  ')}`);
  console.log(`  classes         ${[...classes.entries()].map(([k, c]) => `${k}:${c}`).join('  ')}`);
  console.log(`  orphan nodes    ${orphans}`);
  if (orphans > 0) { failures++; }

  const oneways = graph.edges.filter((e) => e.o === 1).length;
  console.log(`  one-way edges   ${oneways}`);

  console.log(`\n  → ${failures === 0 ? 'PASS' : `FAIL — ${failures} problem(s)`}\n`);
  if (failures > 0) process.exit(1);
}

main();
