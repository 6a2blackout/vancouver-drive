import * as THREE from 'three';
import { CAR } from './CarConfig';

/**
 * A Porsche 911 (992) built by lofting cross-sections along the body.
 *
 * Boxes cannot express this car. The 911's identity lives in a handful of
 * continuous curves — the nose dropping away below the front wheel arches, the
 * roof flowing unbroken into the engine deck (the "flyline"), and rear hips
 * wider than the front track. Those are all *changes of section along the
 * length*, so the body is defined as a series of stations and lofted between
 * them, the way the real thing is drawn.
 *
 * Glass is picked out with vertex colours rather than separate meshes: any
 * station within the cabin range that sits above its belt line is coloured as
 * window, which produces a continuous windscreen → side glass → rear screen band
 * for free.
 */

interface Station {
  /** Position along the car. +Z is forward. */
  z: number;
  /** Floor height above the wheel centre plane. */
  yBottom: number;
  /** Roof or deck height. */
  yTop: number;
  /** Maximum half-width. */
  wBody: number;
  /** Half-width at the top edge. Narrower than wBody gives tumblehome. */
  wTop: number;
  /** Height at which the body reaches its maximum width. */
  yShoulder: number;
  /** Above this height, this station is glass rather than paint. */
  belt: number;
}

/**
 * The 992 in profile, nose first.
 *
 * Read the `yTop` column downward and the flyline is visible as data: it rises
 * to 1.30 over the cabin then falls away continuously to the tail, never
 * stepping. The `wBody` column shows the other signature — 0.93 at the front
 * arches, pinched to 0.70 at the roof, flaring to 0.97 over the rear hips.
 */
const STATIONS: Station[] = [
  { z: 2.27, yBottom: 0.34, yTop: 0.58, wBody: 0.60, wTop: 0.44, yShoulder: 0.48, belt: 9 },
  { z: 2.10, yBottom: 0.20, yTop: 0.70, wBody: 0.80, wTop: 0.66, yShoulder: 0.52, belt: 9 },
  { z: 1.80, yBottom: 0.16, yTop: 0.82, wBody: 0.89, wTop: 0.78, yShoulder: 0.50, belt: 9 },
  { z: 1.35, yBottom: 0.15, yTop: 0.95, wBody: 0.94, wTop: 0.84, yShoulder: 0.55, belt: 9 },
  { z: 0.95, yBottom: 0.16, yTop: 1.00, wBody: 0.92, wTop: 0.82, yShoulder: 0.56, belt: 0.97 },
  { z: 0.60, yBottom: 0.17, yTop: 1.14, wBody: 0.91, wTop: 0.76, yShoulder: 0.58, belt: 0.92 },
  { z: 0.15, yBottom: 0.18, yTop: 1.29, wBody: 0.90, wTop: 0.70, yShoulder: 0.60, belt: 0.95 },
  { z: -0.35, yBottom: 0.19, yTop: 1.30, wBody: 0.90, wTop: 0.69, yShoulder: 0.62, belt: 0.96 },
  { z: -0.80, yBottom: 0.20, yTop: 1.25, wBody: 0.92, wTop: 0.72, yShoulder: 0.64, belt: 0.98 },
  { z: -1.20, yBottom: 0.21, yTop: 1.12, wBody: 0.96, wTop: 0.84, yShoulder: 0.66, belt: 1.06 },
  { z: -1.60, yBottom: 0.22, yTop: 1.04, wBody: 0.97, wTop: 0.90, yShoulder: 0.64, belt: 9 },
  { z: -1.95, yBottom: 0.24, yTop: 1.00, wBody: 0.96, wTop: 0.91, yShoulder: 0.62, belt: 9 },
  { z: -2.18, yBottom: 0.28, yTop: 0.95, wBody: 0.92, wTop: 0.86, yShoulder: 0.60, belt: 9 },
  { z: -2.27, yBottom: 0.34, yTop: 0.86, wBody: 0.82, wTop: 0.74, yShoulder: 0.58, belt: 9 },
];

/** Points per cross-section, running counter-clockwise seen from the front. */
const SECTION_POINTS = 12;

