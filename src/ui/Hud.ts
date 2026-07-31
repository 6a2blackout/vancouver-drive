import type * as THREE from 'three';

/**
 * Speedometer plus a dev overlay.
 *
 * The overlay tracks the numbers that matter for the streaming work in Phase 6
 * (draw calls, triangles, loaded chunks) — it is much easier to keep it running
 * from the start than to add it once performance is already a problem.
 */
export class Hud {
  private readonly speedValue: HTMLElement;
  private readonly gearLabel: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly tacho: HTMLElement;
  private readonly tachoFill: HTMLElement;
  private readonly tachoRpm: HTMLElement;
  private readonly tachoRatio: HTMLElement;

  private frames = 0;
  private fpsAccum = 0;
  private fps = 0;

  /** Extra lines rendered in the dev overlay, set by other systems. */
  extra: Record<string, string> = {};

  constructor() {
    this.speedValue = document.querySelector('#speedo .value')!;
    this.gearLabel = document.querySelector('#speedo .gear')!;
    this.stats = document.querySelector('#stats')!;
    this.tacho = document.querySelector('#tacho')!;
    this.tachoFill = document.querySelector('#tacho .fill')!;
    this.tachoRpm = document.querySelector('#tacho .rpm')!;
    this.tachoRatio = document.querySelector('#tacho .ratio')!;
  }

  update(
    speedMs: number,
    grounded: boolean,
    dt: number,
    renderer: THREE.WebGLRenderer,
    engine?: { rpm: number; gear: number; revFraction: number; shifting: boolean },
  ): void {
    const kmh = Math.abs(speedMs) * 3.6;
    this.speedValue.textContent = String(Math.round(kmh));

    const dir = speedMs < -0.5 ? 'R' : speedMs > 0.5 ? 'D' : 'N';
    this.gearLabel.textContent = grounded ? `— ${dir} —` : `— ${dir} · AIR —`;

    if (engine) {
      this.tachoFill.style.width = `${Math.min(100, engine.revFraction * 100).toFixed(1)}%`;
      this.tachoRpm.textContent = `${Math.round(engine.rpm)} rpm`;
      this.tachoRatio.textContent = engine.gear === 0 ? 'R' : `${engine.gear}`;
      this.tacho.classList.toggle('shifting', engine.shifting);
    }

    this.frames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.frames / this.fpsAccum;
      this.frames = 0;
      this.fpsAccum = 0;
    }

    const info = renderer.info;
    const lines = [
      `fps    ${this.fps.toFixed(0)}`,
      `calls  ${info.render.calls}`,
      `tris   ${(info.render.triangles / 1000).toFixed(1)}k`,
      ...Object.entries(this.extra).map(([k, v]) => `${k.padEnd(6)} ${v}`),
    ];
    this.stats.textContent = lines.join('\n');
  }

  static hideLoading(): void {
    document.getElementById('loading')?.classList.add('hidden');
  }
}
