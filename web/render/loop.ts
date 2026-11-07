/** requestAnimationFrame loop with a clamped delta and an optional frame-rate cap. */
export class Loop {
  private frameId = 0;
  private last = 0;
  private running = false;
  private accumulator = 0;

  constructor(
    private readonly update: (dt: number, elapsed: number) => void,
    private readonly render: () => void,
    private readonly maxFps = 60,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (time: number) => {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(this.tick);
    this.accumulator += time - this.last;
    this.last = time;
    // Frame cap leaves GPU headroom for the model while it generates.
    if (this.accumulator < 1000 / this.maxFps - 1) return;
    const dt = Math.min(this.accumulator / 1000, 0.05);
    this.accumulator = 0;
    this.update(dt, time / 1000);
    this.render();
  };
}