function sectionOutline(s: Station): Array<{ x: number; y: number }> {
  const midLow = s.yBottom + (s.yShoulder - s.yBottom) * 0.45;
  const midHigh = s.yTop - (s.yTop - s.yShoulder) * 0.32;

  // Right-hand half, bottom centre up to top centre.
  const half = [
    { x: 0, y: s.yBottom },
    { x: s.wBody * 0.72, y: s.yBottom },
    { x: s.wBody, y: midLow },
    { x: s.wBody, y: s.yShoulder },
    { x: s.wTop * 1.04, y: midHigh },
    { x: s.wTop, y: s.yTop },
    { x: 0, y: s.yTop },
  ];
  // Mirror back down the left side, skipping the shared centre points.
  const mirrored = half.slice(1, -1).reverse().map((p) => ({ x: -p.x, y: p.y }));
  return [...half, ...mirrored];
}

export interface CarModel {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  /** Emissive parts that should brighten when braking. */
  brakeLights: THREE.MeshStandardMaterial;
}

export function buildCarModel(): CarModel {
  const group = new THREE.Group();
  const paint = CAR.paint;

  group.add(buildBody());
  group.add(...buildLights());
  group.add(buildSpoiler());
  group.add(...buildMirrors());
  group.add(buildDiffuser());

  const wheels: THREE.Object3D[] = [];
  for (const axle of ['front', 'front', 'rear', 'rear'] as const) {
    const wheel = buildWheel(CAR.wheel[axle].radius, CAR.wheel[axle].width);
    wheels.push(wheel);
    group.add(wheel);
  }

  const brakeLights = new THREE.MeshStandardMaterial({
    color: 0x2a0206,
    emissive: 0xff1e2d,
    emissiveIntensity: 2.4,
    roughness: 0.3,
  });

  // The full-width light bar — the 992's clearest signature at night.
  const barGeo = new THREE.BoxGeometry(1.58, 0.075, 0.06);
  const bar = new THREE.Mesh(barGeo, brakeLights);
  bar.position.set(0, 0.80, -2.255);
  group.add(bar);

  // Reflector strip below it, unlit, to give the tail some depth.
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(1.30, 0.03, 0.04),
    new THREE.MeshStandardMaterial({ color: paint.trim, roughness: 0.5 }),
  );
  strip.position.set(0, 0.64, -2.26);
  group.add(strip);

  return { group, wheels, brakeLights };
}

/** Lofts the stations into a single closed body shell. */
function buildBody(): THREE.Mesh {
  const outlines = STATIONS.map(sectionOutline);
  const n = SECTION_POINTS;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const paint = new THREE.Color(CAR.paint.body);
  const glass = new THREE.Color(CAR.paint.glass);

  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i]!;
    const outline = outlines[i]!;
    for (let j = 0; j < n; j++) {
      const p = outline[j]!;
      positions.push(p.x, p.y, s.z);
      const isGlass = p.y > s.belt;
      const c = isGlass ? glass : paint;
      colors.push(c.r, c.g, c.b);
    }
  }

  // Stations run nose-to-tail, so this winding puts normals outward.
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = i * n;
    const b = (i + 1) * n;
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      indices.push(a + j, b + j, b + j2);
      indices.push(a + j, b + j2, a + j2);
    }
  }

  // Caps. The nose fan runs in outline order (counter-clockwise from +Z); the
  // tail must be reversed so it faces -Z.
  const capNose = positions.length / 3;
  positions.push(0, (STATIONS[0]!.yBottom + STATIONS[0]!.yTop) / 2, STATIONS[0]!.z);
  colors.push(paint.r, paint.g, paint.b);
  for (let j = 0; j < n; j++) indices.push(capNose, j, (j + 1) % n);

  const last = (STATIONS.length - 1) * n;
  const s = STATIONS[STATIONS.length - 1]!;
  const capTail = positions.length / 3;
  positions.push(0, (s.yBottom + s.yTop) / 2, s.z);
  colors.push(paint.r, paint.g, paint.b);
  for (let j = 0; j < n; j++) indices.push(capTail, last + ((j + 1) % n), last + j);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: CAR.paint.roughness,
      metalness: CAR.paint.metalness,
      // The shell is open along the underside seam at the extreme stations;
      // drawing both sides costs nothing here and avoids any peek-through.
      side: THREE.DoubleSide,
    }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** Round quad headlights, plus the low front intakes. */
