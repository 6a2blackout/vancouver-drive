import * as THREE from 'three';
import { CAR } from './CarConfig';

/**
 * A Porsche 911 (992) built by lofting cross-sections along the body.
 *
 * Boxes cannot express this car. The 911's identity lives in a handful of
 * continuous curves — the nose dropping away below the front wing crowns, the
 * roof flowing unbroken into the engine deck (the "flyline"), and rear hips
 * wider than the front track. Those are all *changes of section along the
 * length*, so the body is defined as a series of stations and lofted between
 * them, the way the real thing is drawn.
 */

/**
 * Height of the chassis origin above the road at rest, measured with
 * `npm run test:vehicle`.
 *
 * Stations below are authored as heights above the *ground*, because that is
 * how a car is actually dimensioned and it makes the numbers checkable against
 * the real vehicle. The physics body's origin is not on the ground though, so
 * the whole shell is lowered by this amount when assembled. Getting this wrong
 * floats the body clear of its own wheels.
 */
const RIDE_HEIGHT = 0.653;

interface Station {
  /** Position along the car. +Z is forward. */
  z: number;
  /** Underside height above the road. */
  yBottom: number;
  /** Centreline height above the road — hood, roof or engine deck. */
  yTop: number;
  /** Maximum half-width. */
  wBody: number;
  /** Half-width at the top edge. Narrower than wBody gives tumblehome. */
  wTop: number;
  /** Height at which the body reaches its maximum width. */
  yShoulder: number;
  /**
   * How far the outer top edge rises above the centreline.
   *
   * This is the 911's most particular signature: the front wing crowns stand
   * proud of the hood between them, which is why you can place the car's
   * corners from the driver's seat. Without it the nose reads as a slab.
   */
  crown: number;
  /** Above this height the station is glass rather than paint. */
  belt: number;
}

/**
 * The 992 in profile, nose first.
 *
 * Read `yTop` downward and the flyline is visible as data: it climbs to 1.295
 * over the cabin then falls away continuously to the tail, never stepping.
 * `wBody` shows the other signature — 0.945 at the front arches, pinched to
 * 0.91 at the roof, flaring to 0.965 over the rear hips.
 */
const STATIONS: Station[] = [
  { z: 2.26, yBottom: 0.34, yTop: 0.70, wBody: 0.62, wTop: 0.50, yShoulder: 0.52, crown: 0.01, belt: 9 },
  { z: 2.08, yBottom: 0.20, yTop: 0.80, wBody: 0.84, wTop: 0.68, yShoulder: 0.55, crown: 0.05, belt: 9 },
  { z: 1.80, yBottom: 0.15, yTop: 0.87, wBody: 0.905, wTop: 0.72, yShoulder: 0.56, crown: 0.075, belt: 9 },
  { z: 1.48, yBottom: 0.14, yTop: 0.92, wBody: 0.945, wTop: 0.75, yShoulder: 0.58, crown: 0.085, belt: 9 },
  { z: 1.15, yBottom: 0.15, yTop: 0.945, wBody: 0.935, wTop: 0.78, yShoulder: 0.58, crown: 0.055, belt: 9 },
  { z: 0.80, yBottom: 0.16, yTop: 0.99, wBody: 0.925, wTop: 0.80, yShoulder: 0.59, crown: 0.015, belt: 0.97 },
  { z: 0.42, yBottom: 0.17, yTop: 1.16, wBody: 0.915, wTop: 0.74, yShoulder: 0.60, crown: 0, belt: 0.98 },
  { z: 0.00, yBottom: 0.18, yTop: 1.285, wBody: 0.91, wTop: 0.66, yShoulder: 0.62, crown: 0, belt: 1.00 },
  { z: -0.45, yBottom: 0.19, yTop: 1.295, wBody: 0.91, wTop: 0.65, yShoulder: 0.63, crown: 0, belt: 1.01 },
  { z: -0.90, yBottom: 0.20, yTop: 1.22, wBody: 0.925, wTop: 0.69, yShoulder: 0.65, crown: 0, belt: 1.02 },
  { z: -1.30, yBottom: 0.21, yTop: 1.10, wBody: 0.965, wTop: 0.80, yShoulder: 0.67, crown: 0.04, belt: 1.09 },
  { z: -1.70, yBottom: 0.22, yTop: 1.02, wBody: 0.955, wTop: 0.86, yShoulder: 0.64, crown: 0.025, belt: 9 },
  { z: -2.05, yBottom: 0.28, yTop: 0.94, wBody: 0.90, wTop: 0.85, yShoulder: 0.62, crown: 0.01, belt: 9 },
  // Tail tapers hard in all three dimensions. Left blunt it reads as a truck.
  { z: -2.26, yBottom: 0.46, yTop: 0.82, wBody: 0.74, wTop: 0.68, yShoulder: 0.62, crown: 0, belt: 9 },
];

