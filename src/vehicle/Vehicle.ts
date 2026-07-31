import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CAR } from './CarConfig';
import type { DriveInput } from '../core/Input';

/** Wheel indices. Front wheels steer; rear wheels take the handbrake. */
const FL = 0, FR = 1, RL = 2, RR = 3;
const STEERED = [FL, FR];
const HANDBRAKED = [RL, RR];

const UP = new THREE.Vector3(0, 1, 0);
const AXLE = new THREE.Vector3(-1, 0, 0);

// Scratch objects — allocating inside the frame loop causes GC hitches.
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qSteer = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _scale = new THREE.Vector3(1, 1, 1);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class Vehicle {
  readonly group = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  /** Public so headlights and other car-mounted objects can be parented to it. */
  readonly chassisMesh: THREE.Group;

  private readonly world: RAPIER.World;
  private readonly controller: RAPIER.DynamicRayCastVehicleController;
  private readonly wheelMeshes: THREE.Mesh[] = [];

  /** Current smoothed steer angle in radians. */
  private steerAngle = 0;
  private spawn: THREE.Vector3;

  constructor(rapier: typeof RAPIER, world: RAPIER.World, spawn: THREE.Vector3) {
    this.world = world;
    this.spawn = spawn.clone();

    // --- Chassis rigid body ------------------------------------------------
    // The collider is created with zero density so that it contributes shape
    // but not mass; mass properties come from setAdditionalMassProperties so we
    // can place the centre of mass below the geometric centre.
    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(CAR.linearDamping)
      .setAngularDamping(CAR.angularDamping)
      .setAdditionalMassProperties(
        CAR.mass,
        CAR.centerOfMass,
        CAR.angularInertia,
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.body = world.createRigidBody(bodyDesc);

    const { x: hx, y: hy, z: hz } = CAR.halfExtents;
    world.createCollider(
      rapier.ColliderDesc.cuboid(hx, hy, hz).setDensity(0).setFriction(0.4).setRestitution(0.05),
      this.body,
    );

    // --- Vehicle controller ------------------------------------------------
    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1; // +Y is up
    // Not a typo: Rapier declares this setter as `set setIndexForwardAxis`,
    // while the matching getter is plain `indexForwardAxis`.
    this.controller.setIndexForwardAxis = 2; // +Z is forward

    const w = CAR.wheel;
    const wheelPositions: Array<[number, number, number]> = [
      [-w.halfTrack, w.connectionY, w.frontZ], // FL
      [w.halfTrack, w.connectionY, w.frontZ],  // FR
      [-w.halfTrack, w.connectionY, w.rearZ],  // RL
      [w.halfTrack, w.connectionY, w.rearZ],   // RR
    ];

    for (const [x, y, z] of wheelPositions) {
      this.controller.addWheel(
        { x, y, z },
        { x: 0, y: -1, z: 0 },  // suspension points down
        { x: -1, y: 0, z: 0 },  // axle along X
        CAR.suspension.restLength,
        w.radius,
      );
    }

    for (let i = 0; i < 4; i++) {
      const s = CAR.suspension;
      this.controller.setWheelSuspensionStiffness(i, s.stiffness);
      this.controller.setWheelSuspensionCompression(i, s.compression);
      this.controller.setWheelSuspensionRelaxation(i, s.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.controller.setWheelMaxSuspensionForce(i, s.maxForce);
      this.controller.setWheelFrictionSlip(i, CAR.grip.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(i, CAR.grip.sideFrictionStiffness);
    }

    // --- Visuals -----------------------------------------------------------
    this.chassisMesh = buildChassisMesh();
    this.group.add(this.chassisMesh);

    const wheelGeo = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 20);
    wheelGeo.rotateZ(Math.PI / 2); // align the cylinder axis with X (the axle)
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.85, metalness: 0.1 });
    const rimGeo = new THREE.CylinderGeometry(w.radius * 0.55, w.radius * 0.55, w.width + 0.02, 12);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x8a93a6, roughness: 0.35, metalness: 0.8 });

    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(wheelGeo, wheelMat);
      mesh.castShadow = true;
      mesh.add(new THREE.Mesh(rimGeo, rimMat));
      this.wheelMeshes.push(mesh);
      this.group.add(mesh);
    }

    this.syncMeshes();
  }

  /** Forward speed in m/s. Negative when reversing. */
  get speed(): number {
    return this.controller.currentVehicleSpeed();
  }

  get position(): RAPIER.Vector {
    return this.body.translation();
  }

  /** True if at least one wheel is touching the ground. */
  get grounded(): boolean {
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) return true;
    return false;
  }

  update(input: DriveInput, dt: number): void {
    this.applySteering(input, dt);
    this.applyDrive(input);
    this.controller.updateVehicle(dt);
  }

  /** Must be called after `world.step()` to pick up the new transforms. */
  syncMeshes(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    _v.set(t.x, t.y, t.z);
    _q.set(r.x, r.y, r.z, r.w);
    _mat.compose(_v, _q, _scale);

    this.chassisMesh.position.copy(_v);
    this.chassisMesh.quaternion.copy(_q);

    for (let i = 0; i < 4; i++) {
      const conn = this.controller.wheelChassisConnectionPointCs(i);
      const dir = this.controller.wheelDirectionCs(i);
      if (!conn || !dir) continue;
      const susp = this.controller.wheelSuspensionLength(i) ?? CAR.suspension.restLength;

      const mesh = this.wheelMeshes[i]!;
      mesh.position
        .set(conn.x + dir.x * susp, conn.y + dir.y * susp, conn.z + dir.z * susp)
        .applyMatrix4(_mat);

      _qSteer.setFromAxisAngle(UP, this.controller.wheelSteering(i) ?? 0);
      _qSpin.setFromAxisAngle(AXLE, this.controller.wheelRotation(i) ?? 0);
      mesh.quaternion.copy(_q).multiply(_qSteer).multiply(_qSpin);
    }
  }

  /** Drop the car back at the spawn point, upright and stationary. */
  reset(at?: THREE.Vector3): void {
    const p = at ?? this.spawn;
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
  }

  setSpawn(p: THREE.Vector3): void {
    this.spawn.copy(p);
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
  }

  // -------------------------------------------------------------------------

  /**
   * Steering authority falls off with speed, otherwise the car is undriveable
   * at anything above walking pace. The angle is also rate-limited rather than
   * snapping, which is most of what makes keyboard steering feel analogue.
   */
  private applySteering(input: DriveInput, dt: number): void {
    const st = CAR.steering;
    const speedT = clamp(Math.abs(this.speed) / st.speedForMinAngle, 0, 1);
    const maxAngle = THREE.MathUtils.lerp(st.maxAngle, st.minAngle, speedT);

    const target = input.steer * maxAngle;
    const rate = input.steer === 0 ? st.returnRate : st.rate;
    const step = rate * maxAngle * dt;
    this.steerAngle += clamp(target - this.steerAngle, -step, step);

    for (const i of STEERED) this.controller.setWheelSteering(i, this.steerAngle);
  }

  private applyDrive(input: DriveInput): void {
    const d = CAR.drive;
    const speed = this.speed;
    // Engine force tapers to zero at top speed to give a natural speed limit
    // rather than an abrupt clamp.
    const headroom = clamp(1 - Math.abs(speed) / d.maxSpeed, 0, 1);

    let engineForce = 0;
    let brake = 0;

    if (input.throttle > 0) {
      // Pressing forward while rolling backwards should brake, not accelerate.
      if (speed < -0.5) brake = d.brakeForce;
      else engineForce = d.engineForce * headroom * input.throttle;
    } else if (input.throttle < 0) {
      if (speed > 0.5) brake = d.brakeForce;
      else engineForce = -d.reverseForce * headroom;
    } else {
      brake = d.engineBrake;
    }

    for (let i = 0; i < 4; i++) {
      this.controller.setWheelEngineForce(i, engineForce);
      this.controller.setWheelBrake(i, brake);
    }

    // The handbrake locks the rear wheels and drops their grip in both axes,
    // which is what lets the back end step out into a slide. Cutting only the
    // lateral grip is not enough: the rear tyres keep gripping longitudinally
    // and the car just stops in a straight line.
    const g = CAR.grip;
    for (const i of HANDBRAKED) {
      this.controller.setWheelSideFrictionStiffness(
        i, input.handbrake ? g.handbrakeSideFriction : g.sideFrictionStiffness,
      );
      this.controller.setWheelFrictionSlip(
        i, input.handbrake ? g.handbrakeFrictionSlip : g.frictionSlip,
      );
      if (input.handbrake) {
        this.controller.setWheelBrake(i, d.handbrakeForce);
        this.controller.setWheelEngineForce(i, 0);
      }
    }
  }
}

