import * as THREE from 'three';

/**
 * Scene lighting, fog and sky, as a set of switchable presets.
 *
 * The target look for this game is deep night, but night only reads well once
 * the city supplies its own light — lit windows, street lamps, neon. Until
 * buildings and lamps exist there is nothing emissive in the world, so a true
 * night preset shows an almost black screen. `dusk` and `survey` exist to make
 * the terrain legible in the meantime, and `survey` stays useful afterwards for
 * inspecting geometry without fighting the art direction.
 */
export type LightingMode = 'night' | 'dusk' | 'survey';

export const LIGHTING_MODES: LightingMode[] = ['dusk', 'night', 'survey'];

interface Preset {
  label: string;
  ambient: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  moon: { color: number; intensity: number };
  /**
   * FogExp2 density. Worth a sense of scale: at density d, visibility drops to
   * roughly 50% at 1/d metres. 0.0075 — the value this started with — fogs
   * everything past 200 m almost solid, which is why the city looked black.
   */
  fogDensity: number;
  fogColor: number;
  skyTop: number;
  skyBottom: number;
  exposure: number;
  headlightIntensity: number;
}

const PRESETS: Record<LightingMode, Preset> = {
  night: {
    label: 'night',
    ambient: { color: 0x131e34, intensity: 1.5 },
    hemi: { sky: 0x1b2c4d, ground: 0x06090f, intensity: 1.1 },
    moon: { color: 0x8fb0e8, intensity: 1.1 },
    fogDensity: 0.00055,
    fogColor: 0x070c17,
    skyTop: 0x02040a,
    skyBottom: 0x101c33,
    exposure: 1.25,
    headlightIntensity: 700,
  },
  dusk: {
    label: 'dusk',
    ambient: { color: 0x2b3a56, intensity: 2.4 },
    hemi: { sky: 0x3f5a86, ground: 0x141a24, intensity: 2.0 },
    moon: { color: 0xbcd0f2, intensity: 2.2 },
    fogDensity: 0.00028,
    fogColor: 0x16233a,
    skyTop: 0x0a1424,
    skyBottom: 0x35507a,
    exposure: 1.35,
    headlightIntensity: 500,
  },
  survey: {
    label: 'survey',
    ambient: { color: 0xb8c6de, intensity: 3.0 },
    hemi: { sky: 0x9fb6d8, ground: 0x40484f, intensity: 2.6 },
    moon: { color: 0xffffff, intensity: 2.4 },
    fogDensity: 0.00009,
    fogColor: 0x8fa3bd,
    skyTop: 0x3f6595,
    skyBottom: 0x9db6d4,
    exposure: 1.0,
    headlightIntensity: 200,
  },
};

export class Lighting {
  mode: LightingMode;

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly ambient: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;
  private readonly fog: THREE.FogExp2;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly headlights: THREE.SpotLight[] = [];

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    moon: THREE.DirectionalLight,
    initial: LightingMode = 'dusk',
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.moon = moon;
    this.mode = initial;

    this.ambient = new THREE.AmbientLight(0xffffff, 1);
    scene.add(this.ambient);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0x000000, 0.0005);
    scene.fog = this.fog;

    this.skyMaterial = makeSkyMaterial();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), this.skyMaterial);
    sky.name = 'sky';
    // The sky must never be culled or fogged out from inside.
    sky.frustumCulled = false;
    scene.add(sky);

    this.apply();
  }

  /** Headlights register here so their intensity tracks the preset. */
  registerHeadlight(light: THREE.SpotLight): void {
    this.headlights.push(light);
    light.intensity = PRESETS[this.mode].headlightIntensity;
  }

  cycle(): LightingMode {
    const i = LIGHTING_MODES.indexOf(this.mode);
    this.mode = LIGHTING_MODES[(i + 1) % LIGHTING_MODES.length]!;
    this.apply();
    return this.mode;
  }

  private apply(): void {
    const p = PRESETS[this.mode];

    this.ambient.color.setHex(p.ambient.color);
    this.ambient.intensity = p.ambient.intensity;

    this.hemi.color.setHex(p.hemi.sky);
    this.hemi.groundColor.setHex(p.hemi.ground);
    this.hemi.intensity = p.hemi.intensity;

    this.moon.color.setHex(p.moon.color);
    this.moon.intensity = p.moon.intensity;

    this.fog.color.setHex(p.fogColor);
    this.fog.density = p.fogDensity;

    this.skyMaterial.uniforms['topColor']!.value.setHex(p.skyTop);
    this.skyMaterial.uniforms['bottomColor']!.value.setHex(p.skyBottom);

    this.renderer.toneMappingExposure = p.exposure;
    this.scene.background = new THREE.Color(p.fogColor);

    for (const h of this.headlights) h.intensity = p.headlightIntensity;
  }
}

/**
 * A vertical gradient sky.
 *
 * Beyond looking better than a flat clear colour, a gradient gives the horizon a
 * definite position, which is most of what makes it possible to judge slope and
 * heading while driving.
 */
function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x02040a) },
      bottomColor: { value: new THREE.Color(0x101c33) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y;
        // Bias the blend toward the horizon so the gradient is visible from
        // ground level rather than only when looking up.
        float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.55);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }
    `,
  });
}