/** Points per cross-section, running counter-clockwise seen from the front. */
const SECTION_POINTS = 12;

function sectionOutline(s: Station): Array<{ x: number; y: number }> {
  const midLow = s.yBottom + (s.yShoulder - s.yBottom) * 0.45;

  // Right-hand half, bottom centre up to top centre.
  const half = [
    { x: 0, y: s.yBottom },
    { x: s.wBody * 0.74, y: s.yBottom },
    { x: s.wBody, y: midLow },
    { x: s.wBody, y: s.yShoulder },
    // The crown point sits outboard of the roof edge and may rise above it.
    { x: s.wTop * 1.03, y: s.yTop + s.crown - (s.yTop - s.yShoulder) * 0.22 },
    { x: s.wTop, y: s.yTop },
    { x: 0, y: s.yTop },
  ];
  const mirrored = half.slice(1, -1).reverse().map((p) => ({ x: -p.x, y: p.y }));
  return [...half, ...mirrored];
}

export interface CarModel {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  brakeLights: THREE.MeshStandardMaterial;
}

export function buildCarModel(): CarModel {
  const group = new THREE.Group();

  // Everything shaped from the station table is authored in ground-referenced
  // coordinates, so it all lives under one group lowered onto the chassis
  // origin. Wheels are excluded: physics positions those in world space.
  const shell = new THREE.Group();
  shell.position.y = -RIDE_HEIGHT;
  group.add(shell);

  shell.add(buildBody());
  shell.add(...buildLights());
  shell.add(buildSpoiler());
  shell.add(...buildMirrors());
  shell.add(buildDiffuser());

  const brakeLights = new THREE.MeshStandardMaterial({
    color: 0x2a0206,
    emissive: 0xff1e2d,
    emissiveIntensity: 2.4,
    roughness: 0.3,
  });

  // The full-width light bar — the 992's clearest signature at night.
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.07, 0.06), brakeLights);
  bar.position.set(0, 0.80, -2.25);
  shell.add(bar);

  const wheels: THREE.Object3D[] = [];
  for (const axle of ['front', 'front', 'rear', 'rear'] as const) {
    const wheel = buildWheel(CAR.wheel[axle].radius, CAR.wheel[axle].width);
    wheels.push(wheel);
    group.add(wheel);
  }

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

  // Only the upper *flank* points can be glass — indices 4 and 8, the two
  // shoulders of the section. The roof edge and centreline stay painted, which
  // is what gives a glass band wrapping the cabin under a body-colour roof.
  // Colouring by height alone turned the entire roof panel into a window.
  const GLASS_POINTS = new Set([4, 8]);

  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i]!;
    const outline = outlines[i]!;
    for (let j = 0; j < n; j++) {
      const p = outline[j]!;
      positions.push(p.x, p.y, s.z);
      const c = GLASS_POINTS.has(j) && p.y > s.belt ? glass : paint;
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
  const first = STATIONS[0]!;
  const capNose = positions.length / 3;
  positions.push(0, (first.yBottom + first.yTop) / 2, first.z);
  colors.push(paint.r, paint.g, paint.b);
  for (let j = 0; j < n; j++) indices.push(capNose, j, (j + 1) % n);

  const last = STATIONS[STATIONS.length - 1]!;
  const lastBase = (STATIONS.length - 1) * n;
  const capTail = positions.length / 3;
  positions.push(0, (last.yBottom + last.yTop) / 2, last.z);
  colors.push(paint.r, paint.g, paint.b);
  for (let j = 0; j < n; j++) indices.push(capTail, lastBase + ((j + 1) % n), lastBase + j);

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
    }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** Round headlight units set into the wing crowns, plus the low intakes. */
