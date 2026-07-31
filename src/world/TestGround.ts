import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

const GROUND_SIZE = 600;

/**
 * A temporary tuning course for Phase 0: flat tarmac, ramps, a washboard
 * section and some solid obstacles.
 *
 * The point is to make suspension and grip problems *visible* while tuning
 * CarConfig, before any city geometry exists. This whole module is deleted
 * once the real Vancouver terrain lands in Phase 2.
 */
export function createTestGround(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  scene: THREE.Scene,
): void {
  const asphalt = new THREE.MeshStandardMaterial({
    map: makeGridTexture(),
    color: 0x2a2f3a,
    roughness: 0.72,
    metalness: 0.05,
  });

  // --- Ground slab ---------------------------------------------------------
  const slab = new THREE.Mesh(new THREE.BoxGeometry(GROUND_SIZE, 1, GROUND_SIZE), asphalt);
  slab.position.y = -0.5;
  slab.receiveShadow = true;
  scene.add(slab);

  const groundBody = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(
    rapier.ColliderDesc.cuboid(GROUND_SIZE / 2, 0.5, GROUND_SIZE / 2).setFriction(1.0),
    groundBody,
  );

  const solid = new THREE.MeshStandardMaterial({ color: 0x323a4a, roughness: 0.6, metalness: 0.15 });
  const neon = new THREE.MeshStandardMaterial({
    color: 0x101820, emissive: 0x27e0ff, emissiveIntensity: 2.2, roughness: 0.4,
  });

  // --- Ramps of increasing severity ---------------------------------------
  [8, 14, 22].forEach((deg, i) => {
    addBox(
      rapier, world, scene, solid,
      { x: 9, y: 0.6, z: 14 },
      { x: -34 + i * 26, y: 0, z: 60 },
      -THREE.MathUtils.degToRad(deg),
    );
  });

  // --- Washboard: reveals suspension bounce and damping problems -----------
  for (let i = 0; i < 14; i++) {
    addBox(
      rapier, world, scene, solid,
      { x: 7, y: 0.11, z: 0.55 },
      { x: 40, y: 0, z: -20 - i * 5 },
      0,
    );
  }

  // --- Obstacle pillars, lit so they read at night -------------------------
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    addBox(
      rapier, world, scene, i % 2 === 0 ? neon : solid,
      { x: 1.1, y: 3, z: 1.1 },
      { x: Math.cos(a) * 55 - 40, y: 3, z: Math.sin(a) * 55 - 60 },
      0,
    );
  }

  // --- Distance markers so speed is legible on an empty plane --------------
  const markerGeo = new THREE.BoxGeometry(0.4, 2.4, 0.4);
  const markerMat = new THREE.MeshStandardMaterial({
    color: 0x0b0f16, emissive: 0xff8a2b, emissiveIntensity: 1.8,
  });
  for (let z = -260; z <= 260; z += 20) {
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.position.set(sx * 11, 1.2, z);
      scene.add(m);
    }
  }
}

function addBox(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  scene: THREE.Scene,
  material: THREE.Material,
  half: { x: number; y: number; z: number },
  pos: { x: number; y: number; z: number },
  rotX: number,
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2), material);
  mesh.position.set(pos.x, pos.y, pos.z);
  mesh.rotation.x = rotX;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, 0, 0));
  const body = world.createRigidBody(
    rapier.RigidBodyDesc.fixed()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
  );
  world.createCollider(rapier.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(1.0), body);
}

/** Procedural grid so the eye has something to judge speed against. */
function makeGridTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#20242e';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#2e3542';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GROUND_SIZE / 8, GROUND_SIZE / 8);
  tex.anisotropy = 8;
  return tex;
}
