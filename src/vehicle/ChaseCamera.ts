import * as THREE from 'three';
import { CAR } from './CarConfig';
import type { Vehicle } from './Vehicle';

export type CameraMode = 'chase' | 'hood' | 'wide' | 'orbit';
const MODES: CameraMode[] = ['chase', 'hood', 'wide', 'orbit'];

const OFFSETS: Record<CameraMode, THREE.Vector3> = {
  chase: new THREE.Vector3(CAR.camera.offset.x, CAR.camera.offset.y, CAR.camera.offset.z),
  hood: new THREE.Vector3(0, 1.05, 0.35),
  wide: new THREE.Vector3(0, 4.6, -12.5),
  orbit: new THREE.Vector3(0, 0, 0), // computed from spherical angles
};

/** Orbit camera limits. The close end is tight enough to fill frame with one wheel. */
const ORBIT = {
  minDistance: 2.2,
  maxDistance: 90,
  /** Radians per pixel of drag. */
  sensitivity: 0.005,
  /** Fraction of distance added per wheel notch. */
  zoomRate: 0.0016,
  minElevation: -0.35,
  maxElevation: 1.45,
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

  /** Orbit state, in world space so the view holds still while the car turns. */
  private azimuth = Math.PI;
  private elevation = 0.32;
  private distance = 9;
  /** Height above the car's origin that the orbit camera looks at. */
  private pivotHeight = 0.7;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  cycleMode(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    // Re-entering orbit should not inherit a stale smoothed position.
    if (this.mode === 'orbit') this.initialised = false;
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.initialised = false;
  }

  /**
   * Applies mouse input. Only meaningful in orbit mode.
   *
   * Angles are world-referenced rather than relative to the car's heading: when
   * you park the camera at a front wheel to watch the suspension, it should stay
   * pointed at that wheel as you drive, not swing around every time you steer.
   */
  applyMouse(dragX: number, dragY: number, wheel: number, dragging: boolean): void {
    if (this.mode !== 'orbit') return;

    if (dragging) {
      this.azimuth -= dragX * ORBIT.sensitivity;
      this.elevation = THREE.MathUtils.clamp(
        this.elevation + dragY * ORBIT.sensitivity,
        ORBIT.minElevation,
        ORBIT.maxElevation,
      );
    }
    if (wheel !== 0) {
      // Proportional zoom, so it is equally controllable near and far.
      this.distance = THREE.MathUtils.clamp(
        this.distance * (1 + wheel * ORBIT.zoomRate),
        ORBIT.minDistance,
        ORBIT.maxDistance,
      );
    }
  }

  /** Distance from the car, for the HUD. */
  get orbitDistance(): number {
    return this.distance;
  }

  update(vehicle: Vehicle, dt: number): void {
    const t = vehicle.body.translation();
    const r = vehicle.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);

    if (this.mode === 'orbit') {
      // Spherical offset in world space, pivoting on the car.
      const ce = Math.cos(this.elevation);
      _desired.set(
        t.x + this.distance * ce * Math.sin(this.azimuth),
        t.y + this.pivotHeight + this.distance * Math.sin(this.elevation),
        t.z + this.distance * ce * Math.cos(this.azimuth),
      );
      _look.set(t.x, t.y + this.pivotHeight, t.z);
    } else {
      _desired.copy(OFFSETS[this.mode]).applyQuaternion(_q).add(_look.set(t.x, t.y, t.z));
      _fwd.set(0, 0, 1).applyQuaternion(_q);
      _look.set(t.x, t.y + 0.8, t.z).addScaledVector(_fwd, CAR.camera.lookAhead);
    }

    if (!this.initialised) {
      this.position.copy(_desired);
      this.target.copy(_look);
      this.initialised = true;
    } else {
      // Hood is rigidly attached; orbit is nearly so, because lag while
      // inspecting suspension reads as the camera drifting rather than the
      // wheel moving — which defeats the whole purpose of the mode.
      const stiffness =
        this.mode === 'hood' ? 1e6 : this.mode === 'orbit' ? 26 : CAR.camera.stiffness;
      const a = 1 - Math.exp(-stiffness * dt);
      this.position.lerp(_desired, a);
      this.target.lerp(_look, Math.min(1, a * 1.6));
    }

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);

    // Speed FOV would fight against manual zoom, so orbit keeps a fixed lens.
    const speedT = this.mode === 'orbit'
      ? 0
      : Math.min(Math.abs(vehicle.speed) / CAR.drive.maxSpeed, 1);
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
