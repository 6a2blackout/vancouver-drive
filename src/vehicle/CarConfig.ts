/**
 * Every tunable that affects how the car feels, in one place.
 *
 * Phase 0 of this project is explicitly "make the car feel good on an empty
 * plane" — so these values are meant to be edited constantly. Keep them here
 * rather than scattered through Vehicle.ts.
 *
 * Units are SI: metres, kilograms, newtons, radians, seconds.
 */
export const CAR = {
  // ---- Chassis -----------------------------------------------------------
  /** Half-extents of the chassis collider box (x = half width, y = half height, z = half length). */
  halfExtents: { x: 0.9, y: 0.45, z: 2.2 },
  mass: 1250,
  /**
   * Centre of mass offset from the chassis centre. Pulling this *down* is the
   * single most effective anti-rollover measure for a raycast vehicle — without
   * it the car tips over in hard corners.
   */
  centerOfMass: { x: 0, y: -0.28, z: 0 },
  /**
   * Principal angular inertia. Roughly box-derived, but yaw (y) is deliberately
   * lowered below the physical value to make the car rotate into corners more
   * eagerly than a real one would.
   */
  angularInertia: { x: 1500, y: 1150, z: 620 },
  linearDamping: 0.06,
  angularDamping: 0.55,

  // ---- Wheels ------------------------------------------------------------
  wheel: {
    radius: 0.36,
    width: 0.25,
    /** Lateral distance from centreline to each wheel. */
    halfTrack: 0.82,
    frontZ: 1.45,
    rearZ: -1.35,
    /** Height of the suspension attachment point relative to chassis centre. */
    connectionY: -0.1,
  },

  // ---- Suspension --------------------------------------------------------
  suspension: {
    restLength: 0.35,
    stiffness: 32,
    /** Damping while compressing (hitting a bump). */
    compression: 0.85,
    /** Damping while extending (rebound). Slightly higher kills bounciness. */
    relaxation: 0.88,
    maxTravel: 0.28,
    maxForce: 60_000,
  },

  // ---- Grip --------------------------------------------------------------
  grip: {
    /** Longitudinal grip. Higher = harder acceleration without spin. */
    frictionSlip: 2.2,
    /** Lateral grip. Lower = slides more readily. This is the drift knob. */
    sideFrictionStiffness: 0.9,
    /**
     * Rear-axle grip while the handbrake is down. A locked, sliding tyre loses
     * grip in *both* directions — cutting only the lateral value leaves the rear
     * wheels still gripping longitudinally, and the car simply stops in a
     * straight line instead of rotating.
     */
    handbrakeSideFriction: 0.3,
    handbrakeFrictionSlip: 1.05,
  },

  // ---- Drivetrain --------------------------------------------------------
  drive: {
    /** Peak force per driven wheel. All four wheels are driven (AWD). */
    engineForce: 2400,
    /** Reverse is deliberately weaker than forward. */
    reverseForce: 1100,
    brakeForce: 42,
    /**
     * Enough to lock the rears, but deliberately well below `brakeForce`-scale
     * values: a very high number scrubs so much speed that the slide dies before
     * the player can steer through it.
     */
    handbrakeForce: 62,
    /** Light braking applied when coasting, so the car slows off-throttle. */
    engineBrake: 3.5,
    /** Speed (m/s) at which engine force has fallen to zero — the top speed. */
    maxSpeed: 62,
  },

  // ---- Steering ----------------------------------------------------------
  steering: {
    /** Maximum steer angle at a standstill. */
    maxAngle: 0.55,
    /** Maximum steer angle at or above `speedForMinAngle`. */
    minAngle: 0.16,
    /** Speed (m/s) at which steering authority bottoms out. */
    speedForMinAngle: 45,
    /** How fast the wheels turn toward the target angle (radians/second). */
    rate: 3.6,
    /** How fast they return to centre when no input is held. */
    returnRate: 5.5,
  },

  // ---- Camera ------------------------------------------------------------
  camera: {
    /** Chase camera offset in the car's local space (behind and above). */
    offset: { x: 0, y: 2.5, z: -7.2 },
    /** Look-at point offset, slightly ahead of the car. */
    lookAhead: 6.0,
    /** Position smoothing per second. Higher = stiffer, more locked-on. */
    stiffness: 5.0,
    baseFov: 68,
    /** Extra FOV at top speed, for a sense of acceleration. */
    speedFov: 18,
  },
} as const;

export type CarConfig = typeof CAR;
