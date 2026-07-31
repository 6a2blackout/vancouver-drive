import * as THREE from 'three';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** The shadow-casting light. Must be kept near the player — see `followMoon`. */
  moon: THREE.DirectionalLight;
  render: () => void;
}

/**
 * Keeps the shadow camera centred on the player.
 *
 * A directional light's shadow map covers a fixed box. Over a 4 x 5 km city
 * that box has to travel with the car, or shadows simply stop existing a few
 * hundred metres from wherever it was left.
 */
export function followMoon(moon: THREE.DirectionalLight, target: THREE.Vector3): void {
  moon.target.position.copy(target);
  moon.position.set(target.x - 120, target.y + 190, target.z + 80);
  moon.target.updateMatrixWorld();
}

/**
 * Renderer, scene and night lighting.
 *
 * Postprocessing (bloom in particular) lands in Phase 5; the tone mapping and
 * colour space set up here are chosen to match what that will expect, so the
 * look does not shift underneath us later.
 */
export function createStage(): Stage {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Cap DPR: a retina display at 3x costs ~9x the fragments for little gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // Far plane must clear the map diagonal (~7 km) plus the sky sphere.
  const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.3, 20000);

  // Ambient, hemisphere, fog and sky are all owned by Lighting; only the
  // shadow-casting light lives here, because it has to be moved each frame.
  const moon = new THREE.DirectionalLight(0xffffff, 1);
  moon.position.set(-120, 190, 80);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 10;
  moon.shadow.camera.far = 500;
  const s = 90;
  moon.shadow.camera.left = -s;
  moon.shadow.camera.right = s;
  moon.shadow.camera.top = s;
  moon.shadow.camera.bottom = -s;
  moon.shadow.bias = -0.0012;
  scene.add(moon);
  scene.add(moon.target);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return {
    renderer,
    scene,
    camera,
    moon,
    render: () => renderer.render(scene, camera),
  };
}

/**
 * Headlights: two spotlights aimed down the road.
 *
 * Intensity is not set here — it belongs to the active lighting preset, so the
 * returned lights are handed to `Lighting.registerHeadlight`.
 */
export function createHeadlights(): { group: THREE.Group; lights: THREE.SpotLight[] } {
  const group = new THREE.Group();
  const lights: THREE.SpotLight[] = [];

  for (const sx of [-1, 1]) {
    const light = new THREE.SpotLight(0xdce8ff, 1, 160, Math.PI / 6, 0.42, 1.1);
    light.position.set(sx * 0.56, 0.05, 2.2);
    light.target.position.set(sx * 0.4, -1.4, 34);
    group.add(light);
    group.add(light.target);
    lights.push(light);
  }

  return { group, lights };
}