function buildLights(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];

  const lens = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xcfe0ff,
    emissiveIntensity: 5.5,
    roughness: 0.15,
  });
  const housing = new THREE.MeshStandardMaterial({ color: 0x0b0d11, roughness: 0.4 });

  const lensGeo = new THREE.CylinderGeometry(0.115, 0.115, 0.07, 20);
  lensGeo.rotateX(Math.PI / 2);
  const ringGeo = new THREE.CylinderGeometry(0.145, 0.145, 0.05, 20);
  ringGeo.rotateX(Math.PI / 2);

  for (const sx of [-1, 1]) {
    const ring = new THREE.Mesh(ringGeo, housing);
    ring.position.set(sx * 0.62, 0.79, 2.05);
    out.push(ring);

    const light = new THREE.Mesh(lensGeo, lens);
    light.position.set(sx * 0.62, 0.79, 2.09);
    out.push(light);

    // Lower intake, dark, to break up the nose.
    const intake = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.14, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.9 }),
    );
    intake.position.set(sx * 0.52, 0.42, 2.13);
    out.push(intake);
  }

  return out;
}

/** The GTS ducktail. */
function buildSpoiler(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1.52, 0.05, 0.30);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: CAR.paint.body,
      roughness: CAR.paint.roughness,
      metalness: CAR.paint.metalness,
    }),
  );
  mesh.position.set(0, 1.045, -1.90);
  mesh.rotation.x = -0.12;
  mesh.castShadow = true;
  return mesh;
}

function buildMirrors(): THREE.Object3D[] {
  const material = new THREE.MeshStandardMaterial({
    color: CAR.paint.body,
    roughness: CAR.paint.roughness,
    metalness: CAR.paint.metalness,
  });
  const geometry = new THREE.BoxGeometry(0.20, 0.07, 0.11);

  return [-1, 1].map((sx) => {
    const mirror = new THREE.Mesh(geometry, material);
    mirror.position.set(sx * 1.02, 1.00, 0.62);
    mirror.castShadow = true;
    return mirror;
  });
}

/** Rear diffuser and exhausts. */
function buildDiffuser(): THREE.Group {
  const g = new THREE.Group();

  const diffuser = new THREE.Mesh(
    new THREE.BoxGeometry(1.42, 0.16, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.85 }),
  );
  diffuser.position.set(0, 0.36, -2.16);
  g.add(diffuser);

  const pipeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.12, 12);
  pipeGeo.rotateX(Math.PI / 2);
  const pipeMat = new THREE.MeshStandardMaterial({
    color: 0x8b9199, roughness: 0.25, metalness: 0.95,
  });
  for (const sx of [-1, 1]) {
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.position.set(sx * 0.30, 0.44, -2.24);
    g.add(pipe);
  }

  return g;
}

/** A wheel: tyre, dished rim with spokes, and a brake disc behind it. */
function buildWheel(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();

  const tyreGeo = new THREE.CylinderGeometry(radius, radius, width, 28);
  tyreGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.Mesh(
    tyreGeo,
    new THREE.MeshStandardMaterial({ color: 0x0e1013, roughness: 0.92, metalness: 0.0 }),
  );
  tyre.castShadow = true;
  g.add(tyre);

  const rimRadius = radius * 0.72;
  const rimGeo = new THREE.CylinderGeometry(rimRadius, rimRadius, width * 0.92, 24);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x6f7681, roughness: 0.22, metalness: 0.95,
  });
  g.add(new THREE.Mesh(rimGeo, rimMat));

  // Five twin-spokes, offset outboard so the wheel reads as dished.
  const spokeGeo = new THREE.BoxGeometry(0.035, rimRadius * 1.75, 0.05);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(spokeGeo, rimMat);
    spoke.rotation.x = (i / 5) * Math.PI;
    spoke.position.x = width * 0.30;
    g.add(spoke);
  }

  const discGeo = new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, 0.03, 20);
  discGeo.rotateZ(Math.PI / 2);
  const disc = new THREE.Mesh(
    discGeo,
    new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.35, metalness: 0.7 }),
  );
  g.add(disc);

  return g;
}
