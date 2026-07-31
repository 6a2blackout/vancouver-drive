import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * A suspension test facility, floating over Burrard Inlet north of downtown.
 *
 * Tuning suspension on city streets is slow: you have to find a bump, and the
 * bump you find is never the one you needed. This lays out every kind of input
 * a suspension can receive — single impacts, sustained ripple, articulation,
 * off-camber load, airtime — in parallel lanes you can drive at any speed and
 * repeat immediately.
 *
 * It sits over water so it is unmistakably not part of the city, but close
 * enough that the skyline is the backdrop. Reached with `T`.
 */

/** North of downtown, over Burrard Inlet. */
export const SANDBOX_ORIGIN = new THREE.Vector3(900, 12, -1600);

const PAD_WIDTH = 150;
const PAD_DEPTH = 190;
const PAD_THICKNESS = 2;

/** Lane spacing across the pad. */
const LANE = 15;

/**
 * The car's ground clearance, in metres: chassis origin at 0.653 m at rest,
 * collider half-height 0.42.
 *
 * Every obstacle here must stay comfortably below this. A 911 has very little
 * clearance, and anything taller does not test the suspension — it beaches the
 * car on its floor with all four wheels in the air, which is a different and
 * much less useful experience.
 */
const CLEARANCE = 0.233;
/** Tallest obstacle permitted, leaving room for suspension compression. */
const MAX_OBSTACLE = CLEARANCE * 0.78;

export interface Sandbox {
  /** Where the car lands when teleported here. */
  spawn: THREE.Vector3;
  group: THREE.Group;
}

interface Ctx {
  rapier: typeof RAPIER;
  world: RAPIER.World;
  group: THREE.Group;
  deck: THREE.MeshStandardMaterial;
  obstacle: THREE.MeshStandardMaterial;
  marker: THREE.MeshStandardMaterial;
}

export function createSandbox(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  scene: THREE.Scene,
): Sandbox {
  const group = new THREE.Group();
  group.name = 'sandbox';

  const ctx: Ctx = {
    rapier, world, group,
    deck: new THREE.MeshStandardMaterial({ color: 0x23272f, roughness: 0.85, metalness: 0.05 }),
    obstacle: new THREE.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.7, metalness: 0.1 }),
    marker: new THREE.MeshStandardMaterial({
      color: 0x0d1016, emissive: 0x2ee6ff, emissiveIntensity: 2.6, roughness: 0.4,
    }),
  };

  const o = SANDBOX_ORIGIN;

  // --- Deck ----------------------------------------------------------------
  addBox(ctx,
    { x: PAD_WIDTH / 2, y: PAD_THICKNESS / 2, z: PAD_DEPTH / 2 },
    { x: o.x, y: o.y - PAD_THICKNESS / 2, z: o.z },
    0, ctx.deck, 1.0);

  // Edge kerbs, so you notice the edge before you leave it.
  for (const sx of [-1, 1]) {
    addBox(ctx,
      { x: 0.5, y: 0.45, z: PAD_DEPTH / 2 },
      { x: o.x + sx * (PAD_WIDTH / 2 - 0.5), y: o.y + 0.45, z: o.z },
      0, ctx.marker, 1.0);
  }
  for (const sz of [-1, 1]) {
    addBox(ctx,
      { x: PAD_WIDTH / 2, y: 0.45, z: 0.5 },
      { x: o.x, y: o.y + 0.45, z: o.z + sz * (PAD_DEPTH / 2 - 0.5) },
      0, ctx.marker, 1.0);
  }

  // Lanes run along +Z, which is the car's forward axis with no rotation
  // applied. The spawn sits at the low-Z end so every obstacle is ahead of you;
  // laid out the other way, reversing off the pad is all you can do.
  const laneX = (n: number): number => o.x + n * LANE;
  const startZ = o.z - PAD_DEPTH / 2 + 22;

  buildWashboard(ctx, laneX(-3), startZ, o.y);
  buildArticulation(ctx, laneX(-2), startZ, o.y);
  buildSpeedBumps(ctx, laneX(-1), startZ, o.y);
  buildMoguls(ctx, laneX(0), startZ, o.y);
  buildJump(ctx, laneX(1), startZ, o.y);
  buildOffCamber(ctx, laneX(2), startZ, o.y);
  buildSlalom(ctx, laneX(3), startZ, o.y);
  buildStairs(ctx, laneX(4), startZ, o.y);

  scene.add(group);

  return {
    spawn: new THREE.Vector3(o.x, o.y + 1.2, o.z - PAD_DEPTH / 2 + 12),
    group,
  };
}

/**
 * Sustained ripple. Reveals damping problems: too little and the car floats
 * and never settles, too much and it hammers through and loses grip.
 */
function buildWashboard(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'washboard');
  for (let i = 0; i < 26; i++) {
    addBox(c,
      { x: 5.5, y: 0.05, z: 0.35 },
      { x, y: y + 0.05, z: z + 8 + i * 1.6 },
      0, c.obstacle, 1.0);
  }
}

/**
 * Alternating single-wheel lifts. This is the one to watch in orbit mode: each
 * block picks up one corner at a time, so you can see the suspension articulate
 * and the body roll independently of the wheels.
 */
function buildArticulation(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'articulation');
  for (let i = 0; i < 10; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    addBox(c,
      { x: 2.4, y: 0.07, z: 1.6 },
      { x: x + side * 2.6, y: y + 0.07, z: z + 10 + i * 6 },
      0, c.obstacle, 1.0);
  }
}