function buildLights(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];

  const lens = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xcfe0ff, emissiveIntensity: 5.5, roughness: 0.15,
  });
  const housing = new THREE.MeshStandardMaterial({ color: 0x0b0d11, roughness: 0.4 });

  // Set *into* the wing rather than sat on it: the housing is sunk back so the
  // body surface passes in front of its outer edge, which is what makes the
  // lamp read as recessed instead of stuck on.
  const lensGeo = new THREE.CylinderGeometry(0.105, 0.105, 0.10, 20);
  lensGeo.rotateX(Math.PI / 2);
  const ringGeo = new THREE.CylinderGeometry(0.135, 0.135, 0.14, 20);
  ringGeo.rotateX(Math.PI / 2);

  for (const sx of [-1, 1]) {
    const ring = new THREE.Mesh(ringGeo, housing);
    ring.position.set(sx * 0.58, 0.775, 1.94);
    out.push(ring);

    const light = new THREE.Mesh(lensGeo, lens);
    light.position.set(sx * 0.58, 0.775, 1.965);
    out.push(light);

    const intake = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.12, 0.07),
      new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.9 }),
    );
    intake.position.set(sx * 0.46, 0.40, 2.06);
    out.push(intake);
  }

  return out;
}

/** The GTS ducktail, sat on the engine deck. */
function buildSpoiler(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.50, 0.045, 0.34),
    new THREE.MeshStandardMaterial({
      color: CAR.paint.body,
      roughness: CAR.paint.roughness,
      metalness: CAR.paint.metalness,
    }),
  );
  mesh.position.set(0, 1.06, -1.72);
  mesh.rotation.x = -0.14;
  mesh.castShadow = true;
  return mesh;
}

function buildMirrors(): THREE.Object3D[] {
  const material = new THREE.MeshStandardMaterial({
    color: CAR.paint.body,
    roughness: CAR.paint.roughness,
    metalness: CAR.paint.metalness,
  });

  // The stalk has to physically reach the flank, or the mirror hangs in space.
  return [-1, 1].map((sx) => {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.07, 0.09), material);
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.045), material);
    stalk.position.x = -sx * 0.13;
    stalk.position.y = -0.015;
    g.add(shell, stalk);
    g.position.set(sx * 0.90, 0.925, 0.63);
    g.castShadow = true;
    return g;
  });
}

/** Rear diffuser and exhausts. */
function buildDiffuser(): THREE.Group {
  const g = new THREE.Group();

  const diffuser = new THREE.Mesh(
    new THREE.BoxGeometry(1.36, 0.15, 0.20),
    new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.85 }),
  );
  diffuser.position.set(0, 0.32, -2.14);
  g.add(diffuser);

  const pipeGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.12, 12);
  pipeGeo.rotateX(Math.PI / 2);
  const pipeMat = new THREE.MeshStandardMaterial({
    color: 0x8b9199, roughness: 0.25, metalness: 0.95,
  });
  for (const sx of [-1, 1]) {
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.position.set(sx * 0.28, 0.42, -2.22);
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

  const rimRadius = radius * 0.74;
  const rimGeo = new THREE.CylinderGeometry(rimRadius, rimRadius, width * 0.9, 24);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x767d88, roughness: 0.22, metalness: 0.95,
  });
  g.add(new THREE.Mesh(rimGeo, rimMat));

  // Five twin-spokes, pushed outboard so the wheel reads as dished.
  const spokeGeo = new THREE.BoxGeometry(0.03, rimRadius * 1.8, 0.055);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(spokeGeo, rimMat);
    spoke.rotation.x = (i / 5) * Math.PI;
    spoke.position.x = width * 0.32;
    g.add(spoke);
  }

  const discGeo = new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, 0.03, 20);
  discGeo.rotateZ(Math.PI / 2);
  g.add(new THREE.Mesh(
    discGeo,
    new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.35, metalness: 0.7 }),
  ));

  return g;
}
