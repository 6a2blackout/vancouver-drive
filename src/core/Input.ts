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
/** Mouse movement accumulated since the last read. */
export interface MouseDelta {
  /** Horizontal drag in pixels, while a button is held. */
  dragX: number;
  /** Vertical drag in pixels, while a button is held. */
  dragY: number;
  /** Scroll wheel, positive when scrolling down (zoom out). */
  wheel: number;
  dragging: boolean;
}

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  private dragX = 0;
  private dragY = 0;
  private wheel = 0;
  private dragging = false;

  constructor(target: EventTarget = window) {
    this.attachMouse();
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
    // Mouse deltas are consumed per frame; anything not read is discarded so a
    // paused or backgrounded tab does not bank up a huge camera swing.
    this.dragX = 0;
    this.dragY = 0;
    this.wheel = 0;
  }

  /** Reads accumulated mouse motion. Does not clear — `endFrame` does that. */
  readMouse(): MouseDelta {
    return { dragX: this.dragX, dragY: this.dragY, wheel: this.wheel, dragging: this.dragging };
  }

  private attachMouse(): void {
    const canvasIsTarget = (e: Event): boolean =>
      e.target instanceof HTMLCanvasElement;

    window.addEventListener('pointerdown', (e) => {
      if (!canvasIsTarget(e)) return;
      this.dragging = true;
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (e.target instanceof HTMLCanvasElement && e.target.hasPointerCapture(e.pointerId)) {
        e.target.releasePointerCapture(e.pointerId);
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.dragX += e.movementX;
      this.dragY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!canvasIsTarget(e)) return;
        // Otherwise the browser zooms the whole page instead.
        e.preventDefault();
        this.wheel += e.deltaY;
      },
      { passive: false },
    );
    // A right-drag orbit would otherwise pop the context menu mid-turn.
    window.addEventListener('contextmenu', (e) => {
      if (canvasIsTarget(e)) e.preventDefault();
    });
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
