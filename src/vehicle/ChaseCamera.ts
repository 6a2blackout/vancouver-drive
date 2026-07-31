import * as THREE from 'three';
import { CAR } from './CarConfig';
import type { Vehicle } from './Vehicle';

export type CameraMode = 'chase' | 'hood' | 'wide';
const MODES: CameraMode[] = ['chase', 'hood', 'wide'];

const OFFSETS: Record<CameraMode, THREE.Vector3> = {
  chase: new THREE.Vector3(CAR.camera.offset.x, CAR.camera.offset.y, CAR.camera.offset.z),
  hood: new THREE.Vector3(0, 1.25, 0.6),
  wide: new THREE.Vector3(0, 4.6, -12.5),
};

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Follow camera with exponential smoothing and speed-driven FOV.
 *
 * The smoothing is frame-rate independent (`1 - exp(-k·dt)`) rather than a raw
 * lerp factor, so the feel does not change between a 60 Hz and a 144 Hz display.
 */
export class ChaseCamera {
  mode: CameraMode = 'chase';
  private readonly camera: THREE.PerspectiveCamera;
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  cycleMode(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    return this.mode;
  }

  update(vehicle: Vehicle, dt: number): void {
    const t = vehicle.body.translation();
    const r = vehicle.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);

    _desired.copy(OFFSETS[this.mode]).applyQuaternion(_q).add(_look.set(t.x, t.y, t.z));
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _look.set(t.x, t.y + 0.8, t.z).addScaledVector(_fwd, CAR.camera.lookAhead);

    if (!this.initialised) {
      this.position.copy(_desired);
      this.target.copy(_look);
      this.initialised = true;
    } else {
      // The hood camera is rigidly attached; smoothing it would make it swim.
      const stiffness = this.mode === 'hood' ? 1e6 : CAR.camera.stiffness;
      const a = 1 - Math.exp(-stiffness * dt);
      this.position.lerp(_desired, a);
      this.target.lerp(_look, Math.min(1, a * 1.6));
    }

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);

    const speedT = Math.min(Math.abs(vehicle.speed) / CAR.drive.maxSpeed, 1);
    const fov = CAR.camera.baseFov + CAR.camera.speedFov * speedT * speedT;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Snap instantly, e.g. after the car is reset. */
  snap(): void {
    this.initialised = false;
  }
}
