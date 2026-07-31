import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CAR } from './CarConfig';
import { buildCarModel } from './CarModel';
import type { DriveInput } from '../core/Input';

/** Wheel indices. Front wheels steer; rear wheels take drive and the handbrake. */
const FL = 0, FR = 1, RL = 2, RR = 3;
const STEERED = [FL, FR];
const HANDBRAKED = [RL, RR];
const REAR = [RL, RR];
const ALL = [FL, FR, RL, RR];

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
  private readonly wheelMeshes: THREE.Object3D[] = [];
  private readonly brakeLights: THREE.MeshStandardMaterial;

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
    // Staggered: the rears are both wider apart and larger in diameter.
    const wheelPositions: Array<[number, number, number, number]> = [
      [-w.halfTrackFront, w.connectionY, w.frontZ, w.front.radius], // FL
      [w.halfTrackFront, w.connectionY, w.frontZ, w.front.radius],  // FR
      [-w.halfTrackRear, w.connectionY, w.rearZ, w.rear.radius],    // RL
      [w.halfTrackRear, w.connectionY, w.rearZ, w.rear.radius],     // RR
    ];

    for (const [x, y, z, radius] of wheelPositions) {
      this.controller.addWheel(
        { x, y, z },
        { x: 0, y: -1, z: 0 },  // suspension points down
        { x: -1, y: 0, z: 0 },  // axle along X
        CAR.suspension.restLength,
        radius,
      );
    }

    for (let i = 0; i < 4; i++) {
      const s = CAR.suspension;
      this.controller.setWheelSuspensionStiffness(i, s.stiffness);
      this.controller.setWheelSuspensionCompression(i, s.compression);
      this.controller.setWheelSuspensionRelaxation(i, s.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.controller.setWheelMaxSuspensionForce(i, s.maxForce);
      this.controller.setWheelFrictionSlip(
        i, REAR.includes(i) ? CAR.grip.rearFrictionSlip : CAR.grip.frictionSlip,
      );
      this.controller.setWheelSideFrictionStiffness(i, CAR.grip.sideFrictionStiffness);
    }

    // --- Visuals -----------------------------------------------------------
    const model = buildCarModel();
    this.chassisMesh = model.group;
    this.brakeLights = model.brakeLights;
    this.group.add(this.chassisMesh);

    // Wheels are driven by the physics controller, so they are detached from
    // the body group and positioned in world space each frame.
    for (const wheel of model.wheels) {
      this.chassisMesh.remove(wheel);
      this.wheelMeshes.push(wheel);
      this.group.add(wheel);
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

    // Rear-wheel drive: only the rears get engine force, which is what gives
    // the car its throttle-on rotation. Brakes act on all four.
    const driven = d.layout === 'rwd' ? REAR : ALL;
    for (const i of ALL) {
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, brake);
    }
    for (const i of driven) {
      // With two driven wheels instead of four, each carries the full share.
      this.controller.setWheelEngineForce(i, engineForce);
    }

    // Brake lights respond to braking and to lifting off at speed.
    const braking = input.throttle < 0 || (input.handbrake && Math.abs(speed) > 1);
    this.brakeLights.emissiveIntensity = braking ? 9 : 2.4;

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
        i, input.handbrake ? g.handbrakeFrictionSlip : g.rearFrictionSlip,
      );
      if (input.handbrake) {
        this.controller.setWheelBrake(i, d.handbrakeForce);
        this.controller.setWheelEngineForce(i, 0);
      }
    }
  }
}