/** A blocky but readable car silhouette, styled for the night/neon look. */
function buildChassisMesh(): THREE.Group {
  const g = new THREE.Group();
  const { x: hx, y: hy, z: hz } = CAR.halfExtents;

  const paint = new THREE.MeshStandardMaterial({ color: 0x1b2535, roughness: 0.32, metalness: 0.65 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x05080f, roughness: 0.08, metalness: 0.9,
  });

  const lower = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 1.5, hz * 2), paint);
  lower.position.y = -hy * 0.2;
  lower.castShadow = true;
  g.add(lower);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.72, hy * 1.15, hz * 1.02), glass);
  cabin.position.set(0, hy * 0.92, -hz * 0.12);
  cabin.castShadow = true;
  g.add(cabin);

  // Headlights and tail lights are emissive so bloom picks them up later.
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xbfd8ff, emissiveIntensity: 4,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff2233, emissive: 0xff1a2b, emissiveIntensity: 3,
  });
  const lampGeo = new THREE.BoxGeometry(0.34, 0.16, 0.08);

  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(lampGeo, headMat);
    head.position.set(sx * hx * 0.62, 0, hz + 0.02);
    g.add(head);

    const tail = new THREE.Mesh(lampGeo, tailMat);
    tail.position.set(sx * hx * 0.62, 0.05, -hz - 0.02);
    g.add(tail);
  }

  return g;
}
