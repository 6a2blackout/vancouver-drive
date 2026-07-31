/**
 * Headless vehicle harness — `npx tsx tools/test-vehicle.ts`
 *
 * Phase 0 of this project is "make the car feel good", which is subjective, but
 * most of what makes a car feel wrong is measurable: it sits too low, it takes
 * 30 seconds to reach 100, it cannot turn, it flips in a corner. This runs the
 * real Vehicle class against real Rapier physics with no renderer and prints
 * those numbers, so CarConfig can be tuned against evidence instead of vibes.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/Vehicle';
import { CAR } from '../src/vehicle/CarConfig';
import type { DriveInput } from '../src/core/Input';

const DT = 1 / 60;
const COAST: DriveInput = { throttle: 0, steer: 0, handbrake: false };

function makeWorld(): { world: RAPIER.World; vehicle: Vehicle } {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setFriction(1.0), ground);

  const vehicle = new Vehicle(RAPIER, world, new THREE.Vector3(0, 1.2, 0));
  return { world, vehicle };
}

function step(world: RAPIER.World, vehicle: Vehicle, input: DriveInput, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    vehicle.update(input, DT);
    world.step();
  }
}

/** Settle the car under gravity and report its resting stance. */
function testRestStance(): void {
  const { world, vehicle } = makeWorld();
  step(world, vehicle, COAST, 3);

  const heights: number[] = [];
  for (let i = 0; i < 120; i++) {
    vehicle.update(COAST, DT);
    world.step();
    heights.push(vehicle.position.y);
  }
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;

  const r = vehicle.body.rotation();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
    new THREE.Quaternion(r.x, r.y, r.z, r.w),
  );

  console.log('\n── Rest stance ─────────────────────────────');
  console.log(`  ride height     ${mean.toFixed(3)} m  (chassis centre above ground)`);
  console.log(`  settle jitter   ${((max - min) * 1000).toFixed(2)} mm peak-to-peak`);
  console.log(`  upright         ${up.y > 0.999 ? 'yes' : `NO (up.y=${up.y.toFixed(3)})`}`);
  console.log(`  wheels grounded ${vehicle.grounded ? 'yes' : 'NO'}`);
  const verdict = max - min < 0.004 && up.y > 0.999 && vehicle.grounded;
  console.log(`  → ${verdict ? 'OK — sits stable and level' : 'PROBLEM — unstable or airborne'}`);
}

/** Full throttle from a standstill: 0-100 km/h and terminal speed. */
function testAcceleration(): void {
  const { world, vehicle } = makeWorld();
  step(world, vehicle, COAST, 1.5); // settle first

  const full: DriveInput = { throttle: 1, steer: 0, handbrake: false };
  let t = 0;
  let time100 = Infinity;
  let peak = 0;

  for (let i = 0; i < 60 * 45; i++) {
    vehicle.update(full, DT);
    world.step();
    t += DT;
    const kmh = Math.abs(vehicle.speed) * 3.6;
    peak = Math.max(peak, kmh);
    if (kmh >= 100 && time100 === Infinity) time100 = t;
  }

  console.log('\n── Acceleration ────────────────────────────');
  console.log(`  0-100 km/h      ${time100 === Infinity ? 'never reached' : time100.toFixed(2) + ' s'}`);
  console.log(`  top speed       ${peak.toFixed(1)} km/h  (config cap ${(CAR.drive.maxSpeed * 3.6).toFixed(0)})`);
  const ok = time100 < 12 && peak > 90;
  console.log(`  → ${ok ? 'OK — pulls convincingly' : 'PROBLEM — underpowered'}`);
}