/** Clamps an obstacle so it can never beach the car on its floor. */
function capHeight(h: number): number {
  return Math.min(h, MAX_OBSTACLE);
}

/** Four impacts of increasing severity: 7, 11, 15 and 18 cm. */
function buildSpeedBumps(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'speed bumps');
  [0.07, 0.11, 0.15, 0.18].map(capHeight).forEach((h, i) => {
    const geo = new THREE.CylinderGeometry(h, h, 11, 16, 1, false, 0, Math.PI);
    geo.rotateZ(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, c.obstacle);
    mesh.position.set(x, y, z + 12 + i * 16);
    mesh.castShadow = true;
    c.group.add(mesh);

    // Collide against a box: a half-cylinder trimesh is needless precision for
    // something the wheels only ever touch on top.
    addCollider(c, { x: 5.5, y: h / 2, z: h }, { x, y: y + h / 2, z: z + 12 + i * 16 }, 0);
  });
}

/** Offset domes — diagonal loading, the hardest case for roll control. */
function buildMoguls(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'moguls');
  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -1.9 : 1.9;
    const r = 1.5;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 8), c.obstacle);
    mesh.position.set(x + side, y - r * 0.88, z + 10 + i * 4.5);
    mesh.castShadow = true;
    c.group.add(mesh);

    const body = c.world.createRigidBody(
      c.rapier.RigidBodyDesc.fixed().setTranslation(x + side, y - r * 0.88, z + 10 + i * 4.5),
    );
    c.world.createCollider(c.rapier.ColliderDesc.ball(r).setFriction(1.0), body);
  }
}

/** A ramp, and a landing far enough away to matter. */
function buildJump(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'jump');
  const angle = THREE.MathUtils.degToRad(11);
  addBox(c, { x: 5, y: 0.4, z: 7 }, { x, y: y + 0.32, z: z + 22 }, -angle, c.obstacle, 1.0);
  // Landing ramp, angled to receive the car rather than stop it dead.
  addBox(c, { x: 5, y: 0.4, z: 6 }, { x, y: y + 0.22, z: z + 46 }, angle * 0.6, c.obstacle, 1.0);
}

/** A long tilted section — sustained lateral load without steering input. */
function buildOffCamber(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'off-camber');
  // Sunk to deck level so the plate's low edge is only a few centimetres up:
  // sat on top of the deck instead, its leading edge is a wall the car simply
  // cannot climb.
  const tilt = THREE.MathUtils.degToRad(6);
  const halfWidth = 4;
  const halfThick = 0.5;

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2, halfThick * 2, 34), c.obstacle);
  mesh.position.set(x, y, z + 28);
  mesh.rotation.z = tilt;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.group.add(mesh);

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, tilt));
  const body = c.world.createRigidBody(
    c.rapier.RigidBodyDesc.fixed()
      .setTranslation(x, y, z + 28)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
  );
  c.world.createCollider(
    c.rapier.ColliderDesc.cuboid(halfWidth, halfThick, 17).setFriction(1.0), body,
  );
}

/** Cones for steering response and weight transfer. */
function buildSlalom(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'slalom');
  for (let i = 0; i < 9; i++) {
    const side = i % 2 === 0 ? -2.6 : 2.6;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.8, 12), c.marker);
    cone.position.set(x + side, y + 0.4, z + 10 + i * 8);
    c.group.add(cone);
    // Deliberately no collider: clipping a cone should cost you nothing but
    // pride, and knocking one flying would just interrupt the run.
  }
}

/** Square-edged steps up and back down — the harshest impact on the pad. */
function buildStairs(c: Ctx, x: number, z: number, y: number): void {
  lane(c, x, z, y, 'steps');
  const heights = [0.06, 0.11, 0.16, 0.11, 0.06].map(capHeight);
  heights.forEach((h, i) => {
    addBox(c, { x: 5.5, y: h / 2, z: 2.5 }, { x, y: y + h / 2, z: z + 14 + i * 6 }, 0, c.obstacle, 1.0);
  });
}

/** A dark strip marking each lane, with a lit gate at its entrance. */
function lane(c: Ctx, x: number, z: number, y: number, _label: string): void {
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(12, 0.02, PAD_DEPTH - 12),
    new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.9 }),
  );
  strip.position.set(x, y + 0.011, z + PAD_DEPTH / 2 - 20);
  strip.receiveShadow = true;
  c.group.add(strip);

  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.5, 0.22), c.marker);
    post.position.set(x + sx * 6, y + 0.75, z + 2);
    c.group.add(post);
  }
}

function addBox(
  c: Ctx,
  half: { x: number; y: number; z: number },
  pos: { x: number; y: number; z: number },
  rotX: number,
  material: THREE.Material,
  friction: number,
): void {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
    material,
  );
  mesh.position.set(pos.x, pos.y, pos.z);
  mesh.rotation.x = rotX;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.group.add(mesh);

  addCollider(c, half, pos, rotX, friction);
}

function addCollider(
  c: Ctx,
  half: { x: number; y: number; z: number },
  pos: { x: number; y: number; z: number },
  rotX: number,
  friction = 1.0,
): void {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, 0, 0));
  const body = c.world.createRigidBody(
    c.rapier.RigidBodyDesc.fixed()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
  );
  c.world.createCollider(
    c.rapier.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(friction),
    body,
  );
}
