import { CAR } from './CarConfig';

/**
 * Engine, gearbox and final drive.
 *
 * Applying a flat force scaled by speed produces motion but no *machine*: no
 * revs rising and falling, no torque peak to sit on, no shift interrupting the
 * pull. Deriving wheel force from engine RPM through a real gear ratio gives
 * all of that for very little code, and it makes the car diagnosable — a corner
 * exit that feels wrong can be read off the tacho as "bogged below the torque
 * peak" rather than guessed at.
 *
 * RPM is derived from road speed rather than integrated independently, which
 * keeps engine and wheels exactly consistent and cannot drift out of sync.
 */

export interface DrivetrainState {
  rpm: number;
  /** 1-based gear index; 0 is reverse. */
  gear: number;
  /** Tractive force per driven wheel, newtons. */
  forcePerWheel: number;
  /** True while a shift is in progress and drive is cut. */
  shifting: boolean;
  /** Fraction of redline, for a tacho. */
  revFraction: number;
}

export class Drivetrain {
  private gearIndex = 0;
  private shiftTimer = 0;
  private smoothedRpm = CAR.engine.idleRpm;

  /** Ratio of the currently selected gear. */
  private get ratio(): number {
    return CAR.transmission.gears[this.gearIndex] ?? 1;
  }

  /**
   * @param speed  forward road speed in m/s (signed)
   * @param throttle 0..1
   * @param reverse true when the driver is selecting reverse
   */
  update(speed: number, throttle: number, reverse: boolean, dt: number): DrivetrainState {
    const e = CAR.engine;
    const t = CAR.transmission;
    const radius = CAR.wheel.rear.radius;

    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    const effectiveRatio = reverse ? t.reverse : this.ratio;

    // Engine speed implied by road speed through the current ratio.
    const wheelRevsPerSec = Math.abs(speed) / (2 * Math.PI * radius);
    const rawRpm = wheelRevsPerSec * 60 * effectiveRatio * t.final;

    // Below the clutch bite the engine idles rather than stalling, which is
    // what lets the car pull away from rest at all.
    const clutched = Math.max(rawRpm, e.idleRpm + throttle * e.clutchRise);
    const target = Math.min(e.redlineRpm, clutched);

    // A little smoothing stands in for flywheel inertia.
    const blend = 1 - Math.exp(-12 * dt);
    this.smoothedRpm += (target - this.smoothedRpm) * blend;

    if (!reverse) this.selectGear(rawRpm, speed);

    let forcePerWheel = 0;
    if (this.shiftTimer <= 0 && throttle > 0) {
      const torque = this.torqueAt(this.smoothedRpm) * throttle;
      const wheelTorque = torque * effectiveRatio * t.final * t.efficiency;
      forcePerWheel = wheelTorque / radius / CAR.drive.drivenWheelCount;

      // Hard rev limiter: cut drive rather than let revs run away.
      if (this.smoothedRpm >= e.redlineRpm - 20) forcePerWheel *= 0.15;
    }

    return {
      rpm: this.smoothedRpm,
      gear: reverse ? 0 : this.gearIndex + 1,
      forcePerWheel,
      shifting: this.shiftTimer > 0,
      revFraction: this.smoothedRpm / e.redlineRpm,
    };
  }

  /**
   * Torque curve, normalised around the peak.
   *
   * Modelled as a rise off idle, a broad plateau, then a fall past peak power —
   * roughly the shape of a modern turbocharged flat-six.
   */
  private torqueAt(rpm: number): number {
    const e = CAR.engine;
    if (rpm < e.idleRpm * 0.5) return 0;
    const t = rpm / e.redlineRpm;

    let factor: number;
    if (t < 0.22) factor = 0.45 + (t / 0.22) * 0.55;   // spooling up
    else if (t < 0.78) factor = 1.0;                    // plateau
    else factor = Math.max(0.35, 1.0 - (t - 0.78) * 2.2); // past peak power

    return e.peakTorque * factor;
  }

  /** Simple automatic: shift up near the limiter, down when it would bog. */
  private selectGear(rawRpm: number, speed: number): void {
    const e = CAR.engine;
    const t = CAR.transmission;
    if (this.shiftTimer > 0) return;

    // Below walking pace always sit in first, or pulling away hunts gears.
    if (Math.abs(speed) < 1.5) {
      this.gearIndex = 0;
      return;
    }

    if (rawRpm > e.shiftUpRpm && this.gearIndex < t.gears.length - 1) {
      this.gearIndex++;
      this.shiftTimer = e.shiftTime;
    } else if (rawRpm < e.shiftDownRpm && this.gearIndex > 0) {
      this.gearIndex--;
      this.shiftTimer = e.shiftTime;
    }
  }

  reset(): void {
    this.gearIndex = 0;
    this.shiftTimer = 0;
    this.smoothedRpm = CAR.engine.idleRpm;
  }
}

/**
 * Total resistive force in newtons — aerodynamic drag plus rolling resistance —
 * clamped so it can never do more than bring the car to a stop this timestep.
 *
 * Drag alone is not enough. A raycast vehicle with a rearward centre of mass
 * sits very slightly nose-up, which tilts the suspension rays off vertical and
 * leaves them with a small horizontal component: the car creeps forward under
 * no power at all. Rolling resistance is the real-world term that cancels that,
 * and it is what a stationary car actually has.
 *
 * The clamp matters as much as the terms. Unclamped, a resistive force larger
 * than the remaining momentum reverses the car instead of stopping it, and it
 * oscillates.
 */
export function resistiveForce(speed: number, mass: number, dt: number): number {
  const a = CAR.aero;
  const v = Math.abs(speed);
  if (v < 1e-4) return 0;

  const drag = 0.5 * a.airDensity * a.dragCoefficient * a.frontalArea * v * v;
  const rolling = a.rollingResistance * mass * 9.81;

  // Force that would exactly arrest the car within this step.
  const arresting = (v * mass) / dt;
  return Math.min(drag + rolling, arresting);
}