/** Braking distance from 100 km/h. */
function testBraking(): void {
  const { world, vehicle } = makeWorld();
  step(world, vehicle, COAST, 1.5);

  const full: DriveInput = { throttle: 1, steer: 0, handbrake: false };
  for (let i = 0; i < 60 * 45 && Math.abs(vehicle.speed) * 3.6 < 100; i++) {
    vehicle.update(full, DT);
    world.step();
  }

  const startZ = vehicle.position.z;
  const startKmh = Math.abs(vehicle.speed) * 3.6;
  const brake: DriveInput = { throttle: -1, steer: 0, handbrake: false };
  let t = 0;
  for (let i = 0; i < 60 * 20 && Math.abs(vehicle.speed) > 0.4; i++) {
    vehicle.update(brake, DT);
    world.step();
    t += DT;
  }
  const dist = Math.abs(vehicle.position.z - startZ);

  console.log('\n── Braking ─────────────────────────────────');
  console.log(`  from            ${startKmh.toFixed(0)} km/h`);
  console.log(`  distance        ${dist.toFixed(1)} m in ${t.toFixed(2)} s`);
  console.log(`  → ${dist > 5 && dist < 120 ? 'OK — stops in a believable distance' : 'PROBLEM — check brakeForce'}`);
}

/**
 * Turning circle at walking pace, plus a rollover check at speed.
 *
 * Manufacturers quote turning circles at crawling speed on full lock, and so
 * does this: at full throttle the car simply accelerates until speed-sensitive
 * steering washes the angle out, which measures power rather than geometry.
 * Throttle is therefore modulated to hold a constant crawl.
 */
function testCornering(): void {
  const TARGET_MS = 4.2; // ~15 km/h

  // --- Low-speed turning circle -------------------------------------------
  const { world, vehicle } = makeWorld();
  step(world, vehicle, COAST, 1.5);

  let maxX = -Infinity, minX = Infinity, maxZ = -Infinity, minZ = Infinity;
  for (let i = 0; i < 60 * 30; i++) {
    const throttle = vehicle.speed < TARGET_MS ? 0.35 : 0;
    vehicle.update({ throttle, steer: 1, handbrake: false }, DT);
    world.step();
    // Sample only once it has settled into a steady circle.
    if (i > 60 * 10) {
      const p = vehicle.position;
      maxX = Math.max(maxX, p.x); minX = Math.min(minX, p.x);
      maxZ = Math.max(maxZ, p.z); minZ = Math.min(minZ, p.z);
    }
  }
  const diameter = Math.max(maxX - minX, maxZ - minZ);

  // --- Rollover resistance at speed ---------------------------------------
  const fast = makeWorld();
  step(fast.world, fast.vehicle, COAST, 1.5);
  const full: DriveInput = { throttle: 1, steer: 0, handbrake: false };
  for (let i = 0; i < 60 * 30 && Math.abs(fast.vehicle.speed) * 3.6 < 90; i++) {
    fast.vehicle.update(full, DT);
    fast.world.step();
  }
  let minUpY = 1;
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3();
  for (let i = 0; i < 60 * 8; i++) {
    fast.vehicle.update({ throttle: 0.4, steer: 1, handbrake: false }, DT);
    fast.world.step();
    const r = fast.vehicle.body.rotation();
    up.set(0, 1, 0).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
    minUpY = Math.min(minUpY, up.y);
  }

  console.log('\n── Cornering ───────────────────────────────');
  console.log(`  turning circle  ${diameter.toFixed(1)} m at ${(TARGET_MS * 3.6).toFixed(0)} km/h, full lock`);
  console.log(`  min upright     ${minUpY.toFixed(3)} entering a corner at 90 km/h`);
  console.log(`  rolled over     ${minUpY < 0.2 ? 'YES' : 'no'}`);
  // A 911's real turning circle is about 11 m; allow arcade latitude.
  const ok = minUpY > 0.55 && diameter > 8 && diameter < 20;
  console.log(`  → ${ok ? 'OK — turns tightly and stays flat' : 'PROBLEM — circle too wide, or rolls'}`);
}

/**
 * The handbrake should measurably loosen the rear end.
 *
 * This has to be a realistic handbrake turn: build speed in a straight line
 * first, *then* yank the handbrake while steering. Applying it from a standstill
 * just stops the car and measures nothing.
 */
