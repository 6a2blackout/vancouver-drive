import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { createStage, createHeadlights, followMoon } from './render/Renderer';
import { Lighting } from './render/Lighting';
import { Input } from './core/Input';
import { Vehicle } from './vehicle/Vehicle';
import { CAR } from './vehicle/CarConfig';
import { ChaseCamera } from './vehicle/ChaseCamera';
import { createTestGround } from './world/TestGround';
import { loadWorld } from './world/Terrain';
import { createSandbox } from './world/Sandbox';
import { Hud } from './ui/Hud';

/** Physics runs on a fixed step so handling is identical on every display. */
const FIXED_DT = 1 / 60;
/** Cap on catch-up work after a stall (e.g. a background tab). */
const MAX_FRAME_TIME = 0.1;
const MAX_STEPS_PER_FRAME = 5;
/** Below this height the car has fallen out of the world. */
const VOID_Y = -30;

async function main(): Promise<void> {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  const stage = createStage();
  const input = new Input();
  const hud = new Hud();

  // Starts at 'dusk': until buildings and street lamps exist there is nothing
  // emissive in the world, so full night would show an almost black screen.
  const lighting = new Lighting(stage.scene, stage.renderer, stage.moon, 'dusk');

  // Load the real city if it has been generated; otherwise fall back to the
  // Phase 0 tuning course so the project still runs on a fresh clone.
  let spawn = new THREE.Vector3(0, 1.2, 0);
  let loaded: Awaited<ReturnType<typeof loadWorld>> | null = null;
  try {
    loaded = await loadWorld(RAPIER, world, stage.scene);
    const s = loaded.manifest.spawn;
    spawn = new THREE.Vector3(s.x, loaded.heightmap.sample(s.x, s.z) + 1.5, s.z);
    console.log(
      `Vancouver loaded: ${loaded.manifest.bounds.width.toFixed(0)} x ` +
      `${loaded.manifest.bounds.depth.toFixed(0)} m, spawn at ${spawn.y.toFixed(1)} m elevation` +
      (loaded.roads ? `, ${loaded.manifest.roads.lengthKm.toFixed(0)} km of road` : '') +
      (loaded.buildings ? `, ${loaded.manifest.buildings?.count.toLocaleString()} buildings` : ''),
    );
  } catch (e) {
    console.warn(`${e instanceof Error ? e.message : e}\nFalling back to the test course.`);
    createTestGround(RAPIER, world, stage.scene);
  }

  const vehicle = new Vehicle(RAPIER, world, spawn);
  stage.scene.add(vehicle.group);
  const headlights = createHeadlights();
  vehicle.chassisMesh.add(headlights.group);
  for (const light of headlights.lights) lighting.registerHeadlight(light);

  const camera = new ChaseCamera(stage.camera);

  // Suspension test facility, always built so `T` works instantly.
  const sandbox = createSandbox(RAPIER, world, stage.scene);
  const citySpawn = spawn.clone();
  let inSandbox = false;

  let accumulator = 0;
  let last = performance.now();
  const _lightTarget = new THREE.Vector3();
  Hud.hideLoading();

  function frame(now: number): void {
    requestAnimationFrame(frame);

    const frameTime = Math.min((now - last) / 1000, MAX_FRAME_TIME);
    last = now;

    if (input.wasPressed('KeyR')) {
      vehicle.reset();
      camera.snap();
    }
    if (input.wasPressed('KeyC')) camera.cycleMode();
    if (input.wasPressed('KeyL')) lighting.cycle();

    // T teleports between the city and the suspension pad, and switches to
    // orbit on arrival — the pad exists to be watched, not just driven.
    if (input.wasPressed('KeyT')) {
      inSandbox = !inSandbox;
      vehicle.setSpawn(inSandbox ? sandbox.spawn : citySpawn);
      vehicle.reset();
      if (inSandbox && camera.mode !== 'orbit') camera.setMode('orbit');
      camera.snap();
    }

    const mouse = input.readMouse();
    camera.applyMouse(mouse.dragX, mouse.dragY, mouse.wheel, mouse.dragging);

    const drive = input.read();

    accumulator += frameTime;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      // updateVehicle must run before world.step so the suspension forces it
      // computes are integrated by this step rather than the next one.
      vehicle.update(drive, FIXED_DT);
      world.step();
      accumulator -= FIXED_DT;
      steps++;
    }
    // Drop any backlog we could not work through, rather than spiralling.
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

    if (vehicle.position.y < VOID_Y) {
      vehicle.reset();
      camera.snap();
    }

    vehicle.syncMeshes();
    camera.update(vehicle, frameTime);

    const p = vehicle.position;
    _lightTarget.set(p.x, p.y, p.z);
    followMoon(stage.moon, _lightTarget);

    hud.extra['car'] = CAR.name;
    hud.extra['cam'] = camera.mode === 'orbit'
      ? `orbit ${camera.orbitDistance.toFixed(1)}m`
      : camera.mode;
    hud.extra['where'] = inSandbox ? 'test pad' : 'vancouver';

    // Live suspension bars — the point of the test pad is seeing these move.
    const s = vehicle.suspension;
    const bar = (v: number, contact: boolean): string => {
      const filled = Math.round(v * 8);
      return (contact ? '' : '·') + '█'.repeat(filled) + '░'.repeat(8 - filled);
    };
    hud.extra['susp F'] = `${bar(s[0]!.compression, s[0]!.contact)} ${bar(s[1]!.compression, s[1]!.contact)}`;
    hud.extra['susp R'] = `${bar(s[2]!.compression, s[2]!.contact)} ${bar(s[3]!.compression, s[3]!.contact)}`;
    hud.extra['light'] = lighting.mode;
    hud.extra['elev'] = `${p.y.toFixed(0)} m`;
    if (loaded) {
      hud.extra['pos'] = `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`;
    }
    hud.update(vehicle.speed, vehicle.grounded, frameTime, stage.renderer, vehicle.engine);
    stage.render();
    input.endFrame();
  }

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) {
    el.textContent = 'FAILED TO START — SEE CONSOLE';
    el.style.color = '#ff6b7a';
  }
});
