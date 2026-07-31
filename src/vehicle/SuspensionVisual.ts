import * as THREE from 'three';
import { CAR } from './CarConfig';

/**
 * Visible coilover suspension — spring, damper, wishbone and upright.
 *
 * Watching a wheel move relative to the body tells you almost nothing: you see
 * the result, not the mechanism. A visible spring that compresses its coils, a
 * damper shaft that telescopes, and a wishbone that swings through its arc make
 * the loading legible at a glance — which corner is working, which is topped
 * out, how much travel is left.
 *
 * Everything lives in chassis-local space. The suspension attachment is fixed
 * to the body and the wheel travels straight down from it, so the assembly only
 * needs its length updated each frame, never a world-space rebuild.
 */

const SPRING_COILS = 7;
const SPRING_RADIUS = 0.075;
const SPRING_WIRE = 0.016;

/** Inboard pivot of the lower wishbone, as a fraction of half-track. */
const ARM_INBOARD = 0.28;

export interface SuspensionCorner {
  group: THREE.Group;
  update(suspensionLength: number, steerAngle: number): void;
}

/**
 * A unit-height helix, built once and scaled per frame.
 *
 * Scaling a coil spring along its axis is exactly what a real one does — the
 * coils close up — so this is both the cheapest and the most accurate option.
 */
function makeSpringGeometry(): THREE.TubeGeometry {
  const points: THREE.Vector3[] = [];
  const steps = SPRING_COILS * 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * SPRING_COILS * Math.PI * 2;
    points.push(new THREE.Vector3(
      Math.cos(angle) * SPRING_RADIUS,
      -t, // unit height; scaled to the live spring length
      Math.sin(angle) * SPRING_RADIUS,
    ));
  }
  return new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(points), steps, SPRING_WIRE, 6, false,
  );
}

const SPRING_GEOMETRY = makeSpringGeometry();

const MATERIALS = {
  spring: new THREE.MeshStandardMaterial({
    color: 0xd94b3a, roughness: 0.42, metalness: 0.65,
  }),
  damper: new THREE.MeshStandardMaterial({
    color: 0x2b3038, roughness: 0.35, metalness: 0.85,
  }),
  shaft: new THREE.MeshStandardMaterial({
    color: 0xc8ccd2, roughness: 0.12, metalness: 1.0,
  }),
  arm: new THREE.MeshStandardMaterial({
    color: 0x4a515c, roughness: 0.45, metalness: 0.8,
  }),
  upright: new THREE.MeshStandardMaterial({
    color: 0x6a727e, roughness: 0.35, metalness: 0.9,
  }),
};

/**
 * Builds one corner.
 *
 * @param side  -1 for left, +1 for right
 * @param halfTrack lateral position of the wheel centre
 */
export function buildSuspensionCorner(
  connection: { x: number; y: number; z: number },
  side: number,
  halfTrack: number,
): SuspensionCorner {
  const group = new THREE.Group();
  group.position.set(connection.x, connection.y, connection.z);

  // --- Coilover ------------------------------------------------------------
  const spring = new THREE.Mesh(SPRING_GEOMETRY, MATERIALS.spring);
  group.add(spring);

  // Damper body hangs from the top mount; the shaft slides inside it.
  const bodyGeo = new THREE.CylinderGeometry(0.032, 0.032, 1, 12);
  bodyGeo.translate(0, -0.5, 0); // origin at the top, extends downward
  const damperBody = new THREE.Mesh(bodyGeo, MATERIALS.damper);
  group.add(damperBody);

  const shaftGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 10);
  shaftGeo.translate(0, -0.5, 0);
  const shaft = new THREE.Mesh(shaftGeo, MATERIALS.shaft);
  group.add(shaft);

  // Top mount plate.
  const topMount = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.03, 12), MATERIALS.upright,
  );
  group.add(topMount);

  // --- Upright and wishbone ------------------------------------------------
  // These sit in the same local frame, so the arm's inboard pivot is toward
  // the car's centreline: negative on the right, positive on the left.
  const upright = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.20, 0.07), MATERIALS.upright,
  );
  group.add(upright);

  const armGeo = new THREE.BoxGeometry(1, 0.035, 0.075);
  armGeo.translate(0.5, 0, 0); // origin at the inboard pivot
  const lowerArm = new THREE.Mesh(armGeo, MATERIALS.arm);
  group.add(lowerArm);

  const inboardX = -side * halfTrack * ARM_INBOARD;

  const update = (length: number, steerAngle: number): void => {
    // The wheel centre sits `length` below the attachment point.
    const hubY = -length;

    spring.scale.y = Math.max(0.05, length);
    damperBody.scale.y = Math.max(0.05, length * 0.62);
    shaft.position.y = -length * 0.55;
    shaft.scale.y = Math.max(0.05, length * 0.5);

    upright.position.set(0, hubY, 0);
    upright.rotation.y = steerAngle;

    // The wishbone runs from its fixed inboard pivot out to the hub, so it
    // swings as the wheel rises and falls — the visible giveaway that the
    // suspension is articulating rather than the whole car moving.
    const pivotY = -CAR.suspension.restLength * 0.92;
    const dx = 0 - inboardX;
    const dy = hubY - pivotY;
    const armLength = Math.hypot(dx, dy);

    lowerArm.position.set(inboardX, pivotY, 0);
    lowerArm.scale.x = armLength;
    // Rotating about Z tips the arm in the car's transverse plane.
    lowerArm.rotation.z = Math.atan2(dy, dx) * (side >= 0 ? 1 : -1);
    if (side < 0) lowerArm.rotation.y = Math.PI;
  };

  update(CAR.suspension.restLength, 0);

  return { group, update };
}