function testHandbrake(): void {
  const ENTRY_KMH = 60;

  const q = new THREE.Quaternion();
  const fwd = new THREE.Vector3();

  /** Angle between where the car points and where it is actually going. */
  const slipAngle = (vehicle: Vehicle): number => {
    const r = vehicle.body.rotation();
    fwd.set(0, 0, 1).applyQuaternion(q.set(r.x, r.y, r.z, r.w));
    const v = vehicle.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    if (speed < 3) return 0;
    const cos = (fwd.x * v.x + fwd.z * v.z) / speed;
    return Math.acos(Math.min(1, Math.abs(cos)));
  };

  const measure = (handbrake: boolean) => {
    const { world, vehicle } = makeWorld();
    step(world, vehicle, COAST, 1.5);

    // Build entry speed straight ahead.
    const full: DriveInput = { throttle: 1, steer: 0, handbrake: false };
    for (let i = 0; i < 60 * 30 && Math.abs(vehicle.speed) * 3.6 < ENTRY_KMH; i++) {
      vehicle.update(full, DT);
      world.step();
    }

    // Initiate: full lock, briefly, with or without the handbrake.
    const turn: DriveInput = { throttle: 0.15, steer: 1, handbrake };
    let peakYaw = 0;
    for (let i = 0; i < Math.round(0.8 / DT); i++) {
      vehicle.update(turn, DT);
      world.step();
      peakYaw = Math.max(peakYaw, Math.abs(vehicle.body.angvel().y));
    }
    const initiated = slipAngle(vehicle);
    const speedAtRelease = Math.abs(vehicle.speed);

    // Recover: release the handbrake, straighten up, feed in throttle.
    const recover: DriveInput = { throttle: 0.3, steer: 0, handbrake: false };
    let settled = Infinity;
    let t = 0;
    for (let i = 0; i < 60 * 3; i++) {
      vehicle.update(recover, DT);
      world.step();
      t += DT;
      // Only count it as recovered while still genuinely moving — slipAngle is
      // undefined at low speed, so a car that simply stopped would otherwise
      // register as a clean save.
      if (settled === Infinity && Math.abs(vehicle.speed) > 5 && slipAngle(vehicle) < 0.17) {
        settled = t;
      }
    }
    return {
      peakYaw, initiated, settled,
      speedAtRelease,
      finalSlip: slipAngle(vehicle),
      finalSpeed: Math.abs(vehicle.speed),
    };
  };

  const normal = measure(false);
  const pulled = measure(true);
  const deg = (r: number) => (r * 180) / Math.PI;

  console.log('\n── Handbrake turn ──────────────────────────');
  console.log(`  entry speed     ${ENTRY_KMH} km/h, 0.8 s of full lock`);
  console.log(`  peak yaw rate   ${normal.peakYaw.toFixed(2)} → ${pulled.peakYaw.toFixed(2)} rad/s`);
  console.log(`  slip at release ${deg(normal.initiated).toFixed(1)}° → ${deg(pulled.initiated).toFixed(1)}°`);
  console.log(
    `  speed retained  ${(normal.speedAtRelease * 3.6).toFixed(0)} → ` +
    `${(pulled.speedAtRelease * 3.6).toFixed(0)} km/h at release, ` +
    `${(pulled.finalSpeed * 3.6).toFixed(0)} km/h after recovery`,
  );
  console.log(
    `  recovers in     ${pulled.settled === Infinity
      ? `never (still ${deg(pulled.finalSlip).toFixed(0)}° after 3 s)`
      : pulled.settled.toFixed(2) + ' s'}`,
  );

  const breaksTraction = pulled.initiated > normal.initiated * 1.3 && deg(pulled.initiated) > 12;
  const catchable = pulled.settled < 2.0;
  const verdict = !breaksTraction
    ? 'PROBLEM — handbrake does not break traction'
    : !catchable
      ? 'PROBLEM — slide is unrecoverable once started'
      : 'OK — rear steps out and the slide can be caught';
  console.log(`  → ${verdict}`);
}

async function main(): Promise<void> {
  await RAPIER.init();
  console.log('Vehicle harness — Rapier raycast vehicle, no renderer');
  console.log(`mass ${CAR.mass} kg · engine ${CAR.drive.engineForce} N/wheel · grip ${CAR.grip.frictionSlip}`);
  testRestStance();
  testAcceleration();
  testBraking();
  testCornering();
  testHandbrake();
  console.log('');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
