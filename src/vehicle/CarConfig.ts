/**
 * Porsche 911 GTS (992.2) — dimensions, mass and handling.
 *
 * Real numbers where they exist: 4,542 mm long, 1,900 mm wide (GTS wide-body),
 * 1,297 mm tall, 2,450 mm wheelbase, ~1,570 kg, staggered 20" front / 21" rear
 * wheels. Handling is tuned toward that car's character — rear weight bias,
 * rear-wheel drive, eager turn-in — but arcade-legible rather than simulation
 * accurate.
 *
 * Phase 0 of this project was "make the car feel good", and these values are
 * meant to be edited constantly. `npm run test:vehicle` measures the result.
 *
 * Units are SI: metres, kilograms, newtons, radians, seconds.
 */
export const CAR = {
  name: 'Porsche 911 GTS',

  // ---- Chassis -----------------------------------------------------------
  /** Half-extents of the collider box (x = half width, y = half height, z = half length). */
  halfExtents: { x: 0.95, y: 0.42, z: 2.27 },
  mass: 1570,
  /**
   * Centre of mass. Low, and *behind* the centreline: a 911 carries its engine
   * out past the rear axle and runs roughly 39/61 front/rear. That rear bias is
   * the whole personality of the car — it turns in hard and rotates on lift.
   */
  centerOfMass: { x: 0, y: -0.30, z: -0.27 },
  /** Yaw (y) is set below the physical value so the car rotates eagerly. */
  angularInertia: { x: 1750, y: 1280, z: 640 },
  linearDamping: 0.05,
  angularDamping: 0.5,

  // ---- Wheels ------------------------------------------------------------
  /**
   * Staggered, as on the real car: 245/35 R20 front, 315/30 R21 rear. The wider
   * rear is not just cosmetic here — it is why the car puts down rear-drive
   * power without spinning up.
   */
  wheel: {
    front: { radius: 0.35, width: 0.245 },
    rear: { radius: 0.365, width: 0.315 },
    halfTrackFront: 0.80,
    halfTrackRear: 0.785,
    frontZ: 1.225,
    rearZ: -1.225,
    connectionY: -0.06,
  },

  // ---- Suspension --------------------------------------------------------
  suspension: {
    restLength: 0.30,
    /** Stiff, like a sports car. Too stiff and it skitters over Vancouver's crowns. */
    stiffness: 38,
    compression: 0.88,
    relaxation: 0.92,
    maxTravel: 0.22,
    maxForce: 70_000,
  },

  // ---- Grip --------------------------------------------------------------
  grip: {
    frictionSlip: 2.5,
    /**
     * The rears run 315-section tyres against 245 at the front, and they are
     * the driven axle. Giving them more grip is both physically honest and what
     * lets a rear-drive car put its power down instead of lighting them up.
     */
    rearFrictionSlip: 3.1,
    sideFrictionStiffness: 0.95,
    /** Rear grip while the handbrake is down, in both axes. */
    handbrakeSideFriction: 0.3,
    handbrakeFrictionSlip: 1.05,
  },

  // ---- Drivetrain --------------------------------------------------------
  drive: {
    /** Rear-wheel drive, as a GTS should be. */
    layout: 'rwd' as 'rwd' | 'awd',
    /** Peak force per driven wheel. Only the rears are driven. */
    engineForce: 8600,
    reverseForce: 2200,
    brakeForce: 52,
    handbrakeForce: 62,
    engineBrake: 3.8,
    /** Speed (m/s) at which engine force reaches zero. ~290 km/h. */
    maxSpeed: 80,
  },

  // ---- Steering ----------------------------------------------------------
  steering: {
    maxAngle: 0.56,
    minAngle: 0.14,
    speedForMinAngle: 48,
    rate: 4.0,
    returnRate: 6.0,
  },

  // ---- Camera ------------------------------------------------------------
  camera: {
    offset: { x: 0, y: 2.25, z: -7.0 },
    lookAhead: 6.5,
    stiffness: 5.2,
    baseFov: 68,
    speedFov: 20,
  },

  // ---- Appearance --------------------------------------------------------
  paint: {
    /** GT Silver Metallic — reads well against a dark city. */
    body: 0x9aa3ab,
    roughness: 0.28,
    metalness: 0.85,
    /**
     * Dark, but not black. At 0x0a0d14 the greenhouse rendered as a hole in the
     * car rather than as glass — there was nothing left for a highlight to sit
     * on.
     */
    glass: 0x1b2432,
    trim: 0x14161a,
  },
} as const;

export type CarConfig = typeof CAR;
