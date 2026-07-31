/**
 * Renders the car model to PNGs — `npx tsx tools/preview-car.ts`.
 *
 * There is no browser in this environment, so the car was previously shipped
 * without anyone having looked at it, and a coordinate-space error left the
 * body floating clear of its own wheels. Numbers could not catch that; a
 * picture catches it instantly.
 *
 * This is a tiny orthographic rasteriser — flat shading, a depth buffer, no
 * WebGL — run over the same geometry the game builds, so what it shows is what
 * the game draws.
 */
import * as THREE from 'three';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCarModel } from '../src/vehicle/CarModel';
import { CAR } from '../src/vehicle/CarConfig';
import { rgbPng } from './lib/png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'preview');

const WIDTH = 900;
const HEIGHT = 460;

interface Tri {
  a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3;
  color: THREE.Color;
}

/** Pulls world-space triangles out of the model, with each mesh's colour. */
function collectTriangles(root: THREE.Object3D): Tri[] {
  root.updateMatrixWorld(true);
  const tris: Tri[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const colAttr = geo.getAttribute('color');
    const index = geo.getIndex();
    const material = obj.material as THREE.MeshStandardMaterial;

    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const ids = index
        ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
        : [i, i + 1, i + 2];

      for (let k = 0; k < 3; k++) {
        v[k]!.fromBufferAttribute(pos, ids[k]!).applyMatrix4(obj.matrixWorld);
      }

      let color: THREE.Color;
      if (material.vertexColors && colAttr) {
        color = new THREE.Color(
          colAttr.getX(ids[0]!), colAttr.getY(ids[0]!), colAttr.getZ(ids[0]!),
        );
      } else {
        color = material.color ? material.color.clone() : new THREE.Color(0x888888);
        // Emissive parts should read as lit rather than as dark plastic.
        if (material.emissive && material.emissiveIntensity > 0.5) {
          color.lerp(material.emissive, 0.85);
        }
      }

      tris.push({
        a: v[0]!.clone(), b: v[1]!.clone(), c: v[2]!.clone(), color,
      });
    }
  });

  return tris;
}

/** Orthographic projection with flat shading and a depth buffer. */
function render(tris: Tri[], rotY: number, rotX: number, label: string): Uint8Array {
  const rot = new THREE.Matrix4()
    .makeRotationY(rotY)
    .premultiply(new THREE.Matrix4().makeRotationX(rotX));

  const view = tris.map((t) => ({
    a: t.a.clone().applyMatrix4(rot),
    b: t.b.clone().applyMatrix4(rot),
    c: t.c.clone().applyMatrix4(rot),
    color: t.color,
  }));

  // Fit the model to frame.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of view) {
    for (const p of [t.a, t.b, t.c]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const pad = 0.35;
  const scale = Math.min(
    (WIDTH - 40) / (maxX - minX + pad * 2),
    (HEIGHT - 40) / (maxY - minY + pad * 2),
  );
  const ox = WIDTH / 2 - ((minX + maxX) / 2) * scale;
  const oy = HEIGHT / 2 + ((minY + maxY) / 2) * scale;

  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  // Background gradient, so the silhouette is legible.
  for (let y = 0; y < HEIGHT; y++) {
    const t = y / HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      rgb[i] = Math.round(14 + 12 * t);
      rgb[i + 1] = Math.round(18 + 16 * t);
      rgb[i + 2] = Math.round(28 + 22 * t);
    }
  }
  // Nearer means *larger* z here (camera looks down -Z), so the buffer starts
  // at -Infinity rather than the usual +Infinity.
  const depth = new Float32Array(WIDTH * HEIGHT).fill(-Infinity);

  const light = new THREE.Vector3(-0.4, 0.75, 0.9).normalize();
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  for (const t of view) {
    e1.subVectors(t.b, t.a);
    e2.subVectors(t.c, t.a);
    normal.crossVectors(e1, e2);
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    // Back-face cull: with the camera looking down -Z, front faces point at +Z.
    if (normal.z <= 0) continue;

    const lambert = Math.max(0, normal.dot(light));
    const shade = 0.22 + 0.78 * lambert;

    const px = [t.a, t.b, t.c].map((p) => ({
      x: ox + p.x * scale,
      y: oy - p.y * scale,
      z: p.z,
    }));

    const x0 = Math.max(0, Math.floor(Math.min(px[0]!.x, px[1]!.x, px[2]!.x)));
    const x1 = Math.min(WIDTH - 1, Math.ceil(Math.max(px[0]!.x, px[1]!.x, px[2]!.x)));
    const y0 = Math.max(0, Math.floor(Math.min(px[0]!.y, px[1]!.y, px[2]!.y)));
    const y1 = Math.min(HEIGHT - 1, Math.ceil(Math.max(px[0]!.y, px[1]!.y, px[2]!.y)));

    const area = (px[1]!.x - px[0]!.x) * (px[2]!.y - px[0]!.y)
               - (px[2]!.x - px[0]!.x) * (px[1]!.y - px[0]!.y);
    if (Math.abs(area) < 1e-9) continue;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        // Barycentric coordinates for coverage and depth.
        const w0 = ((px[1]!.x - cx) * (px[2]!.y - cy) - (px[2]!.x - cx) * (px[1]!.y - cy)) / area;
        const w1 = ((px[2]!.x - cx) * (px[0]!.y - cy) - (px[0]!.x - cx) * (px[2]!.y - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const z = w0 * px[0]!.z + w1 * px[1]!.z + w2 * px[2]!.z;
        const idx = y * WIDTH + x;
        if (z <= depth[idx]!) continue; // larger z is nearer the camera
        depth[idx] = z;

        const i = idx * 3;
        rgb[i] = Math.min(255, Math.round(t.color.r * 255 * shade));
        rgb[i + 1] = Math.min(255, Math.round(t.color.g * 255 * shade));
        rgb[i + 2] = Math.min(255, Math.round(t.color.b * 255 * shade));
      }
    }
  }

  console.log(`  ${label}: ${view.length} triangles`);
  return rgb;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const model = buildCarModel();

  // Physics normally places the wheels; for a static preview, seat them at
  // their resting positions so the stance is what you would actually see.
  const w = CAR.wheel;
  const rest: Array<[number, number, number]> = [
    [-w.halfTrackFront, w.front.radius, w.frontZ],
    [w.halfTrackFront, w.front.radius, w.frontZ],
    [-w.halfTrackRear, w.rear.radius, w.rearZ],
    [w.halfTrackRear, w.rear.radius, w.rearZ],
  ];
  // 0.653 m is the chassis origin height; wheels sit relative to the group.
  model.wheels.forEach((wheel, i) => {
    const [x, y, z] = rest[i]!;
    wheel.position.set(x, y - 0.653, z);
  });

  const tris = collectTriangles(model.group);
  console.log(`Car preview — ${tris.length} triangles total`);

  const views: Array<[string, number, number]> = [
    ['side', Math.PI / 2, 0],
    ['front', Math.PI, 0],
    ['three-quarter', Math.PI * 0.72, 0.20],
    ['rear-quarter', -Math.PI * 0.28, 0.20],
  ];

  for (const [name, rotY, rotX] of views) {
    const rgb = render(tris, rotY, rotX, name);
    await writeFile(join(OUT, `car-${name}.png`), rgbPng(WIDTH, HEIGHT, rgb));
  }

  console.log(`\nWrote ${views.length} views to data/preview/\n`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
