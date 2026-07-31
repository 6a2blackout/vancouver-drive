/** Normalised driving inputs, all in the range the vehicle expects. */
export interface DriveInput {
  /** -1 (full reverse/brake) .. +1 (full throttle) */
  throttle: number;
  /** -1 (right) .. +1 (left), matching a left-handed steer angle in radians later */
  steer: number;
  handbrake: boolean;
}

const THROTTLE_KEYS = ['KeyW', 'ArrowUp'];
const BRAKE_KEYS = ['KeyS', 'ArrowDown'];
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];

/**
 * Tracks raw key state and exposes it as normalised driving input.
 *
 * Steering is smoothed here rather than in the vehicle so that gamepad or AI
 * input can later be substituted by writing `steer` directly.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      this.down.add(ev.code);
      this.pressed.add(ev.code);
      // Stop the page scrolling out from under the game.
      if (ev.code.startsWith('Arrow') || ev.code === 'Space') ev.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete((e as KeyboardEvent).code));
    // Releasing focus mid-key would otherwise leave the throttle stuck on.
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True exactly once per physical key press. Call `endFrame()` to clear. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }

  read(): DriveInput {
    const any = (codes: string[]) => codes.some((c) => this.down.has(c));
    return {
      throttle: (any(THROTTLE_KEYS) ? 1 : 0) - (any(BRAKE_KEYS) ? 1 : 0),
      steer: (any(LEFT_KEYS) ? 1 : 0) - (any(RIGHT_KEYS) ? 1 : 0),
      handbrake: this.down.has('Space'),
    };
  }
}
